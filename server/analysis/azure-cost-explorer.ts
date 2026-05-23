/**
 * Azure Cost Explorer Helper
 * Fetches cost data grouped by meter category for attribution
 */

import { getProviderCredentials } from "../cloud-config-manager";

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

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Azure Cost Explorer] API failed: ${response.status}`, errorText);
      return [];
    }

    const data = await response.json();
    const costs: AzureMeterCategoryCost[] = [];
    
    if (data.properties?.rows) {
      for (const row of data.properties.rows) {
        // Row format: [PreTaxCost, MeterCategory, ResourceGroup]
        const [preTaxCost, meterCategory, resourceGroup] = row;
        const cost = parseFloat(preTaxCost) || 0;
        
        if (cost > 0) {
          costs.push({
            meterCategory: meterCategory || "Unknown",
            resourceGroup: resourceGroup || "No Resource Group",
            cost,
          });
        }
      }
    }
    
    console.log(`[Azure Cost Explorer] ✓ Found ${costs.length} meter category costs`);
    return costs;
    
  } catch (error: any) {
    console.error('[Azure Cost Explorer] Error:', error.message);
    return [];
  }
}
