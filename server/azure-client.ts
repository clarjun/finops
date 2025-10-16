import type { AzureConfig, AzureQueryBody, AzureCostResponse } from "@shared/schema";

interface AzureTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
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
