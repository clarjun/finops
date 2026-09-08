/**
 * Keeps the report's headline cost equal to the dashboard's.
 *
 * The FinOps report is a heavy composite — six months of history, Cost Explorer
 * resource lookups, and model-generated insight — so it is cached to disk and to
 * the database for up to an hour. That caching is justified for those parts.
 *
 * The trouble is that the *cost headline* was cached alongside them. It comes
 * from cost_facts, which is one indexed query, so freezing it for an hour buys
 * nothing and guarantees the report and the dashboard disagree by however much
 * changed in that window — including immediately after any ingestion, backfill
 * or correction. A user comparing the two screens sees two different numbers for
 * the same month and has no way to tell which is right.
 *
 * So the expensive parts stay cached and the cheap authoritative numbers are
 * recomputed on every request, through the SAME query layer the dashboard uses.
 * One source, one freshness policy, for the figure people actually compare.
 *
 * `costAsOf` is attached so the answer is inspectable rather than asserted.
 */
import type { CloudProvider } from '@shared/schema';
import { getTotalCost, getCoverage } from '../ingestion/queries';

export interface ReconciledTotals {
  /** Recomputed from cost_facts, matching the dashboard's default basis. */
  totalSpendMTD: number;
  /** When the underlying facts were last ingested, not when this ran. */
  costAsOf: string | null;
  /** The latest day the fact store actually holds. */
  dataThrough: string | null;
  source: 'cost_facts';
}

/**
 * The authoritative cost figure for a window.
 *
 * Deliberately uses `effective` cost and excludes tax — the same defaults as
 * `buildProcessedCostData`, which is what the dashboard renders. Choosing a
 * different basis here is precisely how two screens end up disagreeing while
 * both being internally consistent.
 */
export async function reconcileTotals(
  provider: CloudProvider,
  start: Date,
  end: Date,
): Promise<ReconciledTotals> {
  const filters = {
    start,
    end,
    providers: [provider],
    costBasis: 'effective' as const,
    // includeTax omitted: both paths exclude tax by default, and tax is not
    // attributable to a service or a team.
  };

  const [total, coverage] = await Promise.all([
    getTotalCost(filters),
    getCoverage().catch(() => null),
  ]);

  return {
    totalSpendMTD: total,
    costAsOf: coverage?.lastUpdated ?? null,
    dataThrough: coverage?.latest ?? null,
    source: 'cost_facts',
  };
}

/**
 * Overlays the recomputed totals onto a report that may have come from cache.
 *
 * Mutates a shallow copy rather than the cached object: the cache holds a shared
 * reference, and writing through it would corrupt the entry for every later
 * reader — including the background refresh that is comparing against it.
 *
 * Only the headline is replaced. Derived narrative (insights, recommendations)
 * is left as generated, because rewriting the number a sentence refers to
 * without rewriting the sentence produces a report that contradicts itself.
 * `costAsOf` makes the distinction visible.
 */
export function applyReconciledTotals<T extends Record<string, any>>(
  report: T,
  totals: ReconciledTotals,
): T {
  const out: any = { ...report };

  if (out.spendOverview && typeof out.spendOverview === 'object') {
    out.spendOverview = {
      ...out.spendOverview,
      totalSpendMTD: totals.totalSpendMTD,
    };
  }

  out.costReconciliation = {
    source: totals.source,
    costAsOf: totals.costAsOf,
    dataThrough: totals.dataThrough,
    note:
      'Headline cost is recomputed from the cost fact store on every request so it ' +
      'matches the dashboard. Insight narrative may reflect the cached snapshot.',
  };

  return out as T;
}
