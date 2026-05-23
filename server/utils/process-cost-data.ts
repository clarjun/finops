import type { AzureCostResponse, ProcessedCostData, AzureCostRow } from "@shared/schema";

export function processAzureCostData(azureResponse: AzureCostResponse): ProcessedCostData {
  const rows: AzureCostRow[] = azureResponse.properties.rows;
  
  // Aggregate data
  let totalCost = 0;
  const serviceMap = new Map<string, number>();
  const subscriptionMap = new Map<string, number>();
  const subscriptionSet = new Set<string>();
  const dailyMap = new Map<string, { cost: number; services: Map<string, number> }>();

  for (const row of rows) {
    const [preTaxCost, usageDate, subscriptionName, , serviceName] = row;
    
    totalCost += preTaxCost;
    
    // Track services
    serviceMap.set(serviceName, (serviceMap.get(serviceName) || 0) + preTaxCost);
    
    // Track subscriptions
    subscriptionMap.set(subscriptionName, (subscriptionMap.get(subscriptionName) || 0) + preTaxCost);
    subscriptionSet.add(subscriptionName);
    
    // Format date from YYYYMMDD to YYYY-MM-DD
    const dateStr = usageDate.toString();
    const formattedDate = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
    
    // Track daily costs
    if (!dailyMap.has(formattedDate)) {
      dailyMap.set(formattedDate, { cost: 0, services: new Map() });
    }
    const dailyData = dailyMap.get(formattedDate)!;
    dailyData.cost += preTaxCost;
    dailyData.services.set(serviceName, (dailyData.services.get(serviceName) || 0) + preTaxCost);
  }

  // Calculate service breakdown with percentages
  const serviceBreakdown = Array.from(serviceMap.entries())
    .map(([name, cost]) => ({
      name,
      cost,
      percentage: (cost / totalCost) * 100,
    }))
    .sort((a, b) => b.cost - a.cost);

  // Get top service
  const topService = serviceBreakdown[0] || { name: "N/A", cost: 0 };

  // Calculate daily trends
  const dailyTrends = Array.from(dailyMap.entries())
    .map(([date, data]) => ({
      date,
      cost: data.cost,
      services: Object.fromEntries(data.services),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Find peak day
  const peakDay = dailyTrends.reduce(
    (max, day) => (day.cost > max.cost ? day : max),
    dailyTrends[0] || { date: "", cost: 0 }
  );

  // Calculate average daily cost
  const avgDailyCost = dailyTrends.length > 0 ? totalCost / dailyTrends.length : 0;

  // Calculate subscription breakdown with percentages
  const subscriptionBreakdown = Array.from(subscriptionMap.entries())
    .map(([name, cost]) => ({
      name,
      cost,
      percentage: (cost / totalCost) * 100,
    }))
    .sort((a, b) => b.cost - a.cost);

  return {
    totalCost,
    avgDailyCost,
    topService,
    serviceCount: serviceMap.size,
    dailyTrends,
    serviceBreakdown,
    subscriptionBreakdown,
    subscriptions: Array.from(subscriptionSet),
    services: Array.from(serviceMap.keys()),
    peakDay,
  };
}
