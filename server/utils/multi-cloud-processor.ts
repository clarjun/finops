/**
 * Multi-Cloud Cost Data Processor
 * Normalizes and aggregates cost data from Azure, AWS, and GCP
 */

import { CloudProvider, ProcessedCostData } from '@shared/schema';
import { AwsCostData } from './aws-cost-client';
import { GcpCostData } from './gcp-cost-client';
import { AzureCostResponse } from '@shared/schema';

// Unified cost data interface
export interface UnifiedCostData {
  provider: CloudProvider;
  accountId: string;
  accountName: string;
  date: string;
  serviceName: string;
  region?: string;
  cost: number;
  currency: string;
  tags?: Record<string, string>;
  metadata?: Record<string, any>;
}

/**
 * Process multi-cloud cost data and return aggregated insights
 */
export function processMultiCloudCosts(
  costData: UnifiedCostData[],
  provider?: CloudProvider
): ProcessedCostData {
  // Filter by provider if specified
  const filteredData = provider
    ? costData.filter(d => d.provider === provider)
    : costData;

  if (filteredData.length === 0) {
    return getEmptyProcessedData();
  }

  //console.log("filteredData ", filteredData);
  // console.log("filteredData ", JSON.stringify(filteredData.slice(0,2000)));
  // Calculate total cost
  const totalCost = filteredData.reduce((sum, item) => sum + item.cost, 0);

  // Calculate daily trends
  const dailyTrendsMap = new Map<string, { cost: number; services: Record<string, number> }>();
  
  for (const item of filteredData) {
    const existing = dailyTrendsMap.get(item.date) || { cost: 0, services: {} };
    existing.cost += item.cost;
    existing.services[item.serviceName] = (existing.services[item.serviceName] || 0) + item.cost;
    dailyTrendsMap.set(item.date, existing);
  }

  const dailyTrends = Array.from(dailyTrendsMap.entries())
    .map(([date, data]) => ({
      date,
      cost: data.cost,
      services: data.services
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Calculate average daily cost
  const avgDailyCost = dailyTrends.length > 0 ? totalCost / dailyTrends.length : 0;

  // Service breakdown
  const serviceMap = new Map<string, number>();
  for (const item of filteredData) {
    serviceMap.set(item.serviceName, (serviceMap.get(item.serviceName) || 0) + item.cost);
  }

  const serviceBreakdown = Array.from(serviceMap.entries())
    .map(([name, cost]) => ({
      name,
      cost,
      percentage: (cost / totalCost) * 100
    }))
    .sort((a, b) => b.cost - a.cost);

  // Account/Subscription breakdown
  const accountMap = new Map<string, number>();
  for (const item of filteredData) {
    const key = `${item.provider}:${item.accountName}`;
    accountMap.set(key, (accountMap.get(key) || 0) + item.cost);
  }

  const subscriptionBreakdown = Array.from(accountMap.entries())
    .map(([name, cost]) => ({
      name,
      cost,
      percentage: (cost / totalCost) * 100
    }))
    .sort((a, b) => b.cost - a.cost);

  // Top service
  const topService = serviceBreakdown[0] || { name: 'N/A', cost: 0 };

  // Peak day
  const peakDay = dailyTrends.reduce(
    (peak, day) => (day.cost > peak.cost ? day : peak),
    { date: '', cost: 0 }
  );

  // Unique lists
  const subscriptions = Array.from(new Set(filteredData.map(d => d.accountName)));
  const services = Array.from(new Set(filteredData.map(d => d.serviceName)));

  return {
    totalCost,
    avgDailyCost,
    topService,
    serviceCount: services.length,
    dailyTrends,
    serviceBreakdown,
    subscriptionBreakdown,
    subscriptions,
    services,
    peakDay
  };
}

/**
 * Convert AWS cost data to unified format
 */
export function normalizeAwsCosts(awsData: AwsCostData[]): UnifiedCostData[] {
  return awsData.map(item => ({
    provider: 'aws' as CloudProvider,
    accountId: item.accountId,
    accountName: item.accountName,
    date: item.date,
    serviceName: item.serviceName,
    region: item.region,
    cost: item.cost,
    currency: item.currency,
    tags: item.tags,
    metadata: item.metadata
  }));
}

/**
 * Convert GCP cost data to unified format
 */
export function normalizeGcpCosts(gcpData: GcpCostData[]): UnifiedCostData[] {
  return gcpData.map(item => ({
    provider: 'gcp' as CloudProvider,
    accountId: item.accountId,
    accountName: item.accountName,
    date: item.date,
    serviceName: item.serviceName,
    region: item.region,
    cost: item.cost,
    currency: item.currency,
    tags: item.tags,
    metadata: item.metadata
  }));
}

/**
 * Convert Azure cost data to unified format
 */
export function normalizeAzureCosts(azureResponse: AzureCostResponse): UnifiedCostData[] {
  const costData: UnifiedCostData[] = [];

  for (const row of azureResponse.properties.rows) {
    const [preTaxCost, usageDateNum, subscriptionName, resourceGroup, serviceName, currency] = row;

    // Convert usage date from YYYYMMDD to YYYY-MM-DD
    const dateStr = usageDateNum.toString();
    const date = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;

    costData.push({
      provider: 'azure',
      accountId: subscriptionName, // Use subscription name as ID
      accountName: subscriptionName,
      date,
      serviceName,
      region: resourceGroup, // Azure uses resource groups
      cost: preTaxCost,
      currency,
      tags: {},
      metadata: { resourceGroup }
    });
  }

  return costData;
}

/**
 * Calculate multi-cloud comparison metrics
 */
export function calculateMultiCloudComparison(costData: UnifiedCostData[]) {
  const providerCosts = new Map<CloudProvider, number>();
  const providerServices = new Map<CloudProvider, Set<string>>();
  const providerRegions = new Map<CloudProvider, Set<string>>();

  for (const item of costData) {
    // Total cost by provider
    providerCosts.set(item.provider, (providerCosts.get(item.provider) || 0) + item.cost);

    // Services by provider
    if (!providerServices.has(item.provider)) {
      providerServices.set(item.provider, new Set());
    }
    providerServices.get(item.provider)!.add(item.serviceName);

    // Regions by provider
    if (item.region) {
      if (!providerRegions.has(item.provider)) {
        providerRegions.set(item.provider, new Set());
      }
      providerRegions.get(item.provider)!.add(item.region);
    }
  }

  const comparison = Array.from(providerCosts.entries()).map(([provider, cost]) => ({
    provider,
    totalCost: cost,
    percentage: (cost / Array.from(providerCosts.values()).reduce((a, b) => a + b, 0)) * 100,
    serviceCount: providerServices.get(provider)?.size || 0,
    regionCount: providerRegions.get(provider)?.size || 0
  }));

  return {
    providers: comparison,
    totalCost: Array.from(providerCosts.values()).reduce((a, b) => a + b, 0),
    mostExpensive: comparison.reduce((max, p) => p.totalCost > max.totalCost ? p : max, comparison[0]),
    leastExpensive: comparison.reduce((min, p) => p.totalCost < min.totalCost ? p : min, comparison[0])
  };
}

/**
 * Analyze cost allocation by tags across all providers
 */
export function analyzeTagAllocation(costData: UnifiedCostData[]) {
  const tagCosts = new Map<string, Map<string, number>>();

  for (const item of costData) {
    if (item.tags) {
      for (const [key, value] of Object.entries(item.tags)) {
        if (!tagCosts.has(key)) {
          tagCosts.set(key, new Map());
        }
        const valueMap = tagCosts.get(key)!;
        valueMap.set(value, (valueMap.get(value) || 0) + item.cost);
      }
    }
  }

  const analysis = Array.from(tagCosts.entries()).map(([tagKey, valueMap]) => ({
    tagKey,
    values: Array.from(valueMap.entries()).map(([value, cost]) => ({
      value,
      cost,
      percentage: (cost / Array.from(valueMap.values()).reduce((a, b) => a + b, 0)) * 100
    })).sort((a, b) => b.cost - a.cost)
  }));

  // Find resources without tags
  const untaggedCost = costData
    .filter(item => !item.tags || Object.keys(item.tags).length === 0)
    .reduce((sum, item) => sum + item.cost, 0);

  return {
    tagAnalysis: analysis,
    untaggedCost,
    totalCost: costData.reduce((sum, item) => sum + item.cost, 0),
    untaggedPercentage: (untaggedCost / costData.reduce((sum, item) => sum + item.cost, 0)) * 100
  };
}

function getEmptyProcessedData(): ProcessedCostData {
  return {
    totalCost: 0,
    avgDailyCost: 0,
    topService: { name: 'N/A', cost: 0 },
    serviceCount: 0,
    dailyTrends: [],
    serviceBreakdown: [],
    subscriptionBreakdown: [],
    subscriptions: [],
    services: [],
    peakDay: { date: '', cost: 0 }
  };
}
