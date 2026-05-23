/**
 * Cost Trend Analyzer
 * Analyzes historical cost data for trends and patterns
 */

import { CostTrendDataPoint, TopCostDriver } from './types';

export async function analyzeCostTrend(
  historicalData: Array<{ date: string; service: string; cost: number }>,
  months: number = 6
): Promise<CostTrendDataPoint[]> {
  console.log(`[Cost Trend] Analyzing last ${months} months`);
  
  // Group by month
  const monthlyData: Record<string, number> = {};
  
  for (const record of historicalData) {
    const date = new Date(record.date);
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    
    if (!monthlyData[monthKey]) {
      monthlyData[monthKey] = 0;
    }
    monthlyData[monthKey] += record.cost;
  }
  
  // Get last N months (only up to current month, no future forecast)
  const now = new Date();
  const trendData: CostTrendDataPoint[] = [];
  
  for (let i = months - 1; i >= 0; i--) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    const monthName = date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    
    trendData.push({
      month: monthName,
      cost: monthlyData[monthKey] || 0,
    });
  }
  
  console.log(`[Cost Trend] ✓ Generated ${trendData.length} data points`);
  return trendData;
}

export function analyzeTopCostDrivers(
  currentMonthData: Array<{ service: string; cost: number }>,
  previousMonthData: Array<{ service: string; cost: number }>,
  topN: number = 5
): TopCostDriver[] {
  console.log(`[Cost Drivers] Analyzing top ${topN} services`);
  
  // Aggregate current month by service
  const currentByService: Record<string, number> = {};
  for (const record of currentMonthData) {
    if (!currentByService[record.service]) {
      currentByService[record.service] = 0;
    }
    currentByService[record.service] += record.cost;
  }
  
  // Aggregate previous month by service
  const previousByService: Record<string, number> = {};
  for (const record of previousMonthData) {
    if (!previousByService[record.service]) {
      previousByService[record.service] = 0;
    }
    previousByService[record.service] += record.cost;
  }
  
  // Calculate total for percentages
  const totalCost = Object.values(currentByService).reduce((sum, cost) => sum + cost, 0);
  
  // Create drivers with trend analysis
  const drivers: TopCostDriver[] = Object.entries(currentByService)
    .map(([service, cost]) => {
      const previousCost = previousByService[service] || 0;
      const changePercent = previousCost > 0 
        ? ((cost - previousCost) / previousCost) * 100 
        : 0;
      
      let trend: 'up' | 'down' | 'stable' = 'stable';
      if (changePercent > 5) trend = 'up';
      else if (changePercent < -5) trend = 'down';
      
      return {
        service,
        cost,
        percentage: totalCost > 0 ? (cost / totalCost) * 100 : 0,
        trend,
        changePercent,
      };
    })
    .sort((a, b) => b.cost - a.cost)
    .slice(0, topN);
  
  console.log(`[Cost Drivers] ✓ Top service: ${drivers[0]?.service} ($${drivers[0]?.cost.toFixed(2)})`);
  return drivers;
}
