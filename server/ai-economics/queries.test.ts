import { describe, it, expect } from 'vitest';
import { summarizeModels, type AiSpendRow } from './queries';

const row = (over: Partial<AiSpendRow> = {}): AiSpendRow => ({
  vendor: 'google',
  model: 'Gemini 2.5 Pro',
  family: 'Gemini Pro',
  direction: 'output',
  modality: 'text',
  tokens: null,
  isInference: true,
  provider: 'gcp',
  accountId: 'proj-1',
  serviceName: 'Vertex AI',
  cost: 0,
  day: '2026-09-01',
  ...over,
});

describe('cost per million tokens', () => {
  it('computes the real rate when every row reports tokens', () => {
    // Verified shape from the fact store: 461,280 output tokens at $1.153197 is
    // Gemini 2.5 Flash's published $2.50/1M.
    const [m] = summarizeModels([
      row({ model: 'Gemini 2.5 Flash', direction: 'output', tokens: 461_280, cost: 1.153197 }),
    ]);
    expect(m.costPerMillionTokens).toBeCloseTo(2.5, 2);
    expect(m.tokenCoverage).toBe(1);
  });

  it('does NOT divide full cost by partial tokens', () => {
    // The bug this test exists for. Half this model's spend reports tokens and
    // half does not. Dividing $20 by 7,263 tokens produced $2,753/1M for a
    // model that lists at ~$10/1M — precise, plausible, and wrong.
    const [m] = summarizeModels([
      row({ direction: 'output', tokens: 1_000_000, cost: 10 }),   // token-backed
      row({ direction: 'output', tokens: null, cost: 10 }),        // no token count
    ]);

    // $10 against 1M tokens, not $20 against 1M.
    expect(m.costPerMillionTokens).toBeCloseTo(10, 4);
    expect(m.cost).toBe(20);              // total spend is still the full amount
    expect(m.tokenCoverage).toBeCloseTo(0.5, 4);
  });

  it('reports coverage so a partial rate is never presented as complete', () => {
    const [m] = summarizeModels([
      row({ direction: 'input', tokens: 800_000, cost: 1 }),
      row({ direction: 'output', tokens: null, cost: 9 }),
    ]);
    expect(m.tokenCoverage).toBeCloseTo(0.1, 4);
  });

  it('returns null rather than a rate when no row reports tokens', () => {
    // All of Bedrock. An infinite or zero-denominator figure would be rendered
    // to a user as though it meant something.
    const [m] = summarizeModels([
      row({ vendor: 'anthropic', model: 'Claude Opus 4.8', provider: 'aws', tokens: null, cost: 14735.35 }),
    ]);
    expect(m.totalTokens).toBeNull();
    expect(m.costPerMillionTokens).toBeNull();
    expect(m.tokenCoverage).toBeNull();
    expect(m.cost).toBeCloseTo(14735.35, 2);
  });
});

describe('token direction accounting', () => {
  it('keeps input, output and cache separate', () => {
    // Cache writes are priced very differently from ordinary input; folding
    // them together distorts both rates.
    const [m] = summarizeModels([
      row({ direction: 'input', tokens: 1_000_000, cost: 0.3 }),
      row({ direction: 'output', tokens: 400_000, cost: 1.0 }),
      row({ direction: 'cache', tokens: 200_000, cost: 0.05 }),
    ]);
    expect(m.inputTokens).toBe(1_000_000);
    expect(m.outputTokens).toBe(400_000);
    expect(m.cacheTokens).toBe(200_000);
  });

  it('excludes cache from the total token count', () => {
    // Cached tokens are not new work; counting them inflates volume and
    // deflates the apparent rate.
    const [m] = summarizeModels([
      row({ direction: 'input', tokens: 1_000_000, cost: 0.3 }),
      row({ direction: 'output', tokens: 400_000, cost: 1.0 }),
      row({ direction: 'cache', tokens: 5_000_000, cost: 0.05 }),
    ]);
    expect(m.totalTokens).toBe(1_400_000);
  });

  it('prices output separately, which is the number that drives cost', () => {
    const [m] = summarizeModels([
      row({ direction: 'input', tokens: 1_000_000, cost: 0.30 }),
      row({ direction: 'output', tokens: 100_000, cost: 1.00 }),
    ]);
    expect(m.outputCostPerMillion).toBeCloseTo(10, 4);
  });

  it('distinguishes a direction with no data from one with zero tokens', () => {
    const [m] = summarizeModels([row({ direction: 'output', tokens: 400_000, cost: 1 })]);
    expect(m.inputTokens).toBeNull();     // not 0
    expect(m.outputTokens).toBe(400_000);
  });
});

describe('grouping', () => {
  it('groups by model and sorts by spend', () => {
    const models = summarizeModels([
      row({ model: 'Gemini 2.5 Flash', cost: 5 }),
      row({ model: 'Claude Opus 4.8', provider: 'aws', vendor: 'anthropic', cost: 100 }),
      row({ model: 'Gemini 2.5 Flash', cost: 5 }),
    ]);
    expect(models.map(m => m.model)).toEqual(['Claude Opus 4.8', 'Gemini 2.5 Flash']);
    expect(models[1].cost).toBe(10);
  });

  it('keeps the same model name on different providers apart', () => {
    // Claude on Bedrock and Claude on Vertex are different rates and different
    // contracts; merging them would average two unrelated prices.
    const models = summarizeModels([
      row({ model: 'Claude Sonnet 4.5', provider: 'aws', cost: 10 }),
      row({ model: 'Claude Sonnet 4.5', provider: 'gcp', cost: 5 }),
    ]);
    expect(models).toHaveLength(2);
  });

  it('computes share of total spend', () => {
    const models = summarizeModels([
      row({ model: 'A', cost: 75 }),
      row({ model: 'B', cost: 25 }),
    ]);
    expect(models[0].share).toBeCloseTo(75, 4);
    expect(models[1].share).toBeCloseTo(25, 4);
  });

  it('survives an empty window without dividing by zero', () => {
    expect(summarizeModels([])).toEqual([]);
  });

  it('does not produce NaN when a model has zero cost', () => {
    const [m] = summarizeModels([row({ model: 'Free tier', cost: 0, tokens: 1000 })]);
    expect(Number.isNaN(m.share)).toBe(false);
    expect(Number.isNaN(m.costPerMillionTokens ?? 0)).toBe(false);
  });
});
