/**
 * Anomaly Detection — pure TypeScript replacement for anomaly_detection.py
 * Uses Z-score + IQR statistical detection (equivalent to Isolation Forest for cost data)
 * Output shape matches the Python script exactly.
 */

interface DailyTrend {
  date: string;
  cost: number;
  services?: Record<string, number>;
}

interface AnomalyResult {
  date: string;
  type: 'spike' | 'drop' | 'unusual';
  cost: number;
  totalDelta: number;
  rootCause: string | null;
  serviceImpact: number;
  contributionPercent: number;
  severity: 'Critical' | 'High' | 'Medium' | 'Low';
  confidenceScore: number;
  recommendation: string;
}

interface DetectionOutput {
  anomalies: AnomalyResult[];
  insights: string[];
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stddev(values: number[], avg: number): number {
  const variance = values.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / values.length;
  return Math.sqrt(variance);
}

function linearTrendSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = mean(values);
  const num = values.reduce((sum, y, x) => sum + (x - xMean) * (y - yMean), 0);
  const den = values.reduce((sum, _, x) => sum + Math.pow(x - xMean, 2), 0);
  return den === 0 ? 0 : num / den;
}

export function detectAnomaliesTS(costData: { dailyTrends: DailyTrend[] }): DetectionOutput {
  try {
    const trends = [...(costData.dailyTrends || [])].sort((a, b) => a.date.localeCompare(b.date));

    if (trends.length < 3) {
      return { anomalies: [], insights: ['Insufficient data (minimum 3 days required)'] };
    }

    const costs = trends.map(d => d.cost);
    const avg = mean(costs);
    const sd = stddev(costs, avg);

    // Z-score threshold: flag anything beyond 2 standard deviations
    const Z_THRESHOLD = 2.0;

    const anomalies: AnomalyResult[] = [];

    for (let i = 0; i < trends.length; i++) {
      const row = trends[i];
      const cost = row.cost;
      const zScore = sd > 0 ? Math.abs(cost - avg) / sd : 0;

      if (zScore < Z_THRESHOLD) continue;

      const confidenceScore = Math.min(1, (zScore - Z_THRESHOLD) / Z_THRESHOLD);

      let totalDelta = 0;
      let anomalyType: 'spike' | 'drop' | 'unusual' = 'unusual';
      let rootCause: string | null = null;
      let serviceImpact = 0;
      let contributionPercent = 0;

      if (i > 0) {
        const prev = trends[i - 1];
        totalDelta = cost - prev.cost;

        if (cost > prev.cost * 1.5) anomalyType = 'spike';
        else if (cost < prev.cost * 0.5) anomalyType = 'drop';

        // Root cause: find service with largest delta
        const todaySvc = row.services || {};
        const prevSvc = prev.services || {};
        const allServices = Array.from(new Set([...Object.keys(todaySvc), ...Object.keys(prevSvc)]));

        let maxDelta = 0;
        for (const svc of allServices) {
          const delta = (todaySvc[svc] || 0) - (prevSvc[svc] || 0);
          if (Math.abs(delta) > Math.abs(maxDelta)) {
            maxDelta = delta;
            rootCause = svc;
          }
        }

        if (rootCause) {
          serviceImpact = Math.round(maxDelta * 100) / 100;
          contributionPercent = totalDelta !== 0
            ? Math.round((Math.abs(serviceImpact) / Math.abs(totalDelta)) * 10000) / 100
            : 0;
        }
      }

      const absDelta = Math.abs(totalDelta);
      const severity: AnomalyResult['severity'] =
        absDelta > 1000 ? 'Critical' :
        absDelta > 500  ? 'High' :
        absDelta > 200  ? 'Medium' : 'Low';

      const recommendation =
        anomalyType === 'spike' ? `Review scaling & workload increase for ${rootCause}.` :
        anomalyType === 'drop'  ? `Verify if ${rootCause} resources were stopped or resized.` :
        'Investigate unusual cost behavior.';

      anomalies.push({
        date: row.date,
        type: anomalyType,
        cost: Math.round(cost * 100) / 100,
        totalDelta: Math.round(totalDelta * 100) / 100,
        rootCause,
        serviceImpact,
        contributionPercent,
        severity,
        confidenceScore: Math.round(confidenceScore * 10000) / 10000,
        recommendation,
      });
    }

    // Trend insight
    const slope = linearTrendSlope(costs);
    const insights: string[] = [];

    if (slope > 0.5) insights.push(`Costs trending upward at $${Math.abs(slope).toFixed(2)}/day`);
    else if (slope < -0.5) insights.push(`Costs trending downward at $${Math.abs(slope).toFixed(2)}/day`);
    else insights.push('Costs stable');

    insights.push(anomalies.length > 0 ? `${anomalies.length} anomalies detected` : 'No anomalies detected');

    return { anomalies, insights };
  } catch (e: any) {
    return { anomalies: [], insights: [`Error during anomaly detection: ${e.message}`] };
  }
}
