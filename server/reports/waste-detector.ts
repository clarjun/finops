/**
 * Waste Detector
 * Identifies idle resources, unattached disks, and underutilized VMs
 */

import { WasteDetection, ResourceUtilization } from './types';
import { 
  EC2Client, 
  DescribeInstancesCommand,
  DescribeVolumesCommand 
} from "@aws-sdk/client-ec2";
import { 
  CloudWatchClient, 
  GetMetricStatisticsCommand 
} from "@aws-sdk/client-cloudwatch";
import { getProviderCredentials } from "../cloud-config-manager";

export async function detectWaste(
  provider: 'aws' | 'azure' | 'gcp',
  costData: Array<{ resourceId: string; service: string; cost: number }>
): Promise<WasteDetection> {
  console.log(`[Waste Detector] Analyzing ${provider} resources`);
  
  if (provider === 'aws') {
    return detectAWSWaste(costData);
  }
  
  // Placeholder for Azure/GCP
  return {
    idleInstances: 0,
    unattachedDisks: 0,
    lowCpuVMs: 0,
    potentialSaving: 0,
    details: {
      idleResources: [],
      underutilizedResources: [],
    },
  };
}

async function detectAWSWaste(
  costData: Array<{ resourceId: string; service: string; cost: number }>
): Promise<WasteDetection> {
  const waste: WasteDetection = {
    idleInstances: 0,
    unattachedDisks: 0,
    lowCpuVMs: 0,
    potentialSaving: 0,
    details: {
      idleResources: [],
      underutilizedResources: [],
    },
  };
  
  try {
    const accountConfig = await getProviderCredentials('aws');
    if (!accountConfig) {
      console.log('[Waste Detector] AWS not configured');
      return waste;
    }
    
    const credentials = accountConfig.credentials;
    const region = credentials.region || 'us-east-1';
    
    const ec2Client = new EC2Client({
      region,
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
      },
    });
    
    const cwClient = new CloudWatchClient({
      region,
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
      },
    });
    
    // 1. Check for unattached EBS volumes
    const volumesCommand = new DescribeVolumesCommand({});
    const volumesResponse = await ec2Client.send(volumesCommand);
    
    for (const volume of volumesResponse.Volumes || []) {
      if (volume.State === 'available' && volume.VolumeId) {
        // Find cost for this volume
        const volumeCost = costData.find(c => 
          c.resourceId.includes(volume.VolumeId!)
        )?.cost || 5; // Estimate $5/month if not found
        
        waste.unattachedDisks++;
        waste.potentialSaving += volumeCost;
        waste.details.idleResources.push({
          resourceId: volume.VolumeId,
          type: 'EBS Volume',
          cost: volumeCost,
          reason: 'Unattached volume',
        });
      }
    }
    
    // 2. Check for stopped instances
    const instancesCommand = new DescribeInstancesCommand({});
    const instancesResponse = await ec2Client.send(instancesCommand);
    
    const runningInstances: Array<{ id: string; name: string }> = [];
    
    for (const reservation of instancesResponse.Reservations || []) {
      for (const instance of reservation.Instances || []) {
        const instanceId = instance.InstanceId;
        if (!instanceId) continue;
        
        const instanceName = instance.Tags?.find(t => t.Key === 'Name')?.Value || instanceId;
        
        // Stopped instances
        if (instance.State?.Name === 'stopped') {
          const instanceCost = costData.find(c => 
            c.resourceId.includes(instanceId)
          )?.cost || 50; // Estimate
          
          waste.idleInstances++;
          waste.potentialSaving += instanceCost;
          waste.details.idleResources.push({
            resourceId: instanceId,
            type: 'EC2 Instance',
            cost: instanceCost,
            reason: 'Stopped instance',
          });
        }
        
        // Track running instances for CPU check
        if (instance.State?.Name === 'running') {
          runningInstances.push({ id: instanceId, name: instanceName });
        }
      }
    }
    
    // 3. Check CPU utilization for running instances (last 7 days)
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - 7 * 24 * 60 * 60 * 1000);
    
    for (const instance of runningInstances.slice(0, 20)) { // Limit to 20 to avoid rate limits
      try {
        const metricsCommand = new GetMetricStatisticsCommand({
          Namespace: 'AWS/EC2',
          MetricName: 'CPUUtilization',
          Dimensions: [
            {
              Name: 'InstanceId',
              Value: instance.id,
            },
          ],
          StartTime: startTime,
          EndTime: endTime,
          Period: 86400, // 1 day
          Statistics: ['Average'],
        });
        
        const metricsResponse = await cwClient.send(metricsCommand);
        const datapoints = metricsResponse.Datapoints || [];
        
        if (datapoints.length > 0) {
          const avgCPU = datapoints.reduce((sum, dp) => sum + (dp.Average || 0), 0) / datapoints.length;
          
          if (avgCPU < 10) {
            const instanceCost = costData.find(c => 
              c.resourceId.includes(instance.id)
            )?.cost || 100;
            
            waste.lowCpuVMs++;
            waste.potentialSaving += instanceCost * 0.5; // 50% savings by downsizing
            waste.details.underutilizedResources.push({
              resourceId: instance.id,
              type: 'EC2 Instance',
              cost: instanceCost,
              utilization: avgCPU,
              recommendation: `CPU usage is ${avgCPU.toFixed(1)}%. Consider downsizing or stopping.`,
            });
          }
        }
      } catch (error) {
        // Skip if metrics not available
        console.log(`[Waste Detector] Could not get metrics for ${instance.id}`);
      }
    }
    
    console.log(`[Waste Detector] ✓ Found ${waste.idleInstances} idle, ${waste.unattachedDisks} unattached, ${waste.lowCpuVMs} underutilized`);
    
  } catch (error: any) {
    console.error('[Waste Detector] Error:', error.message);
  }
  
  return waste;
}

export async function getResourceUtilization(
  provider: 'aws' | 'azure' | 'gcp',
  costData: Array<{ resourceId: string; service: string; cost: number }>
): Promise<ResourceUtilization[]> {
  console.log(`[Resource Utilization] Fetching data for ${provider}`);
  
  if (provider !== 'aws') {
    return [];
  }
  
  const utilization: ResourceUtilization[] = [];
  
  try {
    const accountConfig = await getProviderCredentials('aws');
    if (!accountConfig) return [];
    
    const credentials = accountConfig.credentials;
    const region = credentials.region || 'us-east-1';
    
    const ec2Client = new EC2Client({
      region,
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
      },
    });
    
    const cwClient = new CloudWatchClient({
      region,
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
      },
    });
    
    const instancesCommand = new DescribeInstancesCommand({});
    const instancesResponse = await ec2Client.send(instancesCommand);
    
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - 7 * 24 * 60 * 60 * 1000);
    
    for (const reservation of instancesResponse.Reservations || []) {
      for (const instance of reservation.Instances || []) {
        if (instance.State?.Name !== 'running') continue;
        
        const instanceId = instance.InstanceId;
        if (!instanceId) continue;
        
        const instanceName = instance.Tags?.find(t => t.Key === 'Name')?.Value || instanceId;
        const instanceType = instance.InstanceType || 'unknown';
        
        try {
          const metricsCommand = new GetMetricStatisticsCommand({
            Namespace: 'AWS/EC2',
            MetricName: 'CPUUtilization',
            Dimensions: [{ Name: 'InstanceId', Value: instanceId }],
            StartTime: startTime,
            EndTime: endTime,
            Period: 86400,
            Statistics: ['Average'],
          });
          
          const metricsResponse = await cwClient.send(metricsCommand);
          const datapoints = metricsResponse.Datapoints || [];
          
          if (datapoints.length > 0) {
            const avgCPU = datapoints.reduce((sum, dp) => sum + (dp.Average || 0), 0) / datapoints.length;
            const instanceCost = costData.find(c => c.resourceId.includes(instanceId))?.cost || 100;
            
            let recommendation = 'Optimal usage';
            if (avgCPU < 10) recommendation = 'Consider stopping or downsizing';
            else if (avgCPU < 30) recommendation = 'Consider downsizing';
            else if (avgCPU > 80) recommendation = 'Consider upsizing';
            
            utilization.push({
              resourceId: instanceId,
              resourceName: instanceName,
              service: 'EC2',
              cost: instanceCost,
              utilization: avgCPU,
              size: instanceType,
              recommendation,
            });
          }
        } catch (error) {
          // Skip if metrics unavailable
        }
        
        // Limit to 30 resources to avoid performance issues
        if (utilization.length >= 30) break;
      }
      if (utilization.length >= 30) break;
    }
    
    console.log(`[Resource Utilization] ✓ Fetched ${utilization.length} resources`);
    
  } catch (error: any) {
    console.error('[Resource Utilization] Error:', error.message);
  }
  
  return utilization;
}
