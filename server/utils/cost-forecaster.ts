/**
 * Cost Forecaster (TypeScript, no external ML runtime)
 *
 * Ports the previous Python/Ridge approach so it runs in-process and works in
 * the Node deployment without a Python + scikit-learn install. Method:
 *   - IQR outlier handling (replace extremes with the median)
 *   - OLS linear trend over the day index
 *   - weekly (day-of-week) seasonality factor, clamped to avoid wild swings
 *   - damping toward the historical median over the horizon (stability)
 *   - robust confidence intervals (MAD-based std, widening over time)
 *   - in-sample MAPE for an accuracy metric
 */

export interface DailyTrend {
  date: string;
  cost: number;
}

export interface ForecastPoint {
  date: string;
  cost: number;
  lowerBound: number;
  upperBound: number;
}

export interface ForecastOutput {
  success: boolean;
  error?: string;
  forecasts: ForecastPoint[];
  metrics?: { mape: number; historical_avg: number; forecast_avg: number };
  recommendations: Array<{
    type: string;
    severity: string;
    message: string;
    recommended_budget: number;
  }>;
}

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (sorted: number[], q: number) => {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base];
};
const std = (a: number[]) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

// Replace IQR outliers with the median (matches the Python behaviour).
function clampOutliers(costs: number[]): number[] {
  const sorted = [...costs].sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  const lower = q1 - 1.5 * iqr;
  const upper = q3 + 1.5 * iqr;
  const med = median(costs);
  return costs.map((c) => (c > upper || c < lower ? med : c));
}

// Ordinary least squares: cost = intercept + slope * index
function linearFit(y: number[]): { intercept: number; slope: number } {
  const n = y.length;
  const xs = Array.from({ length: n }, (_, i) => i);
  const mx = mean(xs);
  const my = mean(y);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (y[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  return { intercept: my - slope * mx, slope };
}

export function forecastCosts(costData: { dailyTrends?: DailyTrend[] }, forecastDaysInput = 30): ForecastOutput {
  try {
    const forecastDays = Math.max(7, Math.min(Math.floor(forecastDaysInput) || 30, 180));

    const trends = (costData?.dailyTrends || [])
      .filter((d) => d && d.date && Number.isFinite(Number(d.cost)))
      .map((d) => ({ date: new Date(d.date), cost: Number(d.cost) }))
      .filter((d) => !isNaN(d.date.getTime()))
      .sort((a, b) => a.date.getTime() - b.date.getTime());

    if (trends.length < 7) {
      return { success: false, error: 'Insufficient historical data for forecasting (minimum 7 days required)', forecasts: [], recommendations: [] };
    }

    const histCosts = trends.map((t) => t.cost);
    const histMedian = median(histCosts);
    if (histMedian < 0.01) {
      return { success: false, error: 'Insufficient cost data (historical median is zero or near-zero)', forecasts: [], recommendations: [] };
    }

    const cleaned = clampOutliers(histCosts);
    // Baseline = mean of the outlier-cleaned series, so anomaly spike days (e.g. a
    // one-off $40k day) don't distort the "historical average" the forecast is
    // compared against. Keeps the displayed average close to typical daily spend.
    const baselineAvg = mean(cleaned);

    // Trend
    const { intercept, slope } = linearFit(cleaned);

    // Weekly seasonality: average ratio of each weekday vs overall mean, clamped.
    const overall = mean(cleaned) || 1;
    const byDow: Record<number, number[]> = {};
    trends.forEach((t, i) => {
      const dow = t.date.getDay();
      (byDow[dow] ||= []).push(cleaned[i]);
    });
    const seasonal: Record<number, number> = {};
    for (let d = 0; d < 7; d++) {
      const f = byDow[d] && byDow[d].length ? mean(byDow[d]) / overall : 1;
      seasonal[d] = Math.max(0.5, Math.min(1.5, f)); // clamp to avoid wild swings
    }

    // Robust spread for bounds + confidence intervals
    const mad = median(histCosts.map((c) => Math.abs(c - histMedian)));
    const robustStd = mad * 1.4826 || std(histCosts);
    const maxReasonable = histMedian + 1.5 * robustStd;
    const minReasonable = Math.max(0, histMedian - 1.5 * robustStd);

    const n = trends.length;
    const lastDate = trends[n - 1].date;

    const rawForecasts: number[] = [];
    for (let i = 1; i <= forecastDays; i++) {
      const future = new Date(lastDate);
      future.setDate(future.getDate() + i);
      let pred = (intercept + slope * (n - 1 + i)) * seasonal[future.getDay()];
      // Clamp to a sane band around recent behaviour
      pred = Math.max(minReasonable, Math.min(pred, maxReasonable));
      // Damp toward the median, increasing with the horizon (stability)
      const blend = 0.2 + (i / forecastDays) * 0.3;
      pred = pred * (1 - blend) + histMedian * blend;
      rawForecasts.push(pred);
    }

    let forecastValues = rawForecasts;
    let forecastMean = mean(forecastValues);
    // Sanity fallback: never let the forecast run away vs typical spend
    if (forecastMean > baselineAvg * 5) {
      forecastValues = new Array(forecastDays).fill(histMedian);
      forecastMean = histMedian;
    }

    const z = 1.96;
    const forecasts: ForecastPoint[] = forecastValues.map((cost, i) => {
      const future = new Date(lastDate);
      future.setDate(future.getDate() + i + 1);
      const margin = z * robustStd * (1 + i * 0.03);
      return {
        date: future.toISOString().split('T')[0],
        cost: Number(cost.toFixed(2)),
        lowerBound: Number(Math.max(0, cost - margin).toFixed(2)),
        upperBound: Number((cost + margin).toFixed(2)),
      };
    });

    // In-sample MAPE from trend + seasonality
    let mape = 15;
    const nonZero = trends.filter((t) => t.cost > 0.01);
    if (nonZero.length >= 10) {
      const errs = trends.map((t, i) => {
        if (t.cost < 0.01) return null;
        const fit = (intercept + slope * i) * seasonal[t.date.getDay()];
        return Math.abs((t.cost - fit) / t.cost);
      }).filter((e): e is number => e !== null);
      mape = Math.min((mean(errs) || 0.15) * 100, 100);
    }

    return {
      success: true,
      forecasts,
      metrics: { mape: Number(mape.toFixed(2)), historical_avg: Number(baselineAvg.toFixed(2)), forecast_avg: Number(forecastMean.toFixed(2)) },
      recommendations: budgetRecommendations(baselineAvg, forecastMean),
    };
  } catch (e: any) {
    return { success: false, error: `Forecasting error: ${e?.message || e}`, forecasts: [], recommendations: [] };
  }
}

function budgetRecommendations(historicalAvg: number, forecastAvg: number) {
  if (historicalAvg <= 0) {
    return [{ type: 'stable', severity: 'low', message: 'Not enough historical spend to assess the trend.', recommended_budget: forecastAvg * 1.1 }];
  }
  let change = ((forecastAvg - historicalAvg) / historicalAvg) * 100;
  if (Math.abs(change) > 200) change = change > 0 ? 200 : -200;

  if (change > 10) {
    return [{
      type: 'budget_increase',
      severity: change > 20 ? 'high' : 'medium',
      message: `Forecasted spending is ${change.toFixed(1)}% higher than the historical average. Consider increasing budget.`,
      recommended_budget: forecastAvg * 1.1,
    }];
  }
  if (change < -10) {
    return [{
      type: 'cost_reduction',
      severity: 'low',
      message: `Forecasted spending is ${Math.abs(change).toFixed(1)}% lower than the historical average. Potential cost optimization achieved.`,
      recommended_budget: forecastAvg * 1.05,
    }];
  }
  return [{
    type: 'stable',
    severity: 'low',
    message: 'Spending forecast is stable. Current budget allocation is appropriate.',
    recommended_budget: forecastAvg * 1.1,
  }];
}
