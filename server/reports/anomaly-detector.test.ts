/**
 * Anomaly detection, and the self-contradicting card that motivated these tests.
 *
 * The report showed, for the same service on consecutive days:
 *
 *     Claude Opus 4.8 … 2026-09-07 … Spike of 1184%   $45.17 → $579.80
 *     Claude Opus 4.8 … 2026-09-06 … Spike of 1391%   $45.17 → $673.25
 *
 * If the 6th reached $673, how is the 7th starting from $45 again? It wasn't.
 * The real series was 09-05 $764.77, 09-06 $673.25, 09-07 $579.80, and $45.17
 * was the mean of Aug 9–29 — one baseline per service, repeated on every
 * finding, but rendered in a "$before → $after" shape that claimed to be a
 * day-over-day change.
 *
 * These tests pin the four fixes: the baseline is named and dated as a baseline,
 * the real prior day travels alongside it, consecutive anomalous days collapse
 * into one event, and severity requires real money and not just a big
 * percentage off a near-zero base.
 */
import { describe, it, expect } from 'vitest';
import { detectAnomalies } from './anomaly-detector';

type Row = { date: string; service: string; cost: number };

/** Build a daily series for one service starting at `start`. */
function series(service: string, start: string, costs: number[]): Row[] {
  const d0 = new Date(start + 'T00:00:00Z');
  return costs.map((cost, i) => ({
    date: new Date(d0.getTime() + i * 86_400_000).toISOString().slice(0, 10),
    service,
    cost,
  }));
}

/**
 * A 30-day window whose first 21 days are the baseline, mirroring the real
 * 70/30 split so `baselinePeriod` lands on 2026-08-09..2026-08-29.
 *
 * The baseline varies +/-10% around `level` rather than being flat: real billing
 * data always has some variance, and a perfectly flat series exercises only the
 * standard-deviation floor.
 */
function flatThen(service: string, level: number, tail: number[]): Row[] {
  const pattern = [level * 0.9, level, level * 1.1];
  const baseline = Array.from({ length: 30 - tail.length }, (_, i) => pattern[i % 3]);
  return series(service, '2026-08-09', [...baseline, ...tail]);
}

describe('the baseline is a baseline, not the previous day', () => {
  const rows = flatThen('Bedrock', 45, [50, 700, 673, 580]);

  it('reports the baseline mean under a name that says so', () => {
    const [a] = detectAnomalies(rows, 30);
    expect(a.baselineCost).toBeCloseTo(45, 6);
    // The field the card used to print as "$45.17 →" is gone.
    expect('previousCost' in a).toBe(false);
  });

  it('states the window the baseline covers', () => {
    // Without this the reader cannot tell a 3-week average from yesterday.
    const [a] = detectAnomalies(rows, 30);
    expect(a.baselinePeriod).toBe('2026-08-09 to 2026-08-29');
    expect(a.baselineDays).toBe(21);
  });

  it('carries the genuine prior day separately', () => {
    // $50 is the actual day before the run began — the honest day-over-day
    // number, distinct from the $45 baseline.
    const [a] = detectAnomalies(rows, 30);
    expect(a.previousDayCost).toBeCloseTo(50, 6);
  });
});

describe('a sustained rise is one event, not one per day', () => {
  it('collapses consecutive anomalous days', () => {
    // The exact shape of the screenshot: four elevated days in a row became
    // four separate "critical spikes" for the same service.
    const found = detectAnomalies(flatThen('Bedrock', 45, [700, 673, 580, 600]), 30);
    const bedrock = found.filter(a => a.service === 'Bedrock');

    expect(bedrock).toHaveLength(1);
    expect(bedrock[0].sustainedDays).toBe(4);
    // The tail occupies the last four days of the 30-day window.
    expect(bedrock[0].date).toBe('2026-09-04');
    expect(bedrock[0].sustainedThrough).toBe('2026-09-07');
  });

  it('reports the peak of the run as the current cost', () => {
    const [a] = detectAnomalies(flatThen('Bedrock', 45, [700, 900, 580]), 30);
    expect(a.currentCost).toBeCloseTo(900, 6);
  });

  it('keeps genuinely separate spikes separate', () => {
    // One bad day, back to normal, then another bad day: two events.
    const found = detectAnomalies(flatThen('Bedrock', 45, [700, 45, 700]), 30);
    expect(found.filter(a => a.service === 'Bedrock')).toHaveLength(2);
  });

  it('leaves a single-day spike unmarked as sustained', () => {
    const [a] = detectAnomalies(flatThen('Bedrock', 45, [45, 700, 45]), 30);
    expect(a.sustainedDays).toBe(1);
    expect(a.sustainedThrough).toBeUndefined();
  });
});

describe('severity needs money, not just a percentage', () => {
  it('does not call a $4 change critical', () => {
    // The EFS row: $0.02 → $4.30 scored 18121% and sat next to a $628 increase
    // wearing the same "critical" badge.
    const found = detectAnomalies(flatThen('EFS', 0.02, [4.30, 4.30]), 30);
    for (const a of found) expect(a.severity).not.toBe('critical');
  });

  it('drops changes too small to act on entirely', () => {
    // A 4-cent baseline going to 90 cents is 2000% and worth nobody's time.
    expect(detectAnomalies(flatThen('Tiny', 0.04, [0.9, 0.9]), 30)).toHaveLength(0);
  });

  it('still calls a large, expensive spike critical', () => {
    const [a] = detectAnomalies(flatThen('Bedrock', 45, [700, 700]), 30);
    expect(a.severity).toBe('critical');
  });

  it('ranks the biggest dollar impact first', () => {
    const found = detectAnomalies([
      ...flatThen('Bedrock', 45, [700, 700]),
      ...flatThen('IAM', 0.26, [29.6, 29.6]),
    ], 30);
    // IAM's 11336% beats Bedrock's 1456% on percentage alone; $655 beats $29 on
    // what a customer actually cares about.
    expect(found[0].service).toBe('Bedrock');
  });
});

describe('baseline hygiene', () => {
  it('excludes days before a service existed', () => {
    // Filling absent days with 0 dragged the baseline toward zero, so any newly
    // adopted service was guaranteed to look like a critical spike.
    const rows: Row[] = [
      // 'Old' spans the window so the window has 30 days of dates.
      ...series('Old', '2026-08-09', Array(30).fill(10)),
      // 'New' appears only for the last 10 days, at a steady $100.
      ...series('New', '2026-08-30', Array(10).fill(100)),
    ];
    const found = detectAnomalies(rows, 30);
    // Steady spend since launch is not an anomaly. Zero-padding would have made
    // its baseline ~$33 and flagged it.
    expect(found.filter(a => a.service === 'New')).toHaveLength(0);
  });

  it('refuses to judge a service with too little history', () => {
    const rows: Row[] = [
      ...series('Old', '2026-08-09', Array(30).fill(10)),
      ...series('Brandnew', '2026-09-05', [5, 900, 900]),
    ];
    // Three days is not a baseline. Reporting 900% off a two-day mean would be
    // a confident number with nothing behind it.
    expect(detectAnomalies(rows, 30).filter(a => a.service === 'Brandnew')).toHaveLength(0);
  });

  it('honours lookbackDays instead of using whatever it was handed', () => {
    // lookbackDays was logged and never applied, so the baseline silently
    // depended on how the caller had pre-filtered.
    const rows = series('Svc', '2026-06-01', [
      ...Array(60).fill(500),   // ancient history, far above the recent level
      ...Array(21).fill(10),    // the real baseline
      ...Array(9).fill(200),    // the spike
    ]);

    const [a] = detectAnomalies(rows, 30);
    // Baseline drawn from the last 30 days only, so $10 — not a blend with $500.
    expect(a.baselineCost).toBeCloseTo(10, 6);
  });

  it('returns nothing rather than guessing when history is short', () => {
    expect(detectAnomalies(series('Svc', '2026-09-01', [10, 20, 900]), 30)).toEqual([]);
  });
});

describe('drops', () => {
  it('detects a collapse as a drop, not a spike', () => {
    const [a] = detectAnomalies(flatThen('Svc', 500, [10, 10]), 30);
    expect(a.type).toBe('drop');
    expect(a.currentCost).toBeCloseTo(10, 6);
    expect(a.baselineCost).toBeCloseTo(500, 6);
  });
});

describe('the screenshot, reproduced', () => {
  // The genuine daily series for Claude Opus 4.8, 2026-08-09 to 2026-09-07,
  // straight out of cost_facts.
  const REAL = [
    0.00, 0.23, 3.85, 6.42, 3.85, 1.74, 2.54, 4.40, 4.24, 1.65,
    6.30, 13.04, 66.40, 21.78, 1.36, 101.37, 202.36, 188.89, 142.62, 175.44,
    137.07, 179.90, 359.58, 427.59, 569.68, 729.05, 764.77, 673.25, 579.80,
  ];

  it('yields one coherent finding where there were two contradictory ones', () => {
    const rows = series('Claude Opus 4.8 (Amazon Bedrock Edition)', '2026-08-09', REAL);
    const found = detectAnomalies(rows, 30);

    // Previously this service produced a separate "critical spike" for each
    // elevated day, each claiming to start from the same $45.
    expect(found).toHaveLength(1);

    const [a] = found;
    expect(a.sustainedDays).toBeGreaterThan(1);
    expect(a.currentCost).toBeCloseTo(764.77, 2);   // the peak of the run, 09-05

    // The baseline is the mean of the baseline slice — derived here rather than
    // hardcoded, so the test asserts the relationship and not a magic number.
    // Note the leading $0.00 day is excluded: 2026-08-09 predates the service's
    // first charge, and averaging it in is exactly the zero-padding that used to
    // drag baselines down.
    const existed = REAL.slice(REAL.findIndex((c) => c > 0));
    const baselineSlice = existed.slice(0, Math.floor(existed.length * 0.7));
    const expectedBaseline = baselineSlice.reduce((s, c) => s + c, 0) / baselineSlice.length;
    expect(a.baselineCost).toBeCloseTo(expectedBaseline, 6);
  });

  it('does not claim the day before the run was the baseline', () => {
    // The heart of the confusion. The card implied the cost had been ~$45 the
    // day before each spike; the real prior day was several times that.
    const rows = series('Claude Opus 4.8 (Amazon Bedrock Edition)', '2026-08-09', REAL);
    const [a] = detectAnomalies(rows, 30);

    expect(a.previousDayCost).toBeGreaterThan(a.baselineCost * 2);
    // And it is a real value from the series, not a computed average.
    expect(REAL).toContain(a.previousDayCost);
  });
});
