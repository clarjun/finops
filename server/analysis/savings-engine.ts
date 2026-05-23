/**
 * Savings Calculation Engine
 * Deterministic savings calculation based on infrastructure data
 */

import { SavingsResult } from './types';

export function calculateSavings(data: any): SavingsResult {
  let savings = 0;
  const reasons: string[] = [];

  // 1. Compute Optimizer Savings
  if (data.infrastructure?.optimizerRecommendations?.length > 0) {
    const optimizerSavings = data.infrastructure.optimizerRecommendations.reduce(
      (sum: number, rec: any) =>
        sum + (rec.recommendationOptions?.[0]?.estimatedMonthlySavings?.value || 0),
      0
    );
    savings += optimizerSavings;
    if (optimizerSavings > 0) {
      reasons.push(`Compute Optimizer recommendations: $${optimizerSavings.toFixed(2)}`);
    }
  }

  // 2. High-Cost Resources (Rightsizing Opportunities)
  if (data.infrastructure?.resources) {
    const highCostResources = data.infrastructure.resources.filter(
      (r: any) => r.optimizationSignals?.includes('HIGH_USAGE_COST')
    );
    if (highCostResources.length > 0) {
      // Calculate total cost of high-cost resources
      const highCostTotal = highCostResources.reduce(
        (sum: number, r: any) => sum + (r.estimatedMonthlyCost || 0),
        0
      );
      // Conservative 20% savings through rightsizing
      const rightsizingSavings = highCostTotal * 0.20;
      savings += rightsizingSavings;
      reasons.push(`${highCostResources.length} high-cost resources identified for rightsizing (potential 20% reduction)`);
    }
  }

  // 3. Idle Resource Detection (CPU < 10%)
  if (data.infrastructure?.resources) {
    const idleResources = data.infrastructure.resources.filter(
      (r: any) => r.utilization?.cpu && r.utilization.cpu < 10
    );
    if (idleResources.length > 0) {
      const idleSavings = data.totalCost * 0.25; // Conservative 25%
      savings += idleSavings;
      reasons.push(`${idleResources.length} idle resources detected (CPU < 10%)`);
    }
  }

  // 4. Low Utilization Detection (CPU 10-30%)
  if (data.infrastructure?.resources) {
    const lowUtilResources = data.infrastructure.resources.filter(
      (r: any) => r.utilization?.cpu && r.utilization.cpu >= 10 && r.utilization.cpu < 30
    );
    if (lowUtilResources.length > 0) {
      const lowUtilSavings = data.totalCost * 0.15; // 15% savings potential
      savings += lowUtilSavings;
      reasons.push(`${lowUtilResources.length} underutilized resources (CPU 10-30%)`);
    }
  }

  // 5. No Savings Plan/Reserved Coverage
  if (data.purchaseModel?.onDemandPercent >= 80) {
    const purchaseSavings = data.totalCost * 0.30; // 30% typical savings
    savings += purchaseSavings;
    reasons.push(`${data.purchaseModel.onDemandPercent.toFixed(0)}% On-Demand usage (no commitment discounts)`);
  }

  // 6. Storage Optimization (S3)
  if (data.infrastructure?.resources) {
    const largeStorageResources = data.infrastructure.resources.filter(
      (r: any) => r.optimizationSignals?.includes('LARGE_BUCKET_NO_TIERING')
    );
    if (largeStorageResources.length > 0) {
      const storageSavings = data.totalCost * 0.20; // 20% with tiering
      savings += storageSavings;
      reasons.push(`${largeStorageResources.length} large buckets without lifecycle policies`);
    }
  }

  // 7. Multi-AZ without need (RDS)
  if (data.infrastructure?.resources) {
    const multiAZResources = data.infrastructure.resources.filter(
      (r: any) => r.optimizationSignals?.includes('MULTI_AZ_ENABLED')
    );
    if (multiAZResources.length > 0 && data.totalCost > 100) {
      const multiAZSavings = data.totalCost * 0.50; // Multi-AZ doubles cost
      savings += multiAZSavings;
      reasons.push(`${multiAZResources.length} Multi-AZ databases (consider single-AZ for dev/test)`);
    }
  }

  return {
    estimatedSavingsAmount: parseFloat(savings.toFixed(2)),
    estimatedSavingsPercent: data.totalCost > 0 
      ? parseFloat(((savings / data.totalCost) * 100).toFixed(2))
      : 0,
    breakdown: reasons,
  };
}
