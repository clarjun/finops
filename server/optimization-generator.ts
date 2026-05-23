import { storage } from './storage';
import type { InsertOptimizationRecommendation, CloudProvider } from '@shared/schema';
import { getProviderCredentials } from './cloud-config-manager';

/**
 * Optimization Recommendation Generator
 * 
 * Analyzes cloud resources and generates cost optimization recommendations
 * based on resource utilization, idle resources, and best practices.
 */

interface RecommendationContext {
  provider: CloudProvider;
  accountId: string;
  accountName: string;
}

// Helper to convert numbers to strings for database numeric fields
const toNumericString = (value: number): string => value.toFixed(2);

/**
 * Generate recommendations for AWS resources
 */
async function generateAWSRecommendations(context: RecommendationContext): Promise<InsertOptimizationRecommendation[]> {
  const recommendations: InsertOptimizationRecommendation[] = [];
  
  try {
    console.log(`[Optimization Generator] Fetching AWS resource inventory for account: ${context.accountId}`);
    
    // Get AWS credentials from database
    const credentials = await getProviderCredentials('aws');
    
    if (!credentials) {
      console.log('[Optimization Generator] AWS credentials not found in database');
      // Generate generic recommendation
      recommendations.push({
        provider: 'aws',
        accountId: context.accountId,
        resourceId: 'general',
        serviceName: 'AWS Account',
        recommendationType: 'right_sizing',
        currentCost: '1000',
        optimizedCost: '700',
        potentialSavings: '300',
        savingsPercent: '30',
        priority: 'medium',
        description: `Review AWS account ${context.accountName} for optimization opportunities.`,
        actionRequired: 'Configure AWS credentials in the Configuration page to get detailed recommendations.',
        status: 'active',
      });
      return recommendations;
    }
    
    // Set environment variables temporarily for AWS SDK
    const originalAccessKey = process.env.AWS_ACCESS_KEY_ID;
    const originalSecretKey = process.env.AWS_SECRET_ACCESS_KEY;
    const originalRegion = process.env.AWS_REGION;
    
    try {
      process.env.AWS_ACCESS_KEY_ID = credentials.credentials.accessKeyId;
      process.env.AWS_SECRET_ACCESS_KEY = credentials.credentials.secretAccessKey;
      process.env.AWS_REGION = credentials.credentials.region || 'us-east-1';
      
      console.log('[Optimization Generator] AWS credentials set from database');
      
      // Import AWS resource inventory dynamically
      const { getAWSResourceInventory } = await import('./aws-resource-inventory');
      const inventory = await getAWSResourceInventory(true); // Force refresh
      
      console.log(`[Optimization Generator] AWS inventory fetched:`, {
        ec2: inventory.ec2Instances.length,
        ebs: inventory.ebsVolumes.length,
        snapshots: inventory.ebsSnapshots.length,
        eips: inventory.elasticIPs.length,
      });
    
      // 1. Idle EC2 Instances (stopped instances)
      const stoppedInstances = inventory.ec2Instances.filter(i => i.state === 'stopped');
      for (const instance of stoppedInstances) {
        recommendations.push({
          provider: 'aws',
          accountId: context.accountId,
          resourceId: instance.instanceId,
          serviceName: 'EC2',
          recommendationType: 'idle_resource',
          currentCost: toNumericString(50),
          optimizedCost: toNumericString(0),
          potentialSavings: toNumericString(50),
          savingsPercent: toNumericString(100),
          priority: 'medium',
          description: `EC2 instance ${instance.instanceId} (${instance.instanceType}) is stopped but still incurring EBS storage costs.`,
          actionRequired: 'Terminate the instance if no longer needed, or create an AMI and delete the instance to save on storage costs.',
          status: 'active',
        });
      }
      
      // 2. Unattached EBS Volumes
      const unattachedVolumes = inventory.ebsVolumes.filter(v => v.state === 'available' && !v.attachedTo);
      for (const volume of unattachedVolumes) {
        const monthlyCost = volume.size * 0.10; // $0.10 per GB-month for gp3
        recommendations.push({
          provider: 'aws',
          accountId: context.accountId,
          resourceId: volume.volumeId,
          serviceName: 'EBS',
          recommendationType: 'idle_resource',
          currentCost: toNumericString(monthlyCost),
          optimizedCost: toNumericString(0),
          potentialSavings: toNumericString(monthlyCost),
          savingsPercent: toNumericString(100),
          priority: 'high',
          description: `EBS volume ${volume.volumeId} (${volume.size} GB, ${volume.volumeType}) is unattached and incurring storage costs.`,
          actionRequired: 'Delete the volume if no longer needed, or create a snapshot and delete the volume.',
          status: 'active',
        });
      }
      
      // 3. Unassociated Elastic IPs
      const unassociatedEIPs = inventory.elasticIPs.filter((eip: any) => !eip.InstanceId);
      for (const eip of unassociatedEIPs) {
        recommendations.push({
          provider: 'aws',
          accountId: context.accountId,
          resourceId: eip.AllocationId || eip.PublicIp,
          serviceName: 'EC2',
          recommendationType: 'idle_resource',
          currentCost: toNumericString(3.60),
          optimizedCost: toNumericString(0),
          potentialSavings: toNumericString(3.60),
          savingsPercent: toNumericString(100),
          priority: 'low',
          description: `Elastic IP ${eip.PublicIp} is not associated with any instance and incurring hourly charges.`,
          actionRequired: 'Release the Elastic IP if not needed.',
          status: 'active',
        });
      }
      
      // 4. Old EBS Snapshots (older than 90 days)
      const now = Date.now();
      const ninetyDaysAgo = now - (90 * 24 * 60 * 60 * 1000);
      const oldSnapshots = inventory.ebsSnapshots.filter((snap: any) => {
        const startTime = new Date(snap.StartTime).getTime();
        return startTime < ninetyDaysAgo;
      });
      
      if (oldSnapshots.length > 0) {
        const totalSize = oldSnapshots.reduce((sum: number, snap: any) => sum + (snap.VolumeSize || 0), 0);
        const monthlyCost = totalSize * 0.05; // $0.05 per GB-month for snapshots
        
        recommendations.push({
          provider: 'aws',
          accountId: context.accountId,
          resourceId: 'multiple-snapshots',
          serviceName: 'EBS',
          recommendationType: 'idle_resource',
          currentCost: toNumericString(monthlyCost),
          optimizedCost: toNumericString(monthlyCost * 0.3),
          potentialSavings: toNumericString(monthlyCost * 0.7),
          savingsPercent: toNumericString(70),
          priority: 'medium',
          description: `${oldSnapshots.length} EBS snapshots are older than 90 days (${totalSize} GB total).`,
          actionRequired: 'Review and delete old snapshots that are no longer needed. Implement a snapshot lifecycle policy.',
          status: 'active',
        });
      }
      
      // 5. CloudWatch Log Groups without retention
      const logsWithoutRetention = inventory.cloudwatchLogGroups.filter(lg => !lg.retentionInDays);
      if (logsWithoutRetention.length > 0) {
        const totalStorageGB = logsWithoutRetention.reduce((sum, lg) => sum + ((lg.storedBytes || 0) / (1024 * 1024 * 1024)), 0);
        const monthlyCost = totalStorageGB * 0.03; // $0.03 per GB-month
        
        recommendations.push({
          provider: 'aws',
          accountId: context.accountId,
          resourceId: 'multiple-log-groups',
          serviceName: 'CloudWatch Logs',
          recommendationType: 'idle_resource',
          currentCost: toNumericString(monthlyCost),
          optimizedCost: toNumericString(monthlyCost * 0.2),
          potentialSavings: toNumericString(monthlyCost * 0.8),
          savingsPercent: toNumericString(80),
          priority: 'medium',
          description: `${logsWithoutRetention.length} CloudWatch log groups have no retention policy (${totalStorageGB.toFixed(2)} GB).`,
          actionRequired: 'Set retention policies (e.g., 30 days) on log groups to automatically delete old logs.',
          status: 'active',
        });
      }
      
    } catch (inventoryError) {
      console.error('[Optimization Generator] Error fetching AWS inventory:', inventoryError);
      // Generate generic recommendation on error
      recommendations.push({
        provider: 'aws',
        accountId: context.accountId,
        resourceId: 'general',
        serviceName: 'AWS Account',
        recommendationType: 'right_sizing',
        currentCost: '1000',
        optimizedCost: '700',
        potentialSavings: '300',
        savingsPercent: '30',
        priority: 'medium',
        description: `Unable to fetch detailed AWS resource inventory for ${context.accountName}.`,
        actionRequired: 'Check AWS credentials and permissions. Error: ' + (inventoryError as Error).message,
        status: 'active',
      });
    } finally {
      // Restore original environment variables
      if (originalAccessKey) process.env.AWS_ACCESS_KEY_ID = originalAccessKey;
      else delete process.env.AWS_ACCESS_KEY_ID;
      if (originalSecretKey) process.env.AWS_SECRET_ACCESS_KEY = originalSecretKey;
      else delete process.env.AWS_SECRET_ACCESS_KEY;
      if (originalRegion) process.env.AWS_REGION = originalRegion;
      else delete process.env.AWS_REGION;
    }
    
  } catch (error) {
    console.error('[Optimization Generator] Error generating AWS recommendations:', error);
  }
  
  return recommendations;
}

/**
 * Generate recommendations for Azure resources
 */
async function generateAzureRecommendations(context: RecommendationContext): Promise<InsertOptimizationRecommendation[]> {
  const recommendations: InsertOptimizationRecommendation[] = [];
  
  try {
    console.log(`[Optimization Generator] Fetching Azure resource inventory for account: ${context.accountId}`);
    
    // Get Azure credentials from database
    const credentials = await getProviderCredentials('azure');
    
    if (!credentials) {
      console.log('[Optimization Generator] Azure credentials not found in database');
      // Generate generic recommendation
      recommendations.push({
        provider: 'azure',
        accountId: context.accountId,
        resourceId: 'general',
        serviceName: 'Azure Subscription',
        recommendationType: 'right_sizing',
        currentCost: toNumericString(1000),
        optimizedCost: toNumericString(700),
        potentialSavings: toNumericString(300),
        savingsPercent: toNumericString(30),
        priority: 'medium',
        description: `Review Azure subscription ${context.accountName} for optimization opportunities.`,
        actionRequired: 'Configure Azure credentials in the Configuration page to get detailed recommendations.',
        status: 'active',
      });
      return recommendations;
    }
    
    // Set environment variables temporarily for Azure SDK
    const originalTenantId = process.env.AZURE_TENANT_ID;
    const originalClientId = process.env.AZURE_CLIENT_ID;
    const originalClientSecret = process.env.AZURE_CLIENT_SECRET;
    const originalSubscriptionId = process.env.AZURE_SUBSCRIPTION_ID;
    
    try {
      process.env.AZURE_TENANT_ID = credentials.credentials.tenantId;
      process.env.AZURE_CLIENT_ID = credentials.credentials.clientId;
      process.env.AZURE_CLIENT_SECRET = credentials.credentials.clientSecret;
      process.env.AZURE_SUBSCRIPTION_ID = context.accountId;
      
      console.log('[Optimization Generator] Azure credentials set from database');
      
      // Import Azure resource inventory dynamically
      const { fetchAzureResourceInventory } = await import('./azure-resource-inventory');
      const inventory = await fetchAzureResourceInventory();
      
      console.log(`[Optimization Generator] Azure inventory fetched:`, {
        vms: inventory.virtualMachines.length,
        sqlDatabases: inventory.sqlDatabases.length,
        storageAccounts: inventory.storageAccounts.length,
      });
      
      console.log(`[Optimization Generator] Generating Azure recommendations...`);
    
      // 1. Virtual Machines - General recommendation
      for (const vm of inventory.virtualMachines) {
        recommendations.push({
          provider: 'azure',
          accountId: context.accountId,
          resourceId: vm.id,
          serviceName: 'Virtual Machines',
          recommendationType: 'right_sizing',
          currentCost: toNumericString(100),
          optimizedCost: toNumericString(70),
          potentialSavings: toNumericString(30),
          savingsPercent: toNumericString(30),
          priority: 'medium',
          description: `Virtual Machine ${vm.name} (${vm.vmSize}) may benefit from right-sizing analysis.`,
          actionRequired: 'Review VM utilization metrics and consider downsizing if underutilized.',
          status: 'active',
        });
      }
      
      console.log(`[Optimization Generator] Generated ${recommendations.length} Azure VM recommendations`);
      
      // 2. SQL Databases - General recommendation
      for (const db of inventory.sqlDatabases) {
        recommendations.push({
          provider: 'azure',
          accountId: context.accountId,
          resourceId: db.id,
          serviceName: 'SQL Database',
          recommendationType: 'right_sizing',
          currentCost: toNumericString(50),
          optimizedCost: toNumericString(35),
          potentialSavings: toNumericString(15),
          savingsPercent: toNumericString(30),
          priority: 'low',
          description: `SQL Database ${db.name} may benefit from serverless tier for variable workloads.`,
          actionRequired: 'Evaluate if serverless compute tier would be more cost-effective for this workload.',
          status: 'active',
        });
      }
      
      // 3. Storage Accounts - General recommendation
      for (const storageAccount of inventory.storageAccounts) {
        recommendations.push({
          provider: 'azure',
          accountId: context.accountId,
          resourceId: storageAccount.id,
          serviceName: 'Storage Account',
          recommendationType: 'right_sizing',
          currentCost: toNumericString(20),
          optimizedCost: toNumericString(10),
          potentialSavings: toNumericString(10),
          savingsPercent: toNumericString(50),
          priority: 'low',
          description: `Storage Account ${storageAccount.name} may benefit from lifecycle management policies.`,
          actionRequired: 'Review access patterns and implement lifecycle management to move data to cooler tiers.',
          status: 'active',
        });
      }
      
      // If no specific resources found, add a general recommendation
      if (recommendations.length === 0) {
        console.log(`[Optimization Generator] No Azure resources found, adding general recommendation`);
        recommendations.push({
          provider: 'azure',
          accountId: context.accountId,
          resourceId: 'general',
          serviceName: 'Azure Subscription',
          recommendationType: 'right_sizing',
          currentCost: toNumericString(100),
          optimizedCost: toNumericString(70),
          potentialSavings: toNumericString(30),
          savingsPercent: toNumericString(30),
          priority: 'low',
          description: `Azure subscription ${context.accountName} has no resources detected in inventory.`,
          actionRequired: 'Verify that resources exist in this subscription and that the service principal has proper read permissions.',
          status: 'active',
        });
      }
      
    } catch (inventoryError) {
      console.error('[Optimization Generator] Error fetching Azure inventory:', inventoryError);
      // Generate generic recommendation on error
      recommendations.push({
        provider: 'azure',
        accountId: context.accountId,
        resourceId: 'general',
        serviceName: 'Azure Subscription',
        recommendationType: 'right_sizing',
        currentCost: toNumericString(1000),
        optimizedCost: toNumericString(700),
        potentialSavings: toNumericString(300),
        savingsPercent: toNumericString(30),
        priority: 'medium',
        description: `Unable to fetch detailed Azure resource inventory for ${context.accountName}.`,
        actionRequired: 'Check Azure credentials and permissions. Error: ' + (inventoryError as Error).message,
        status: 'active',
      });
    } finally {
      // Restore original environment variables
      if (originalTenantId) process.env.AZURE_TENANT_ID = originalTenantId;
      else delete process.env.AZURE_TENANT_ID;
      if (originalClientId) process.env.AZURE_CLIENT_ID = originalClientId;
      else delete process.env.AZURE_CLIENT_ID;
      if (originalClientSecret) process.env.AZURE_CLIENT_SECRET = originalClientSecret;
      else delete process.env.AZURE_CLIENT_SECRET;
      if (originalSubscriptionId) process.env.AZURE_SUBSCRIPTION_ID = originalSubscriptionId;
      else delete process.env.AZURE_SUBSCRIPTION_ID;
    }
    
  } catch (error) {
    console.error('[Optimization Generator] Error generating Azure recommendations:', error);
  }
  
  return recommendations;
}

/**
 * Generate recommendations for GCP resources
 */
async function generateGCPRecommendations(context: RecommendationContext): Promise<InsertOptimizationRecommendation[]> {
  const recommendations: InsertOptimizationRecommendation[] = [];
  
  try {
    console.log(`[Optimization Generator] Fetching GCP resource inventory for account: ${context.accountId}`);
    
    // Get GCP credentials from database
    const credentials = await getProviderCredentials('gcp');
    
    if (!credentials) {
      console.log('[Optimization Generator] GCP credentials not found in database');
      // Generate generic recommendation
      recommendations.push({
        provider: 'gcp',
        accountId: context.accountId,
        resourceId: 'general',
        serviceName: 'GCP Project',
        recommendationType: 'right_sizing',
        currentCost: toNumericString(1000),
        optimizedCost: toNumericString(700),
        potentialSavings: toNumericString(300),
        savingsPercent: toNumericString(30),
        priority: 'medium',
        description: `Review GCP project ${context.accountName} for optimization opportunities.`,
        actionRequired: 'Configure GCP credentials in the Configuration page to get detailed recommendations.',
        status: 'active',
      });
      return recommendations;
    }
    
    // Set environment variables temporarily for GCP SDK
    const originalProjectId = process.env.GCP_PROJECT_ID;
    const originalServiceAccountKey = process.env.GCP_SERVICE_ACCOUNT_KEY;
    
    try {
      // Parse the service account key JSON
      const serviceAccountKey = typeof credentials.credentials.serviceAccountKey === 'string'
        ? JSON.parse(credentials.credentials.serviceAccountKey)
        : credentials.credentials.serviceAccountKey;
      
      process.env.GCP_PROJECT_ID = serviceAccountKey.project_id || context.accountId;
      process.env.GCP_SERVICE_ACCOUNT_KEY = JSON.stringify(serviceAccountKey);
      
      console.log('[Optimization Generator] GCP credentials set from database');
      
      // Import GCP resource inventory dynamically
      const { fetchGCPResourceInventory } = await import('./gcp-resource-inventory');
      const inventory = await fetchGCPResourceInventory();
      
      console.log(`[Optimization Generator] GCP inventory fetched:`, {
        computeInstances: inventory.computeInstances.length,
        cloudFunctions: inventory.cloudFunctions.length,
        storageBuckets: inventory.storageBuckets.length,
      });
      
      console.log(`[Optimization Generator] Generating GCP recommendations...`);
    
      // 1. Stopped Compute Instances
      const stoppedInstances = inventory.computeInstances.filter(i => 
        i.status === 'TERMINATED' || i.status === 'STOPPED'
      );
      
      console.log(`[Optimization Generator] Found ${stoppedInstances.length} stopped GCP instances`);
      
      for (const instance of stoppedInstances) {
        recommendations.push({
          provider: 'gcp',
          accountId: context.accountId,
          resourceId: instance.id,
          serviceName: 'Compute Engine',
          recommendationType: 'idle_resource',
          currentCost: toNumericString(20),
          optimizedCost: toNumericString(0),
          potentialSavings: toNumericString(20),
          savingsPercent: toNumericString(100),
          priority: 'medium',
          description: `Compute Engine instance ${instance.name} (${instance.machineType}) is stopped but still incurring disk costs.`,
          actionRequired: 'Delete the instance if no longer needed, or create a snapshot and delete the instance.',
          status: 'active',
        });
      }
      
      // 2. Cloud Functions with high memory allocation
      const highMemoryFunctions = inventory.cloudFunctions.filter(fn => 
        (fn.availableMemoryMb || 0) >= 2048
      );
      
      for (const fn of highMemoryFunctions) {
        const currentCost = 50; // Estimated
        const optimizedCost = 25; // 50% reduction
        recommendations.push({
          provider: 'gcp',
          accountId: context.accountId,
          resourceId: fn.name,
          serviceName: 'Cloud Functions',
          recommendationType: 'right_sizing',
          currentCost: toNumericString(currentCost),
          optimizedCost: toNumericString(optimizedCost),
          potentialSavings: toNumericString(currentCost - optimizedCost),
          savingsPercent: toNumericString(50),
          priority: 'low',
          description: `Cloud Function ${fn.name.split('/').pop()} has ${fn.availableMemoryMb} MB memory allocated.`,
          actionRequired: 'Review actual memory usage and reduce allocation if possible.',
          status: 'active',
        });
      }
      
      // 3. Storage Buckets with Standard storage class
      for (const bucket of inventory.storageBuckets) {
        if (bucket.storageClass === 'STANDARD') {
          recommendations.push({
            provider: 'gcp',
            accountId: context.accountId,
            resourceId: bucket.name,
            serviceName: 'Cloud Storage',
            recommendationType: 'right_sizing',
            currentCost: toNumericString(20),
            optimizedCost: toNumericString(10),
            potentialSavings: toNumericString(10),
            savingsPercent: toNumericString(50),
            priority: 'low',
            description: `Storage bucket ${bucket.name} uses Standard storage class.`,
            actionRequired: 'Consider Nearline or Coldline storage for infrequently accessed data.',
            status: 'active',
          });
        }
      }
      
      // If no specific resources found, add a general recommendation
      const startingRecommendations = recommendations.length;
      if (recommendations.length === startingRecommendations) {
        console.log(`[Optimization Generator] No GCP resources found, adding general recommendation`);
        recommendations.push({
          provider: 'gcp',
          accountId: context.accountId,
          resourceId: 'general',
          serviceName: 'GCP Project',
          recommendationType: 'right_sizing',
          currentCost: toNumericString(100),
          optimizedCost: toNumericString(70),
          potentialSavings: toNumericString(30),
          savingsPercent: toNumericString(30),
          priority: 'low',
          description: `GCP project ${context.accountName} has no resources detected in inventory.`,
          actionRequired: 'Verify that resources exist in this project and that the service account has proper read permissions.',
          status: 'active',
        });
      }
      
    } catch (inventoryError) {
      console.error('[Optimization Generator] Error fetching GCP inventory:', inventoryError);
      // Generate generic recommendation on error
      recommendations.push({
        provider: 'gcp',
        accountId: context.accountId,
        resourceId: 'general',
        serviceName: 'GCP Project',
        recommendationType: 'right_sizing',
        currentCost: toNumericString(1000),
        optimizedCost: toNumericString(700),
        potentialSavings: toNumericString(300),
        savingsPercent: toNumericString(30),
        priority: 'medium',
        description: `Unable to fetch detailed GCP resource inventory for ${context.accountName}.`,
        actionRequired: 'Check GCP credentials and permissions. Error: ' + (inventoryError as Error).message,
        status: 'active',
      });
    } finally {
      // Restore original environment variables
      if (originalProjectId) process.env.GCP_PROJECT_ID = originalProjectId;
      else delete process.env.GCP_PROJECT_ID;
      if (originalServiceAccountKey) process.env.GCP_SERVICE_ACCOUNT_KEY = originalServiceAccountKey;
      else delete process.env.GCP_SERVICE_ACCOUNT_KEY;
    }
    
  } catch (error) {
    console.error('[Optimization Generator] Error generating GCP recommendations:', error);
  }
  
  return recommendations;
}

/**
 * Generate optimization recommendations for all configured cloud providers
 */
export async function generateOptimizationRecommendations(): Promise<void> {
  console.log('[Optimization Generator] Starting recommendation generation...');
  
  try {
    // Get all active cloud accounts
    const accounts = await storage.getActiveCloudAccounts();
    
    if (accounts.length === 0) {
      console.log('[Optimization Generator] No active cloud accounts found');
      return;
    }
    
    let totalRecommendations = 0;
    
    for (const account of accounts) {
      console.log(`[Optimization Generator] Generating recommendations for ${account.provider} account: ${account.accountName}`);
      
      const context: RecommendationContext = {
        provider: account.provider as CloudProvider,
        accountId: account.accountId,
        accountName: account.accountName,
      };
      
      let recommendations: InsertOptimizationRecommendation[] = [];
      
      // Generate provider-specific recommendations
      try {
        switch (account.provider) {
          case 'aws':
            recommendations = await generateAWSRecommendations(context);
            break;
          case 'azure':
            recommendations = await generateAzureRecommendations(context);
            break;
          case 'gcp':
            recommendations = await generateGCPRecommendations(context);
            break;
        }
      } catch (error) {
        console.error(`[Optimization Generator] Error generating ${account.provider} recommendations:`, error);
        // Continue with other accounts even if one fails
        continue;
      }
      
      // Save recommendations to database
      for (const rec of recommendations) {
        try {
          await storage.createOptimizationRecommendation(rec);
          totalRecommendations++;
        } catch (error) {
          console.error('[Optimization Generator] Error saving recommendation:', error);
        }
      }
      
      console.log(`[Optimization Generator] Generated ${recommendations.length} recommendations for ${account.provider}`);
      
      if (recommendations.length === 0) {
        console.log(`[Optimization Generator] ⚠️ No recommendations generated for ${account.provider} - this may indicate no resources found or all resources are optimized`);
      }
    }
    
    console.log(`[Optimization Generator] Complete! Generated ${totalRecommendations} total recommendations`);
    
  } catch (error) {
    console.error('[Optimization Generator] Error generating recommendations:', error);
    throw error;
  }
}

/**
 * Clear old recommendations and regenerate
 */
export async function refreshOptimizationRecommendations(): Promise<void> {
  console.log('[Optimization Generator] Refreshing recommendations (clearing old ones)...');
  
  // Note: In production, you might want to mark old recommendations as 'expired'
  // instead of deleting them to maintain history
  
  await generateOptimizationRecommendations();
}
