/**
 * Expensive Resources Fetcher
 * Fetches actual individual resources with their costs
 */

import { ExpensiveResource } from './types';
import { fetchAWSCostData } from '../aws-client';
import { getProviderCredentials } from '../cloud-config-manager';

/**
 * Fetch top expensive resources for AWS
 * Uses Cost Explorer with RESOURCE_ID grouping
 */
async function fetchAWSExpensiveResources(
  startDate: string,
  endDate: string,
  limit: number = 10
): Promise<ExpensiveResource[]> {
  try {
    const { CostExplorerClient, GetCostAndUsageCommand } = await import("@aws-sdk/client-cost-explorer");
    
    const accountConfig = await getProviderCredentials('aws');
    if (!accountConfig) {
      console.log('[Expensive Resources] AWS not configured');
      return [];
    }

    const credentials = accountConfig.credentials;
    const client = new CostExplorerClient({
      region: credentials.region || "us-east-1",
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
      },
    });

    // Fetch costs grouped by resource ID and service
    const command = new GetCostAndUsageCommand({
      TimePeriod: {
        Start: startDate,
        End: endDate,
      },
      Granularity: "MONTHLY",
      Metrics: ["UnblendedCost"],
      GroupBy: [
        {
          Type: "DIMENSION",
          Key: "RESOURCE_ID",
        },
        {
          Type: "DIMENSION",
          Key: "SERVICE",
        },
      ],
    });

    const response = await client.send(command);
    
    if (!response.ResultsByTime || response.ResultsByTime.length === 0) {
      console.log('[Expensive Resources] No resource data available');
      return [];
    }

    // Aggregate costs by resource
    const resourceMap = new Map<string, {
      resourceId: string;
      service: string;
      cost: number;
    }>();

    for (const result of response.ResultsByTime) {
      if (result.Groups) {
        for (const group of result.Groups) {
          const resourceId = group.Keys?.[0] || 'Unknown';
          const service = group.Keys?.[1] || 'Unknown';
          const cost = parseFloat(group.Metrics?.UnblendedCost?.Amount || '0');

          if (cost > 0 && resourceId !== 'NoResourceId' && resourceId !== 'Unknown') {
            const key = `${resourceId}:${service}`;
            const existing = resourceMap.get(key);
            
            if (existing) {
              existing.cost += cost;
            } else {
              resourceMap.set(key, {
                resourceId,
                service,
                cost,
              });
            }
          }
        }
      }
    }

    // Convert to array and sort by cost
    const resources = Array.from(resourceMap.values())
      .sort((a, b) => b.cost - a.cost)
      .slice(0, limit);

    // Format as ExpensiveResource
    const expensiveResources: ExpensiveResource[] = resources.map(r => ({
      resourceId: r.resourceId,
      resourceName: extractResourceName(r.resourceId),
      service: r.service,
      cost: r.cost,
      region: extractRegion(r.resourceId),
      owner: undefined,
    }));

    console.log(`[Expensive Resources] Found ${expensiveResources.length} expensive resources`);
    return expensiveResources;

  } catch (error: any) {
    console.error('[Expensive Resources] Error fetching AWS resources:', error.message);
    return [];
  }
}

/**
 * Extract a readable resource name from resource ID
 * AWS resource IDs are often ARNs or instance IDs
 */
function extractResourceName(resourceId: string): string {
  // Handle ARNs (arn:aws:service:region:account:resource/name)
  if (resourceId.startsWith('arn:')) {
    const parts = resourceId.split(':');
    const resourcePart = parts[parts.length - 1];
    return resourcePart.split('/').pop() || resourceId;
  }
  
  // Handle instance IDs (i-xxxxx, vol-xxxxx, etc.)
  if (resourceId.match(/^(i|vol|snap|ami|sg|vpc|subnet|eni|eip|igw|nat|rtb|acl)-[a-z0-9]+$/)) {
    return resourceId;
  }
  
  // Handle S3 buckets and other simple names
  return resourceId;
}

/**
 * Extract region from resource ID (if available)
 */
function extractRegion(resourceId: string): string {
  // Handle ARNs
  if (resourceId.startsWith('arn:')) {
    const parts = resourceId.split(':');
    if (parts.length >= 4) {
      return parts[3] || 'unknown';
    }
  }
  
  return 'unknown';
}

/**
 * Fetch expensive resources for any provider
 */
export async function fetchExpensiveResources(
  provider: 'aws' | 'azure' | 'gcp',
  startDate: string,
  endDate: string,
  limit: number = 10
): Promise<ExpensiveResource[]> {
  console.log(`[Expensive Resources] Fetching for ${provider}`);
  
  switch (provider) {
    case 'aws':
      return await fetchAWSExpensiveResources(startDate, endDate, limit);
    
    case 'azure':
      // Azure implementation would go here
      console.log('[Expensive Resources] Azure not yet implemented');
      return [];
    
    case 'gcp':
      // GCP implementation would go here
      console.log('[Expensive Resources] GCP not yet implemented');
      return [];
    
    default:
      return [];
  }
}
