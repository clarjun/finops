/**
 * Live Cost Data Fetcher
 * Fetches real-time cost data from cloud providers without saving to database
 * Used by alert checker and other real-time cost monitoring features
 */

import { fetchAWSCostData, isAWSConfigured } from '../aws-client';
import { fetchGCPCostData, isGCPConfigured } from '../gcp-client';
import { fetchAzureCostData, isAzureConfigured } from '../azure-client';
import type { CloudProvider } from '@shared/schema';

export interface CostRecord {
  provider: CloudProvider;
  accountId: string;
  accountName: string;
  date: string;
  serviceName: string;
  region?: string;
  cost: number;
  currency: string;
}

export interface ServiceCost {
  serviceName: string;
  cost: number;
  provider: CloudProvider;
  accountId: string;
}

export interface AggregatedCosts {
  totalCost: number;
  byProvider: Record<string, number>;
  byService: Record<string, number>;
  byServiceDetailed: ServiceCost[];
  records: CostRecord[];
}

/**
 * Fetch live cost data from a specific provider
 */
async function fetchProviderData(
  provider: CloudProvider,
  startDate: string,
  endDate: string
): Promise<CostRecord[]> {
  try {
    let rawData: any[];
    
    switch (provider) {
      case 'aws':
        if (!await isAWSConfigured()) return [];
        rawData = await fetchAWSCostData(startDate, endDate);
        break;
      case 'gcp':
        if (!await isGCPConfigured()) return [];
        rawData = await fetchGCPCostData(startDate, endDate);
        break;
      case 'azure':
        if (!await isAzureConfigured()) return [];
        rawData = await fetchAzureCostData(startDate, endDate);
        break;
      default:
        return [];
    }
console.log("rawData ", rawData)
    // Transform to unified format
    return rawData.map(record => ({
      provider: record.provider as CloudProvider,
      accountId: record.accountId || record.subscriptionName || `${provider}-account`,
      accountName: record.accountName || record.subscriptionName || `${provider.toUpperCase()} Account`,
      date: typeof record.date === 'string' ? record.date : record.date.toISOString().split('T')[0],
      serviceName: record.service || record.serviceName,
      region: record.region || record.resourceGroup,
      cost: typeof record.cost === 'number' ? record.cost : parseFloat(record.cost),
      currency: record.currency || 'USD',
    }));
  } catch (error: any) {
    console.error(`Error fetching ${provider.toUpperCase()} data:`, error);
    return [];
  }
}

/**
 * Fetch live cost data from all configured providers
 */
export async function fetchLiveCosts(
  startDate?: Date,
  endDate?: Date,
  providers?: CloudProvider[]
): Promise<CostRecord[]> {
  // Default to current month
  const end = endDate || new Date();
  const start = startDate || new Date(end.getFullYear(), end.getMonth(), 1);
  
  const startDateStr = start.toISOString().split('T')[0];
  const endDateStr = end.toISOString().split('T')[0];
  
  // Determine which providers to fetch
  const providersToFetch: CloudProvider[] = providers || ['aws', 'gcp', 'azure'];
  
  console.log(`[Live Cost Fetcher] Fetching costs from ${providersToFetch.join(', ')} for ${startDateStr} to ${endDateStr}`);
  
  // Fetch from all providers in parallel
  const results = await Promise.all(
    providersToFetch.map(provider => fetchProviderData(provider, startDateStr, endDateStr))
  );
  
  // Flatten results
  const allRecords = results.flat();
  
  console.log(`[Live Cost Fetcher] Fetched ${allRecords.length} total cost records`);
  
  return allRecords;
}

/**
 * Aggregate cost data by provider and service
 */
export function aggregateCosts(records: CostRecord[]): AggregatedCosts {
  const byProvider: Record<string, number> = {};
  const byService: Record<string, number> = {};
  const byServiceDetailed: ServiceCost[] = [];
  
  let totalCost = 0;
  
  for (const record of records) {
    const cost = record.cost;
    totalCost += cost;
    
    // Aggregate by provider
    byProvider[record.provider] = (byProvider[record.provider] || 0) + cost;
    
    // Aggregate by service
    const serviceKey = `${record.provider}:${record.serviceName}`;
    byService[serviceKey] = (byService[serviceKey] || 0) + cost;
  }
  
  // Create detailed service breakdown
  for (const [key, cost] of Object.entries(byService)) {
    const [provider, serviceName] = key.split(':');
    const record = records.find(r => r.provider === provider && r.serviceName === serviceName);
    
    byServiceDetailed.push({
      serviceName,
      cost,
      provider: provider as CloudProvider,
      accountId: record?.accountId || 'unknown',
    });
  }
  
  // Sort by cost descending
  byServiceDetailed.sort((a, b) => b.cost - a.cost);
  
  return {
    totalCost,
    byProvider,
    byService,
    byServiceDetailed,
    records,
  };
}

/**
 * Get current cost for a specific service
 */
export async function getServiceCost(
  provider?: CloudProvider,
  serviceName?: string,
  accountId?: string,
  startDate?: Date,
  endDate?: Date
): Promise<number> {
  const providers = provider ? [provider] : undefined;
  const records = await fetchLiveCosts(startDate, endDate, providers);
  
  console.log(`[getServiceCost] Total records fetched: ${records.length}`);
  console.log(`[getServiceCost] Filtering for: provider=${provider}, serviceName=${serviceName}, accountId=${accountId}`);
  
  // Filter by criteria
  const filtered = records.filter(record => {
    if (provider && record.provider !== provider) return false;
    if (serviceName && record.serviceName !== serviceName) return false;
    if (accountId && record.accountId !== accountId) return false;
    return true;
  });
  
  console.log(`[getServiceCost] Filtered records: ${filtered.length}`);
  
  if (filtered.length > 0 && serviceName) {
    // Show sample of what we found
    const sample = filtered.slice(0, 3);
    console.log(`[getServiceCost] Sample filtered records:`, sample.map(r => ({
      service: r.serviceName,
      cost: r.cost,
      date: r.date
    })));
  }
  
  // Sum costs
  const total = filtered.reduce((sum, record) => sum + record.cost, 0);
  console.log(`[getServiceCost] Total cost: $${total.toFixed(2)}`);
  
  return total;
}

/**
 * Get costs grouped by service for a provider
 */
export async function getServiceBreakdown(
  provider?: CloudProvider,
  startDate?: Date,
  endDate?: Date
): Promise<ServiceCost[]> {
  const providers = provider ? [provider] : undefined;
  const records = await fetchLiveCosts(startDate, endDate, providers);
  const aggregated = aggregateCosts(records);
  
  return aggregated.byServiceDetailed;
}
