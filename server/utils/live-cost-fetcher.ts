/**
 * Live Cost Data Fetcher
 * Fetches real-time cost data from cloud providers without saving to database
 * Used by alert checker and other real-time cost monitoring features
 */

import { runAdapter, BUDGET_INTERACTIVE_MS } from '../cloud/fetch-runtime';
import { adapterFor, ALL_PROVIDERS } from '../cloud/registry';
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
 * Fetches one provider's costs through the SHARED cost adapter.
 *
 * This function previously held a three-way switch over hand-written provider
 * clients, entirely separate from the ingestion connectors. That duplication is
 * what let Azure's missing `nextLink` pagination exist TWICE, independently, in
 * two files - each found and fixed on its own schedule, and one forgotten while
 * it silently hid 29% of a month's spend.
 *
 * Both pipelines now run the same adapters, so a provider behaves identically
 * whether a number came from the fact store or a live call, and a fix lands once.
 *
 * Two deliberate differences from ingestion:
 *
 *   budget   the interactive budget, not the background one. A dashboard request
 *            must not hang for eight minutes waiting out Azure throttling.
 *   basis    effectiveCost where the provider supplies it, matching both the
 *            dashboard default and the fact store query. Reporting billed cost
 *            here and effective cost there is how two screens disagree while
 *            each is internally consistent.
 */
async function fetchProviderData(
  provider: CloudProvider,
  startDate: string,
  endDate: string
): Promise<CostRecord[]> {
  try {
    const adapter = adapterFor(provider);

    // The adapters own their date semantics - AWS converts to its exclusive
    // End, Azure passes its inclusive `to` through, GCP uses `<=`. This module
    // no longer needs to know, which is the point.
    const result = await runAdapter(adapter, { start: startDate, end: endDate }, {
      budgetMs: BUDGET_INTERACTIVE_MS,
    });

    if (result.warnings.length > 0) {
      // Surfaced rather than swallowed: a provider that could not be reached
      // must not read as zero spend.
      console.warn(`[Live Cost Fetcher] ${provider}: ${result.warnings.join(' | ')}`);
    }

    return result.records
      // Tax excluded, matching buildProcessedCostData and the fact-store
      // queries. Tax is a real charge but is not attributable to a service or a
      // team, so every allocation view excludes it — and the live path including
      // it made the dashboard's live fallback disagree with its stored figure by
      // exactly the tax amount, which reads as a broken integration rather than
      // a definitional difference.
      .filter((r) => r.chargeCategory !== 'Tax')
      .map((r) => ({
      provider: r.provider,
      accountId: r.subAccountId,
      accountName: r.subAccountName || r.billingAccountName || `${provider.toUpperCase()} Account`,
      date: r.chargePeriodStart,
      serviceName: r.serviceName,
      region: r.regionId ?? undefined,
      // Effective where known, billed otherwise - the same coalesce the fact
      // store query uses, so the two paths cannot diverge on basis.
      cost: r.effectiveCost ?? r.billedCost,
      currency: r.billingCurrency || 'USD',
    }));
  } catch (error: any) {
    console.error(`Error fetching ${provider.toUpperCase()} data:`, error?.message ?? error);
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
  // UTC: `new Date(y, m, 1)` is local midnight, which east of Greenwich lands
  // in the previous month once converted. Same fix as /api/cost-data.
  const start = startDate || new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  
  const startDateStr = start.toISOString().split('T')[0];
  const endDateStr = end.toISOString().split('T')[0];
  
  // Determine which providers to fetch
  const providersToFetch: CloudProvider[] = providers || [...ALL_PROVIDERS];
  
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
