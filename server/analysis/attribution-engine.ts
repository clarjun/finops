/**
 * Cost Attribution Engine
 * Aggregates costs by owner/user based on resource tags
 * Uses usage type costs and resource tagging to estimate owner attribution
 * Supports both AWS and Azure
 */

import { getCostByUsageType } from "./aws-cost-explorer";
import { getResourceOwnersByService } from "./aws-tagging-service";
import { getAzureCostByMeterCategory, AzureMeterCategoryCost } from "./azure-cost-explorer";
import { getAzureResourceOwnersByService } from "./azure-tagging-service";

export interface UserCostReport {
  owner: string;
  totalCost: number;
  resourceCount: number;
  usageTypes: {
    usageType: string;
    cost: number;
  }[];
}

export async function buildUserAttribution(
  serviceName: string,
  startDate: string,
  endDate: string,
  provider: 'aws' | 'azure' = 'aws'
): Promise<UserCostReport[]> {
  console.log(`[Attribution Engine] Building user attribution for ${serviceName} (${provider})`);
  
  if (provider === 'azure') {
    return buildAzureUserAttribution(serviceName, startDate, endDate);
  }
  
  return buildAWSUserAttribution(serviceName, startDate, endDate);
}

async function buildAWSUserAttribution(
  serviceName: string,
  startDate: string,
  endDate: string
): Promise<UserCostReport[]> {
  // 1️⃣ Get cost per usage type
  const usageTypeCosts = await getCostByUsageType(
    serviceName,
    startDate,
    endDate
  );

  if (usageTypeCosts.length === 0) {
    console.log('[Attribution Engine] No usage type costs found');
    return [];
  }

  // 2️⃣ Get resource owners from tags
  const resourceOwners = await getResourceOwnersByService(serviceName);

  if (resourceOwners.length === 0) {
    console.log('[Attribution Engine] No tagged resources found, returning usage type breakdown');
    
    // Fallback: Group by linked account if no tags available
    const accountMap: Record<string, UserCostReport> = {};
    
    for (const usage of usageTypeCosts) {
      const owner = usage.linkedAccount || "Unassigned";
      
      if (!accountMap[owner]) {
        accountMap[owner] = {
          owner,
          totalCost: 0,
          resourceCount: 0,
          usageTypes: [],
        };
      }
      
      accountMap[owner].totalCost += usage.cost;
      accountMap[owner].usageTypes.push({
        usageType: usage.usageType,
        cost: usage.cost,
      });
    }
    
    return Object.values(accountMap).sort((a, b) => b.totalCost - a.totalCost);
  }

  // 3️⃣ Count resources per owner
  const ownerResourceCount: Record<string, number> = {};
  for (const resource of resourceOwners) {
    ownerResourceCount[resource.owner] = (ownerResourceCount[resource.owner] || 0) + 1;
  }

  const totalResources = resourceOwners.length;
  const totalCost = usageTypeCosts.reduce((sum, u) => sum + u.cost, 0);

  // 4️⃣ Distribute costs proportionally based on resource count
  const userCostMap: Record<string, UserCostReport> = {};

  for (const [owner, resourceCount] of Object.entries(ownerResourceCount)) {
    const proportion = resourceCount / totalResources;
    const estimatedCost = totalCost * proportion;

    userCostMap[owner] = {
      owner,
      totalCost: estimatedCost,
      resourceCount,
      usageTypes: usageTypeCosts.map(u => ({
        usageType: u.usageType,
        cost: u.cost * proportion,
      })).filter(u => u.cost > 0.01), // Filter out negligible costs
    };
  }

  const result = Object.values(userCostMap).sort(
    (a, b) => b.totalCost - a.totalCost
  );

  console.log(`[Attribution Engine] ✓ Found ${result.length} owners with estimated costs`);
  console.log(`[Attribution Engine] Note: Costs are estimated based on resource count proportion`);
  
  return result;
}

async function buildAzureUserAttribution(
  serviceName: string,
  startDate: string,
  endDate: string
): Promise<UserCostReport[]> {
  // 1️⃣ Get cost per meter category
  const meterCategoryCosts = await getAzureCostByMeterCategory(
    serviceName,
    startDate,
    endDate
  );

  if (meterCategoryCosts.length === 0) {
    console.log('[Attribution Engine] No meter category costs found');
    return [];
  }

  // 2️⃣ Get resource owners from tags
  const resourceOwners = await getAzureResourceOwnersByService(serviceName);

  if (resourceOwners.length === 0) {
    console.log('[Attribution Engine] No tagged resources found, returning meter category breakdown');
    
    // Fallback: Group by resource group if no tags available
    const rgMap: Record<string, UserCostReport> = {};
    
    for (const meter of meterCategoryCosts) {
      const owner = meter.resourceGroup || "Unassigned";
      
      if (!rgMap[owner]) {
        rgMap[owner] = {
          owner,
          totalCost: 0,
          resourceCount: 0,
          usageTypes: [],
        };
      }
      
      rgMap[owner].totalCost += meter.cost;
      rgMap[owner].usageTypes.push({
        usageType: meter.meterCategory,
        cost: meter.cost,
      });
    }
    
    return Object.values(rgMap).sort((a, b) => b.totalCost - a.totalCost);
  }

  // 3️⃣ Count resources per owner
  const ownerResourceCount: Record<string, number> = {};
  for (const resource of resourceOwners) {
    ownerResourceCount[resource.owner] = (ownerResourceCount[resource.owner] || 0) + 1;
  }

  const totalResources = resourceOwners.length;
  const totalCost = meterCategoryCosts.reduce((sum: number, m: AzureMeterCategoryCost) => sum + m.cost, 0);

  // 4️⃣ Distribute costs proportionally based on resource count
  const userCostMap: Record<string, UserCostReport> = {};

  for (const [owner, resourceCount] of Object.entries(ownerResourceCount)) {
    const proportion = resourceCount / totalResources;
    const estimatedCost = totalCost * proportion;

    userCostMap[owner] = {
      owner,
      totalCost: estimatedCost,
      resourceCount,
      usageTypes: meterCategoryCosts.map((m: AzureMeterCategoryCost) => ({
        usageType: m.meterCategory,
        cost: m.cost * proportion,
      })).filter((u: { usageType: string; cost: number }) => u.cost > 0.01), // Filter out negligible costs
    };
  }

  const result = Object.values(userCostMap).sort(
    (a, b) => b.totalCost - a.totalCost
  );

  console.log(`[Attribution Engine] ✓ Found ${result.length} owners with estimated costs`);
  console.log(`[Attribution Engine] Note: Costs are estimated based on resource count proportion`);
  
  return result;
}
