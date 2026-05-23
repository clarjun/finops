/**
 * Azure Cost Deep Dive
 * Fetches granular cost breakdown by resource group and meter category
 * Note: Azure Cost Management API allows multiple grouping dimensions
 */

import { getProviderCredentials } from "../cloud-config-manager";

export async function getAzureDeepCostBreakdown(
  serviceName: string,
  startDate: string,
  endDate: string
): Promise<Record<string, Record<string, any>>> {
  try {
    console.log("Azure Cost Deep Dive")
    // Get Azure credentials from database
    const accountConfig = await getProviderCredentials('azure');
    
    if (!accountConfig) {
      console.log('[Azure Cost Deep Dive] Azure not configured, returning empty breakdown');
      return {};
    }

    const credentials = accountConfig.credentials;
    const subscriptionId = credentials.subscriptionId || accountConfig.accountId;
    const billingAccountId = credentials.billingAccountId;

    if (!subscriptionId && !billingAccountId) {
      console.log('[Azure Cost Deep Dive] No subscription or billing account configured');
      return {};
    }

    console.log(`[Azure Cost Deep Dive] Fetching breakdown for ${serviceName}`);

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
          { type: "Dimension", name: "ResourceGroup" },
          { type: "Dimension", name: "MeterCategory" },
          { type: "Dimension", name: "ResourceLocation" },
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
      console.error(`[Azure Cost Deep Dive] API failed: ${response.status}`, errorText);
      return {};
    }

    const data = await response.json();
    
    // Transform to nested structure: { meterCategory: { resourceGroup: { cost, location } } }
    const breakdown: Record<string, Record<string, any>> = {};
    
    if (data.properties?.rows) {
      for (const row of data.properties.rows) {
        // Row format: [PreTaxCost, ResourceGroup, MeterCategory, ResourceLocation]
        const [preTaxCost, resourceGroup, meterCategory, location] = row;
        const cost = parseFloat(preTaxCost) || 0;
        
        if (cost > 0) {
          const category = meterCategory || "Unknown";
          const rg = resourceGroup || "No Resource Group";
          
          if (!breakdown[category]) breakdown[category] = {};
          if (!breakdown[category][rg]) {
            breakdown[category][rg] = { cost: 0, location: location || "Unknown" };
          }
          breakdown[category][rg].cost += cost;
        }
      }
    }
    
    console.log(`[Azure Cost Deep Dive] ✓ Found ${Object.keys(breakdown).length} meter categories`);
    return breakdown;
    
  } catch (error: any) {
    console.error('[Azure Cost Deep Dive] Error:', error.message);
    return {};
  }
}
