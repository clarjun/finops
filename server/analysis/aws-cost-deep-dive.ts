/**
 * AWS Cost Deep Dive
 * Fetches granular cost breakdown by usage type and region
 * Note: AWS Cost Explorer API only allows 2 GroupBy dimensions
 */

import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import { getProviderCredentials } from "../cloud-config-manager";

export async function getDeepCostBreakdown(
  serviceName: string,
  startDate: string,
  endDate: string
): Promise<Record<string, Record<string, any>>> {
  try {
    // Get AWS credentials from database
    const accountConfig = await getProviderCredentials('aws');
    
    if (!accountConfig) {
      console.log('[Cost Deep Dive] AWS not configured, returning empty breakdown');
      return {};
    }

    const credentials = accountConfig.credentials;
    
    const ceClient = new CostExplorerClient({
      region: credentials.region || "us-east-1",
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
      },
    });

    console.log(`[Cost Deep Dive] Fetching breakdown for ${serviceName}`);

    // AWS only allows 2 GroupBy dimensions, so we'll use USAGE_TYPE and REGION
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
        { Type: "DIMENSION", Key: "USAGE_TYPE" },
        { Type: "DIMENSION", Key: "REGION" },
      ],
    });

    const response = await ceClient.send(command);
    
    // Transform to nested structure: { usageType: { region: { cost } } }
    const breakdown: Record<string, Record<string, any>> = {};
    
    for (const result of response.ResultsByTime || []) {
      for (const group of result.Groups || []) {
        const [usageType, region] = group.Keys || [];
        const cost = parseFloat(group.Metrics?.UnblendedCost?.Amount || "0");
        
        if (cost > 0) {
          if (!breakdown[usageType]) breakdown[usageType] = {};
          if (!breakdown[usageType][region]) {
            breakdown[usageType][region] = { cost: 0 };
          }
          breakdown[usageType][region].cost += cost;
        }
      }
    }
    
    console.log(`[Cost Deep Dive] ✓ Found ${Object.keys(breakdown).length} usage types`);
    return breakdown;
    
  } catch (error: any) {
    console.error('[Cost Deep Dive] Error:', error.message);
    return {};
  }
}
