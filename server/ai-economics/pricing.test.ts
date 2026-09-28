import { describe, it, expect } from 'vitest';
import {
  resolvePrice, priceUsage, costPerCall, blendedPerMillion, findPricingGaps,
  type ModelPrice,
} from './pricing';

const price = (over: Partial<ModelPrice> = {}): ModelPrice => ({
  id: 1,
  providerKey: 'bedrock',
  modelId: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
  inputPerMillion: 3,
  outputPerMillion: 15,
  cacheReadPerMillion: null,
  cacheWritePerMillion: null,
  perCallCost: null,
  currency: 'USD',
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  source: 'catalog',
  organizationId: null,
  ...over,
});

describe('resolving the price for a period', () => {
  it('prices usage with the rate in force THEN, not the rate now', () => {
    // The property the whole effective-dated table exists for. Without it,
    // last quarter's cost per call changes every time a vendor adjusts a
    // price — silently, after the number was reported.
    const old = price({ id: 1, inputPerMillion: 3, effectiveFrom: '2026-01-01', effectiveTo: '2026-05-31' });
    const current = price({ id: 2, inputPerMillion: 2, effectiveFrom: '2026-06-01' });

    expect(resolvePrice([old, current], 'bedrock', old.modelId, '2026-03-15')!.id).toBe(1);
    expect(resolvePrice([old, current], 'bedrock', old.modelId, '2026-09-15')!.id).toBe(2);
  });

  it('treats effective_to as inclusive', () => {
    // An exclusive end date leaves a one-day hole at every price change, and
    // that day's usage silently comes back unpriced.
    const p = price({ effectiveFrom: '2026-01-01', effectiveTo: '2026-03-31' });
    expect(resolvePrice([p], 'bedrock', p.modelId, '2026-03-31')).not.toBeNull();
    expect(resolvePrice([p], 'bedrock', p.modelId, '2026-04-01')).toBeNull();
  });

  it('prefers a tenant rate over the published catalog', () => {
    // A customer with an EDP or committed-use discount must see their real
    // rate, not list price.
    const catalog = price({ id: 1, inputPerMillion: 3, organizationId: null });
    const negotiated = price({ id: 2, inputPerMillion: 1.8, organizationId: 7, source: 'contract' });
    const chosen = resolvePrice([catalog, negotiated], 'bedrock', catalog.modelId, '2026-06-01')!;
    expect(chosen.id).toBe(2);
    expect(chosen.source).toBe('contract');
  });

  it('prefers the most recent effective_from among equals', () => {
    const older = price({ id: 1, effectiveFrom: '2026-01-01' });
    const newer = price({ id: 2, effectiveFrom: '2026-06-01' });
    expect(resolvePrice([older, newer], 'bedrock', older.modelId, '2026-09-01')!.id).toBe(2);
  });

  it('lets a later correction supersede one issued the same day', () => {
    const first = price({ id: 5, effectiveFrom: '2026-06-01', inputPerMillion: 3 });
    const correction = price({ id: 9, effectiveFrom: '2026-06-01', inputPerMillion: 2.75 });
    expect(resolvePrice([first, correction], 'bedrock', first.modelId, '2026-06-10')!.id).toBe(9);
  });

  it('matches model ids case-insensitively', () => {
    // Providers are inconsistent about case between usage APIs and docs.
    const p = price({ modelId: 'GPT-4o-Mini', providerKey: 'openai' });
    expect(resolvePrice([p], 'openai', 'gpt-4o-mini', '2026-06-01')).not.toBeNull();
  });

  it('does not cross providers', () => {
    // The same model id exists on Bedrock and Vertex at different rates.
    const p = price({ providerKey: 'bedrock' });
    expect(resolvePrice([p], 'vertex', p.modelId, '2026-06-01')).toBeNull();
  });

  it('returns null before a price takes effect', () => {
    expect(resolvePrice([price({ effectiveFrom: '2026-06-01' })], 'bedrock', price().modelId, '2026-01-01')).toBeNull();
  });
});

describe('pricing usage', () => {
  it('computes input and output separately at per-million rates', () => {
    const r = priceUsage({ inputTokens: 1_000_000, outputTokens: 200_000 }, price());
    expect(r.inputCost).toBeCloseTo(3, 6);          // 1M at $3/1M
    expect(r.outputCost).toBeCloseTo(3, 6);         // 200K at $15/1M
    expect(r.totalCost).toBeCloseTo(6, 6);
  });

  it('marks usage unpriced rather than free when no rate applies', () => {
    // A new model appearing before its price is catalogued would otherwise show
    // millions of tokens at $0.00, which reads as a bargain rather than a gap.
    const r = priceUsage({ inputTokens: 5_000_000, outputTokens: 1_000_000 }, null);
    expect(r.totalCost).toBe(0);
    expect(r.pricingId).toBeNull();
    expect(r.unpricedReason).toMatch(/No pricing is configured/);
  });

  it('costs cache tokens at their own rate', () => {
    const r = priceUsage(
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 },
      price({ cacheReadPerMillion: 0.3, cacheWritePerMillion: 3.75 }),
    );
    expect(r.cacheCost).toBeCloseTo(4.05, 6);
  });

  it('never falls back to the input rate for cache reads', () => {
    // Cache reads are ~10% of input. Costing them at the input rate would
    // overstate a caching workload by roughly ten times.
    const r = priceUsage(
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 },
      price({ cacheReadPerMillion: null }),
    );
    expect(r.cacheCost).toBe(0);
    // And the omission is reported rather than silent.
    expect(r.unpricedReason).toMatch(/cache rate/i);
  });

  it('does not warn about cache rates when there are no cache tokens', () => {
    const r = priceUsage({ inputTokens: 1000, outputTokens: 100 }, price({ cacheReadPerMillion: null }));
    expect(r.unpricedReason).toBeNull();
  });

  it('adds a per-call charge where the provider levies one', () => {
    const r = priceUsage(
      { inputTokens: 0, outputTokens: 0, inferenceCalls: 10_000 },
      price({ perCallCost: 0.0001 }),
    );
    expect(r.callCost).toBeCloseTo(1, 6);
  });

  it('carries the pricing id and source through, so a figure can be explained', () => {
    const r = priceUsage({ inputTokens: 1000, outputTokens: 100 }, price({ id: 42, source: 'contract' }));
    expect(r.pricingId).toBe(42);
    expect(r.pricingSource).toBe('contract');
  });

  it('handles zero usage without producing NaN', () => {
    const r = priceUsage({ inputTokens: 0, outputTokens: 0 }, price());
    expect(r.totalCost).toBe(0);
    expect(Number.isNaN(r.totalCost)).toBe(false);
  });
});

describe('derived rates', () => {
  it('computes cost per call', () => {
    expect(costPerCall(25, 5000)).toBeCloseTo(0.005, 8);
  });

  it('returns null rather than dividing by zero calls', () => {
    expect(costPerCall(25, 0)).toBeNull();
  });

  it('blends input and output into one rate', () => {
    // $6 over 1.2M tokens.
    expect(blendedPerMillion(6, 1_000_000, 200_000)).toBeCloseTo(5, 6);
  });

  it('returns null for a blended rate with no tokens', () => {
    expect(blendedPerMillion(6, 0, 0)).toBeNull();
  });
});

describe('pricing gaps', () => {
  const usage = (modelId: string, over: Record<string, unknown> = {}) => ({
    providerKey: 'bedrock', modelId, periodStart: '2026-06-10',
    inputTokens: 1000, outputTokens: 500, inferenceCalls: 10, ...over,
  });

  it('reports models with no price, worst first by volume', () => {
    const prices = [price({ modelId: 'known-model' })];
    const gaps = findPricingGaps(
      [
        usage('known-model'),
        usage('new-model', { inputTokens: 5_000_000, outputTokens: 1_000_000 }),
        usage('other-new', { inputTokens: 1000, outputTokens: 100 }),
      ],
      prices,
    );

    expect(gaps.map(g => g.modelId)).toEqual(['new-model', 'other-new']);
    expect(gaps[0].tokens).toBe(6_000_000);
  });

  it('aggregates a model across periods and keeps the earliest', () => {
    const gaps = findPricingGaps(
      [
        usage('new-model', { periodStart: '2026-06-10' }),
        usage('new-model', { periodStart: '2026-06-01' }),
      ],
      [],
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0].periodStart).toBe('2026-06-01');
    expect(gaps[0].calls).toBe(20);
  });

  it('reports nothing when everything is priced', () => {
    expect(findPricingGaps([usage('known-model')], [price({ modelId: 'known-model' })])).toEqual([]);
  });

  it('treats a period outside a price window as a gap', () => {
    // A model priced from June onwards has a genuine gap in May.
    const prices = [price({ modelId: 'm', effectiveFrom: '2026-06-01' })];
    expect(findPricingGaps([usage('m', { periodStart: '2026-05-15' })], prices)).toHaveLength(1);
  });
});
