/**
 * AWS CloudWatch Metrics Fetcher
 * Fetches utilization metrics to identify idle resources
 */

import { CloudWatchClient, GetMetricStatisticsCommand } from "@aws-sdk/client-cloudwatch";
import { getProviderCredentials } from "../cloud-config-manager";

export interface ResourceMetrics {
  resourceId: string;
  resourceType: string;
  avgCpuUtilization?: number;
  maxCpuUtilization?: number;
  avgNetworkIn?: number;
  avgNetworkOut?: number;
  period: string; // e.g., "30 days"
  isIdle: boolean;
  idleReason?: string;
}

/**
 * Fetch CPU utilization for EC2 instances over a specified period
 * @param instanceIds - Array of EC2 instance IDs
 * @param days - Number of days to look back (default: 30)
 */
export async function fetchEC2Metrics(instanceIds: string[], days: number = 30): Promise<ResourceMetrics[]> {
  if (instanceIds.length === 0) return [];

  try {
    // Get AWS credentials with region
    const accountConfig = await getProviderCredentials('aws');
    if (!accountConfig) {
      console.log('[AWS Metrics] No AWS credentials configured');
      return [];
    }

    const credentials = accountConfig.credentials;
    const cloudwatch = new CloudWatchClient({
      region: credentials.region || "us-east-1",
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
      },
    });
    
    const endTime = new Date();
    const startTime = new Date();
    startTime.setDate(startTime.getDate() - days);

    const metrics: ResourceMetrics[] = [];

    console.log(`[AWS Metrics] Fetching metrics for ${instanceIds.length} EC2 instances over ${days} days...`);

    // Fetch metrics for each instance
    for (const instanceId of instanceIds) {
      try {
        // Fetch CPU Utilization
        const cpuCommand = new GetMetricStatisticsCommand({
          Namespace: 'AWS/EC2',
          MetricName: 'CPUUtilization',
          Dimensions: [
            {
              Name: 'InstanceId',
              Value: instanceId,
            },
          ],
          StartTime: startTime,
          EndTime: endTime,
          Period: 86400, // 1 day in seconds
          Statistics: ['Average', 'Maximum'],
        });

        const cpuResponse = await cloudwatch.send(cpuCommand);
        
        // Calculate average CPU over the period
        const cpuDatapoints = cpuResponse.Datapoints || [];
        const avgCpu = cpuDatapoints.length > 0
          ? cpuDatapoints.reduce((sum, dp) => sum + (dp.Average || 0), 0) / cpuDatapoints.length
          : 0;
        const maxCpu = cpuDatapoints.length > 0
          ? Math.max(...cpuDatapoints.map(dp => dp.Maximum || 0))
          : 0;

        // Fetch Network In
        const networkInCommand = new GetMetricStatisticsCommand({
          Namespace: 'AWS/EC2',
          MetricName: 'NetworkIn',
          Dimensions: [
            {
              Name: 'InstanceId',
              Value: instanceId,
            },
          ],
          StartTime: startTime,
          EndTime: endTime,
          Period: 86400,
          Statistics: ['Average'],
        });

        const networkInResponse = await cloudwatch.send(networkInCommand);
        const networkInDatapoints = networkInResponse.Datapoints || [];
        const avgNetworkIn = networkInDatapoints.length > 0
          ? networkInDatapoints.reduce((sum, dp) => sum + (dp.Average || 0), 0) / networkInDatapoints.length
          : 0;

        // Fetch Network Out
        const networkOutCommand = new GetMetricStatisticsCommand({
          Namespace: 'AWS/EC2',
          MetricName: 'NetworkOut',
          Dimensions: [
            {
              Name: 'InstanceId',
              Value: instanceId,
            },
          ],
          StartTime: startTime,
          EndTime: endTime,
          Period: 86400,
          Statistics: ['Average'],
        });

        const networkOutResponse = await cloudwatch.send(networkOutCommand);
        const networkOutDatapoints = networkOutResponse.Datapoints || [];
        const avgNetworkOut = networkOutDatapoints.length > 0
          ? networkOutDatapoints.reduce((sum, dp) => sum + (dp.Average || 0), 0) / networkOutDatapoints.length
          : 0;

        // Determine if idle (CPU < 5% and low network activity)
        const isIdle = avgCpu < 5 && maxCpu < 10;
        let idleReason = '';
        if (isIdle) {
          idleReason = `Average CPU: ${avgCpu.toFixed(2)}%, Max CPU: ${maxCpu.toFixed(2)}%`;
        }

        metrics.push({
          resourceId: instanceId,
          resourceType: 'EC2 Instance',
          avgCpuUtilization: avgCpu,
          maxCpuUtilization: maxCpu,
          avgNetworkIn: avgNetworkIn / (1024 * 1024), // Convert to MB
          avgNetworkOut: avgNetworkOut / (1024 * 1024), // Convert to MB
          period: `${days} days`,
          isIdle,
          idleReason,
        });

        console.log(`[AWS Metrics] ${instanceId}: CPU ${avgCpu.toFixed(2)}%, ${isIdle ? 'IDLE' : 'ACTIVE'}`);
      } catch (error) {
        console.error(`[AWS Metrics] Error fetching metrics for ${instanceId}:`, error);
        // Continue with other instances
      }
    }

    console.log(`[AWS Metrics] Found ${metrics.filter(m => m.isIdle).length} idle instances out of ${metrics.length}`);
    return metrics;
  } catch (error) {
    console.error('[AWS Metrics] Error fetching EC2 metrics:', error);
    return [];
  }
}

/**
 * Fetch metrics for RDS instances
 * @param dbInstanceIds - Array of RDS DB instance identifiers
 * @param days - Number of days to look back (default: 30)
 */
export async function fetchRDSMetrics(dbInstanceIds: string[], days: number = 30): Promise<ResourceMetrics[]> {
  if (dbInstanceIds.length === 0) return [];

  try {
    // Get AWS credentials with region
    const accountConfig = await getProviderCredentials('aws');
    if (!accountConfig) {
      console.log('[AWS Metrics] No AWS credentials configured');
      return [];
    }

    const credentials = accountConfig.credentials;
    const cloudwatch = new CloudWatchClient({
      region: credentials.region || "us-east-1",
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
      },
    });
    
    const endTime = new Date();
    const startTime = new Date();
    startTime.setDate(startTime.getDate() - days);

    const metrics: ResourceMetrics[] = [];

    console.log(`[AWS Metrics] Fetching metrics for ${dbInstanceIds.length} RDS instances over ${days} days...`);

    for (const dbInstanceId of dbInstanceIds) {
      try {
        // Fetch CPU Utilization
        const cpuCommand = new GetMetricStatisticsCommand({
          Namespace: 'AWS/RDS',
          MetricName: 'CPUUtilization',
          Dimensions: [
            {
              Name: 'DBInstanceIdentifier',
              Value: dbInstanceId,
            },
          ],
          StartTime: startTime,
          EndTime: endTime,
          Period: 86400,
          Statistics: ['Average', 'Maximum'],
        });

        const cpuResponse = await cloudwatch.send(cpuCommand);
        const cpuDatapoints = cpuResponse.Datapoints || [];
        const avgCpu = cpuDatapoints.length > 0
          ? cpuDatapoints.reduce((sum, dp) => sum + (dp.Average || 0), 0) / cpuDatapoints.length
          : 0;
        const maxCpu = cpuDatapoints.length > 0
          ? Math.max(...cpuDatapoints.map(dp => dp.Maximum || 0))
          : 0;

        // Fetch Database Connections
        const connectionsCommand = new GetMetricStatisticsCommand({
          Namespace: 'AWS/RDS',
          MetricName: 'DatabaseConnections',
          Dimensions: [
            {
              Name: 'DBInstanceIdentifier',
              Value: dbInstanceId,
            },
          ],
          StartTime: startTime,
          EndTime: endTime,
          Period: 86400,
          Statistics: ['Average'],
        });

        const connectionsResponse = await cloudwatch.send(connectionsCommand);
        const connectionsDatapoints = connectionsResponse.Datapoints || [];
        const avgConnections = connectionsDatapoints.length > 0
          ? connectionsDatapoints.reduce((sum, dp) => sum + (dp.Average || 0), 0) / connectionsDatapoints.length
          : 0;

        // Determine if idle (CPU < 5% and very few connections)
        const isIdle = avgCpu < 5 && avgConnections < 2;
        let idleReason = '';
        if (isIdle) {
          idleReason = `Average CPU: ${avgCpu.toFixed(2)}%, Avg Connections: ${avgConnections.toFixed(1)}`;
        }

        metrics.push({
          resourceId: dbInstanceId,
          resourceType: 'RDS Instance',
          avgCpuUtilization: avgCpu,
          maxCpuUtilization: maxCpu,
          period: `${days} days`,
          isIdle,
          idleReason,
        });

        console.log(`[AWS Metrics] ${dbInstanceId}: CPU ${avgCpu.toFixed(2)}%, Connections ${avgConnections.toFixed(1)}, ${isIdle ? 'IDLE' : 'ACTIVE'}`);
      } catch (error) {
        console.error(`[AWS Metrics] Error fetching metrics for ${dbInstanceId}:`, error);
      }
    }

    console.log(`[AWS Metrics] Found ${metrics.filter(m => m.isIdle).length} idle RDS instances out of ${metrics.length}`);
    return metrics;
  } catch (error) {
    console.error('[AWS Metrics] Error fetching RDS metrics:', error);
    return [];
  }
}
