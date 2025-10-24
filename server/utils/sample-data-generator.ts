/**
 * Multi-Cloud Sample Data Generator
 * Generates realistic sample cost data for AWS, GCP, and Azure
 * Used for immediate testing and demo purposes when no cloud accounts are configured
 */

import { readFileSync } from "fs";
import { join } from "path";
import { processAzureCostData } from "./process-cost-data";
import type { AzureCostResponse } from "@shared/schema";
import { 
  normalizeAwsCosts, 
  normalizeGcpCosts, 
  normalizeAzureCosts,
  processMultiCloudCosts,
  type UnifiedCostData 
} from "./multi-cloud-processor";

/**
 * Generate sample AWS cost data
 */
export function generateAwsSampleData(daysBack: number = 30): UnifiedCostData[] {
  const services = [
    'Amazon EC2',
    'Amazon S3', 
    'AWS Lambda',
    'Amazon RDS',
    'Amazon CloudFront',
    'Amazon DynamoDB',
    'Amazon ECS',
    'Amazon Route 53'
  ];
  
  const regions = ['us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1'];
  const teams = ['engineering', 'data-science', 'devops', 'ml-platform'];
  const environments = ['production', 'staging', 'development'];

  const costData: UnifiedCostData[] = [];
  const today = new Date();

  for (let dayOffset = 0; dayOffset < daysBack; dayOffset++) {
    const date = new Date(today);
    date.setDate(date.getDate() - dayOffset);
    const dateStr = date.toISOString().split('T')[0];

    for (const service of services) {
      // Generate 1-3 regions per service per day
      const numRegions = Math.floor(Math.random() * 3) + 1;
      const selectedRegions = regions.slice(0, numRegions);

      for (const region of selectedRegions) {
        // Base cost varies by service type
        let baseCost = 0;
        if (service === 'Amazon EC2') baseCost = 150 + Math.random() * 200;
        else if (service === 'Amazon RDS') baseCost = 80 + Math.random() * 120;
        else if (service === 'Amazon S3') baseCost = 30 + Math.random() * 70;
        else if (service === 'AWS Lambda') baseCost = 20 + Math.random() * 40;
        else baseCost = 10 + Math.random() * 50;

        // Add day-of-week variation (higher on weekdays)
        const dayOfWeek = date.getDay();
        const weekdayMultiplier = (dayOfWeek >= 1 && dayOfWeek <= 5) ? 1.2 : 0.8;
        
        // Add random spikes (5% chance of 2-3x cost)
        const spikeMultiplier = Math.random() < 0.05 ? (2 + Math.random()) : 1;

        const finalCost = baseCost * weekdayMultiplier * spikeMultiplier;

        costData.push({
          provider: 'aws',
          accountId: '123456789012', // Mock AWS account ID
          accountName: 'AWS Production Account',
          date: dateStr,
          serviceName: service,
          region,
          cost: parseFloat(finalCost.toFixed(2)),
          currency: 'USD',
          tags: {
            team: teams[Math.floor(Math.random() * teams.length)],
            environment: environments[Math.floor(Math.random() * environments.length)],
            project: `project-${Math.floor(Math.random() * 5) + 1}`
          },
          metadata: {
            estimatedCharges: false,
            usageType: `${region}:${service}`
          }
        });
      }
    }
  }

  return costData;
}

/**
 * Generate sample GCP cost data
 */
export function generateGcpSampleData(daysBack: number = 30): UnifiedCostData[] {
  const services = [
    'Compute Engine',
    'Cloud Storage',
    'Cloud Functions',
    'Cloud SQL',
    'Cloud Load Balancing',
    'BigQuery',
    'Cloud Run',
    'Kubernetes Engine'
  ];
  
  const regions = ['us-central1', 'us-east1', 'europe-west1', 'asia-southeast1'];
  const teams = ['engineering', 'data', 'ml', 'platform'];
  const environments = ['production', 'staging', 'dev'];

  const costData: UnifiedCostData[] = [];
  const today = new Date();

  for (let dayOffset = 0; dayOffset < daysBack; dayOffset++) {
    const date = new Date(today);
    date.setDate(date.getDate() - dayOffset);
    const dateStr = date.toISOString().split('T')[0];

    for (const service of services) {
      // Generate 1-3 regions per service per day
      const numRegions = Math.floor(Math.random() * 3) + 1;
      const selectedRegions = regions.slice(0, numRegions);

      for (const region of selectedRegions) {
        // Base cost varies by service type
        let baseCost = 0;
        if (service === 'Compute Engine') baseCost = 120 + Math.random() * 180;
        else if (service === 'Kubernetes Engine') baseCost = 100 + Math.random() * 150;
        else if (service === 'Cloud SQL') baseCost = 60 + Math.random() * 90;
        else if (service === 'Cloud Storage') baseCost = 25 + Math.random() * 50;
        else if (service === 'BigQuery') baseCost = 40 + Math.random() * 80;
        else baseCost = 15 + Math.random() * 45;

        // Add day-of-week variation
        const dayOfWeek = date.getDay();
        const weekdayMultiplier = (dayOfWeek >= 1 && dayOfWeek <= 5) ? 1.15 : 0.85;
        
        // Add random spikes
        const spikeMultiplier = Math.random() < 0.05 ? (2 + Math.random()) : 1;

        const finalCost = baseCost * weekdayMultiplier * spikeMultiplier;

        costData.push({
          provider: 'gcp',
          accountId: 'finops-project-12345', // Mock GCP project ID
          accountName: 'GCP Production Project',
          date: dateStr,
          serviceName: service,
          region,
          cost: parseFloat(finalCost.toFixed(2)),
          currency: 'USD',
          tags: {
            team: teams[Math.floor(Math.random() * teams.length)],
            environment: environments[Math.floor(Math.random() * environments.length)],
            cost_center: `cc-${Math.floor(Math.random() * 3) + 1}`
          },
          metadata: {
            sku: `${service} - ${region}`,
            usageAmount: Math.random() * 1000
          }
        });
      }
    }
  }

  return costData;
}

/**
 * Load Azure sample data from attached assets
 */
export function loadAzureSampleData(): UnifiedCostData[] {
  try {
    const samplePath = join(process.cwd(), "attached_assets", "azure_1760597470327.json");
    const sampleData = JSON.parse(readFileSync(samplePath, "utf-8")) as AzureCostResponse;
    return normalizeAzureCosts(sampleData);
  } catch (error) {
    console.error('Error loading Azure sample data:', error);
    return [];
  }
}

/**
 * Generate comprehensive multi-cloud sample data
 */
export function generateMultiCloudSampleData(daysBack: number = 30) {
  const awsData = generateAwsSampleData(daysBack);
  const gcpData = generateGcpSampleData(daysBack);
  const azureData = loadAzureSampleData();

  // Combine all provider data
  const allCostData = [...awsData, ...gcpData, ...azureData];

  return {
    allCostData,
    awsData,
    gcpData,
    azureData,
    
    // Process aggregated insights for each provider
    allProviders: processMultiCloudCosts(allCostData),
    awsOnly: processMultiCloudCosts(allCostData, 'aws'),
    gcpOnly: processMultiCloudCosts(allCostData, 'gcp'),
    azureOnly: processMultiCloudCosts(allCostData, 'azure'),
  };
}

/**
 * Get sample cost data for a specific provider
 */
export function getSampleDataByProvider(provider: 'aws' | 'gcp' | 'azure' | 'all', daysBack: number = 30) {
  const sampleData = generateMultiCloudSampleData(daysBack);
  
  switch (provider) {
    case 'aws':
      return {
        costData: sampleData.awsData,
        processed: sampleData.awsOnly
      };
    case 'gcp':
      return {
        costData: sampleData.gcpData,
        processed: sampleData.gcpOnly
      };
    case 'azure':
      return {
        costData: sampleData.azureData,
        processed: sampleData.azureOnly
      };
    case 'all':
    default:
      return {
        costData: sampleData.allCostData,
        processed: sampleData.allProviders
      };
  }
}
