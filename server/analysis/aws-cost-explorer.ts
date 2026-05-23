/**
 * AWS Cost Explorer - Usage type level cost fetching
 * Gets cost breakdown by usage type and linked account
 * Note: AWS Cost Explorer doesn't support RESOURCE_ID grouping
 */

import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import { getProviderCredentials } from "../cloud-config-manager";

export interface UsageTypeCost {
  usageType: string;
  linkedAccount: string;
  cost: number;
}

export async function getCostByUsageType(
  serviceName: string,
  startDate: string,
  endDate: string
): Promise<UsageTypeCost[]> {
  try {
    // Get AWS credentials from database
    const accountConfig = await getProviderCredentials('aws');
    
    if (!accountConfig) {
      console.log('[Cost Explorer] AWS not configured');
      return [];
    }

    const credentials = accountConfig.credentials;
    
    const ceClient = new CostExplorerClient({
      region: credentials.region || "us-east-1",
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
      },
    });

    console.log(`[Cost Explorer] Fetching usage type costs for ${serviceName}`);

    const command = new GetCostAndUsageCommand({
      TimePeriod: { Start: startDate, End: endDate },
      Granularity: "MONTHLY",
      Metrics: ["UnblendedCost"],
      Filter: {
        Dimensions: {
          Key: "SERVICE",
          Values: [serviceName],
        },
      },
      GroupBy: [
        {
          Type: "DIMENSION",
          Key: "USAGE_TYPE",
        },
        {
          Type: "DIMENSION",
          Key: "LINKED_ACCOUNT",
        },
      ],
    });

    const response = await ceClient.send(command);
    const results: UsageTypeCost[] = [];

    response.ResultsByTime?.forEach((time) => {
      time.Groups?.forEach((group) => {
        const [usageType, linkedAccount] = group.Keys || [];
        const cost = parseFloat(
          group.Metrics?.UnblendedCost?.Amount || "0"
        );

        if (usageType && cost > 0) {
          results.push({ 
            usageType, 
            linkedAccount: linkedAccount || "Unknown",
            cost 
          });
        }
      });
    });

    console.log(`[Cost Explorer] ✓ Found ${results.length} usage types with costs`);
    return results;
    
  } catch (error: any) {
    console.error('[Cost Explorer] Error:', error.message);
    return [];
  }
}
