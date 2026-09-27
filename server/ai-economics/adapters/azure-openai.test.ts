/**
 * The parsing is the part that can be silently wrong, so it is the part tested.
 * Everything else in the adapter is a network call.
 */
import { describe, it, expect } from 'vitest';
import { parseMetrics, floorToHour, ceilToHour } from './azure-openai';

/** Builds a response in the shape @azure/arm-monitor returns. */
const response = (metrics: Array<{
  name: string;
  series: Array<{ model?: string; deployment?: string; data: Array<[string, number]> }>;
}>) => ({
  value: metrics.map((m) => ({
    name: { value: m.name },
    timeseries: m.series.map((s) => ({
      metadatavalues: [
        ...(s.model !== undefined ? [{ name: { value: 'modelname' }, value: s.model }] : []),
        ...(s.deployment !== undefined ? [{ name: { value: 'modeldeploymentname' }, value: s.deployment }] : []),
      ],
      data: s.data.map(([timeStamp, total]) => ({ timeStamp, total })),
    })),
  })),
});

describe('floorToHour / ceilToHour', () => {
  it('floors to the containing UTC hour', () => {
    expect(floorToHour(new Date('2026-09-22T13:47:31.500Z')).toISOString())
      .toBe('2026-09-22T13:00:00.000Z');
  });

  it('leaves an exact hour alone when ceiling', () => {
    const exact = new Date('2026-09-22T13:00:00.000Z');
    expect(ceilToHour(exact).toISOString()).toBe('2026-09-22T13:00:00.000Z');
  });

  it('ceils a partial hour up', () => {
    expect(ceilToHour(new Date('2026-09-22T13:00:00.001Z')).toISOString())
      .toBe('2026-09-22T14:00:00.000Z');
  });
});

describe('parseMetrics', () => {
  it('merges the three metrics for one model-hour onto one row', () => {
    // The core of the adapter: Azure returns prompt tokens, generated tokens
    // and request counts as three SEPARATE series. Failing to merge them would
    // produce three rows per hour, two of which have zero in every other column.
    const { points } = parseMetrics(response([
      { name: 'ProcessedPromptTokens', series: [{ model: 'gpt-4o', deployment: 'prod', data: [['2026-09-22T10:00:00Z', 1500]] }] },
      { name: 'GeneratedTokens',       series: [{ model: 'gpt-4o', deployment: 'prod', data: [['2026-09-22T10:00:00Z', 400]] }] },
      { name: 'AzureOpenAIRequests',   series: [{ model: 'gpt-4o', deployment: 'prod', data: [['2026-09-22T10:00:00Z', 12]] }] },
    ]));

    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({
      modelName: 'gpt-4o', deployment: 'prod',
      promptTokens: 1500, generatedTokens: 400, requests: 12,
    });
  });

  it('keeps different models apart', () => {
    // gpt-4o and gpt-4o-mini differ ~17x in price, so blending them would make
    // any cost derived from the result meaningless.
    const { points } = parseMetrics(response([
      { name: 'ProcessedPromptTokens', series: [
        { model: 'gpt-4o',      deployment: 'prod', data: [['2026-09-22T10:00:00Z', 1000]] },
        { model: 'gpt-4o-mini', deployment: 'prod', data: [['2026-09-22T10:00:00Z', 9000]] },
      ] },
    ]));

    expect(points).toHaveLength(2);
    expect(points.find((p) => p.modelName === 'gpt-4o')!.promptTokens).toBe(1000);
    expect(points.find((p) => p.modelName === 'gpt-4o-mini')!.promptTokens).toBe(9000);
  });

  it('keeps the same model apart across deployments', () => {
    const { points } = parseMetrics(response([
      { name: 'ProcessedPromptTokens', series: [
        { model: 'gpt-4o', deployment: 'prod', data: [['2026-09-22T10:00:00Z', 100]] },
        { model: 'gpt-4o', deployment: 'dev',  data: [['2026-09-22T10:00:00Z', 200]] },
      ] },
    ]));

    expect(points).toHaveLength(2);
    expect(new Set(points.map((p) => p.deployment))).toEqual(new Set(['prod', 'dev']));
  });

  it('floors off-hour timestamps so re-collecting cannot duplicate', () => {
    // The Bedrock bug, repeated here: two collections whose points land at
    // :00 and :05 would upsert as different rows and double the usage.
    const { points } = parseMetrics(response([
      { name: 'ProcessedPromptTokens', series: [{ model: 'gpt-4o', data: [
        ['2026-09-22T10:00:00Z', 100],
        ['2026-09-22T10:05:00Z', 50],
      ] }] },
    ]));

    expect(points).toHaveLength(1);
    expect(points[0].promptTokens).toBe(150);
    expect(new Date(points[0].hour).toISOString()).toBe('2026-09-22T10:00:00.000Z');
  });

  it('drops usage that carries no model, and says the split failed', () => {
    const { points, split } = parseMetrics(response([
      { name: 'ProcessedPromptTokens', series: [{ data: [['2026-09-22T10:00:00Z', 5000]] }] },
    ]));

    expect(points).toHaveLength(0);
    expect(split).toBe(false);   // drives the "could not be priced" warning
  });

  it('does not claim a failed split when there was simply no usage', () => {
    // An idle account must not produce a warning about unattributed tokens.
    expect(parseMetrics(response([])).split).toBe(true);
    expect(parseMetrics(response([
      { name: 'ProcessedPromptTokens', series: [{ model: 'gpt-4o', data: [['2026-09-22T10:00:00Z', 0]] }] },
    ])).split).toBe(true);
  });

  it('ignores metrics it does not understand', () => {
    const { points } = parseMetrics(response([
      { name: 'BlockedCalls', series: [{ model: 'gpt-4o', data: [['2026-09-22T10:00:00Z', 99]] }] },
    ]));
    expect(points).toHaveLength(0);
  });

  it('survives an empty or malformed response rather than throwing', () => {
    for (const bad of [undefined, null, {}, { value: null }, { value: [{}] }]) {
      expect(() => parseMetrics(bad)).not.toThrow();
      expect(parseMetrics(bad).points).toEqual([]);
    }
  });

  it('skips points with an unusable timestamp', () => {
    const { points } = parseMetrics(response([
      { name: 'ProcessedPromptTokens', series: [{ model: 'gpt-4o', data: [['not-a-date', 100]] }] },
    ]));
    expect(points).toHaveLength(0);
  });
});
