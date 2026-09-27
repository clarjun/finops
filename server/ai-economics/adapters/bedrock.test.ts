import { describe, it, expect } from 'vitest';
import { normalizeBedrockModelId, bedrockDisplayName, floorToHour, ceilToHour } from './bedrock';

describe('Bedrock model ids', () => {
  it('strips the cross-region inference profile prefix', () => {
    // The same model reached through an inference profile must not appear as a
    // second, separately-priced model — it would split one model's spend in
    // two and make both cost-per-token figures wrong.
    expect(normalizeBedrockModelId('us.anthropic.claude-opus-4-1-20250805-v1:0'))
      .toBe('anthropic.claude-opus-4-1-20250805-v1:0');
    expect(normalizeBedrockModelId('eu.anthropic.claude-sonnet-4-5-20250929-v1:0'))
      .toBe('anthropic.claude-sonnet-4-5-20250929-v1:0');
    expect(normalizeBedrockModelId('apac.amazon.nova-pro-v1:0'))
      .toBe('amazon.nova-pro-v1:0');
  });

  it('strips the global inference-profile prefix', () => {
    // Missed initially, and it split one model's usage in two: the global
    // profile id and the direct id looked like different models, so each
    // needed its own price and neither total was right.
    expect(normalizeBedrockModelId('global.anthropic.claude-haiku-4-5-20251001-v1:0'))
      .toBe('anthropic.claude-haiku-4-5-20251001-v1:0');
  });

  it('collapses routing profiles — for DISPLAY only', () => {
    // Used for grouping in a chart legend, never for pricing or row identity.
    // LiteLLM prices us.anthropic.claude-sonnet-4-6 at $3.30/1M against
    // $3.00/1M for the base model, so collapsing them before pricing would
    // understate every cross-region call by 10%.
    const ids = [
      'anthropic.claude-haiku-4-5-20251001-v1:0',
      'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    ].map(normalizeBedrockModelId);
    expect(new Set(ids).size).toBe(1);
  });

  it('leaves an unprefixed id alone', () => {
    expect(normalizeBedrockModelId('anthropic.claude-3-haiku-20240307-v1:0'))
      .toBe('anthropic.claude-3-haiku-20240307-v1:0');
  });

  it('does not mistake a vendor name for a region prefix', () => {
    // "amazon." and "meta." are vendors, not geographies.
    expect(normalizeBedrockModelId('amazon.titan-text-express-v1')).toBe('amazon.titan-text-express-v1');
    expect(normalizeBedrockModelId('meta.llama3-70b-instruct-v1:0')).toBe('meta.llama3-70b-instruct-v1:0');
  });
});

describe('display names', () => {
  it('drops the vendor, build date and version suffix', () => {
    // Two builds of one model would otherwise render as two series in a chart.
    expect(bedrockDisplayName('anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('Claude Sonnet 4 5');
    expect(bedrockDisplayName('anthropic.claude-3-haiku-20240307-v1:0')).toBe('Claude 3 Haiku');
  });

  it('handles the region-prefixed form identically', () => {
    expect(bedrockDisplayName('us.anthropic.claude-opus-4-1-20250805-v1:0'))
      .toBe(bedrockDisplayName('anthropic.claude-opus-4-1-20250805-v1:0'));
  });

  it('works for non-Anthropic models', () => {
    expect(bedrockDisplayName('amazon.nova-pro-v1:0')).toBe('Nova Pro');
    expect(bedrockDisplayName('meta.llama3-70b-instruct-v1:0')).toBe('Llama3 70b Instruct');
  });

  it('does not throw on an unexpected shape', () => {
    // Model ids come from whatever AWS returns, not from us.
    expect(() => bedrockDisplayName('')).not.toThrow();
    expect(() => bedrockDisplayName('weird')).not.toThrow();
  });
});

describe('hour alignment', () => {
  it('floors a timestamp to the top of its UTC hour', () => {
    expect(floorToHour(new Date('2026-09-16T14:45:32.123Z')).toISOString())
      .toBe('2026-09-16T14:00:00.000Z');
  });

  it('leaves an already-aligned timestamp alone', () => {
    const on = new Date('2026-09-16T14:00:00.000Z');
    expect(floorToHour(on).getTime()).toBe(on.getTime());
    expect(ceilToHour(on).getTime()).toBe(on.getTime());
  });

  it('ceils a partial hour upwards', () => {
    expect(ceilToHour(new Date('2026-09-16T14:00:00.001Z')).toISOString())
      .toBe('2026-09-16T15:00:00.000Z');
  });

  it('produces the SAME bucket whatever minute the query ran at', () => {
    // The bug this exists for. CloudWatch aligns data points to the query start
    // time, so "now - 14 days" returned 17:45, then 17:50, then 17:55 on
    // successive runs. period_start is part of the row identity, so each run
    // inserted a fresh copy instead of updating — three collections produced
    // exactly three times the usage.
    const sameHourDifferentMinutes = ['14:05', '14:31', '14:59']
      .map(hm => floorToHour(new Date(`2026-09-16T${hm}:00.000Z`)).toISOString());
    expect(new Set(sameHourDifferentMinutes).size).toBe(1);
  });

  it('does not mutate its argument', () => {
    const original = new Date('2026-09-16T14:45:00.000Z');
    floorToHour(original);
    expect(original.toISOString()).toBe('2026-09-16T14:45:00.000Z');
  });
});
