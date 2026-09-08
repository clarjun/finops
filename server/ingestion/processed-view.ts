/**
 * ProcessedCostData, built from cost_facts.
 *
 * The dashboard and every chart component already speak ProcessedCostData. This
 * rebuilds that exact shape from the fact store so the data source can be
 * swapped without touching a single chart — and swapped back by changing one
 * URL if anything looks wrong.
 *
 * Aggregation is three grouped queries rather than one scan reduced in Node.
 * The old path pulled every record into memory and built objects; that does not
 * survive a tenant with a few million rows a month.
 */
import { and, eq, gte, lte, sql, inArray, type SQL } from "drizzle-orm";
import { db } from "../db";
import { costFacts, type CloudProvider, type ProcessedCostData } from "@shared/schema";
import { currentOrgId } from "../tenant-context";
import type { CostBasis } from "./queries";

export interface ProcessedViewOptions {
  start: Date;
  end: Date;
  providers?: CloudProvider[];
  costBasis?: CostBasis;
  includeTax?: boolean;
  /** Per-day service detail is capped so a wide account does not produce a huge payload. */
  maxServicesPerDay?: number;
}

function costExpr(basis: CostBasis) {
  return basis === 'billed'
    ? sql<string>`sum(${costFacts.billedCost})`
    : sql<string>`sum(coalesce(${costFacts.effectiveCost}, ${costFacts.billedCost}))`;
}

function conditions(o: ProcessedViewOptions): SQL[] {
  const c: SQL[] = [
    eq(costFacts.organizationId, currentOrgId()),
    gte(costFacts.chargePeriodStart, o.start),
    lte(costFacts.chargePeriodStart, o.end),
  ];
  if (o.providers?.length) c.push(inArray(costFacts.provider, o.providers));
  if (!o.includeTax) c.push(sql`${costFacts.chargeCategory} <> 'Tax'`);
  return c;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function buildProcessedCostData(
  options: ProcessedViewOptions
): Promise<ProcessedCostData & { costBasis: CostBasis }> {
  const basis = options.costBasis ?? 'effective';
  const where = and(...conditions(options));
  const money = costExpr(basis);
  const maxPerDay = options.maxServicesPerDay ?? 12;

  const [perDayService, perService, perSubAccount] = await Promise.all([
    db.select({
      date: sql<string>`to_char(${costFacts.chargePeriodStart}, 'YYYY-MM-DD')`,
      serviceName: costFacts.serviceName,
      cost: money,
    }).from(costFacts).where(where).groupBy(sql`1`, costFacts.serviceName).orderBy(sql`1`),

    db.select({
      serviceName: costFacts.serviceName,
      cost: money,
    }).from(costFacts).where(where).groupBy(costFacts.serviceName).orderBy(sql`2 desc nulls last`),

    db.select({
      name: sql<string>`coalesce(${costFacts.subAccountName}, ${costFacts.subAccountId})`,
      cost: money,
    }).from(costFacts).where(where).groupBy(sql`1`).orderBy(sql`2 desc nulls last`),
  ]);

  // Daily totals and per-day service detail from a single grouped result.
  const byDate = new Map<string, { cost: number; services: Array<{ name: string; cost: number }> }>();
  for (const row of perDayService) {
    const cost = Number(row.cost ?? 0);
    let day = byDate.get(row.date);
    if (!day) {
      day = { cost: 0, services: [] };
      byDate.set(row.date, day);
    }
    day.cost += cost;
    day.services.push({ name: row.serviceName, cost });
  }

  const dailyTrends = Array.from(byDate.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, d]) => ({
      date,
      cost: round2(d.cost),
      // Top N by cost; the remainder is folded into "Other" so each day's
      // service map still sums to that day's total.
      services: (() => {
        const sorted = d.services.sort((a, b) => b.cost - a.cost);
        const head = sorted.slice(0, maxPerDay);
        const tail = sorted.slice(maxPerDay);
        const map: Record<string, number> = {};
        for (const s of head) map[s.name] = round2(s.cost);
        if (tail.length > 0) {
          map.Other = round2(tail.reduce((sum, s) => sum + s.cost, 0));
        }
        return map;
      })(),
    }));

  const services = perService.map(s => ({ name: s.serviceName, cost: Number(s.cost ?? 0) }));
  const totalCost = services.reduce((sum, s) => sum + s.cost, 0);

  const subscriptions = perSubAccount.map(s => ({ name: s.name, cost: Number(s.cost ?? 0) }));

  const peak = dailyTrends.reduce(
    (best, d) => (d.cost > best.cost ? { date: d.date, cost: d.cost } : best),
    { date: '', cost: 0 }
  );

  // Percentages are of the absolute total. Credits are negative rows, so using
  // the signed total would produce shares above 100% for a heavily credited
  // account.
  const absTotal = services.reduce((sum, s) => sum + Math.abs(s.cost), 0) || 1;

  return {
    costBasis: basis,
    totalCost: round2(totalCost),
    avgDailyCost: round2(totalCost / Math.max(1, dailyTrends.length)),
    topService: services.length > 0
      ? { name: services[0].name, cost: round2(services[0].cost) }
      : { name: 'N/A', cost: 0 },
    serviceCount: services.length,
    dailyTrends,
    serviceBreakdown: services.map(s => ({
      name: s.name,
      cost: round2(s.cost),
      percentage: round2((Math.abs(s.cost) / absTotal) * 100),
    })),
    subscriptionBreakdown: subscriptions.map(s => ({
      name: s.name,
      cost: round2(s.cost),
      percentage: round2((Math.abs(s.cost) / absTotal) * 100),
    })),
    subscriptions: subscriptions.map(s => s.name),
    services: services.map(s => s.name),
    peakDay: peak,
  };
}
