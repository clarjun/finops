/**
 * Optimization Calculator
 * Calculates all optimization opportunities and potential savings
 */

import { OptimizationOpportunity } from './types';

export function calculateOptimizationOpportunities(
  wasteData: {
    idleInstances: number;
    unattachedDisks: number;
    lowCpuVMs: number;
    potentialSaving: number;
  },
  purchaseModel: {
    onDemandPercent: number;
    onDemandCost: number;
  },
  storageData: {
    totalStorageCost: number;
    tieringOpportunity: number;
  }
): OptimizationOpportunity[] {
  console.log('[Optimization Calculator] Calculating opportunities');
  
  const opportunities: OptimizationOpportunity[] = [];
  
  // 1. Instance Rightsizing
  if (wasteData.lowCpuVMs > 0) {
    const rightsizingSavings = wasteData.potentialSaving * 0.4; // Estimate 40% of waste from underutilized
    opportunities.push({
      category: 'Instance Rightsizing',
      description: `${wasteData.lowCpuVMs} instances with low CPU utilization can be downsized`,
      monthlySavings: rightsizingSavings,
      effort: 'medium',
      impact: 'high',
      resources: wasteData.lowCpuVMs,
    });
  }
  
  // 2. Reserved Instances / Savings Plans
  if (purchaseModel.onDemandPercent > 50) {
    const riSavings = purchaseModel.onDemandCost * 0.30; // 30% typical RI savings
    opportunities.push({
      category: 'Reserved Instances',
      description: `${purchaseModel.onDemandPercent.toFixed(0)}% of compute is On-Demand. Purchase Reserved Instances or Savings Plans`,
      monthlySavings: riSavings,
      effort: 'low',
      impact: 'high',
      resources: 0,
    });
  }
  
  // 3. Storage Tiering
  if (storageData.tieringOpportunity > 0) {
    opportunities.push({
      category: 'Storage Tiering',
      description: 'Implement lifecycle policies to move infrequently accessed data to cheaper storage tiers',
      monthlySavings: storageData.tieringOpportunity,
      effort: 'low',
      impact: 'medium',
      resources: 0,
    });
  }
  
  // 4. Idle Resources
  if (wasteData.idleInstances > 0 || wasteData.unattachedDisks > 0) {
    const idleSavings = wasteData.potentialSaving * 0.6; // Estimate 60% from idle resources
    opportunities.push({
      category: 'Idle Resources',
      description: `${wasteData.idleInstances} stopped instances and ${wasteData.unattachedDisks} unattached disks can be deleted`,
      monthlySavings: idleSavings,
      effort: 'low',
      impact: 'medium',
      resources: wasteData.idleInstances + wasteData.unattachedDisks,
    });
  }
  
  // Sort by monthly savings
  opportunities.sort((a, b) => b.monthlySavings - a.monthlySavings);
  
  const totalSavings = opportunities.reduce((sum, opp) => sum + opp.monthlySavings, 0);
  console.log(`[Optimization Calculator] ✓ Found ${opportunities.length} opportunities, total savings: $${totalSavings.toFixed(2)}`);
  
  return opportunities;
}
