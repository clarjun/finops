/**
 * Azure OpenAI / AI Foundry token usage, from Azure Monitor.
 *
 * Azure publishes real token counts as platform metrics on the Cognitive
 * Services account, which makes this the second provider (after Bedrock) whose
 * usage can be metered without asking the customer for a vendor admin key.
 *
 *   ProcessedPromptTokens   prompt (input) tokens
 *   GeneratedTokens         completion (output) tokens
 *   AzureOpenAIRequests     inference calls
 *
 * https://learn.microsoft.com/en-us/azure/ai-foundry/openai/monitor-openai-reference
 *
 * ── Two things that decide whether the numbers are right ────────────────────
 *
 * 1. DIMENSION SPLIT. Without `ModelName eq '*'` Azure returns one total across
 *    every deployment in the account. That total is not wrong, but it cannot be
 *    priced: GPT-4o and GPT-4o-mini differ by roughly 17x per token, so a
 *    blended number multiplied by either rate is a fabrication. Usage that
 *    arrives without a model dimension is therefore reported as a gap rather
 *    than stored as a total nothing can attribute.
 *
 * 2. HOUR ALIGNMENT. The same trap the Bedrock adapter fell into. Metric points
 *    are aligned to the requested timespan, so two collections a few minutes
 *    apart produce different period_start values, the identity upsert misses,
 *    and re-collecting silently multiplies usage. Every bucket is floored to
 *    the hour.
 *
 * ── Model ids ───────────────────────────────────────────────────────────────
 *
 * ModelName is the bare model ("gpt-4o"); ModelDeploymentName is the customer's
 * own alias ("prod-chat"), which is arbitrary and useless for pricing. The
 * model name becomes the id; the deployment is carried as `application` so
 * per-deployment breakdowns still work.
 */
import { MonitorClient } from '@azure/arm-monitor';
import { ResourceManagementClient } from '@azure/arm-resources';
import { ClientSecretCredential } from '@azure/identity';
import { getProviderCredentials } from '../../cloud-config-manager';
import { runProviderQuery } from '../../cloud/query-runner';
import {
  type AdapterResult, type FetchWindow, type UsageAdapter, type UsageBucket,
} from './types';

/** One hour, matching the Bedrock adapter so both providers bucket alike. */
const PERIOD_SECONDS = 3600;
const INTERVAL = 'PT1H';

const METRIC_NAMESPACE = 'Microsoft.CognitiveServices/accounts';

/**
 * Kinds that serve models and emit the token metrics.
 *
 * "OpenAI" is the original Azure OpenAI resource; "AIServices" is what AI
 * Foundry creates now, and a tenant that onboarded recently has only the
 * latter — matching "OpenAI" alone would report no usage on an account that is
 * actively serving traffic.
 */
const MODEL_SERVING_KINDS = new Set(['openai', 'aiservices', 'cognitiveservices']);

export function floorToHour(d: Date): Date {
  const out = new Date(d);
  out.setUTCMinutes(0, 0, 0);
  return out;
}

export function ceilToHour(d: Date): Date {
  const out = floorToHour(d);
  if (out.getTime() !== d.getTime()) out.setUTCHours(out.getUTCHours() + 1);
  return out;
}

interface AzureCreds {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  subscriptionId: string;
}

/** A metric point already split by model and deployment. */
export interface Point {
  hour: number;
  modelName: string;
  deployment: string | null;
  promptTokens: number;
  generatedTokens: number;
  requests: number;
}

/** Reads a dimension off a timeseries, whatever shape the SDK returns it in. */
function dimension(series: any, name: string): string | null {
  for (const md of series?.metadatavalues ?? []) {
    const key = (md?.name?.value ?? md?.name ?? '').toString().toLowerCase();
    if (key === name.toLowerCase()) {
      const v = md?.value;
      return typeof v === 'string' && v.length > 0 ? v : null;
    }
  }
  return null;
}

type Counter = 'promptTokens' | 'generatedTokens' | 'requests';

const METRIC_ALIASES: Record<string, Counter> = {
  processedprompttokens: 'promptTokens',
  generatedtokens: 'generatedTokens',
  azureopenairequests: 'requests',
};

/**
 * Turns an Azure Monitor metrics response into per-hour, per-model points.
 *
 * Exported and pure so it can be tested without a subscription. The dimension
 * handling and the three-metrics-into-one-row merge are where this adapter
 * would silently produce wrong numbers, and neither is reachable from any test
 * that needs credentials.
 *
 * `split` reports whether Azure actually honoured the model dimension. A
 * response carrying usage but no ModelName is not an empty result and must not
 * be shown as one.
 */
export function parseMetrics(res: any): { points: Point[]; split: boolean } {
  // Keyed by hour + model + deployment so the three metrics land on one row.
  const merged = new Map<string, Point>();
  let sawSplit = false;
  let sawUnsplitUsage = false;

  for (const metric of res?.value ?? []) {
    const rawName = (metric?.name?.value ?? metric?.name ?? '').toString().toLowerCase();
    const field = METRIC_ALIASES[rawName];
    if (!field) continue;

    for (const series of metric?.timeseries ?? []) {
      const modelName = dimension(series, 'ModelName');
      const deployment = dimension(series, 'ModelDeploymentName');

      for (const point of series?.data ?? []) {
        const total = point?.total;
        if (typeof total !== 'number' || total === 0) continue;

        const ts = point?.timeStamp ? new Date(point.timeStamp) : null;
        if (!ts || Number.isNaN(ts.getTime())) continue;

        // A model-less series is dropped rather than bucketed as "unknown".
        // It cannot be priced, and an unpriceable phantom model on the
        // dashboard is worse than a gap that says so.
        if (!modelName) {
          sawUnsplitUsage = true;
          continue;
        }
        sawSplit = true;

        const hour = floorToHour(ts).getTime();
        const key = `${hour}|${modelName}|${deployment ?? ''}`;
        let row = merged.get(key);
        if (!row) {
          row = { hour, modelName, deployment, promptTokens: 0, generatedTokens: 0, requests: 0 };
          merged.set(key, row);
        }
        row[field] += total;
      }
    }
  }

  return {
    points: [...merged.values()],
    // Only meaningful when there was usage to split in the first place.
    split: sawSplit || !sawUnsplitUsage,
  };
}

export class AzureOpenAiUsageAdapter implements UsageAdapter {
  readonly providerKey = 'azure_openai';

  readonly setupHint =
    'Connect an Azure account whose service principal has the Monitoring Reader and Reader roles ' +
    'on the subscription (or on the Azure OpenAI / AI Foundry resources). Token counts come from ' +
    'Azure Monitor, so no OpenAI API key is needed.';

  private creds: AzureCreds | null = null;

  private async credentials(): Promise<AzureCreds | null> {
    if (this.creds) return this.creds;

    const config = await getProviderCredentials('azure');
    const c: any = config?.credentials;
    if (!c?.tenantId || !c?.clientId || !c?.clientSecret || !c?.subscriptionId) return null;

    this.creds = {
      tenantId: c.tenantId, clientId: c.clientId,
      clientSecret: c.clientSecret, subscriptionId: c.subscriptionId,
    };
    return this.creds;
  }

  async isConfigured(): Promise<boolean> {
    return (await this.credentials()) !== null;
  }

  /**
   * Model-serving Cognitive Services accounts in the subscription.
   *
   * Discovered rather than configured: a customer should not have to paste
   * resource ids, and a resource created next week would otherwise go unmetered
   * until someone remembered to add it.
   */
  private async listAccounts(client: ResourceManagementClient): Promise<
    Array<{ id: string; name: string; location: string | null; kind: string }>
  > {
    const found: Array<{ id: string; name: string; location: string | null; kind: string }> = [];

    const iterator = client.resources.list({
      filter: `resourceType eq '${METRIC_NAMESPACE}'`,
    });

    for await (const r of iterator) {
      const kind = (r.kind ?? '').toLowerCase();
      // A blank kind is kept rather than dropped: the metric query returns
      // nothing for a resource that serves no models, whereas a too-strict
      // filter loses a resource that does.
      if (kind && !MODEL_SERVING_KINDS.has(kind)) continue;
      if (!r.id) continue;
      found.push({ id: r.id, name: r.name ?? r.id, location: r.location ?? null, kind });
    }

    return found;
  }

  /** Metric points for one account, split by model and deployment. */
  private async pointsFor(
    monitor: MonitorClient,
    resourceId: string,
    window: FetchWindow,
  ): Promise<{ points: Point[]; split: boolean }> {
    const start = floorToHour(window.start);
    const end = ceilToHour(window.end);

    const res: any = await runProviderQuery('azure', 'metrics:ai-tokens', () =>
      monitor.metrics.list(resourceId, {
        timespan: `${start.toISOString()}/${end.toISOString()}`,
        interval: INTERVAL,
        metricnames: 'ProcessedPromptTokens,GeneratedTokens,AzureOpenAIRequests',
        aggregation: 'Total',
        metricnamespace: METRIC_NAMESPACE,
        // Splits the series by model. Without it Azure returns one blended
        // total per account, which cannot be priced — see the header.
        filter: "ModelName eq '*' and ModelDeploymentName eq '*'",
      }),
    );

    return parseMetrics(res);
  }

  async fetchUsage(window: FetchWindow): Promise<AdapterResult> {
    const creds = await this.credentials();
    if (!creds) {
      return { buckets: [], apiCalls: 0, warning: this.setupHint };
    }

    const credential = new ClientSecretCredential(creds.tenantId, creds.clientId, creds.clientSecret);
    const resources = new ResourceManagementClient(credential, creds.subscriptionId);
    const monitor = new MonitorClient(credential, creds.subscriptionId);

    let apiCalls = 0;
    const notes: string[] = [];

    let accounts: Array<{ id: string; name: string; location: string | null; kind: string }>;
    try {
      accounts = await this.listAccounts(resources);
      apiCalls++;
    } catch (err: any) {
      // A missing role is by far the most likely failure and is worth naming,
      // because "no usage" and "no permission" look identical on a dashboard.
      const denied = /authoriz|forbidden|403/i.test(String(err?.message ?? ''));
      return {
        buckets: [],
        apiCalls,
        warning: denied
          ? 'Azure refused to list resources for this service principal. Grant it the Reader and ' +
            'Monitoring Reader roles on the subscription, then collect again. ' +
            'Billing access alone is not enough — token metrics are read through Azure Resource Manager.'
          : `Could not list Azure AI resources: ${err?.message ?? err}`,
      };
    }

    if (accounts.length === 0) {
      return {
        buckets: [],
        apiCalls,
        warning:
          'No Azure OpenAI or AI Foundry resources were found in this subscription. ' +
          'If you run them in a different subscription, connect that one as well.',
      };
    }

    const buckets: UsageBucket[] = [];
    let unsplit = 0;

    for (const account of accounts) {
      try {
        const { points, split } = await this.pointsFor(monitor, account.id, window);
        apiCalls++;
        if (!split) unsplit++;

        for (const p of points) {
          buckets.push({
            modelId: p.modelName,
            periodStart: new Date(p.hour),
            periodEnd: new Date(p.hour + PERIOD_SECONDS * 1000),
            inputTokens: Math.round(p.promptTokens),
            outputTokens: Math.round(p.generatedTokens),
            inferenceCalls: Math.round(p.requests),
            accountId: creds.subscriptionId,
            region: account.location,
            // The customer's deployment alias — arbitrary as a model id, but
            // exactly what they want to group spend by.
            application: p.deployment,
            environment: null,
            sourceRef: account.id,
          });
        }
      } catch (err: any) {
        // One inaccessible resource must not lose the others.
        notes.push(`${account.name}: ${err?.message ?? err}`);
      }
    }

    if (unsplit > 0) {
      notes.push(
        `${unsplit} resource(s) reported usage with no model dimension, so it could not be priced ` +
        'and was left out. This usually means an older resource kind that does not emit ModelName.',
      );
    }

    return {
      buckets,
      apiCalls,
      warning: notes.length > 0 ? notes.join(' ') : undefined,
    };
  }
}
