/**
 * Turning metered token usage into money.
 *
 * Two rules decide whether this stays correct over years, and both are about
 * refusing to guess.
 *
 * ── 1. Price as of the period, never as of now ──────────────────────────────
 *
 * A model's price changes. If usage were priced with today's rate, last
 * quarter's cost per call would change every time a vendor adjusted a price —
 * silently, retroactively, after the number had been reported. The pricing
 * table is effective-dated and this resolver picks the row covering the usage
 * period, so a figure computed in March still reads the same in December.
 *
 * ── 2. Unpriced is not free ─────────────────────────────────────────────────
 *
 * When no pricing row covers a model and period, the result is marked unpriced
 * with a reason. It is NOT costed at zero. A new model appearing before its
 * price is catalogued would otherwise show millions of tokens at $0.00, which
 * reads as a bargain rather than as a gap.
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  inferenceCalls?: number;
}

export interface ModelPrice {
  id: number;
  providerKey: string;
  modelId: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number | null;
  cacheWritePerMillion: number | null;
  perCallCost: number | null;
  currency: string;
  effectiveFrom: string;         // YYYY-MM-DD
  effectiveTo: string | null;    // null = still current
  source: string;                // catalog | customer | contract
  /** Null for the global catalog, set for a tenant override. */
  organizationId: number | null;
}

export interface PricedUsage {
  inputCost: number;
  outputCost: number;
  cacheCost: number;
  callCost: number;
  totalCost: number;
  currency: string;
  pricingId: number | null;
  pricingSource: string | null;
  /** Set when no price applied. The usage is still recorded; the cost is not invented. */
  unpricedReason: string | null;
}

const PER_MILLION = 1_000_000;

/** Dates only, so a period and an effective date compare on the same terms. */
function day(value: Date | string): string {
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

function covers(price: ModelPrice, on: string): boolean {
  if (price.effectiveFrom > on) return false;
  // effective_to is INCLUSIVE: a price ending 2026-03-31 applies on the 31st.
  // Treating it as exclusive would leave a one-day hole on every price change,
  // and that day's usage would come back unpriced.
  if (price.effectiveTo !== null && price.effectiveTo < on) return false;
  return true;
}

/**
 * Picks the price to use for a model on a date.
 *
 * Tenant rows beat catalog rows: a customer with an EDP or a committed-use
 * discount must see their real rate, not list. Among rows of equal precedence
 * the latest effective_from wins, which makes a correction issued later
 * override an earlier one for the same period without deleting the history.
 */
export function resolvePrice(
  prices: ModelPrice[],
  providerKey: string,
  modelId: string,
  on: Date | string,
): ModelPrice | null {
  const date = day(on);

  const candidates = prices.filter(
    (p) =>
      p.providerKey === providerKey &&
      p.modelId.toLowerCase() === modelId.toLowerCase() &&
      covers(p, date),
  );

  if (candidates.length === 0) return null;

  return candidates.sort((a, b) => {
    // Tenant override first.
    const tenancy = Number(b.organizationId !== null) - Number(a.organizationId !== null);
    if (tenancy !== 0) return tenancy;
    // Then the most recently effective row.
    if (a.effectiveFrom !== b.effectiveFrom) return b.effectiveFrom.localeCompare(a.effectiveFrom);
    // Then the most recently created, so a correction supersedes.
    return b.id - a.id;
  })[0];
}

/**
 * Applies a price to usage.
 *
 * Cache reads and writes are costed at their own rates where the vendor
 * publishes them. Falling back to the input rate for a cache read would
 * overstate a caching workload by roughly ten times, since cache reads are
 * typically ~10% of input — so where no cache rate exists, cache tokens are
 * costed at the input rate only when the vendor genuinely bills them that way,
 * which is expressed by the caller setting cacheReadPerMillion explicitly.
 */
export function priceUsage(usage: TokenUsage, price: ModelPrice | null): PricedUsage {
  if (!price) {
    return {
      inputCost: 0,
      outputCost: 0,
      cacheCost: 0,
      callCost: 0,
      totalCost: 0,
      currency: 'USD',
      pricingId: null,
      pricingSource: null,
      unpricedReason: 'No pricing is configured for this model on this date.',
    };
  }

  const inputCost = (usage.inputTokens / PER_MILLION) * price.inputPerMillion;
  const outputCost = (usage.outputTokens / PER_MILLION) * price.outputPerMillion;

  // Only costed when a rate exists. A cache read priced at the input rate would
  // be an order of magnitude wrong; priced at zero it would be free. Neither is
  // acceptable, so an absent rate contributes nothing and is reported.
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const cacheCost =
    (price.cacheReadPerMillion !== null ? (cacheRead / PER_MILLION) * price.cacheReadPerMillion : 0) +
    (price.cacheWritePerMillion !== null ? (cacheWrite / PER_MILLION) * price.cacheWritePerMillion : 0);

  const callCost = price.perCallCost !== null ? (usage.inferenceCalls ?? 0) * price.perCallCost : 0;

  const missingCacheRate =
    (cacheRead > 0 && price.cacheReadPerMillion === null) ||
    (cacheWrite > 0 && price.cacheWritePerMillion === null);

  return {
    inputCost,
    outputCost,
    cacheCost,
    callCost,
    totalCost: inputCost + outputCost + cacheCost + callCost,
    currency: price.currency,
    pricingId: price.id,
    pricingSource: price.source,
    unpricedReason: missingCacheRate
      ? 'Cache tokens are present but this model has no cache rate configured, so they are excluded from the cost.'
      : null,
  };
}

/** Cost per inference call, or null when no calls were recorded. */
export function costPerCall(totalCost: number, calls: number): number | null {
  return calls > 0 ? totalCost / calls : null;
}

/**
 * Blended cost per million tokens.
 *
 * Input and output are deliberately NOT averaged into one headline rate
 * elsewhere — output is typically 3-5x input, so a blended figure moves with
 * the input/output ratio of the workload rather than with price. It is useful
 * for comparing a model against itself over time and misleading for comparing
 * two models, which is why the UI shows input and output separately as well.
 */
export function blendedPerMillion(totalCost: number, inputTokens: number, outputTokens: number): number | null {
  const total = inputTokens + outputTokens;
  return total > 0 ? (totalCost / total) * PER_MILLION : null;
}

/** Gaps a tenant should be told about, rather than discovering as a wrong total. */
export interface PricingGap {
  providerKey: string;
  modelId: string;
  periodStart: string;
  tokens: number;
  calls: number;
}

export function findPricingGaps(
  records: Array<{ providerKey: string; modelId: string; periodStart: string; inputTokens: number; outputTokens: number; inferenceCalls: number }>,
  prices: ModelPrice[],
): PricingGap[] {
  const gaps = new Map<string, PricingGap>();

  for (const r of records) {
    if (resolvePrice(prices, r.providerKey, r.modelId, r.periodStart)) continue;

    const key = `${r.providerKey}|${r.modelId}`;
    const existing = gaps.get(key);
    if (existing) {
      existing.tokens += r.inputTokens + r.outputTokens;
      existing.calls += r.inferenceCalls;
      // Keep the earliest period, which is where a customer should start
      // looking when they add the missing price.
      if (r.periodStart < existing.periodStart) existing.periodStart = r.periodStart;
    } else {
      gaps.set(key, {
        providerKey: r.providerKey,
        modelId: r.modelId,
        periodStart: r.periodStart,
        tokens: r.inputTokens + r.outputTokens,
        calls: r.inferenceCalls,
      });
    }
  }

  return Array.from(gaps.values()).sort((a, b) => b.tokens - a.tokens);
}
