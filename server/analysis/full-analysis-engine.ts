/**
 * Full Analysis Engine
 * Main orchestrator that coordinates all analysis steps
 */

import { getDeepCostBreakdown } from "./aws-cost-deep-dive";
import { getAzureDeepCostBreakdown } from "./azure-cost-deep-dive";
import { analyzeService } from "./service-analyzer-router";
import { calculateSavings } from "./savings-engine";
import { analyzeWithLLM } from "./ai-analyzer";
import { buildUserAttribution } from "./attribution-engine";
import { FullAnalysisResult } from "./types";

export async function fullServiceAnalysis(
  service: string,
  startDate: string,
  endDate: string,
  provider: 'aws' | 'azure' | 'gcp' = 'aws'
): Promise<FullAnalysisResult> {
  
  console.log(`\n========== FULL SERVICE ANALYSIS ==========`);
  console.log(`Service: ${service}`);
  console.log(`Provider: ${provider.toUpperCase()}`);
  console.log(`Date Range: ${startDate} to ${endDate}`);
  
  // Step 1: Get deep cost breakdown (provider-specific)
  console.log('[Step 1/6] Fetching cost breakdown...');
  let costBreakdown: any = {};
  
  if (provider === 'azure') {
    costBreakdown = await getAzureDeepCostBreakdown(service, startDate, endDate);
  } else if (provider === 'aws') {
    costBreakdown = await getDeepCostBreakdown(service, startDate, endDate);
  } else {
    // GCP - to be implemented
    console.log('[Step 1/6] GCP analysis not yet implemented');
  }
  
  // Calculate total cost
  let totalCost = 0;
  Object.values(costBreakdown).forEach((usage: any) => {
    Object.values(usage).forEach((data: any) => {
      totalCost += data.cost;
    });
  });
  
  console.log(`[Step 1/6] ✓ Total cost: ${totalCost.toFixed(2)}`);
  
  // Step 2: Get infrastructure analysis
  console.log('[Step 2/6] Analyzing infrastructure...');
  const infrastructure = await analyzeService(service, startDate, endDate, provider);
  console.log(`[Step 2/6] ✓ Found ${infrastructure.resources?.length || 0} resources`);
  
  // Step 3: Get user attribution (AWS and Azure)
  console.log('[Step 3/6] Building user attribution...');
  let userAttribution: any[] = [];
  
  if (provider === 'aws' || provider === 'azure') {
    try {
      userAttribution = await buildUserAttribution(service, startDate, endDate, provider);
      console.log(`[Step 3/6] ✓ Found ${userAttribution.length} users with costs`);
    } catch (error: any) {
      console.log(`[Step 3/6] ⚠ Attribution failed: ${error.message}`);
    }
  } else {
    console.log('[Step 3/6] ⊘ User attribution not available for this provider');
  }
  
  // Step 4: Calculate purchase model distribution (AWS-specific)
  console.log('[Step 4/6] Calculating purchase model...');
  let onDemandCost = 0;
  let reservedCost = 0;
  
  if (provider === 'aws') {
    Object.values(costBreakdown).forEach((usage: any) => {
      Object.values(usage).forEach((region: any) => {
        if (region.purchase === "OnDemand") {
          onDemandCost += region.cost;
        } else {
          reservedCost += region.cost;
        }
      });
    });
  } else {
    // For Azure/GCP, assume all on-demand for now
    onDemandCost = totalCost;
  }
  
  const structuredData = {
    service,
    totalCost,
    costBreakdown,
    infrastructure,
    userAttribution,
    purchaseModel: {
      onDemandPercent: totalCost > 0 ? (onDemandCost / totalCost) * 100 : 0,
      reservedPercent: totalCost > 0 ? (reservedCost / totalCost) * 100 : 0,
    },
  };
  
  
  console.log(`[Step 4/6] ✓ On-Demand: ${structuredData.purchaseModel.onDemandPercent.toFixed(1)}%`);
  
  // Step 5: Calculate deterministic savings
  console.log('[Step 5/6] Calculating savings potential...');
  const savings = calculateSavings(structuredData);
  console.log(`[Step 5/6] ✓ Estimated savings: ${savings.estimatedSavingsAmount} (${savings.estimatedSavingsPercent}%)`);
  
  // Step 6: Get AI insights
  console.log('[Step 6/6] Generating AI insights...');
  const aiInsights = await analyzeWithLLM(structuredData, savings);
  console.log(`[Step 6/6] ✓ AI analysis complete (confidence: ${aiInsights.confidenceScore}%)`);
  
  console.log(`===========================================\n`);
  
  return {
    ...structuredData,
    savings,
    aiInsights,
  };
}
