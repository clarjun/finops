/**
 * Generic Service Analyzer
 * Fallback analyzer for services without specific implementation
 * Uses Cost Explorer breakdown to identify optimization opportunities
 */

import { getDeepCostBreakdown } from "../aws-cost-deep-dive";
import { NormalizedResource } from "../types";

export async function genericAnalyzer(
  service: string,
  startDate: string,
  endDate: string
) {
  console.log(`[Generic Analyzer] Analyzing ${service}`);
  
  const breakdown = await getDeepCostBreakdown(service, startDate, endDate);
  const resources: NormalizedResource[] = [];
  let totalCost = 0;

  // Transform breakdown into normalized resources
  Object.entries(breakdown).forEach(([usageType, regionData]: any) => {
    Object.entries(regionData).forEach(([region, data]: any) => {
      totalCost += data.cost;
      const signals: string[] = [];

      // Detect expensive usage types
      if (data.cost > 100) {
        signals.push("HIGH_USAGE_COST");
      }

      // Detect OnDemand purchase type
      if (data.purchase === "OnDemand") {
        signals.push("NO_SAVINGS_PLAN");
      }

      resources.push({
        id: `${usageType}-${region}`,
        type: usageType,
        region,
        configuration: {
          purchaseType: data.purchase,
        },
        estimatedMonthlyCost: data.cost,
        optimizationSignals: signals,
      });
    });
  });

  console.log(`[Generic Analyzer] ✓ Analyzed ${resources.length} usage types, total cost: $${totalCost.toFixed(2)}`);

  return {
    service,
    totalCost,
    resources,
    analyzerType: "GENERIC_COST_EXPLORER_BASED",
  };
}
