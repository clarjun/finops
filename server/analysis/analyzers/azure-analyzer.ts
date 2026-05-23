/**
 * Azure Service Analyzer
 * Analyzes Azure services using Cost Management API
 */

import { getAzureDeepCostBreakdown } from "../azure-cost-deep-dive";
import { NormalizedResource } from "../types";

export async function azureAnalyzer(
  service: string,
  startDate: string,
  endDate: string
) {
  console.log(`[Azure Analyzer] Analyzing ${service}`);
  
  const breakdown = await getAzureDeepCostBreakdown(service, startDate, endDate);
  const resources: NormalizedResource[] = [];
  let totalCost = 0;

  // Transform breakdown into normalized resources
  Object.entries(breakdown).forEach(([meterCategory, resourceGroupData]: any) => {
    Object.entries(resourceGroupData).forEach(([resourceGroup, data]: any) => {
      totalCost += data.cost;
      const signals: string[] = [];

      // Detect expensive resources
      if (data.cost > 100) {
        signals.push("HIGH_USAGE_COST");
      }

      // Detect resources without resource group (poor organization)
      if (resourceGroup === "No Resource Group") {
        signals.push("NO_RESOURCE_GROUP");
      }

      resources.push({
        id: `${meterCategory}-${resourceGroup}`,
        type: meterCategory,
        region: data.location,
        configuration: {
          resourceGroup,
        },
        estimatedMonthlyCost: data.cost,
        optimizationSignals: signals,
      });
    });
  });

  console.log(`[Azure Analyzer] ✓ Analyzed ${resources.length} meter categories, total cost: ${totalCost.toFixed(2)}`);

  return {
    service,
    totalCost,
    resources,
    analyzerType: "AZURE_COST_MANAGEMENT_BASED",
  };
}
