/**
 * AWS Pricing Calculator
 * Calculates costs using AWS Price List API for real-time pricing
 */

import type { ArchitectureLayer } from './architecture-generator';
import { fetchEC2Pricing, fetchRDSPricing, fetchElastiCachePricing } from './aws-price-list-fetcher';

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
  architecture: Array<ArchitectureLayer & { monthlyCost?: number }>;
  totalCost: number;
  breakdown: CostBreakdown;
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

export async function calculateCosts(architecture: ArchitectureLayer[], region: string = 'us-east-1'): Promise<CostEstimate> {
  const breakdown: CostBreakdown = {
    compute: 0,
    database: 0,
    storage: 0,
    network: 0,
    other: 0,
  };

  console.log(`[Pricing Calculator] Calculating costs for ${architecture.length} services in ${region}...`);

  const enrichedArchitecture = await Promise.all(architecture.map(async (layer) => {
    let cost = 0;
    const serviceLower = layer.service.toLowerCase();

    try {
      // EC2 / Compute
      if (serviceLower.includes('ec2') || serviceLower.includes('compute')) {
        cost = await calculateEC2Cost(layer, region);
        breakdown.compute += cost;
      }
      // Lambda
      else if (serviceLower.includes('lambda')) {
        cost = 10; // Simplified estimate
        breakdown.compute += cost;
      }
      // RDS / Database
      else if (serviceLower.includes('rds') || serviceLower.includes('aurora')) {
        cost = await calculateRDSCost(layer, region);
        breakdown.database += cost;
      }
      // DynamoDB
      else if (serviceLower.includes('dynamodb')) {
        cost = 25; // Simplified estimate for on-demand
        breakdown.database += cost;
      }
      // ElastiCache
      else if (serviceLower.includes('elasticache') || serviceLower.includes('redis') || serviceLower.includes('memcached')) {
        cost = await calculateElastiCacheCost(layer, region);
        breakdown.database += cost;
      }
      // S3
      else if (serviceLower.includes('s3')) {
        cost = calculateS3Cost(layer);
        breakdown.storage += cost;
      }
      // CloudFront
      else if (serviceLower.includes('cloudfront') || serviceLower.includes('cdn')) {
        cost = calculateCloudFrontCost(layer);
        breakdown.network += cost;
      }
      // Load Balancer
      else if (serviceLower.includes('load balancer') || serviceLower.includes('alb') || serviceLower.includes('elb')) {
        cost = calculateLoadBalancerCost();
        breakdown.other += cost;
      }
      // SQS / SNS
      else if (serviceLower.includes('sqs') || serviceLower.includes('sns')) {
        cost = 5; // Simplified estimate
        breakdown.other += cost;
      }
      // API Gateway
      else if (serviceLower.includes('api gateway')) {
        cost = 10; // Simplified estimate
        breakdown.other += cost;
      }
      // Route53
      else if (serviceLower.includes('route53') || serviceLower.includes('dns')) {
        cost = 1; // Hosted zone + queries
        breakdown.other += cost;
      }

      console.log(`[Pricing Calculator] ${layer.service}: $${cost.toFixed(2)}/month`);
    } catch (error) {
      console.error(`[Pricing Calculator] Error calculating cost for ${layer.service}:`, error);
      cost = 0;
    }

    return {
      ...layer,
      monthlyCost: cost,
    };
  }));

  const totalCost = Object.values(breakdown).reduce((sum, val) => sum + val, 0);

  console.log(`[Pricing Calculator] Total monthly cost: $${totalCost.toFixed(2)}`);

  return {
    architecture: enrichedArchitecture,
    totalCost,
    breakdown,
  };
}
