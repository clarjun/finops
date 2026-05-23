/**
 * AWS Price List API Fetcher
 * Fetches real-time pricing data from AWS Price List API
 */

import { PricingClient, GetProductsCommand, type Filter as PricingFilterType } from "@aws-sdk/client-pricing";
import { getProviderCredentials } from "../cloud-config-manager";

// Cache pricing data for 24 hours to reduce API calls
const pricingCache = new Map<string, { price: number; timestamp: number }>();
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

interface PricingFilter {
  Type: string;
  Field: string;
  Value: string;
}

/**
 * Get AWS Pricing client
 */
async function getPricingClient(): Promise<PricingClient> {
  const accountConfig = await getProviderCredentials('aws');
  
  if (!accountConfig) {
    throw new Error('AWS credentials not configured');
  }

  const credentials = accountConfig.credentials;
  
  // Pricing API is only available in us-east-1 and ap-south-1
  return new PricingClient({
    region: 'us-east-1',
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
  });
}

/**
 * Fetch EC2 instance pricing
 */
export async function fetchEC2Pricing(instanceType: string, region: string = 'us-east-1'): Promise<number> {
  const cacheKey = `ec2-${instanceType}-${region}`;
  
  // Check cache
  const cached = pricingCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    console.log(`[Price List] Using cached price for ${instanceType}: $${cached.price}/hour`);
    return cached.price;
  }

  try {
    const client = await getPricingClient();
    
    const filters: PricingFilter[] = [
      { Type: 'TERM_MATCH', Field: 'instanceType', Value: instanceType },
      { Type: 'TERM_MATCH', Field: 'location', Value: getRegionName(region) },
      { Type: 'TERM_MATCH', Field: 'operatingSystem', Value: 'Linux' },
      { Type: 'TERM_MATCH', Field: 'tenancy', Value: 'Shared' },
      { Type: 'TERM_MATCH', Field: 'preInstalledSw', Value: 'NA' },
      { Type: 'TERM_MATCH', Field: 'capacitystatus', Value: 'Used' },
    ];

    const command = new GetProductsCommand({
      ServiceCode: 'AmazonEC2',
      Filters: filters as PricingFilterType[],
      MaxResults: 1,
    });

    const response = await client.send(command);
    
    if (!response.PriceList || response.PriceList.length === 0) {
      console.warn(`[Price List] No pricing found for ${instanceType}, using fallback`);
      return getFallbackEC2Price(instanceType);
    }

    const priceData = JSON.parse(response.PriceList[0]);
    const onDemand = priceData.terms.OnDemand;
    const priceKey = Object.keys(onDemand)[0];
    const priceDimensions = onDemand[priceKey].priceDimensions;
    const dimensionKey = Object.keys(priceDimensions)[0];
    const pricePerHour = parseFloat(priceDimensions[dimensionKey].pricePerUnit.USD);

    // Cache the result
    pricingCache.set(cacheKey, { price: pricePerHour, timestamp: Date.now() });
    
    console.log(`[Price List] Fetched price for ${instanceType}: $${pricePerHour}/hour`);
    return pricePerHour;
  } catch (error) {
    console.error(`[Price List] Error fetching EC2 pricing for ${instanceType}:`, error);
    return getFallbackEC2Price(instanceType);
  }
}

/**
 * Fetch RDS instance pricing
 */
export async function fetchRDSPricing(instanceType: string, engine: string = 'PostgreSQL', region: string = 'us-east-1'): Promise<number> {
  const cacheKey = `rds-${instanceType}-${engine}-${region}`;
  
  const cached = pricingCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    console.log(`[Price List] Using cached price for RDS ${instanceType}: $${cached.price}/hour`);
    return cached.price;
  }

  try {
    const client = await getPricingClient();
    
    const filters: PricingFilter[] = [
      { Type: 'TERM_MATCH', Field: 'instanceType', Value: instanceType },
      { Type: 'TERM_MATCH', Field: 'location', Value: getRegionName(region) },
      { Type: 'TERM_MATCH', Field: 'databaseEngine', Value: engine },
      { Type: 'TERM_MATCH', Field: 'deploymentOption', Value: 'Single-AZ' },
    ];

    const command = new GetProductsCommand({
      ServiceCode: 'AmazonRDS',
      Filters: filters as PricingFilterType[],
      MaxResults: 1,
    });

    const response = await client.send(command);
    
    if (!response.PriceList || response.PriceList.length === 0) {
      console.warn(`[Price List] No pricing found for RDS ${instanceType}, using fallback`);
      return getFallbackRDSPrice(instanceType);
    }

    const priceData = JSON.parse(response.PriceList[0]);
    const onDemand = priceData.terms.OnDemand;
    const priceKey = Object.keys(onDemand)[0];
    const priceDimensions = onDemand[priceKey].priceDimensions;
    const dimensionKey = Object.keys(priceDimensions)[0];
    const pricePerHour = parseFloat(priceDimensions[dimensionKey].pricePerUnit.USD);

    pricingCache.set(cacheKey, { price: pricePerHour, timestamp: Date.now() });
    
    console.log(`[Price List] Fetched price for RDS ${instanceType}: $${pricePerHour}/hour`);
    return pricePerHour;
  } catch (error) {
    console.error(`[Price List] Error fetching RDS pricing for ${instanceType}:`, error);
    return getFallbackRDSPrice(instanceType);
  }
}

/**
 * Fetch ElastiCache pricing
 */
export async function fetchElastiCachePricing(instanceType: string, engine: string = 'Redis', region: string = 'us-east-1'): Promise<number> {
  const cacheKey = `elasticache-${instanceType}-${engine}-${region}`;
  
  const cached = pricingCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return cached.price;
  }

  try {
    const client = await getPricingClient();
    
    const filters: PricingFilter[] = [
      { Type: 'TERM_MATCH', Field: 'instanceType', Value: instanceType.replace('cache.', '') },
      { Type: 'TERM_MATCH', Field: 'location', Value: getRegionName(region) },
      { Type: 'TERM_MATCH', Field: 'cacheEngine', Value: engine },
    ];

    const command = new GetProductsCommand({
      ServiceCode: 'AmazonElastiCache',
      Filters: filters as PricingFilterType[],
      MaxResults: 1,
    });

    const response = await client.send(command);
    
    if (!response.PriceList || response.PriceList.length === 0) {
      return getFallbackElastiCachePrice(instanceType);
    }

    const priceData = JSON.parse(response.PriceList[0]);
    const onDemand = priceData.terms.OnDemand;
    const priceKey = Object.keys(onDemand)[0];
    const priceDimensions = onDemand[priceKey].priceDimensions;
    const dimensionKey = Object.keys(priceDimensions)[0];
    const pricePerHour = parseFloat(priceDimensions[dimensionKey].pricePerUnit.USD);

    pricingCache.set(cacheKey, { price: pricePerHour, timestamp: Date.now() });
    
    return pricePerHour;
  } catch (error) {
    console.error(`[Price List] Error fetching ElastiCache pricing:`, error);
    return getFallbackElastiCachePrice(instanceType);
  }
}

/**
 * Convert AWS region code to region name for Price List API
 */
function getRegionName(region: string): string {
  const regionNames: Record<string, string> = {
    'us-east-1': 'US East (N. Virginia)',
    'us-east-2': 'US East (Ohio)',
    'us-west-1': 'US West (N. California)',
    'us-west-2': 'US West (Oregon)',
    'eu-west-1': 'EU (Ireland)',
    'eu-central-1': 'EU (Frankfurt)',
    'ap-south-1': 'Asia Pacific (Mumbai)',
    'ap-southeast-1': 'Asia Pacific (Singapore)',
    'ap-southeast-2': 'Asia Pacific (Sydney)',
    'ap-northeast-1': 'Asia Pacific (Tokyo)',
  };
  
  return regionNames[region] || 'US East (N. Virginia)';
}

/**
 * Fallback pricing if API call fails
 */
function getFallbackEC2Price(instanceType: string): number {
  const fallbackPrices: Record<string, number> = {
    't3.nano': 0.0052,
    't3.micro': 0.0104,
    't3.small': 0.0208,
    't3.medium': 0.0416,
    't3.large': 0.0832,
    't3.xlarge': 0.1664,
    't3.2xlarge': 0.3328,
    'm5.large': 0.096,
    'm5.xlarge': 0.192,
    'm5.2xlarge': 0.384,
    'c5.large': 0.085,
    'c5.xlarge': 0.17,
    'r5.large': 0.126,
    'r5.xlarge': 0.252,
  };
  
  return fallbackPrices[instanceType] || 0.05;
}

function getFallbackRDSPrice(instanceType: string): number {
  const fallbackPrices: Record<string, number> = {
    'db.t3.micro': 0.017,
    'db.t3.small': 0.034,
    'db.t3.medium': 0.068,
    'db.t3.large': 0.136,
    'db.m5.large': 0.192,
    'db.r5.large': 0.24,
  };
  
  return fallbackPrices[instanceType] || 0.05;
}

function getFallbackElastiCachePrice(instanceType: string): number {
  const fallbackPrices: Record<string, number> = {
    'cache.t3.micro': 0.017,
    'cache.t3.small': 0.034,
    'cache.t3.medium': 0.068,
    'cache.m5.large': 0.161,
    'cache.r5.large': 0.201,
  };
  
  return fallbackPrices[instanceType] || 0.05;
}

/**
 * Clear pricing cache (useful for testing or forcing refresh)
 */
export function clearPricingCache(): void {
  pricingCache.clear();
  console.log('[Price List] Pricing cache cleared');
}
