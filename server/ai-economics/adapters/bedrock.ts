/**
 * AWS Bedrock usage, from CloudWatch.
 *
 * This is the adapter that closes the gap billing could not. Bedrock's billing
 * rows name the model and the dollar amount, but carry no token count and no
 * call count — pricing_unit is literally "N/A". CloudWatch has all three, in
 * the AWS/Bedrock namespace, dimensioned by ModelId:
 *
 *   Invocations       call count
 *   InputTokenCount   input tokens
 *   OutputTokenCount  output tokens
 *
 * ── The dimension trap ──────────────────────────────────────────────────────
 *
 * The AWS docs are explicit, and it is the thing that makes a naive
 * implementation silently wrong: those metrics are only tagged by ModelId.
 * Querying WITHOUT the dimension returns the SUM across every model, which
 * looks like a perfectly plausible number and makes per-model attribution
 * impossible. So this discovers the model ids first and queries each
 * explicitly, rather than fetching a total and trying to split it.
 *
 * GetMetricData is used rather than GetMetricStatistics because it takes up to
 * 500 queries per request, which turns "20 models x 3 metrics" from 60 API
 * calls into one.
 */
import {
  CloudWatchClient,
  GetMetricDataCommand,
  ListMetricsCommand,
  type MetricDataQuery,
} from '@aws-sdk/client-cloudwatch';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { awsReadClient, DEFAULT_AWS_REGION } from '../../aws/client-factory';
import { loadAwsConnection } from '../../aws/credential-provider';
import {
  type AdapterResult,
  type FetchWindow,
  type UsageAdapter,
  type UsageBucket,
} from './types';

const NAMESPACE = 'AWS/Bedrock';

// Declared below; hoisted function declarations are in scope here.

/**
 * Hourly. Daily would lose the intraday shape that makes a cost spike
 * explainable, and per-minute would multiply row count by sixty for detail
 * nobody analyses at the cost level.
 */
const PERIOD_SECONDS = 3600;

/** CloudWatch returns at most 100,800 data points per GetMetricData request. */
const MAX_QUERIES_PER_REQUEST = 100;

/**
 * Floors a timestamp to the top of its hour.
 *
 * Load-bearing, and the reason is not obvious. CloudWatch aligns GetMetricData
 * points relative to the QUERY START TIME, not to clock hours. Passing
 * `now - 30 days` therefore returns points at 17:45, then 17:50 five minutes
 * later, then 17:55 — a different period_start on every run.
 *
 * Since period_start is part of the usage identity, that meant re-ingestion
 * never matched an existing row and inserted a whole new copy instead. Three
 * collections produced exactly three times the usage. Aligning the window to
 * hour boundaries makes the timestamps stable, which is what makes the upsert
 * an upsert.
 */
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

export class BedrockUsageAdapter implements UsageAdapter {
  readonly providerKey = 'bedrock';
  readonly setupHint =
    'Connect an AWS account with cloudwatch:GetMetricData and cloudwatch:ListMetrics. ' +
    'Bedrock publishes Invocations, InputTokenCount and OutputTokenCount to the AWS/Bedrock ' +
    'namespace automatically — no extra configuration is needed on the Bedrock side.';

  private readonly region: string;

  constructor(region?: string) {
    this.region = region ?? process.env.AWS_REGION ?? DEFAULT_AWS_REGION;
  }

  async isConfigured(): Promise<boolean> {
    try {
      return (await loadAwsConnection()) !== null;
    } catch {
      // currentOrgId() throws outside a tenant context. "Not configured" is the
      // honest and safe answer there.
      return false;
    }
  }

  /**
   * Model ids that actually emitted metrics.
   *
   * Discovered rather than assumed: a hard-coded list would miss the model a
   * team adopted last week, which is exactly the spend a FinOps team most wants
   * to see. ListMetrics only returns metrics that have reported recently, so
   * this is also naturally scoped to what is in use.
   */
  private async discoverModelIds(cw: CloudWatchClient): Promise<{ ids: string[]; apiCalls: number }> {
    const ids = new Set<string>();
    let nextToken: string | undefined;
    let apiCalls = 0;

    do {
      const res = await cw.send(new ListMetricsCommand({
        Namespace: NAMESPACE,
        MetricName: 'InputTokenCount',
        NextToken: nextToken,
      }));
      apiCalls++;

      for (const metric of res.Metrics ?? []) {
        const dim = metric.Dimensions?.find((d) => d.Name === 'ModelId');
        if (dim?.Value) ids.add(dim.Value);
      }

      nextToken = res.NextToken;
    } while (nextToken);

    return { ids: Array.from(ids), apiCalls };
  }

  /**
   * The AWS account these metrics actually come from.
   *
   * Asked of STS rather than read from the connection row. The stored
   * account_id is whatever was typed when the account was connected, and on
   * this deployment it held an opaque identifier rather than an account number
   * — which then became the attribution on every usage record, making them
   * impossible to line up against billing.
   *
   * Falls back to the stored value if STS is unavailable: wrong attribution is
   * better than losing the usage entirely, and the warning says which happened.
   */
  private async resolveAccountId(stored: string | null): Promise<{ accountId: string | null; verified: boolean }> {
    try {
      const sts = await awsReadClient(STSClient, { region: this.region });
      const identity = await sts.send(new GetCallerIdentityCommand({}));
      if (identity.Account) return { accountId: identity.Account, verified: true };
    } catch (err: any) {
      console.warn('[Bedrock] Could not resolve the account via STS:', err?.message ?? err);
    }
    return { accountId: stored, verified: false };
  }

  async fetchUsage(window: FetchWindow): Promise<AdapterResult> {
    const connection = await loadAwsConnection();
    if (!connection) {
      return { buckets: [], apiCalls: 0, warning: 'No AWS connection is configured.' };
    }

    const { accountId } = await this.resolveAccountId(connection.accountId ?? null);

    const cw = await awsReadClient(CloudWatchClient, { region: this.region });

    const { ids, apiCalls: listCalls } = await this.discoverModelIds(cw);
    let apiCalls = listCalls;

    if (ids.length === 0) {
      return {
        buckets: [],
        apiCalls,
        warning:
          `No Bedrock models have reported metrics in ${this.region}. If Bedrock is used in another ` +
          'region, that region needs its own connection — CloudWatch metrics are regional.',
      };
    }

    // Query id -> what it means. CloudWatch requires ids matching
    // ^[a-z][a-zA-Z0-9_]*$, so the model id itself cannot be used.
    const meaning = new Map<string, { modelId: string; metric: string }>();
    const queries: MetricDataQuery[] = [];

    ids.forEach((modelId, index) => {
      for (const [metric, suffix] of [
        ['Invocations', 'calls'],
        ['InputTokenCount', 'in'],
        ['OutputTokenCount', 'out'],
      ] as const) {
        const id = `m${index}_${suffix}`;
        meaning.set(id, { modelId, metric });
        queries.push({
          Id: id,
          MetricStat: {
            Metric: {
              Namespace: NAMESPACE,
              MetricName: metric,
              // The dimension that makes this per-model. Omitting it returns
              // the sum across every model — plausible, and useless.
              Dimensions: [{ Name: 'ModelId', Value: modelId }],
            },
            Period: PERIOD_SECONDS,
            // Sum, not Average: these are counters. Average would report the
            // mean tokens per reporting interval, which is not a quantity
            // anything can be costed from.
            Stat: 'Sum',
          },
          ReturnData: true,
        });
      }
    });

    // modelId -> ISO hour -> accumulating bucket
    const byModelHour = new Map<string, Map<string, UsageBucket>>();

    for (let i = 0; i < queries.length; i += MAX_QUERIES_PER_REQUEST) {
      const chunk = queries.slice(i, i + MAX_QUERIES_PER_REQUEST);

      let nextToken: string | undefined;
      do {
        const res = await cw.send(new GetMetricDataCommand({
          MetricDataQueries: chunk,
          // Hour-aligned so the returned timestamps are stable between runs.
          // See floorToHour: without this, re-ingesting duplicates everything.
          StartTime: floorToHour(window.start),
          EndTime: ceilToHour(window.end),
          // Ascending so paging returns coherent slices rather than interleaved
          // ends of the window.
          ScanBy: 'TimestampAscending',
          NextToken: nextToken,
        }));
        apiCalls++;

        for (const result of res.MetricDataResults ?? []) {
          const what = meaning.get(result.Id ?? '');
          if (!what) continue;

          const timestamps = result.Timestamps ?? [];
          const values = result.Values ?? [];

          for (let k = 0; k < timestamps.length; k++) {
            const ts = timestamps[k];
            const value = values[k] ?? 0;
            if (!ts) continue;

            // Truncated again here rather than trusting the request alignment.
            // This is the value that becomes part of the row identity, so it
            // must be stable even if CloudWatch ever returns an offset point.
            const hour = floorToHour(ts);
            const hourKey = hour.toISOString();
            const hours = byModelHour.get(what.modelId) ?? new Map<string, UsageBucket>();

            const bucket = hours.get(hourKey) ?? {
              // The RAW id, deliberately. An earlier version normalised the
              // routing prefix away to collapse "the same model" into one row.
              // The LiteLLM catalogue shows that is wrong: cross-region
              // inference profiles cost about 10% more than the base model
              //   anthropic.claude-sonnet-4-6      $3.00 / 1M
              //   us.anthropic.claude-sonnet-4-6   $3.30 / 1M
              // Collapsing them priced every cross-region call 10% too low,
              // invisibly. The prefix is part of the price.
              modelId: what.modelId,
              periodStart: hour,
              periodEnd: new Date(hour.getTime() + PERIOD_SECONDS * 1000),
              inputTokens: 0,
              outputTokens: 0,
              inferenceCalls: 0,
              accountId,
              region: this.region,
              sourceRef: `cloudwatch:${NAMESPACE}:${what.modelId}`,
            };

            if (what.metric === 'Invocations') bucket.inferenceCalls += value;
            else if (what.metric === 'InputTokenCount') bucket.inputTokens += value;
            else if (what.metric === 'OutputTokenCount') bucket.outputTokens += value;

            hours.set(hourKey, bucket);
            byModelHour.set(what.modelId, hours);
          }
        }

        nextToken = res.NextToken;
      } while (nextToken);
    }

    const buckets: UsageBucket[] = [];
    for (const hours of byModelHour.values()) {
      for (const bucket of hours.values()) {
        // An hour with no tokens and no calls is CloudWatch reporting an empty
        // interval, not usage worth a row.
        if (bucket.inputTokens === 0 && bucket.outputTokens === 0 && bucket.inferenceCalls === 0) continue;
        buckets.push(bucket);
      }
    }

    return {
      buckets,
      apiCalls,
      warning: buckets.length === 0
        ? `Bedrock models exist in ${this.region} but reported no usage in this window.`
        : undefined,
    };
  }
}

/**
 * Strips the routing prefix from a Bedrock model id.
 *
 * NOT used for pricing or for row identity — cross-region profiles are priced
 * separately and must stay distinct. This exists only for display grouping,
 * where showing one model under three names is noise rather than precision.
 */
export function normalizeBedrockModelId(modelId: string): string {
  // Strip the routing prefix used by inference profiles. `global` is one of
  // them and was missed initially, which split one model's usage in two:
  // "global.anthropic.claude-haiku-4-5..." and the direct id looked like
  // different models, so each needed its own price and neither total was right.
  return modelId.replace(/^(global|us|eu|apac|us-gov)\./i, '');
}

/** "anthropic.claude-sonnet-4-5-20250929-v1:0" -> "Claude Sonnet 4 5". */
export function bedrockDisplayName(modelId: string): string {
  const withoutVendor = normalizeBedrockModelId(modelId).replace(/^[a-z0-9-]+\./i, '');
  return withoutVendor
    // Drop the version suffix and the YYYYMMDD build date, which are noise in a
    // chart legend and make two builds of one model look like two models.
    .replace(/-v\d+(:\d+)?$/i, '')
    .replace(/-\d{8}$/, '')
    .split('-')
    .map((part) => (/^\d+$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ');
}
