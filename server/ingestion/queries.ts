/**
 * Read layer over cost_facts.
 *
 * Aggregation happens in Postgres, not in Node. The previous approach pulled
 * every record into memory and reduced it with JavaScript objects; at a few
 * million rows a month that is both slow and a memory risk, and it made
 * "group by tag" impossible without another full scan.
 *
 * Every query takes an explicit `costBasis`. Asking callers to choose between
 * billed and effective cost — rather than defaulting silently — is the point of
 * having both: a showback report and an invoice reconciliation want different
 * numbers, and a tool that will not say which one it used cannot be trusted by
 * finance.
 */
import { and, eq, gte, lte, sql, inArray, type SQL } from "drizzle-orm";
import { db } from "../db";
import { costFacts, type CloudProvider } from "@shared/schema";
import { currentOrgId } from "../tenant-context";

/**
 * billed     — what the invoice says. Use for reconciliation.
 * effective  — commitments amortized, credits applied. Use for showback,
 *              chargeback and optimization. Falls back to billed where a
 *              connector could not determine it, so totals stay complete.
 */
export type CostBasis = 'billed' | 'effective';

export interface CostQueryFilters {
  start: Date;
  end: Date;
  providers?: CloudProvider[];
  subAccountIds?: string[];
  serviceNames?: string[];
  /** Excluded by default; set true to reconcile against an invoice. */
  includeTax?: boolean;
  costBasis?: CostBasis;
}

function basisExpr(basis: CostBasis = 'effective'): SQL<string> {
  return basis === 'billed'
    ? sql<string>`sum(${costFacts.billedCost})`
    // COALESCE, not a plain sum: a connector that cannot compute effective cost
    // leaves NULL, and summing NULLs would silently drop that provider's spend.
    : sql<string>`sum(coalesce(${costFacts.effectiveCost}, ${costFacts.billedCost}))`;
}

function baseConditions(f: CostQueryFilters): SQL[] {
  const conditions: SQL[] = [
    eq(costFacts.organizationId, currentOrgId()),
    gte(costFacts.chargePeriodStart, f.start),
    lte(costFacts.chargePeriodStart, f.end),
  ];

  if (f.providers?.length) conditions.push(inArray(costFacts.provider, f.providers));
  if (f.subAccountIds?.length) conditions.push(inArray(costFacts.subAccountId, f.subAccountIds));
  if (f.serviceNames?.length) conditions.push(inArray(costFacts.serviceName, f.serviceNames));

  // Tax is a real charge but it is not attributable to a team or a resource, so
  // it distorts every optimization view. Excluded unless asked for.
  if (!f.includeTax) conditions.push(sql`${costFacts.chargeCategory} <> 'Tax'`);

  return conditions;
}

export async function getTotalCost(f: CostQueryFilters): Promise<number> {
  const [row] = await db
    .select({ total: basisExpr(f.costBasis) })
    .from(costFacts)
    .where(and(...baseConditions(f)));
  return Number(row?.total ?? 0);
}

export async function getDailyTrend(f: CostQueryFilters): Promise<Array<{ date: string; cost: number }>> {
  const rows = await db
    .select({
      date: sql<string>`to_char(${costFacts.chargePeriodStart}, 'YYYY-MM-DD')`,
      cost: basisExpr(f.costBasis),
    })
    .from(costFacts)
    .where(and(...baseConditions(f)))
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  return rows.map(r => ({ date: r.date, cost: Number(r.cost ?? 0) }));
}

export async function getServiceBreakdown(f: CostQueryFilters, limit = 50) {
  const rows = await db
    .select({
      serviceName: costFacts.serviceName,
      serviceCategory: costFacts.serviceCategory,
      provider: costFacts.provider,
      cost: basisExpr(f.costBasis),
    })
    .from(costFacts)
    .where(and(...baseConditions(f)))
    .groupBy(costFacts.serviceName, costFacts.serviceCategory, costFacts.provider)
    .orderBy(sql`4 desc nulls last`)
    .limit(limit);

  return rows.map(r => ({ ...r, cost: Number(r.cost ?? 0) }));
}

/** Cross-cloud comparison — the reason services are categorized at ingestion. */
export async function getCategoryBreakdown(f: CostQueryFilters) {
  const rows = await db
    .select({
      serviceCategory: costFacts.serviceCategory,
      provider: costFacts.provider,
      cost: basisExpr(f.costBasis),
    })
    .from(costFacts)
    .where(and(...baseConditions(f)))
    .groupBy(costFacts.serviceCategory, costFacts.provider)
    .orderBy(sql`3 desc nulls last`);

  return rows.map(r => ({ ...r, cost: Number(r.cost ?? 0) }));
}

export async function getProviderBreakdown(f: CostQueryFilters) {
  const rows = await db
    .select({ provider: costFacts.provider, cost: basisExpr(f.costBasis) })
    .from(costFacts)
    .where(and(...baseConditions(f)))
    .groupBy(costFacts.provider)
    .orderBy(sql`2 desc nulls last`);

  return rows.map(r => ({ ...r, cost: Number(r.cost ?? 0) }));
}

export async function getSubAccountBreakdown(f: CostQueryFilters) {
  const rows = await db
    .select({
      subAccountId: costFacts.subAccountId,
      subAccountName: costFacts.subAccountName,
      provider: costFacts.provider,
      cost: basisExpr(f.costBasis),
    })
    .from(costFacts)
    .where(and(...baseConditions(f)))
    .groupBy(costFacts.subAccountId, costFacts.subAccountName, costFacts.provider)
    .orderBy(sql`4 desc nulls last`);

  return rows.map(r => ({ ...r, cost: Number(r.cost ?? 0) }));
}

/**
 * Spend grouped by one tag key, with everything untagged collected into a single
 * bucket. That bucket is the number that matters: it is the share of the bill
 * nobody can be charged for.
 */
export async function getCostByTag(f: CostQueryFilters, tagKey: string) {
  const rows = await db
    .select({
      tagValue: sql<string | null>`${costFacts.tags} ->> ${tagKey}`,
      cost: basisExpr(f.costBasis),
    })
    .from(costFacts)
    .where(and(...baseConditions(f)))
    .groupBy(sql`1`)
    .orderBy(sql`2 desc nulls last`);

  return rows.map(r => ({
    tagValue: r.tagValue ?? '(untagged)',
    allocated: r.tagValue !== null,
    cost: Number(r.cost ?? 0),
  }));
}

/**
 * Whether the fact store has anything for this window. Read paths use it to fall
 * back to a live provider call before the first ingestion has run, so a new
 * tenant sees data immediately instead of an empty dashboard.
 */
export async function hasFactsFor(start: Date, end: Date): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(costFacts)
    .where(and(
      eq(costFacts.organizationId, currentOrgId()),
      gte(costFacts.chargePeriodStart, start),
      lte(costFacts.chargePeriodStart, end),
    ));
  return (row?.n ?? 0) > 0;
}

/** Freshness, for a "data as of ..." indicator. */
export async function getCoverage() {
  const [row] = await db
    .select({
      earliest: sql<string | null>`to_char(min(${costFacts.chargePeriodStart}), 'YYYY-MM-DD')`,
      latest: sql<string | null>`to_char(max(${costFacts.chargePeriodStart}), 'YYYY-MM-DD')`,
      rows: sql<number>`count(*)::int`,
      lastUpdated: sql<string | null>`to_char(max(${costFacts.updatedAt}), 'YYYY-MM-DD"T"HH24:MI:SS')`,
    })
    .from(costFacts)
    .where(eq(costFacts.organizationId, currentOrgId()));

  return row ?? { earliest: null, latest: null, rows: 0, lastUpdated: null };
}
