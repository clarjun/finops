/**
 * Azure Monitor Metrics Fetcher
 * Fetches utilization metrics to identify idle resources
 */

import { MonitorClient } from "@azure/arm-monitor";
import { ClientSecretCredential } from "@azure/identity";
import { getProviderCredentials } from "../cloud-config-manager";
import type { ResourceMetrics } from './aws-metrics-fetcher';

/**
 * Get Azure Monitor client
 */
async function getMonitorClient() {
  try {
    const accountConfig = await getProviderCredentials('azure');
    
    if (!accountConfig) {
      console.log('[Azure Metrics] No Azure credentials configured');
      return null;
    }

    const credentials = accountConfig.credentials;
    
    const credential = new ClientSecretCredential(
      credentials.tenantId,
      credentials.clientId,
      credentials.clientSecret
    );

    const monitorClient = new MonitorClient(credential, credentials.subscriptionId);

    return { monitorClient, subscriptionId: credentials.subscriptionId };
  } catch (error) {
    console.error('[Azure Metrics] Error creating Monitor client:', error);
    return null;
  }
}

/**
 * Fetch CPU utilization for Azure VMs over the last 30 days
 */
export async function fetchVMMetrics(vmResourceIds: string[]): Promise<ResourceMetrics[]> {
  if (vmResourceIds.length === 0) return [];

  try {
    const client = await getMonitorClient();
    if (!client) return [];

    const endTime = new Date();
    const startTime = new Date();
    startTime.setDate(startTime.getDate() - 30);

    const metrics: ResourceMetrics[] = [];

    console.log(`[Azure Metrics] Fetching metrics for ${vmResourceIds.length} VMs...`);

    for (const resourceId of vmResourceIds) {
      try {
        // Fetch CPU Percentage metric
        const metricsResponse = await client.monitorClient.metrics.list(
          resourceId,
          {
            timespan: `${startTime.toISOString()}/${endTime.toISOString()}`,
            interval: 'P1D', // 1 day intervals
            metricnames: 'Percentage CPU',
            aggregation: 'Average,Maximum',
          }
        );

        let avgCpu = 0;
        let maxCpu = 0;
        let dataPointCount = 0;

        if (metricsResponse.value && metricsResponse.value.length > 0) {
          const cpuMetric = metricsResponse.value[0];
          if (cpuMetric.timeseries && cpuMetric.timeseries.length > 0) {
            const timeseries = cpuMetric.timeseries[0];
            if (timeseries.data) {
              for (const datapoint of timeseries.data) {
                if (datapoint.average !== undefined) {
                  avgCpu += datapoint.average;
                  dataPointCount++;
                }
                if (datapoint.maximum !== undefined && datapoint.maximum > maxCpu) {
                  maxCpu = datapoint.maximum;
                }
              }
              if (dataPointCount > 0) {
                avgCpu = avgCpu / dataPointCount;
              }
            }
          }
        }

        // Fetch Network In metric
        const networkResponse = await client.monitorClient.metrics.list(
          resourceId,
          {
            timespan: `${startTime.toISOString()}/${endTime.toISOString()}`,
            interval: 'P1D',
            metricnames: 'Network In Total,Network Out Total',
            aggregation: 'Average',
          }
        );

        let avgNetworkIn = 0;
        let avgNetworkOut = 0;

        if (networkResponse.value) {
          for (const metric of networkResponse.value) {
            if (metric.name?.value === 'Network In Total' && metric.timeseries?.[0]?.data) {
              const datapoints = metric.timeseries[0].data.filter(d => d.average !== undefined);
              if (datapoints.length > 0) {
                avgNetworkIn = datapoints.reduce((sum, d) => sum + (d.average || 0), 0) / datapoints.length;
              }
            }
            if (metric.name?.value === 'Network Out Total' && metric.timeseries?.[0]?.data) {
              const datapoints = metric.timeseries[0].data.filter(d => d.average !== undefined);
              if (datapoints.length > 0) {
                avgNetworkOut = datapoints.reduce((sum, d) => sum + (d.average || 0), 0) / datapoints.length;
              }
            }
          }
        }

        // Determine if idle (CPU < 5%)
        const isIdle = avgCpu < 5 && maxCpu < 10;
        let idleReason = '';
        if (isIdle) {
          idleReason = `Average CPU: ${avgCpu.toFixed(2)}%, Max CPU: ${maxCpu.toFixed(2)}%`;
        }

        const vmName = resourceId.split('/').pop() || resourceId;

        metrics.push({
          resourceId: vmName,
          resourceType: 'Azure VM',
          avgCpuUtilization: avgCpu,
          maxCpuUtilization: maxCpu,
          avgNetworkIn: avgNetworkIn / (1024 * 1024), // Convert to MB
          avgNetworkOut: avgNetworkOut / (1024 * 1024), // Convert to MB
          period: '30 days',
          isIdle,
          idleReason,
        });

        console.log(`[Azure Metrics] ${vmName}: CPU ${avgCpu.toFixed(2)}%, ${isIdle ? 'IDLE' : 'ACTIVE'}`);
      } catch (error) {
        console.error(`[Azure Metrics] Error fetching metrics for ${resourceId}:`, error);
      }
    }

    console.log(`[Azure Metrics] Found ${metrics.filter(m => m.isIdle).length} idle VMs out of ${metrics.length}`);
    return metrics;
  } catch (error) {
    console.error('[Azure Metrics] Error fetching VM metrics:', error);
    return [];
  }
}
