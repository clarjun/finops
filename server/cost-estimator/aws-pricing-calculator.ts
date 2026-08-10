/**
 * AWS Pricing Calculator
 * Calculates costs using AWS Price List API for real-time pricing
 */

import type { ArchitectureLayer } from './architecture-generator';
import { fetchEC2Pricing, fetchRDSPricing, fetchElastiCachePricing } from './aws-price-list-fetcher';
import { priceLayer, buildUsageModel, INSTANCE_PRICED, type UsageModel } from './service-pricing';

// Storage pricing (per GB/month) - relatively stable, can be hardcoded
const STORAGE_PRICING = {
  s3Standard: 0.023,
  s3InfrequentAccess: 0.0125,
  ebsGp3: 0.08,
  ebsSsd: 0.10,
  rdsStorage: 0.115,
};

// Data transfer pricing (per GB) - relatively stable
const DATA_TRANSFER_PRICING = {
  cloudFrontToInternet: 0.085,
  ec2ToInternet: 0.09,
  dataTransferIn: 0, // Free
};

// Other services (monthly) - relatively stable
const OTHER_PRICING = {
  albHourly: 0.0225,
  natGatewayHourly: 0.045,
  route53HostedZone: 0.50,
};

export interface CostBreakdown {
  compute: number;
  database: number;
  storage: number;
  network: number;
  other: number;
}

export interface CostEstimate {
  architecture: Array<ArchitectureLayer & {
    monthlyCost?: number;
    /** How the figure was reached, so a reader can check it. */
    costBasis?: string;
    /** True when nothing here could price it; the cost is absent, not zero. */
    unpriced?: boolean;
  }>;
  totalCost: number;
  breakdown: CostBreakdown;
  /** The assumptions every request-priced line was derived from. */
  usage: UsageModel;
  /** Services excluded from the total because they could not be priced. */
  unpriced: string[];
}

async function calculateEC2Cost(layer: ArchitectureLayer, region: string): Promise<number> {
  const instanceType = layer.instanceType || 't3.medium';
  const instanceCount = layer.instanceCount || 1;
  
  const hourlyRate = await fetchEC2Pricing(instanceType, region);
  
  // 730 hours per month
  return hourlyRate * 730 * instanceCount;
}

async function calculateRDSCost(layer: ArchitectureLayer, region: string): Promise<number> {
  const instanceType = layer.instanceType || 'db.t3.medium';
  const instanceCount = layer.instanceCount || 1;
  const storageSize = layer.storageSize || 100;
  
  // Detect database engine from service name
  let engine = 'PostgreSQL';
  const serviceLower = layer.service.toLowerCase();
  if (serviceLower.includes('mysql')) engine = 'MySQL';
  else if (serviceLower.includes('aurora')) engine = 'Aurora MySQL';
  else if (serviceLower.includes('mariadb')) engine = 'MariaDB';
  
  const hourlyRate = await fetchRDSPricing(instanceType, engine, region);
  const computeCost = hourlyRate * 730 * instanceCount;
  const storageCost = storageSize * STORAGE_PRICING.rdsStorage;
  
  return computeCost + storageCost;
}

async function calculateElastiCacheCost(layer: ArchitectureLayer, region: string): Promise<number> {
  const instanceType = layer.instanceType || 'cache.t3.medium';
  const instanceCount = layer.instanceCount || 1;
  
  // Detect engine from service name
  let engine = 'Redis';
  if (layer.service.toLowerCase().includes('memcached')) {
    engine = 'Memcached';
  }
  
  const hourlyRate = await fetchElastiCachePricing(instanceType, engine, region);
  
  return hourlyRate * 730 * instanceCount;
}

function calculateS3Cost(layer: ArchitectureLayer): number {
  const storageSize = layer.storageSize || 100;
  return storageSize * STORAGE_PRICING.s3Standard;
}

function calculateCloudFrontCost(layer: ArchitectureLayer): number {
  const dataTransfer = layer.dataTransfer || 1000; // GB per month
  return dataTransfer * DATA_TRANSFER_PRICING.cloudFrontToInternet;
}

function calculateLoadBalancerCost(): number {
  // ALB: $0.0225 per hour + $0.008 per LCU-hour (simplified)
  return OTHER_PRICING.albHourly * 730 + 15; // ~$15 for LCU
}

export async function calculateCosts(
  architecture: ArchitectureLayer[],
  region: string = 'us-east-1',
  assumptions: { dailyActiveUsers?: number | null; requestsPerUserPerDay?: number | null } = {},
): Promise<CostEstimate> {
  const breakdown: CostBreakdown = { compute: 0, database: 0, storage: 0, network: 0, other: 0 };

  // Every request-priced line is derived from this, so the stated audience
  // actually reaches the numbers. Previously it reached nothing: Lambda,
  // DynamoDB, SQS and API Gateway were flat constants.
  const usage = buildUsageModel(assumptions);
  const unpricedServices: string[] = [];

  console.log(`[Pricing] ${architecture.length} services in ${region}, ` +
    `${usage.dailyActiveUsers} daily users -> ${usage.monthlyRequests.toLocaleString()} requests/month`);

  const enriched = await Promise.all(architecture.map(async (layer) => {
    const text = `${layer.service} ${layer.layer ?? ''}`;

    try {
      // Instance-priced services keep the live Price List API: their rate
      // depends on an instance type, which is exactly what that API is for.
      if (INSTANCE_PRICED.test(text)) {
        const { cost, category, basis } = await priceInstanceService(layer, region);
        breakdown[category] += cost;
        return { ...layer, monthlyCost: round(cost), costBasis: basis };
      }

      const components = priceLayer(layer as never, usage);

      if (components.length === 0) {
        // Not zero. A service nobody could price is reported as such and left
        // out of the total, rather than quietly making the estimate look
        // cheaper than it is.
        unpricedServices.push(layer.service);
        return {
          ...layer,
          monthlyCost: undefined,
          unpriced: true,
          costBasis: `No pricing model for "${layer.service}". Excluded from the total rather than counted as free.`,
        };
      }

      // A line naming two services is charged for both.
      let total = 0;
      const bases: string[] = [];
      for (const c of components) {
        if (c.line.cost == null) continue;
        total += c.line.cost;
        breakdown[c.category] += c.line.cost;
        bases.push(components.length > 1 ? `${c.service}: ${c.line.basis}` : c.line.basis);
      }

      return { ...layer, monthlyCost: round(total), costBasis: bases.join(' · ') };
    } catch (error) {
      console.error(`[Pricing] ${layer.service}:`, error);
      unpricedServices.push(layer.service);
      return {
        ...layer,
        monthlyCost: undefined,
        unpriced: true,
        costBasis: `Pricing failed for "${layer.service}"; excluded from the total.`,
      };
    }
  }));

  const totalCost = round(Object.values(breakdown).reduce((sum, v) => sum + v, 0));
  console.log(`[Pricing] total $${totalCost}/month, ${unpricedServices.length} service(s) unpriced`);

  return { architecture: enriched, totalCost, breakdown, usage, unpriced: unpricedServices };
}

/** EC2, RDS, ElastiCache and load balancers, whose rate depends on a size. */
async function priceInstanceService(
  layer: ArchitectureLayer,
  region: string,
): Promise<{ cost: number; category: keyof CostBreakdown; basis: string }> {
  const text = `${layer.service} ${layer.layer ?? ''}`.toLowerCase();

  if (/\brds\b|\baurora\b/.test(text)) {
    const cost = await calculateRDSCost(layer, region);
    return { cost, category: 'database',
      basis: `${layer.instanceCount ?? 1} × ${layer.instanceType ?? 'db.t3.medium'} for 730 hours, plus ${layer.storageSize ?? 100} GB of storage` };
  }
  if (/elasticache|\bredis\b|memcached/.test(text)) {
    const cost = await calculateElastiCacheCost(layer, region);
    return { cost, category: 'database',
      basis: `${layer.instanceCount ?? 1} × ${layer.instanceType ?? 'cache.t3.medium'} for 730 hours` };
  }
  if (/load balancer|\balb\b|\belb\b/.test(text)) {
    const cost = calculateLoadBalancerCost();
    return { cost, category: 'network', basis: 'one application load balancer for 730 hours, plus capacity units' };
  }

  const cost = await calculateEC2Cost(layer, region);
  return { cost, category: 'compute',
    basis: `${layer.instanceCount ?? 1} × ${layer.instanceType ?? 't3.medium'} for 730 hours` };
}

const round = (n: number): number => Number(n.toFixed(2));
