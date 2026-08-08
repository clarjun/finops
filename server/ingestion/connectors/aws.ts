/**
 * AWS Cost Explorer connector.
 *
 * Differs from the existing fetchAWSCostData in three ways that matter for a
 * trustworthy cost store:
 *
 *   1. It requests UnblendedCost, AmortizedCost, NetAmortizedCost and
 *      UsageQuantity in a single call. Cost Explorer returns up to five metrics
 *      per request at no extra charge, so amortized cost — the number you need
 *      before Reserved Instance and Savings Plan spend can be attributed
 *      honestly — costs nothing extra to collect. The old code asked only for
 *      UnblendedCost, which is why a customer with heavy RI coverage would see
 *      a large upfront charge on one day and near-zero afterwards.
 *
 *   2. It groups by service *and* region, and paginates. The old version read
 *      only the first page, so any tenant with more than ~1000 daily groups was
 *      silently missing data.
 *
 *   3. It keeps zero-cost rows out but retains negative ones. Negative amounts
 *      are credits and refunds; dropping them (as `if (cost > 0)` did) overstates
 *      spend.
 */
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  type GetCostAndUsageCommandInput,
} from "@aws-sdk/client-cost-explorer";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { getActiveCloudAccounts } from "../../cloud-config-manager";
import { categorizeService } from "../service-category";
import type { CostConnector, ConnectorResult, DateRange, NormalizedCostRecord } from "../types";

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

function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

function num(v: string | undefined): number {
  const n = parseFloat(v ?? '0');
  return Number.isFinite(n) ? n : 0;
}

/** accessKeyId -> resolved 12-digit account id, for the process lifetime. */
const accountIdCache = new Map<string, string>();

/**
 * The real AWS account id, from STS rather than from whatever was typed into
 * the Configuration form.
 *
 * cloud_accounts.account_id is a user-supplied label and is not validated. In
 * this deployment the AWS row holds an Azure-style billing-account string, so
 * every AWS cost fact was keyed on a sub-account id that identifies nothing —
 * which breaks per-account attribution and makes multi-account rollups
 * meaningless. GetCallerIdentity is free and authoritative.
 *
 * Falls back to the stored value if STS is unreachable, so a permissions gap
 * degrades attribution rather than stopping ingestion.
 */
async function resolveAccountId(
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string; region?: string },
  fallback: string,
): Promise<string> {
  const cached = accountIdCache.get(credentials.accessKeyId);
  if (cached) return cached;

  try {
    const sts = new STSClient({
      region: credentials.region || 'us-east-1',
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}),
      },
    });
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    if (identity.Account) {
      accountIdCache.set(credentials.accessKeyId, identity.Account);
      return identity.Account;
    }
  } catch (err: any) {
    console.warn(`[AWS] Could not resolve account id via STS, using stored value: ${err?.message ?? err}`);
  }

  return fallback;
}

export class AwsCostConnector implements CostConnector {
  readonly provider = 'aws' as const;

  async isConfigured(): Promise<boolean> {
    const accounts = await getActiveCloudAccounts('aws');
    return accounts.length > 0;
  }

  async fetchCosts(range: DateRange): Promise<ConnectorResult> {
    const accounts = await getActiveCloudAccounts('aws');
    const records: NormalizedCostRecord[] = [];
    const warnings: string[] = [];
    let apiCalls = 0;

    for (const account of accounts) {
      const creds = account.credentials ?? {};
      if (!creds.accessKeyId || !creds.secretAccessKey) {
        warnings.push(`AWS account "${account.accountName}" has no access key configured`);
        continue;
      }

      const client = new CostExplorerClient({
        region: creds.region || 'us-east-1',
        credentials: {
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
          ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
        },
      });

      try {
        const accountId = await resolveAccountId(creds, account.accountId);
        const accountRecords = await this.fetchForAccount(
          client, { accountId, accountName: account.accountName }, range, () => { apiCalls++; }
        );
        records.push(...accountRecords);
      } catch (err: any) {
        // One account failing must not lose the others' data; the run is marked
        // partial so the gap is visible rather than looking like zero spend.
        warnings.push(`AWS account "${account.accountName}": ${err?.message ?? err}`);
      }
    }

    return { records, apiCalls, warnings };
  }

  private async fetchForAccount(
    client: CostExplorerClient,
    account: { accountId: string; accountName: string },
    range: DateRange,
    countCall: () => void,
  ): Promise<NormalizedCostRecord[]> {
    const out: NormalizedCostRecord[] = [];
    let nextPageToken: string | undefined;

    do {
      const params: GetCostAndUsageCommandInput = {
        TimePeriod: { Start: range.start, End: exclusiveEnd(range.end) },
        Granularity: 'DAILY',
        // Five metrics, one request, one charge.
        Metrics: ['UnblendedCost', 'AmortizedCost', 'NetAmortizedCost', 'UsageQuantity'],
        GroupBy: [
          { Type: 'DIMENSION', Key: 'SERVICE' },
          { Type: 'DIMENSION', Key: 'REGION' },
        ],
        ...(nextPageToken ? { NextPageToken: nextPageToken } : {}),
      };

      countCall();
      const response = await client.send(new GetCostAndUsageCommand(params));

      for (const result of response.ResultsByTime ?? []) {
        const day = result.TimePeriod?.Start;
        if (!day) continue;

        for (const group of result.Groups ?? []) {
          const serviceName = group.Keys?.[0] || 'Unknown';
          const regionId = group.Keys?.[1] || null;
          const m = group.Metrics ?? {};

          const billedCost = num(m.UnblendedCost?.Amount);
          // NetAmortizedCost includes credits and refunds; prefer it, fall back
          // to AmortizedCost when the account has no net metrics enabled.
          const effectiveCost = m.NetAmortizedCost?.Amount !== undefined
            ? num(m.NetAmortizedCost.Amount)
            : m.AmortizedCost?.Amount !== undefined
              ? num(m.AmortizedCost.Amount)
              : null;

          // Skip rows that are genuinely nothing, but keep negatives (credits).
          if (billedCost === 0 && (effectiveCost === null || effectiveCost === 0)) continue;

          const quantity = num(m.UsageQuantity?.Amount);

          out.push({
            provider: 'aws',
            billingAccountId: account.accountId,
            billingAccountName: account.accountName,
            subAccountId: account.accountId,
            subAccountName: account.accountName,
            chargePeriodStart: day,
            chargePeriodEnd: nextDay(day),
            billingPeriodStart: monthStart(day),
            serviceName,
            serviceCategory: categorizeService(serviceName),
            // Cost Explorer reports tax as a service named "Tax" rather than
            // through a charge-category dimension. Classifying it here keeps it
            // out of per-team allocation, where it is not attributable.
            chargeCategory: serviceName === 'Tax' ? 'Tax'
              : billedCost < 0 ? 'Credit'
              : 'Usage',
            regionId: regionId === 'NoRegion' ? null : regionId,
            billedCost,
            effectiveCost,
            billingCurrency: m.UnblendedCost?.Unit || 'USD',
            pricingQuantity: quantity || null,
            pricingUnit: m.UsageQuantity?.Unit || null,
          });
        }
      }

      nextPageToken = response.NextPageToken;
    } while (nextPageToken);

    return out;
  }
}
