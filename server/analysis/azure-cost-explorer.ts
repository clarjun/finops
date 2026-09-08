/**
 * Azure Cost Explorer Helper
 * Fetches cost data grouped by meter category for attribution
 */

import { getProviderCredentials } from "../cloud-config-manager";
import { runPaginatedQuery, ProviderQueryError } from "../cloud/query-runner";

export interface AzureMeterCategoryCost {
  meterCategory: string;
  resourceGroup: string;
  cost: number;
}

/**
 * Get Azure costs grouped by meter category for user attribution
 */
export async function getAzureCostByMeterCategory(
  serviceName: string,
  startDate: string,
  endDate: string
): Promise<AzureMeterCategoryCost[]> {
  try {
    // Get Azure credentials from database
    const accountConfig = await getProviderCredentials('azure');
    
    if (!accountConfig) {
      console.log('[Azure Cost Explorer] Azure not configured');
      return [];
    }

    const credentials = accountConfig.credentials;
    const subscriptionId = credentials.subscriptionId || accountConfig.accountId;
    const billingAccountId = credentials.billingAccountId;

    if (!subscriptionId && !billingAccountId) {
      console.log('[Azure Cost Explorer] No subscription or billing account configured');
      return [];
    }

    console.log(`[Azure Cost Explorer] Fetching meter category costs for ${serviceName}`);

    // Get access token
    const { getAccessToken } = await import('../azure-client');
    const token = await getAccessToken();

    // Prefer billing account scope if available
    let apiVersion, url;
    if (billingAccountId) {
      apiVersion = "2023-03-01";
      url = `https://management.azure.com/providers/Microsoft.Billing/billingAccounts/${billingAccountId}/providers/Microsoft.CostManagement/query?api-version=${apiVersion}`;
    } else {
      apiVersion = "2023-03-01";
      url = `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.CostManagement/query?api-version=${apiVersion}`;
    }

    const body = {
      type: "Usage",
      timeframe: "Custom",
      timePeriod: {
        from: startDate,
        to: endDate,
      },
      dataset: {
        granularity: "None", // Get aggregated data
        aggregation: {
          totalCost: { name: "PreTaxCost", function: "Sum" },
        },
        grouping: [
          { type: "Dimension", name: "MeterCategory" },
          { type: "Dimension", name: "ResourceGroup" },
        ],
        filter: {
          dimensions: {
            name: "ServiceName",
            operator: "In",
            values: [serviceName],
          },
        },
      },
    };

    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    /*
     * Paginated and retried through the shared query runner.
     *
     * Previously this issued one unretried fetch and returned [] on any failure,
     * so Cost Management throttling — which has caused three visible outages on
     * this account — read as "this service has no meter categories". It also
     * ignored `nextLink`, so a service with many meter categories was silently
     * truncated.
     */
    const rows = await runPaginatedQuery<any[]>(
      'azure',
      `meter-category:${serviceName}`,
      async (cursor) => {
        const res = await fetch(cursor ?? url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          // Status and headers attached so the runner can classify it and read
          // Azure's Retry-After rather than guessing a backoff.
          throw Object.assign(
            new Error(`Azure Cost Management returned ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`),
            { status: res.status, headers: res.headers },
          );
        }

        const payload = await res.json();
        return {
          items: (payload?.properties?.rows ?? []) as any[][],
          nextCursor: payload?.properties?.nextLink ?? undefined,
        };
      },
    );

    const costs: AzureMeterCategoryCost[] = [];
    for (const row of rows) {
      // Row format: [PreTaxCost, MeterCategory, ResourceGroup]
      const [preTaxCost, meterCategory, resourceGroup] = row;
      const cost = parseFloat(preTaxCost) || 0;

      // Non-zero rather than positive: a negative amount is a credit against
      // this meter category, and dropping it overstates the service's cost.
      if (cost !== 0) {
        costs.push({
          meterCategory: meterCategory || "Unknown",
          resourceGroup: resourceGroup || "No Resource Group",
          cost,
        });
      }
    }

    console.log(`[Azure Cost Explorer] ${serviceName}: ${costs.length} meter categories`);
    return costs;

  } catch (error: any) {
    // Still returns [] so one failed drill-down cannot break an analysis run,
    // but the classification is logged so "throttled" is distinguishable from
    // "genuinely no data".
    if (error instanceof ProviderQueryError) {
      console.error(`[Azure Cost Explorer] ${serviceName}: ${error.message} (${error.classification.kind})`);
    } else {
      console.error(`[Azure Cost Explorer] ${serviceName}:`, error?.message ?? error);
    }
    return [];
  }
}
