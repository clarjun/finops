/**
 * Azure Resource Tagging Service
 * Fetches Owner tags from Azure resources for a specific service
 */

import { getProviderCredentials } from "../cloud-config-manager";

export interface AzureResourceOwner {
  resourceId: string;
  resourceType: string;
  resourceGroup: string;
  owner: string;
  tags: Record<string, string>;
}

export async function getAzureResourceOwnersByService(
  serviceName: string
): Promise<AzureResourceOwner[]> {
  try {
    // Get Azure credentials from database
    const accountConfig = await getProviderCredentials('azure');
    
    if (!accountConfig) {
      console.log('[Azure Tagging Service] Azure not configured');
      return [];
    }

    const credentials = accountConfig.credentials;
    const subscriptionId = credentials.subscriptionId || accountConfig.accountId;

    if (!subscriptionId) {
      console.log('[Azure Tagging Service] No subscription ID configured');
      return [];
    }

    console.log(`[Azure Tagging Service] Fetching resource owners for ${serviceName}`);

    // Get access token
    const { getAccessToken } = await import('../azure-client');
    const token = await getAccessToken();

    const resources: AzureResourceOwner[] = [];
    
    // Map service names to Azure resource type filters
    const serviceTypeMap: Record<string, string[]> = {
      "Virtual Machines": ["Microsoft.Compute/virtualMachines"],
      "Storage": ["Microsoft.Storage/storageAccounts"],
      "Azure App Service": ["Microsoft.Web/sites"],
      "SQL Database": ["Microsoft.Sql/servers"],
      "Azure Database for MySQL": ["Microsoft.DBforMySQL/servers"],
      "Azure Database for PostgreSQL": ["Microsoft.DBforPostgreSQL/servers"],
      "Azure Kubernetes Service": ["Microsoft.ContainerService/managedClusters"],
      "Azure Functions": ["Microsoft.Web/sites"],
      "Bandwidth": [], // Network resources don't have specific types
      "Azure Monitor": ["Microsoft.Insights/components"],
    };

    const resourceTypes = serviceTypeMap[serviceName] || [];

    // Fetch all resources in the subscription
    const apiVersion = "2021-04-01";
    let url = `https://management.azure.com/subscriptions/${subscriptionId}/resources?api-version=${apiVersion}`;
    
    // Add resource type filter if available
    if (resourceTypes.length > 0) {
      const filterQuery = resourceTypes.map(rt => `resourceType eq '${rt}'`).join(' or ');
      url += `&$filter=${encodeURIComponent(filterQuery)}`;
    }

    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    let totalFetched = 0;
    let nextLink: string | null = url;

    while (nextLink) {
      const response: Response = await fetch(nextLink, {
        method: 'GET',
        headers,
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[Azure Tagging Service] API failed: ${response.status}`, errorText);
        break;
      }

      const data: any = await response.json();
      totalFetched += data.value?.length || 0;

      for (const resource of data.value || []) {
        const resourceId = resource.id;
        const resourceType = resource.type || 'unknown';
        const resourceGroup = resource.resourceGroup || 'Unknown';
        const tags = resource.tags || {};

        // Look for Owner tag (case-insensitive)
        let owner = "Unassigned";
        for (const [key, value] of Object.entries(tags)) {
          if (key.toLowerCase() === 'owner') {
            owner = value as string;
            break;
          }
        }

        resources.push({
          resourceId,
          resourceType,
          resourceGroup,
          owner,
          tags,
        });
      }

      // Handle pagination
      nextLink = data.nextLink || null;
    }

    console.log(`[Azure Tagging Service] ✓ Fetched ${totalFetched} resources, found ${resources.filter(r => r.owner !== 'Unassigned').length} with owners`);
    
    return resources;
    
  } catch (error: any) {
    console.error('[Azure Tagging Service] Error:', error.message);
    return [];
  }
}
