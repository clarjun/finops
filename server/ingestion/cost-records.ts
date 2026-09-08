/**
 * fetchLiveCosts, served from the fact store.
 *
 * Deliberately returns the same CostRecord[] shape as
 * utils/live-cost-fetcher.fetchLiveCosts, so callers switch by changing one
 * import rather than by being rewritten. Everything downstream — the forecaster,
 * the FinOps report engine, the anomaly detector — keeps working unchanged.
 *
 * Falls back to the live path when the store holds nothing for the window, so a
 * tenant whose first ingestion has not run still sees data rather than a
 * confident zero.
 *
 * The saving is largest exactly where the old code was worst: the FinOps report
 * pulled six months of history from provider APIs on a cache miss, and the
 * forecast pulled ninety days on every request. Both are now single indexed
 * queries.
 */
import { and, eq, gte, lte, sql, inArray, type SQL } from "drizzle-orm";
import { db } from "../db";
import { costFacts, type CloudProvider } from "@shared/schema";
import { currentOrgId } from "../tenant-context";
import type { CostRecord } from "../utils/live-cost-fetcher";

export interface FetchCostRecordsResult {
  records: CostRecord[];
  source: 'facts' | 'live';
}

/**
 * Daily cost records for a window.
 *
 * Aggregated to one row per day/account/service/region rather than returned raw,
 * matching what the live fetcher produces — the callers all group by those keys
 * anyway, and returning every SKU line would multiply the row count for no gain.
 */
export async function fetchCostRecords(
  startDate: Date,
  endDate: Date,
  providers?: CloudProvider[],
): Promise<FetchCostRecordsResult> {
  const conditions: SQL[] = [
    eq(costFacts.organizationId, currentOrgId()),
    gte(costFacts.chargePeriodStart, startDate),
    lte(costFacts.chargePeriodStart, endDate),
    // Tax is not attributable to a service and would distort both the forecast
    // and per-service reporting.
    sql`${costFacts.chargeCategory} <> 'Tax'`,
  ];

  if (providers?.length) {
    conditions.push(inArray(costFacts.provider, providers));
  }

  const rows = await db.select({
    provider: costFacts.provider,
    accountId: costFacts.subAccountId,
    accountName: costFacts.subAccountName,
    date: sql<string>`to_char(${costFacts.chargePeriodStart}, 'YYYY-MM-DD')`,
    serviceName: costFacts.serviceName,
    region: costFacts.regionId,
    currency: costFacts.billingCurrency,
    // Effective cost: commitments amortized, credits applied. Forecasting on
    // billed cost would model reservation purchase spikes as recurring spend.
    cost: sql<string>`sum(coalesce(${costFacts.effectiveCost}, ${costFacts.billedCost}))`,
  })
    .from(costFacts)
    .where(and(...conditions))
    .groupBy(
      costFacts.provider, costFacts.subAccountId, costFacts.subAccountName,
      sql`4`, costFacts.serviceName, costFacts.regionId, costFacts.billingCurrency,
    );

  if (rows.length > 0) {
    return {
      source: 'facts',
      records: rows.map(r => ({
        provider: r.provider as CloudProvider,
        accountId: r.accountId,
        accountName: r.accountName ?? r.accountId,
        date: r.date,
        serviceName: r.serviceName,
        region: r.region ?? undefined,
        cost: Number(r.cost ?? 0),
        currency: r.currency,
      })),
    };
  }

  const { fetchLiveCosts } = await import("../utils/live-cost-fetcher");
  console.log('[CostRecords] No ingested data for this window; falling back to live provider APIs');
  return { source: 'live', records: await fetchLiveCosts(startDate, endDate, providers) };
}

/**
 * Collapse day/account/service/region records into one row per day + service.
 *
 * Callers need to merge two overlapping windows — typically the reported period
 * plus six months of history, where the history fully contains the period — so
 * the overlap has to be deduplicated. Doing that requires the FULL natural key.
 *
 * The report route deduplicated with `new Map(records.map(r => [\`${r.date}-${r.service}\`, r]))`,
 * which keyed on day and service only. Because these records are one row per
 * day/account/service/REGION, that kept a single region per service per day and
 * silently discarded the rest — every other region's cost vanished. A September
 * report showed $3,712 against an actual $5,503 in the fact store, and the loss
 * propagated into the cost drivers, trend, anomalies, department allocation and
 * AI-spend sections alike.
 *
 * Deduplicate on the natural key, then SUM into the day+service buckets the
 * sections actually consume.
 */
export function aggregateByDayAndService(
  windows: CostRecord[][],
): Array<{ date: string; service: string; cost: number }> {
  const deduped = new Map<string, CostRecord>();
  for (const records of windows) {
    for (const r of records) {
      deduped.set(
        `${r.date}|${r.provider}|${r.accountId}|${r.serviceName}|${r.region ?? ''}`,
        r,
      );
    }
  }

  const totals = new Map<string, { date: string; service: string; cost: number }>();
  for (const r of deduped.values()) {
    const key = `${r.date}|${r.serviceName}`;
    const existing = totals.get(key);
    if (existing) existing.cost += r.cost;
    else totals.set(key, { date: r.date, service: r.serviceName, cost: r.cost });
  }
  return Array.from(totals.values());
}
