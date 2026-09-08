/**
 * Anomaly Detector — cost spikes, drops, and sustained shifts.
 *
 * The card used to render each finding as
 *
 *     $45.17 → $579.80
 *
 * which reads as "yesterday it was $45.17, today it is $579.80". It was not.
 * `previousCost` held the BASELINE MEAN, so two consecutive days appeared as
 * "$45.17 → $673.25" (Sep 6) and "$45.17 → $579.80" (Sep 7) — inviting exactly
 * the right question: if it spiked to $673 on the 6th, how is it back to $45 on
 * the 7th? It never was. The real series was
 *
 *     09-05 $764.77   09-06 $673.25   09-07 $579.80
 *
 * and $45.17 was the mean of Aug 9–29, shown identically against every flagged
 * day for that service. The arithmetic was right; the label was a lie. The field
 * is now `baselineCost`, the window it covers travels with it, and the actual
 * prior day is carried separately so day-over-day can be shown honestly.
 *
 * Three further defects fixed here:
 *
 *  - A SUSTAINED RISE WAS REPORTED AS SEPARATE SPIKES. The recent slice spans
 *    several days, so Sep 4, 5, 6 and 7 each became their own "critical spike"
 *    for the same service, crowding a top-10 list with one event. Consecutive
 *    anomalous days for a service are now one finding that says how long it has
 *    persisted — which is also the more actionable statement: this is not a
 *    blip, it is the new normal.
 *
 *  - SEVERITY IGNORED ABSOLUTE MONEY. EFS moving $0.02 → $4.30 scored 18121%
 *    and was labelled "critical" alongside a $628 increase. Percentages on
 *    near-zero baselines are noise; severity now needs both a large percentage
 *    and a material dollar change.
 *
 *  - THE BASELINE WAS PADDED WITH ZEROS from before a service existed, because
 *    the series filled every date in the window with `|| 0`. Any newly adopted
 *    service was therefore guaranteed to look like a critical spike. Leading
 *    days before a service's first charge are now excluded.
 *
 * `lookbackDays` was also dead — logged and never used, so the baseline silently
 * depended on how the caller had pre-filtered. It is now applied here.
 */

import { AnomalyAlert } from './types';

/** Fraction of the window used to establish normal behaviour. */
const BASELINE_FRACTION = 0.7;

/** Fewer baseline days than this and a mean/stddev is not worth trusting. */
const MIN_BASELINE_DAYS = 7;

/** Standard deviations from the baseline mean before a day counts as anomalous. */
const Z_SCORE_THRESHOLD = 2;

/** A change smaller than this is not worth a customer's attention. */
const MIN_MATERIAL_CHANGE_USD = 5;

export function detectAnomalies(
  dailyCosts: Array<{ date: string; service: string; cost: number }>,
  lookbackDays: number = 30,
): AnomalyAlert[] {
  // Actually applied, rather than logged and ignored.
  const dates = Array.from(new Set(dailyCosts.map(r => r.date))).sort();
  const windowDates = dates.slice(-lookbackDays);
  const inWindow = new Set(windowDates);

  console.log(`[Anomaly Detector] Analyzing ${windowDates.length} day(s) of ${dates.length} available`);

  if (windowDates.length < MIN_BASELINE_DAYS + 1) {
    console.log('[Anomaly Detector] Not enough history to establish a baseline');
    return [];
  }

  // date -> service -> cost
  const costByDateService = new Map<string, Map<string, number>>();
  for (const record of dailyCosts) {
    if (!inWindow.has(record.date)) continue;
    let row = costByDateService.get(record.date);
    if (!row) costByDateService.set(record.date, row = new Map());
    row.set(record.service, (row.get(record.service) ?? 0) + record.cost);
  }

  const services = Array.from(new Set(
    dailyCosts.filter(r => inWindow.has(r.date)).map(r => r.service),
  ));

  const anomalies: AnomalyAlert[] = [];

  for (const service of services) {
    const full = windowDates.map(date => ({
      date,
      cost: costByDateService.get(date)?.get(service) ?? 0,
    }));

    // Drop the stretch before this service's first charge. Averaging in days
    // when a service did not exist drags the baseline toward zero and makes
    // every new service a "critical spike".
    const firstCharge = full.findIndex(d => d.cost > 0);
    if (firstCharge === -1) continue;
    const series = full.slice(firstCharge);

    const baselineCount = Math.floor(series.length * BASELINE_FRACTION);
    if (baselineCount < MIN_BASELINE_DAYS) continue;

    const baselineDays = series.slice(0, baselineCount);
    const baselineCosts = baselineDays.map(d => d.cost);
    const baseline = baselineCosts.reduce((sum, c) => sum + c, 0) / baselineCosts.length;

    // A floor under the standard deviation, because a VERY steady service is the
    // case where a jump is most obviously anomalous — and was the one case the
    // detector stayed silent on. The z-score was computed as
    //
    //     stdDev > 0 ? deviation / stdDev : 0
    //
    // so a baseline with no variance produced a z-score of 0 and a service that
    // sat at $45 for three weeks could go to $700 unreported. The floor is 5% of
    // the baseline, so a flat series still needs a ~10% move to reach z > 2,
    // while any genuinely noisy series keeps its own larger deviation.
    const stdDev = Math.max(calculateStdDev(baselineCosts, baseline), baseline * 0.05);

    // A baseline this small makes any percentage meaningless.
    if (baseline < 0.01) continue;

    const baselinePeriod = `${baselineDays[0].date} to ${baselineDays[baselineDays.length - 1].date}`;

    // Flag the anomalous days first, then collapse runs of them.
    const flagged: Array<{ date: string; cost: number; previousDayCost: number }> = [];
    const recent = series.slice(baselineCount);

    for (let i = 0; i < recent.length; i++) {
      const day = recent[i];
      if (day.cost < 0.01) continue;

      const change = day.cost - baseline;
      if (Math.abs(change) < MIN_MATERIAL_CHANGE_USD) continue;

      if (Math.abs(change) / stdDev <= Z_SCORE_THRESHOLD) continue;

      // The genuine prior day, which is what "$X → $Y" implies and what the
      // baseline was being passed off as.
      const seriesIndex = baselineCount + i;
      const previousDayCost = seriesIndex > 0 ? series[seriesIndex - 1].cost : baseline;

      flagged.push({ date: day.date, cost: day.cost, previousDayCost });
    }

    // Consecutive anomalous days are one event, not one per day.
    for (const run of groupConsecutive(flagged, recent.map(d => d.date))) {
      const peak = run.reduce((worst, d) =>
        Math.abs(d.cost - baseline) > Math.abs(worst.cost - baseline) ? d : worst, run[0]);

      const changePercent = ((peak.cost - baseline) / baseline) * 100;
      const absoluteChange = Math.abs(peak.cost - baseline);

      anomalies.push({
        date: run[0].date,
        service,
        type: peak.cost > baseline ? 'spike' : 'drop',
        changePercent: Math.abs(changePercent),
        baselineCost: baseline,
        currentCost: peak.cost,
        previousDayCost: run[0].previousDayCost,
        baselinePeriod,
        baselineDays: baselineDays.length,
        sustainedDays: run.length,
        sustainedThrough: run.length > 1 ? run[run.length - 1].date : undefined,
        severity: severityFor(Math.abs(changePercent), absoluteChange),
      });
    }
  }

  // Largest dollar impact first. Sorting by severity alone let a $4 change on a
  // near-zero baseline outrank a $600 one, because both scored "critical".
  anomalies.sort((a, b) => {
    const rank = { critical: 0, high: 1, medium: 2, low: 3 };
    if (rank[a.severity] !== rank[b.severity]) return rank[a.severity] - rank[b.severity];
    const impact = (x: AnomalyAlert) => Math.abs(x.currentCost - x.baselineCost);
    if (impact(a) !== impact(b)) return impact(b) - impact(a);
    return b.date.localeCompare(a.date);
  });

  console.log(`[Anomaly Detector] ✓ Found ${anomalies.length} anomalies`);
  return anomalies.slice(0, 10);
}

/**
 * Severity from both the relative and the absolute change.
 *
 * Percentage alone made a $4.28 EFS increase "critical" at 18121%, level with a
 * $628 one. A finding has to be both proportionally large and worth real money.
 */
function severityFor(changePercent: number, absoluteChange: number): AnomalyAlert['severity'] {
  if (absoluteChange < 25) return changePercent > 300 ? 'medium' : 'low';
  if (absoluteChange < 100) return changePercent > 300 ? 'high' : 'medium';
  if (changePercent > 300) return 'critical';
  if (changePercent > 200) return 'high';
  if (changePercent > 100) return 'medium';
  return 'low';
}

/** Split flagged days into runs that are adjacent in the day sequence. */
function groupConsecutive<T extends { date: string }>(
  flagged: T[],
  orderedDates: string[],
): T[][] {
  if (flagged.length === 0) return [];

  const position = new Map(orderedDates.map((d, i) => [d, i]));
  const sorted = [...flagged].sort((a, b) =>
    (position.get(a.date) ?? 0) - (position.get(b.date) ?? 0));

  const runs: T[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = position.get(sorted[i - 1].date) ?? 0;
    const curr = position.get(sorted[i].date) ?? 0;
    if (curr === prev + 1) runs[runs.length - 1].push(sorted[i]);
    else runs.push([sorted[i]]);
  }
  return runs;
}

function calculateStdDev(values: number[], mean: number): number {
  if (values.length === 0) return 0;
  const squaredDiffs = values.map(value => (value - mean) ** 2);
  return Math.sqrt(squaredDiffs.reduce((sum, val) => sum + val, 0) / values.length);
}
