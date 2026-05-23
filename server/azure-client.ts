import type { AzureConfig, AzureQueryBody, AzureCostResponse } from "@shared/schema";
import { getProviderCredentials } from "./cloud-config-manager";

interface AzureTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

let cachedAccessToken: string | null = null;
let tokenExpiry: number = 0;
let currentCredentials: any = null;

// Cache configuration status to avoid rate limiting
let configurationStatus: boolean | null = null;
let configurationCheckTime: number = 0;
const CONFIG_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

/**
 * Clear the configuration cache to force a fresh check
 */
export function clearAzureConfigCache(): void {
  console.log('[Azure] Clearing configuration cache');
  configurationStatus = null;
  configurationCheckTime = 0;
}

/**
 * Get OAuth access token from Azure AD using database credentials
 */
export async function getAccessToken(): Promise<string> {
  // Get credentials from database
  const accountConfig = await getProviderCredentials('azure');
  
  if (!accountConfig) {
    throw new Error('Azure credentials not configured. Please add Azure account via Configuration page.');
  }

  const credentials = accountConfig.credentials;
  
  console.log(`[Azure] Getting access token for account: ${accountConfig.accountName}`);
  console.log(`[Azure] Credentials keys present:`, Object.keys(credentials));
  
  // Check if credentials have changed
  const credentialsChanged = !currentCredentials || 
    currentCredentials.tenantId !== credentials.tenantId ||
    currentCredentials.clientId !== credentials.clientId ||
    currentCredentials.clientSecret !== credentials.clientSecret;

  // Check if we have a valid cached token with same credentials
  if (cachedAccessToken && Date.now() < tokenExpiry && !credentialsChanged) {
    console.log(`[Azure] Using cached access token`);
    return cachedAccessToken;
  }

  if (!credentials.tenantId || !credentials.clientId || !credentials.clientSecret) {
    console.error('[Azure] Missing required credentials:', {
      hasTenantId: !!credentials.tenantId,
      hasClientId: !!credentials.clientId,
      hasClientSecret: !!credentials.clientSecret,
    });
    throw new Error('Azure credentials incomplete');
  }

  const tokenUrl = `https://login.microsoftonline.com/${credentials.tenantId}/oauth2/v2.0/token`;
  
  const params = new URLSearchParams({
    client_id: credentials.clientId,
    scope: 'https://management.azure.com/.default',
    client_secret: credentials.clientSecret,
    grant_type: 'client_credentials',
  });

  try {
    console.log(`[Azure] Requesting access token from Azure AD...`);
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Azure] Authentication failed: ${response.status}`, errorText);
      throw new Error(`Azure authentication failed: ${response.status} ${errorText}`);
    }

    const data: AzureTokenResponse = await response.json();
    cachedAccessToken = data.access_token;
    currentCredentials = credentials;
    // Set expiry to 5 minutes before actual expiry for safety
    tokenExpiry = Date.now() + (data.expires_in - 300) * 1000;
    
    console.log(`[Azure] Access token obtained successfully for account: ${accountConfig.accountName}`);
    return cachedAccessToken;
  } catch (error) {
    console.error('[Azure] Error getting access token:', error);
    throw new Error(`Failed to authenticate with Azure: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export interface AzureCostData {
  date: string;
  provider: "azure";
  service: string;
  cost: number;
  subscriptionName: string;
  resourceGroup?: string;
  currency: string;
}

/**
 * Fetch Azure cost data in unified format (similar to AWS/GCP)
 * Uses caching to prevent rate limit errors
 */
export async function fetchAzureCostData(
  startDate: string,
  endDate: string
): Promise<AzureCostData[]> {
  const { cachedAPICall, createCostCacheKey } = await import('./utils/api-cache');
  
  // Create cache key
  const cacheKey = createCostCacheKey('azure', startDate, endDate);
  
  // Use cached API call with 2-minute TTL
  return cachedAPICall(
    cacheKey,
    'azure',
    async () => {
      // Get account config for subscription ID
      const accountConfig = await getProviderCredentials('azure');
      
      if (!accountConfig) {
        throw new Error("Azure account not configured");
      }

      const credentials = accountConfig.credentials;
      const subscriptionId = credentials.subscriptionId || accountConfig.accountId;
      const billingAccountId = credentials.billingAccountId;

      if (!subscriptionId && !billingAccountId) {
        throw new Error("Azure Subscription ID or Billing Account ID not configured");
      }

      const token = await getAccessToken();
      
      // Prefer billing account scope if available (doesn't require Cost Management Reader role)
      let apiVersion, url;
      if (billingAccountId) {
        console.log(`[Azure] Using Billing Account scope: ${billingAccountId}`);
        apiVersion = "2023-03-01";
        url = `https://management.azure.com/providers/Microsoft.Billing/billingAccounts/${billingAccountId}/providers/Microsoft.CostManagement/query?api-version=${apiVersion}`;
      } else {
        console.log(`[Azure] Using Subscription scope: ${subscriptionId}`);
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
          granularity: "Daily",
          aggregation: {
            totalCost: { name: "PreTaxCost", function: "Sum" },
          },
          grouping: [
            { type: "Dimension", name: "SubscriptionName" },
            { type: "Dimension", name: "ResourceGroup" },
            { type: "Dimension", name: "ServiceName" },
          ],
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
        console.error(`[Azure] Cost Management API failed: ${response.status}`, errorText);
        
        // Check for rate limit error
        if (response.status === 429) {
          throw new Error(
            `Azure API rate limit exceeded. Using cached data if available. ` +
            `Please wait a moment before refreshing.`
          );
        }
        
        // Check for permission error
        if (response.status === 403) {
          throw new Error(
            `Azure Cost Management API permission denied. ` +
            `The service principal needs 'Cost Management Reader' role assigned at the subscription level. ` +
            `See docs/AZURE_PERMISSIONS_SETUP.md for setup instructions.`
          );
        }
        
        throw new Error(`Azure Cost Management API failed: ${response.status} ${errorText}`);
      }

      const data = await response.json();
      const costData: AzureCostData[] = [];

      if (data.properties?.rows) {
        for (const row of data.properties.rows) {
          // Row format: [PreTaxCost, UsageDate, SubscriptionName, ResourceGroup, ServiceName, Currency]
          const [preTaxCost, usageDateNum, subscriptionName, resourceGroup, serviceName, currency] = row;
          
          // Convert usage date from YYYYMMDD to YYYY-MM-DD
          const dateStr = usageDateNum.toString();
          const date = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;

          // IMPORTANT: Filter to only include dates within the requested range
          // Azure API sometimes returns data outside the requested range
          if (date < startDate || date > endDate) {
            console.log(`[Azure] Skipping record outside date range: ${date} (requested: ${startDate} to ${endDate})`);
            continue;
          }

          if (preTaxCost > 0) {
            costData.push({
              date,
              provider: "azure",
              service: serviceName || "Unknown",
              cost: preTaxCost,
              subscriptionName: subscriptionName || "Unknown",
              resourceGroup: resourceGroup || undefined,
              currency: currency || "USD",
            });
          }
        }
      }

      console.log(`[Azure] Fetched ${costData.length} cost records from Cost Management API (after date filtering)`);
      return costData;
    },
    2 * 60 * 1000 // 2-minute cache
  );
}

/**
 * Check if Azure is properly configured
 * Prioritizes credential existence over API test
 */
export async function isAzureConfigured(): Promise<boolean> {
  try {
    // Return cached result if still valid
    if (configurationStatus !== null && Date.now() < configurationCheckTime) {
      console.log(`[Azure] Using cached configuration status: ${configurationStatus ? 'CONFIGURED' : 'NOT CONFIGURED'}`);
      return configurationStatus;
    }

    console.log('[Azure] Checking configuration...');
    
    // Check if credentials exist in database
    const accountConfig = await getProviderCredentials('azure');
    
    if (!accountConfig) {
      console.log('[Azure] No account configuration found in database');
      configurationStatus = false;
      configurationCheckTime = Date.now() + CONFIG_CACHE_DURATION;
      return false;
    }

    const credentials = accountConfig.credentials;
    const subscriptionId = credentials.subscriptionId || accountConfig.accountId;
    const billingAccountId = credentials.billingAccountId;

    console.log('[Azure] Credentials check:', {
      hasTenantId: !!credentials.tenantId,
      hasClientId: !!credentials.clientId,
      hasClientSecret: !!credentials.clientSecret,
      hasSubscriptionId: !!subscriptionId,
      hasBillingAccountId: !!billingAccountId,
    });

    if (!credentials.tenantId || !credentials.clientId || !credentials.clientSecret) {
      console.log('[Azure] Missing required credentials');
      configurationStatus = false;
      configurationCheckTime = Date.now() + CONFIG_CACHE_DURATION;
      return false;
    }

    if (!subscriptionId && !billingAccountId) {
      console.log('[Azure] Missing both subscription ID and billing account ID');
      configurationStatus = false;
      configurationCheckTime = Date.now() + CONFIG_CACHE_DURATION;
      return false;
    }

    // If we have all required credentials, try to get a token
    try {
      const token = await getAccessToken();
      console.log('[Azure] ✅ Successfully obtained access token - Azure is configured');
      
      // Mark as configured immediately since we have valid credentials and token
      configurationStatus = true;
      configurationCheckTime = Date.now() + CONFIG_CACHE_DURATION;
      
      // Optional: Test API call (don't fail if this doesn't work)
      try {
        const endDate = new Date().toISOString().split('T')[0];
        const startDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        
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
          timePeriod: { from: startDate, to: endDate },
          dataset: {
            granularity: "Daily",
            aggregation: { totalCost: { name: "PreTaxCost", function: "Sum" } },
          },
        };

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });

        if (response.ok) {
          console.log(`[Azure] ✅ Test API call successful`);
        } else {
          console.log(`[Azure] ⚠️ Test API call failed (${response.status}), but credentials are valid`);
        }
      } catch (testError) {
        console.log(`[Azure] ⚠️ Test API call error, but credentials are valid:`, testError);
      }
      
      return true;
      
    } catch (tokenError: any) {
      console.error("[Azure] ❌ Failed to get access token:", tokenError.message);
      configurationStatus = false;
      configurationCheckTime = Date.now() + (60 * 1000); // Retry in 1 minute
      return false;
    }
  } catch (error) {
    console.error("[Azure] ❌ Configuration check failed:", error);
    configurationStatus = false;
    configurationCheckTime = Date.now() + (60 * 1000); // Retry in 1 minute
    return false;
  }
}

export class AzureCostManagementClient {
  private config: AzureConfig;
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;

  constructor(config: AzureConfig) {
    this.config = config;
  }

  /**
   * Get OAuth access token from Azure AD
   */
  private async getAccessToken(): Promise<string> {
    // Check if we have a valid cached token
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    const tokenUrl = `https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/token`;
    
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      scope: 'https://management.azure.com/.default',
      client_secret: this.config.clientSecret,
      grant_type: 'client_credentials',
    });

    try {
      const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Azure authentication failed: ${response.status} ${errorText}`);
      }

      const data: AzureTokenResponse = await response.json();
      this.accessToken = data.access_token;
      // Set expiry to 5 minutes before actual expiry for safety
      this.tokenExpiry = Date.now() + (data.expires_in - 300) * 1000;
      
      return this.accessToken;
    } catch (error) {
      console.error('Error getting Azure access token:', error);
      throw new Error(`Failed to authenticate with Azure: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Build the API endpoint URL based on scope
   */
  private getApiEndpoint(): string {
    const baseUrl = 'https://management.azure.com';
    const apiVersion = '2025-03-01';
    
    switch (this.config.scope) {
      case 'subscription':
        return `${baseUrl}/subscriptions/${this.config.subscriptionId}/providers/Microsoft.CostManagement/query?api-version=${apiVersion}`;
      
      case 'resourceGroup':
        if (!this.config.resourceGroupName) {
          throw new Error('Resource group name is required for resourceGroup scope');
        }
        return `${baseUrl}/subscriptions/${this.config.subscriptionId}/resourceGroups/${this.config.resourceGroupName}/providers/Microsoft.CostManagement/query?api-version=${apiVersion}`;
      
      case 'billingAccount':
        if (!this.config.billingAccountId) {
          throw new Error('Billing account ID is required for billingAccount scope');
        }
        return `${baseUrl}/providers/Microsoft.Billing/billingAccounts/${this.config.billingAccountId}/providers/Microsoft.CostManagement/query?api-version=${apiVersion}`;
      
      default:
        throw new Error(`Unsupported scope: ${this.config.scope}`);
    }
  }

  /**
   * Fetch cost data from Azure Cost Management API
   */
  async queryCostData(timeframe: 'MonthToDate' | 'WeekToDate' | 'Custom' = 'MonthToDate'): Promise<AzureCostResponse> {
    const token = await this.getAccessToken();
    const endpoint = this.getApiEndpoint();

    // Build query body similar to sample data structure
    const queryBody: AzureQueryBody = {
      type: 'Usage',
      timeframe,
      dataset: {
        granularity: 'Daily',
        aggregation: {
          totalCost: {
            name: 'PreTaxCost',
            function: 'Sum',
          },
        },
        grouping: [
          { type: 'Dimension', name: 'SubscriptionName' },
          { type: 'Dimension', name: 'ResourceGroup' },
          { type: 'Dimension', name: 'ServiceName' },
        ],
      },
    };

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(queryBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Azure API request failed: ${response.status} ${errorText}`);
      }

      const data = await response.json();
      
      // The Azure API returns data in the format:
      // { properties: { columns: [...], rows: [...] } }
      // We need to transform it to match our schema
      
      return data as AzureCostResponse;
    } catch (error) {
      console.error('Error querying Azure Cost Management API:', error);
      throw new Error(`Failed to fetch cost data from Azure: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Test the Azure connection
   */
  async testConnection(): Promise<boolean> {
    try {
      const token = await this.getAccessToken();
      return !!token;
    } catch (error) {
      console.error('Azure connection test failed:', error);
      return false;
    }
  }
}
