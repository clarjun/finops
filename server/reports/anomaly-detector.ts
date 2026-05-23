/**
 * Anomaly Detector
 * Detects cost spikes, drops, and unusual patterns
 */

import { AnomalyAlert } from './types';

export function detectAnomalies(
  dailyCosts: Array<{ date: string; service: string; cost: number }>,
  lookbackDays: number = 30
): AnomalyAlert[] {
  console.log(`[Anomaly Detector] Analyzing last ${lookbackDays} days`);
  
  const anomalies: AnomalyAlert[] = [];
  
  // Group by date and service
  const costByDateService: Record<string, Record<string, number>> = {};
  
  for (const record of dailyCosts) {
    if (!costByDateService[record.date]) {
      costByDateService[record.date] = {};
    }
    if (!costByDateService[record.date][record.service]) {
      costByDateService[record.date][record.service] = 0;
    }
    costByDateService[record.date][record.service] += record.cost;
  }
  
  // Get unique services
  const services = Array.from(new Set<string>(dailyCosts.map(r => r.service)));
  
  for (const service of services) {
    const serviceCosts: Array<{ date: string; cost: number }> = [];
    
    for (const [date, serviceCostMap] of Object.entries(costByDateService)) {
      serviceCosts.push({
        date,
        cost: serviceCostMap[service] || 0,
      });
    }
    
    // Sort by date
    serviceCosts.sort((a, b) => a.date.localeCompare(b.date));
    
    // Calculate baseline (average of first 70% of data)
    const baselineCount = Math.floor(serviceCosts.length * 0.7);
    const baselineCosts = serviceCosts.slice(0, baselineCount).map(d => d.cost);
    const baseline = baselineCosts.reduce((sum, c) => sum + c, 0) / baselineCosts.length;
    const stdDev = calculateStdDev(baselineCosts, baseline);
    
    // Check recent days for anomalies (last 30%)
    const recentDays = serviceCosts.slice(baselineCount);
    
    for (const day of recentDays) {
      // Skip if cost is too small (less than $0.01) to avoid false positives
      if (day.cost < 0.01) continue;
      
      const deviation = Math.abs(day.cost - baseline);
      const zScore = stdDev > 0 ? deviation / stdDev : 0;
      
      // Anomaly if z-score > 2 (2 standard deviations)
      if (zScore > 2) {
        const changePercent = baseline > 0 
          ? ((day.cost - baseline) / baseline) * 100 
          : 0;
        
        // Skip if baseline is too small (less than $0.01) to avoid huge percentages
        if (baseline < 0.01) continue;
        
        // Skip if absolute change is less than $1 (too small to matter)
        if (Math.abs(day.cost - baseline) < 1) continue;
        
        const type: 'spike' | 'drop' | 'unusual' = 
          day.cost > baseline ? 'spike' : 'drop';
        
        const severity = 
          Math.abs(changePercent) > 300 ? 'critical' :
          Math.abs(changePercent) > 200 ? 'high' :
          Math.abs(changePercent) > 100 ? 'medium' : 'low';
        
        anomalies.push({
          date: day.date,
          service,
          type,
          changePercent: Math.abs(changePercent),
          previousCost: baseline,
          currentCost: day.cost,
          severity,
        });
      }
    }
  }
  
  // Sort by severity and date
  anomalies.sort((a, b) => {
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    if (severityOrder[a.severity] !== severityOrder[b.severity]) {
      return severityOrder[a.severity] - severityOrder[b.severity];
    }
    return b.date.localeCompare(a.date);
  });
  
  console.log(`[Anomaly Detector] ✓ Found ${anomalies.length} anomalies`);
  return anomalies.slice(0, 10); // Return top 10
}

function calculateStdDev(values: number[], mean: number): number {
  if (values.length === 0) return 0;
  
  const squaredDiffs = values.map(value => Math.pow(value - mean, 2));
  const avgSquaredDiff = squaredDiffs.reduce((sum, val) => sum + val, 0) / values.length;
  
  return Math.sqrt(avgSquaredDiff);
}
