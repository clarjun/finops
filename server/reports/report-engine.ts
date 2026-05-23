/**
 * FinOps Report Engine
 * Main orchestrator for comprehensive cost reporting
 */

import { FinOpsReport, ExpensiveResource, AISpendAnalysis } from './types';
import { calculateSpendOverview } from './spend-calculator';
import { analyzeCostTrend, analyzeTopCostDrivers } from './cost-trend-analyzer';
import { detectAnomalies } from './anomaly-detector';
import { detectWaste, getResourceUtilization } from './waste-detector';
import { calculateOptimizationOpportunities } from './optimization-calculator';
import { allocateCostsByDepartment, generateHeatmapData } from './department-allocator';
import { analyzeAICosts } from './ai-cost-analyzer';

export async function generateFinOpsReport(
  provider: 'aws' | 'azure' | 'gcp',
  historicalData: Array<{ date: string; service: string; cost: number }>,
  resourceCosts: Array<{ resourceId: string; service: string; cost: number; resourceName?: string; region?: string; owner?: string }>,
  dateRange?: { startDate: Date; endDate: Date },
  expensiveResources?: ExpensiveResource[],
  accountId?: string
): Promise<FinOpsReport> {
  console.log(`\n========== FINOPS REPORT GENERATION ==========`);
  console.log(`Provider: ${provider.toUpperCase()}`);
  console.log(`Historical records: ${historicalData.length}`);
  console.log(`Resource records: ${resourceCosts.length}`);
  
  if (dateRange) {
    console.log(`Date range: ${dateRange.startDate.toISOString().split('T')[0]} to ${dateRange.endDate.toISOString().split('T')[0]}`);
  }
  
  // Debug: Show sample data
  if (historicalData.length > 0) {
    console.log(`Sample historical record:`, historicalData[0]);
  }
  if (resourceCosts.length > 0) {
    console.log(`Sample resource cost:`, resourceCosts[0]);
  }
  
  const startTime = Date.now();
  
  // Use provided date range or default to current month
  const now = dateRange?.endDate || new Date();
  const periodStart = dateRange?.startDate || new Date(now.getFullYear(), now.getMonth(), 1);
  
  // Get current period data (respecting selected date range)
  // Use string comparison for dates to avoid timezone issues
  const periodStartStr = periodStart.toISOString().split('T')[0];
  const periodEndStr = now.toISOString().split('T')[0];
  
  let currentMonthData = historicalData.filter(d => {
    // d.date is already a string in format "YYYY-MM-DD"
    const dateStr = typeof d.date === 'string' ? d.date : new Date(d.date).toISOString().split('T')[0];
    return dateStr >= periodStartStr && dateStr <= periodEndStr;
  });
  
  console.log(`Period start: ${periodStartStr}`);
  console.log(`Period end: ${periodEndStr}`);
  console.log(`Current period data points: ${currentMonthData.length}`);
  
  // Debug: Show sample of historical data
  if (historicalData.length > 0) {
    console.log(`Sample historical data (first 3):`, historicalData.slice(0, 3).map(d => ({ date: d.date, service: d.service, cost: d.cost })));
  }
  
  // If no current period data (AWS delay), use last complete month ONLY if no custom date range
  if (currentMonthData.length === 0 && !dateRange) {
    // Fallback removed - show real-time data only
    console.log(`⚠ No data found for selected period`);
  } else if (currentMonthData.length === 0 && dateRange) {
    console.log(`⚠ No data found for selected date range`);
  }
  
  if (currentMonthData.length > 0) {
    const totalCurrentMonth = currentMonthData.reduce((sum, d) => sum + d.cost, 0);
    console.log(`Total month cost from data: $${totalCurrentMonth.toFixed(2)}`);
  }
  
  // Get previous month data
  const previousMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const previousMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
  const previousMonthStartStr = previousMonthStart.toISOString().split('T')[0];
  const previousMonthEndStr = previousMonthEnd.toISOString().split('T')[0];
  
  const previousMonthData = historicalData.filter(d => {
    const dateStr = typeof d.date === 'string' ? d.date : new Date(d.date).toISOString().split('T')[0];
    return dateStr >= previousMonthStartStr && dateStr <= previousMonthEndStr;
  });
  
  // Step 1: Top Cost Drivers
  console.log('[Step 1/10] Analyzing top cost drivers...');
  const topCostDrivers = analyzeTopCostDrivers(currentMonthData, previousMonthData, 5);
  
  // Step 2: Calculate potential savings (from optimization opportunities - will calculate later)
  console.log('[Step 2/10] Detecting waste...');
  const wasteDetection = await detectWaste(provider, resourceCosts);
  
  // Step 3: Spend Overview
  console.log('[Step 3/10] Calculating spend overview...');
  const spendOverview = await calculateSpendOverview(
    provider,
    currentMonthData.map(d => ({ date: d.date, cost: d.cost })),
    wasteDetection.potentialSaving,
    dateRange ? { startDate: periodStart, endDate: now } : undefined
  );
  
  // Step 4: Expensive Resources
  console.log('[Step 4/10] Identifying expensive resources...');
  const expensiveResourcesList = expensiveResources && expensiveResources.length > 0
    ? expensiveResources
    : resourceCosts
        .map(r => ({
          resourceId: r.resourceId,
          resourceName: r.resourceName || r.resourceId,
          service: r.service,
          cost: r.cost,
          region: r.region || 'unknown',
          owner: r.owner,
        }))
        .sort((a, b) => b.cost - a.cost)
        .slice(0, 10);
  
  console.log(`[Step 4/10] Using ${expensiveResourcesList.length} expensive resources`);
  
  // Step 5: Cost Trend
  console.log('[Step 5/10] Analyzing cost trend...');
  const costTrend = await analyzeCostTrend(historicalData, 6);
  
  // Step 6: Anomaly Detection
  console.log('[Step 6/10] Detecting anomalies...');
  
  // Get last 30 days of data for anomaly detection
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split('T')[0];
  
  const last30DaysData = historicalData.filter(d => {
    const dateStr = typeof d.date === 'string' ? d.date : new Date(d.date).toISOString().split('T')[0];
    return dateStr >= thirtyDaysAgoStr;
  });
  
  console.log(`[Anomaly Detector] Using ${last30DaysData.length} records from last 30 days`);
  const anomalies = detectAnomalies(last30DaysData, 30);
  
  // Step 7: Resource Utilization
  console.log('[Step 7/10] Fetching resource utilization...');
  const utilizationData = await getResourceUtilization(provider, resourceCosts);
  
  // Step 8: Optimization Opportunities
  console.log('[Step 8/10] Calculating optimization opportunities...');
  
  // Calculate on-demand costs
  const totalCost = currentMonthData.reduce((sum, d) => sum + d.cost, 0);
  const onDemandPercent = 70; // Estimate - would need actual data from Cost Explorer
  const onDemandCost = totalCost * (onDemandPercent / 100);
  
  // Calculate storage costs
  const storageCost = currentMonthData
    .filter(d => d.service.toLowerCase().includes('storage') || d.service.toLowerCase().includes('s3'))
    .reduce((sum, d) => sum + d.cost, 0);
  
  const optimizationOpportunities = calculateOptimizationOpportunities(
    wasteDetection,
    { onDemandPercent, onDemandCost },
    { totalStorageCost: storageCost, tieringOpportunity: storageCost * 0.2 }
  );
  
  // Step 9: Department Allocation
  console.log('[Step 9/10] Allocating costs by department...');
  
  // Aggregate costs by service (currentMonthData has one record per day per service)
  const serviceCostMap = new Map<string, number>();
  for (const record of currentMonthData) {
    const current = serviceCostMap.get(record.service) || 0;
    serviceCostMap.set(record.service, current + record.cost);
  }
  
  const aggregatedServiceCosts = Array.from(serviceCostMap.entries()).map(([service, cost]) => ({
    service,
    cost,
  }));
  
  console.log(`[Department Allocator] Aggregated ${currentMonthData.length} records into ${aggregatedServiceCosts.length} services`);
  
  const departmentAllocationResult = await allocateCostsByDepartment(
    provider,
    aggregatedServiceCosts
  );
  const departmentAllocation = departmentAllocationResult.allocations;
  
  // Step 10: Heatmap Data
  console.log('[Step 10/10] Generating heatmap data...');
  
  // Use full service data from department allocation (includes all services, not just top 3)
  const heatmapData = generateHeatmapData(departmentAllocationResult.fullServiceData);
  
  // Step 11: AI Cost Analysis
  console.log('[Step 11/11] Analyzing AI costs...');
  let aiSpendAnalysis: AISpendAnalysis = {
    totalAISpend: 0,
    aiServices: [],
    aiPercentageOfTotal: 0,
    topAIService: 'None',
    monthOverMonthChange: 0,
  };
  
  if (accountId) {
    try {
      aiSpendAnalysis = await analyzeAICosts(
        provider,
        accountId,
        periodStart.toISOString().split('T')[0],
        now.toISOString().split('T')[0]
      );
    } catch (error) {
      console.error('[AI Cost Analyzer] Failed to analyze AI costs:', error);
    }
  }
  
  const endTime = Date.now();
  console.log(`========== REPORT COMPLETE (${endTime - startTime}ms) ==========\n`);
  
  return {
    provider,
    generatedAt: new Date().toISOString(),
    dateRange: {
      start: periodStart.toISOString().split('T')[0],
      end: now.toISOString().split('T')[0],
    },
    spendOverview,
    topCostDrivers,
    expensiveResources: expensiveResourcesList,
    costTrend,
    anomalies,
    wasteDetection,
    utilizationData,
    optimizationOpportunities,
    departmentAllocation,
    heatmapData,
    aiSpendAnalysis,
  };
}
