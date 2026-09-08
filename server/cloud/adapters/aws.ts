/**
 * AWS Cost Explorer adapter.
 *
 * The connector this replaces already paginated correctly and leaned on the SDK
 * for retry, so it was the least broken of the three. Moving it onto the runtime
 * is not about fixing it — it is about there being one place where retry,
 * throttling and error classification live, so the next fix does not have to be
 * applied three times and forgotten twice.
 *
 * It also gains something the SDK's retry could not give it: participation in
 * the shared per-provider budget. Cost Explorer bills **per request**, so
 * uncoordinated retries across the ingester, alert checker and refresh button
 * cost real money as well as risking throttling.
 *
 * AWS-specific facts that stay here:
 *
 *   - `End` is EXCLUSIVE, so the inclusive range end is converted
 *   - `NextPageToken` is the cursor
 *   - four metrics in one request, because Cost Explorer returns up to five at
 *     no extra charge and amortized cost is needed to attribute commitments
 *   - tax arrives as a service named "Tax", not via a charge-category dimension
 */
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  type GetCostAndUsageCommandInput,
  type ResultByTime,
} from '@aws-sdk/client-cost-explorer';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import type { CloudCostAdapter, FetchContext, PageResult } from '../fetch-runtime';
import type { NormalizedCostRecord } from '../../ingestion/types';
import { getActiveCloudAccounts } from '../../cloud-config-manager';
import { awsReadClient } from '../../aws/client-factory';
import { categorizeService } from '../../ingestion/service-category';

/** A flattened Cost Explorer row, so mapping does not re-walk the SDK shape. */
export interface AwsRow {
  day: string;
  serviceName: string;
  regionId: string | null;
  billedCost: number;
  effectiveCost: number | null;
  currency: string;
  quantity: number | null;
  quantityUnit: string | null;
  /** Resolved account, carried through so mapRows needs no extra lookup. */
  accountId: string;
  accountName: string;
}

const num = (v: string | undefined): number => {
  const n = parseFloat(v ?? '0');
  return Number.isFinite(n) ? n : 0;
};

/** Stored label -> real 12-digit account id, for the process lifetime. */
const accountIdCache = new Map<string, string>();

/**
 * The real AWS account id, from STS rather than from whatever was typed into
 * the Configuration form.
 *
 * `cloud_accounts.account_id` is a free-text label and is not validated — in
 * this deployment the AWS row holds an Azure-style billing-account string. That
 * matters far beyond cosmetics, because subAccountId feeds `sourceHash()`:
 *
 *   Changing how a connector derives a hashed field turns the ingester's UPSERT
 *   into an INSERT, so the same spend is stored twice under two keys.
 *
 * Dropping this resolution when porting the connector to an adapter did exactly
 * that: 992 rows appeared under the label alongside the correct rows under
 * 890882436612, and AWS September read $8,468 instead of ~$4,300. GetCallerIdentity
 * is free and authoritative, so it is not an optimisation to skip.
 *
 * Falls back to the stored value if STS is unreachable, so a permissions gap
 * degrades attribution rather than stopping ingestion.
 */
async function resolveAccountId(
  client: { config: { credentials: unknown } },
  fallback: string,
): Promise<string> {
  const cached = accountIdCache.get(fallback);
  if (cached) return cached;

  try {
    const sts = new STSClient({
      region: process.env.AWS_STS_REGION || 'us-east-1',
      credentials: client.config.credentials as never,
      maxAttempts: 3,
    });
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    if (identity.Account) {
      accountIdCache.set(fallback, identity.Account);
      return identity.Account;
    }
  } catch (err: any) {
    console.warn(`[AWS] Could not resolve account id via STS, using stored value: ${err?.message ?? err}`);
  }

  return fallback;
}

/** Cost Explorer's End is exclusive; our DateRange.end is inclusive. */
function exclusiveEnd(inclusiveEnd: string): string {
  const d = new Date(`${inclusiveEnd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const monthStart = (day: string) => `${day.slice(0, 7)}-01`;

/** Flattens one page of ResultsByTime into rows. */
function flatten(
  results: ResultByTime[] | undefined,
  account: { accountId: string; accountName: string },
): AwsRow[] {
  const out: AwsRow[] = [];

  for (const result of results ?? []) {
    const day = result.TimePeriod?.Start;
    if (!day) continue;

    for (const group of result.Groups ?? []) {
      const m = group.Metrics ?? {};
      const billedCost = num(m.UnblendedCost?.Amount);

      // NetAmortizedCost includes credits and refunds; prefer it, and fall back
      // to AmortizedCost where the account has no net metrics enabled.
      const effectiveCost =
        m.NetAmortizedCost?.Amount !== undefined ? num(m.NetAmortizedCost.Amount)
        : m.AmortizedCost?.Amount !== undefined ? num(m.AmortizedCost.Amount)
        : null;

      const regionId = group.Keys?.[1] || null;
      const quantity = num(m.UsageQuantity?.Amount);

      out.push({
        day,
        serviceName: group.Keys?.[0] || 'Unknown',
        regionId: regionId === 'NoRegion' ? null : regionId,
        billedCost,
        effectiveCost,
        currency: m.UnblendedCost?.Unit || 'USD',
        quantity: quantity || null,
        quantityUnit: m.UsageQuantity?.Unit || null,
        accountId: account.accountId,
        accountName: account.accountName,
      });
    }
  }

  return out;
}

export const awsCostAdapter: CloudCostAdapter<AwsRow> = {
  provider: 'aws',

  passes: ['default'],

  // Cost Explorer pages at 1000 groups. A large account over a month can run to
  // several pages; the cap is generous but finite so a stuck token cannot spin.
  maxPages: 100,

  async listAccounts() {
    const accounts = await getActiveCloudAccounts('aws');
    return accounts.map((a) => ({
      id: a.id,
      accountId: a.accountId,
      accountName: a.accountName,
      credentials: a.credentials ?? {},
      authType: a.authType,
    }));
  },

  async fetchPage(ctx: FetchContext, cursor: string | null): Promise<PageResult<AwsRow>> {
    // Read-only tier. Ingestion reads costs and must never hold credentials
    // able to change anything — enforced by AWS under cross-account roles, and
    // by the factory choosing the tier under legacy keys.
    const client = await awsReadClient(CostExplorerClient, { connectionId: ctx.account.id });

    const params: GetCostAndUsageCommandInput = {
      TimePeriod: { Start: ctx.range.start, End: exclusiveEnd(ctx.range.end) },
      Granularity: 'DAILY',
      // Five metrics cost the same as one. Amortized cost is what makes a
      // Reserved Instance's upfront payment attributable across the days it
      // covers, rather than appearing as a spike on the day it was charged.
      Metrics: ['UnblendedCost', 'AmortizedCost', 'NetAmortizedCost', 'UsageQuantity'],
      GroupBy: [
        { Type: 'DIMENSION', Key: 'SERVICE' },
        { Type: 'DIMENSION', Key: 'REGION' },
      ],
      ...(cursor ? { NextPageToken: cursor } : {}),
    };

    // Resolved BEFORE mapping, because subAccountId is part of sourceHash(): a
    // different value here writes duplicate facts rather than updating them.
    const accountId = await resolveAccountId(client, ctx.account.accountId);

    const response = await client.send(new GetCostAndUsageCommand(params));

    return {
      rows: flatten(response.ResultsByTime, { accountId, accountName: ctx.account.accountName }),
      nextCursor: response.NextPageToken ?? null,
    };
  },

  mapRows(rowsByPass): NormalizedCostRecord[] {
    const rows = rowsByPass.get('default') ?? [];
    const out: NormalizedCostRecord[] = [];

    for (const row of rows) {
      // Genuinely nothing on both measures carries no information. Negatives are
      // kept: they are credits and refunds, and dropping them overstates spend.
      if (row.billedCost === 0 && (row.effectiveCost === null || row.effectiveCost === 0)) continue;

      out.push({
        provider: 'aws',
        billingAccountId: row.accountId,
        billingAccountName: row.accountName,
        subAccountId: row.accountId,
        subAccountName: row.accountName,
        chargePeriodStart: row.day,
        chargePeriodEnd: nextDay(row.day),
        billingPeriodStart: monthStart(row.day),
        serviceName: row.serviceName,
        serviceCategory: categorizeService(row.serviceName),
        // Cost Explorer reports tax as a service named "Tax" rather than through
        // a charge-category dimension. Classifying it here keeps it out of
        // per-team allocation, where it is not attributable.
        chargeCategory:
          row.serviceName === 'Tax' ? 'Tax'
          : row.billedCost < 0 ? 'Credit'
          : 'Usage',
        regionId: row.regionId,
        billedCost: row.billedCost,
        effectiveCost: row.effectiveCost,
        billingCurrency: row.currency,
        pricingQuantity: row.quantity,
        pricingUnit: row.quantityUnit,
      });
    }

    return out;
  },
};
