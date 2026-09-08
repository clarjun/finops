/**
 * AWS usage-type cost drill-down.
 *
 * Answers a different question from the cost adapters — "how does this one
 * service's spend split by usage type and linked account" — so it is not routed
 * through the adapter runtime, which is built for paginated day/service/region
 * cost rows.
 *
 * It does share the operational concerns, and previously shared none of them.
 * Three defects, all fixed here:
 *
 *   1. No pagination. USAGE_TYPE x LINKED_ACCOUNT can exceed Cost Explorer's
 *      1000-group page on any account of size, and the extra groups were
 *      silently dropped — the same class of bug that hid 29% of a month's Azure
 *      spend.
 *
 *   2. No retry. Cost Explorer throttling produced an empty array, which the
 *      analysis engine read as "this service has no usage types" rather than
 *      "the call failed".
 *
 *   3. It built its own CostExplorerClient from raw accessKeyId/secretAccessKey.
 *      That bypasses the credential factory, so it has no read/write tier
 *      separation — and it would break outright once a customer moves to
 *      cross-account roles, because there are no static keys to read.
 */
import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import { awsReadClient } from "../aws/client-factory";
import { runPaginatedQuery, ProviderQueryError } from "../cloud/query-runner";

export interface UsageTypeCost {
  usageType: string;
  linkedAccount: string;
  cost: number;
}

export async function getCostByUsageType(
  serviceName: string,
  startDate: string,
  endDate: string
): Promise<UsageTypeCost[]> {
  try {
    // Read-only tier, via the factory: works with cross-account roles and with
    // legacy keys, and cannot hold credentials able to change anything.
    const client = await awsReadClient(CostExplorerClient);

    const groups = await runPaginatedQuery<{ keys: string[]; amount: string }>(
      'aws',
      `usage-type:${serviceName}`,
      async (cursor) => {
        const response = await client.send(new GetCostAndUsageCommand({
          TimePeriod: { Start: startDate, End: endDate },
          Granularity: "MONTHLY",
          Metrics: ["UnblendedCost"],
          Filter: { Dimensions: { Key: "SERVICE", Values: [serviceName] } },
          GroupBy: [
            { Type: "DIMENSION", Key: "USAGE_TYPE" },
            { Type: "DIMENSION", Key: "LINKED_ACCOUNT" },
          ],
          ...(cursor ? { NextPageToken: cursor } : {}),
        }));

        const items = (response.ResultsByTime ?? []).flatMap((time) =>
          (time.Groups ?? []).map((g) => ({
            keys: g.Keys ?? [],
            amount: g.Metrics?.UnblendedCost?.Amount ?? '0',
          })),
        );

        return { items, nextCursor: response.NextPageToken };
      },
    );

    const results: UsageTypeCost[] = [];
    for (const g of groups) {
      const [usageType, linkedAccount] = g.keys;
      const cost = parseFloat(g.amount);

      // Non-zero rather than positive: a negative amount is a credit or refund
      // against this usage type, and dropping it overstates the service's cost.
      if (usageType && Number.isFinite(cost) && cost !== 0) {
        results.push({ usageType, linkedAccount: linkedAccount || "Unknown", cost });
      }
    }

    console.log(`[Cost Explorer] ${serviceName}: ${results.length} usage types`);
    return results;
  } catch (error: any) {
    // Still returns [] so one failed drill-down cannot break a whole analysis
    // run — but the classification is logged, so "throttled" is distinguishable
    // from "this service genuinely has no usage types".
    if (error instanceof ProviderQueryError) {
      console.error(`[Cost Explorer] ${serviceName}: ${error.message} (${error.classification.kind})`);
    } else {
      console.error(`[Cost Explorer] ${serviceName}:`, error?.message ?? error);
    }
    return [];
  }
}
