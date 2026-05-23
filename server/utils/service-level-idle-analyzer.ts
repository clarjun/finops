/**
 * Service-Level Idle Analyzer
 * Aggregates resource-level metrics into service-level idle analysis
 */

import type { ResourceMetrics } from './aws-metrics-fetcher';

export interface ServiceIdleAnalysis {
  serviceName: string;
  totalResources: number;
  idleResources: number;
  idlePercentage: number;
  totalCost: number;
  wasteCost: number;
  wastePercentage: number;
  details: string;
  recommendation: string;
  idleResourceIds: string[];
}

/**
 * Analyze EC2 service for idle instances
 */
export function analyzeEC2Service(
  instances: any[],
  metrics: ResourceMetrics[],
  costData: any
): ServiceIdleAnalysis {
  const runningInstances = instances.filter((i: any) => i.state === 'running');
  const stoppedInstances = instances.filter((i: any) => i.state === 'stopped');
  const idleRunningInstances = metrics.filter(m => m.isIdle);
  
  // Total idle = stopped instances + running instances with low CPU
  const totalIdleInstances = stoppedInstances.length + idleRunningInstances.length;
  const totalInstances = instances.length;
  
  // Calculate EC2 costs from cost data
  const ec2Costs = costData.serviceBreakdown?.filter((s: any) => 
    s.name.includes('Elastic Compute Cloud') || 
    s.name.includes('EC2')
  ) || [];
  
  const totalEC2Cost = ec2Costs.reduce((sum: number, s: any) => sum + s.cost, 0);
  
  // Estimate waste cost (proportional to idle instances)
  const wasteCost = totalInstances > 0
    ? (totalEC2Cost * totalIdleInstances) / totalInstances
    : 0;
  
  const idlePercentage = totalInstances > 0
    ? (totalIdleInstances / totalInstances) * 100
    : 0;
  
  const wastePercentage = totalEC2Cost > 0
    ? (wasteCost / totalEC2Cost) * 100
    : 0;

  let details = '';
  if (stoppedInstances.length > 0 && idleRunningInstances.length > 0) {
    details = `${stoppedInstances.length} stopped instances + ${idleRunningInstances.length} running instances with avg CPU < 5% over ${idleRunningInstances[0]?.period || '30 days'}. `;
  } else if (stoppedInstances.length > 0) {
    details = `${stoppedInstances.length} stopped instances (still incurring EBS storage costs). `;
  } else if (idleRunningInstances.length > 0) {
    details = `${idleRunningInstances.length} running instances with avg CPU < 5% over ${idleRunningInstances[0]?.period || '30 days'}. `;
  }
  
  if (idleRunningInstances.length > 0) {
    const avgCpu = idleRunningInstances.reduce((sum, m) => sum + (m.avgCpuUtilization || 0), 0) / idleRunningInstances.length;
    details += `Average CPU across idle running instances: ${avgCpu.toFixed(2)}%.`;
  }

  let recommendation = '';
  if (idlePercentage > 30) {
    recommendation = 'HIGH WASTE: Consider terminating or stopping idle instances to save costs.';
  } else if (idlePercentage > 10) {
    recommendation = 'MODERATE WASTE: Review idle instances and consider rightsizing or scheduling.';
  } else if (idlePercentage > 0) {
    recommendation = 'LOW WASTE: Some idle instances detected, review for optimization opportunities.';
  } else {
    recommendation = 'No idle instances detected. EC2 utilization looks healthy.';
  }

  // Collect all idle instance IDs (stopped + low CPU running)
  const idleResourceIds = [
    ...stoppedInstances.map((i: any) => i.instanceId),
    ...idleRunningInstances.map(m => m.resourceId)
  ];

  return {
    serviceName: 'Amazon EC2 (Elastic Compute Cloud)',
    totalResources: totalInstances,
    idleResources: totalIdleInstances,
    idlePercentage,
    totalCost: totalEC2Cost,
    wasteCost,
    wastePercentage,
    details,
    recommendation,
    idleResourceIds,
  };
}

/**
 * Analyze RDS service for idle databases
 */
export function analyzeRDSService(
  databases: any[],
  metrics: ResourceMetrics[],
  costData: any
): ServiceIdleAnalysis {
  const availableDatabases = databases.filter((db: any) => 
    db.dbInstanceStatus === 'available' || db.dbInstanceStatus === 'running'
  );
  const idleDatabases = metrics.filter(m => m.isIdle);
  
  // Calculate RDS costs from cost data
  const rdsCosts = costData.serviceBreakdown?.filter((s: any) => 
    s.name.includes('Relational Database') || 
    s.name.includes('RDS')
  ) || [];
  
  const totalRDSCost = rdsCosts.reduce((sum: number, s: any) => sum + s.cost, 0);
  
  // Estimate waste cost
  const wasteCost = availableDatabases.length > 0
    ? (totalRDSCost * idleDatabases.length) / availableDatabases.length
    : 0;
  
  const idlePercentage = availableDatabases.length > 0
    ? (idleDatabases.length / availableDatabases.length) * 100
    : 0;
  
  const wastePercentage = totalRDSCost > 0
    ? (wasteCost / totalRDSCost) * 100
    : 0;

  let details = `${idleDatabases.length} idle databases with avg CPU < 5% and < 2 connections over ${idleDatabases[0]?.period || '30 days'}.`;

  let recommendation = '';
  if (idlePercentage > 40) {
    recommendation = 'HIGH WASTE: Consider deleting unused databases or taking snapshots and terminating.';
  } else if (idlePercentage > 20) {
    recommendation = 'MODERATE WASTE: Review idle databases, consider stopping or downsizing.';
  } else if (idlePercentage > 0) {
    recommendation = 'LOW WASTE: Some idle databases detected, review for optimization.';
  } else {
    recommendation = 'No idle databases detected. RDS utilization looks healthy.';
  }

  return {
    serviceName: 'Amazon RDS (Relational Database Service)',
    totalResources: availableDatabases.length,
    idleResources: idleDatabases.length,
    idlePercentage,
    totalCost: totalRDSCost,
    wasteCost,
    wastePercentage,
    details,
    recommendation,
    idleResourceIds: idleDatabases.map(m => m.resourceId),
  };
}

/**
 * Analyze ECS service for low utilization
 * Note: This is a simplified analysis based on cost trends
 */
export function analyzeECSService(costData: any): ServiceIdleAnalysis {
  const ecsCosts = costData.serviceBreakdown?.filter((s: any) => 
    s.name.includes('Elastic Container Service') || 
    s.name.includes('ECS')
  ) || [];
  
  const totalECSCost = ecsCosts.reduce((sum: number, s: any) => sum + s.cost, 0);
  
  // Without task-level metrics, we can only provide cost-based analysis
  const details = 'Task-level utilization metrics not available. Analysis based on cost trends.';
  const recommendation = 'Enable Container Insights for detailed ECS task utilization metrics.';

  return {
    serviceName: 'Amazon ECS (Elastic Container Service)',
    totalResources: 0,
    idleResources: 0,
    idlePercentage: 0,
    totalCost: totalECSCost,
    wasteCost: 0,
    wastePercentage: 0,
    details,
    recommendation,
    idleResourceIds: [],
  };
}

/**
 * Analyze Bedrock service for low API usage
 */
export function analyzeBedrockService(costData: any): ServiceIdleAnalysis {
  const bedrockCosts = costData.serviceBreakdown?.filter((s: any) => 
    s.name.includes('Bedrock') || s.name.includes('Claude')
  ) || [];
  
  const totalBedrockCost = bedrockCosts.reduce((sum: number, s: any) => sum + s.cost, 0);
  
  // Bedrock is pay-per-use, so any cost means it's being used
  // But we can check if cost is declining (potential waste)
  const details = 'Bedrock is pay-per-use. Cost indicates active API usage.';
  const recommendation = totalBedrockCost > 100
    ? 'Monitor API call patterns to ensure efficient usage and consider caching responses.'
    : 'Bedrock usage appears reasonable for pay-per-use model.';

  return {
    serviceName: 'Amazon Bedrock',
    totalResources: 0,
    idleResources: 0,
    idlePercentage: 0,
    totalCost: totalBedrockCost,
    wasteCost: 0,
    wastePercentage: 0,
    details,
    recommendation,
    idleResourceIds: [],
  };
}

/**
 * Analyze EBS service for orphaned volumes
 */
export function analyzeEBSService(
  volumes: any[],
  orphanedVolumes: any[],
  costData: any
): ServiceIdleAnalysis {
  // Calculate EBS costs from cost data
  const ebsCosts = costData.serviceBreakdown?.filter((s: any) => 
    s.name.includes('Elastic Block Store') || 
    s.name.includes('EBS')
  ) || [];
  
  const totalEBSCost = ebsCosts.reduce((sum: number, s: any) => sum + s.cost, 0);
  
  // Estimate waste cost (proportional to orphaned volumes)
  const wasteCost = volumes.length > 0
    ? (totalEBSCost * orphanedVolumes.length) / volumes.length
    : 0;
  
  const idlePercentage = volumes.length > 0
    ? (orphanedVolumes.length / volumes.length) * 100
    : 0;
  
  const wastePercentage = totalEBSCost > 0
    ? (wasteCost / totalEBSCost) * 100
    : 0;

  const details = orphanedVolumes.length > 0
    ? `${orphanedVolumes.length} unattached volumes incurring storage costs without being used.`
    : 'All volumes are attached to instances.';

  let recommendation = '';
  if (idlePercentage > 20) {
    recommendation = 'HIGH WASTE: Snapshot and delete unattached volumes to eliminate storage costs.';
  } else if (idlePercentage > 10) {
    recommendation = 'MODERATE WASTE: Review unattached volumes, snapshot if needed, then delete.';
  } else if (idlePercentage > 0) {
    recommendation = 'LOW WASTE: Some unattached volumes detected, review for cleanup.';
  } else {
    recommendation = 'No orphaned volumes detected. EBS storage is efficiently utilized.';
  }

  return {
    serviceName: 'Amazon EBS (Elastic Block Store)',
    totalResources: volumes.length,
    idleResources: orphanedVolumes.length,
    idlePercentage,
    totalCost: totalEBSCost,
    wasteCost,
    wastePercentage,
    details,
    recommendation,
    idleResourceIds: orphanedVolumes.map((v: any) => v.volumeId),
  };
}

/**
 * Analyze Elastic IP service for unattached IPs
 */
export function analyzeElasticIPService(
  elasticIPs: any[],
  unattachedIPs: any[],
  costData: any
): ServiceIdleAnalysis {
  // Elastic IPs cost $0.005/hour when unattached = ~$3.60/month each
  const costPerUnattachedIP = 3.60;
  const wasteCost = unattachedIPs.length * costPerUnattachedIP;
  
  const idlePercentage = elasticIPs.length > 0
    ? (unattachedIPs.length / elasticIPs.length) * 100
    : 0;

  const details = unattachedIPs.length > 0
    ? `${unattachedIPs.length} unattached Elastic IPs incurring hourly charges (~$3.60/month each).`
    : 'All Elastic IPs are attached to instances.';

  let recommendation = '';
  if (unattachedIPs.length > 5) {
    recommendation = 'HIGH WASTE: Release unattached Elastic IPs immediately to stop hourly charges.';
  } else if (unattachedIPs.length > 2) {
    recommendation = 'MODERATE WASTE: Review and release unattached Elastic IPs.';
  } else if (unattachedIPs.length > 0) {
    recommendation = 'LOW WASTE: Some unattached Elastic IPs detected, release if not needed.';
  } else {
    recommendation = 'No unattached Elastic IPs. All IPs are efficiently utilized.';
  }

  return {
    serviceName: 'Amazon VPC - Elastic IPs',
    totalResources: elasticIPs.length,
    idleResources: unattachedIPs.length,
    idlePercentage,
    totalCost: wasteCost, // Only unattached IPs cost money
    wasteCost,
    wastePercentage: 100, // All unattached IP costs are waste
    details,
    recommendation,
    idleResourceIds: unattachedIPs.map((ip: any) => ip.allocationId || ip.publicIp),
  };
}

/**
 * Aggregate all service-level idle analysis
 */
export function aggregateServiceIdleAnalysis(
  awsResources: any,
  costData: any
): ServiceIdleAnalysis[] {
  const analyses: ServiceIdleAnalysis[] = [];

  // EC2 Analysis (includes stopped instances)
  if (awsResources.instances) {
    analyses.push(analyzeEC2Service(
      awsResources.instances,
      awsResources.instanceMetrics || [],
      costData
    ));
  }

  // RDS Analysis
  if (awsResources.rdsInstances && awsResources.rdsMetrics) {
    analyses.push(analyzeRDSService(
      awsResources.rdsInstances,
      awsResources.rdsMetrics,
      costData
    ));
  }

  // EBS Analysis (orphaned volumes)
  if (awsResources.volumes && awsResources.orphanedVolumes) {
    const ebsAnalysis = analyzeEBSService(
      awsResources.volumes,
      awsResources.orphanedVolumes,
      costData
    );
    if (ebsAnalysis.idleResources > 0) {
      analyses.push(ebsAnalysis);
    }
  }

  // Elastic IP Analysis (unattached IPs)
  if (awsResources.elasticIPs && awsResources.unattachedIPs) {
    const eipAnalysis = analyzeElasticIPService(
      awsResources.elasticIPs,
      awsResources.unattachedIPs,
      costData
    );
    if (eipAnalysis.idleResources > 0) {
      analyses.push(eipAnalysis);
    }
  }

  // ECS Analysis (cost-based only)
  const ecsAnalysis = analyzeECSService(costData);
  if (ecsAnalysis.totalCost > 0) {
    analyses.push(ecsAnalysis);
  }

  // Bedrock Analysis
  const bedrockAnalysis = analyzeBedrockService(costData);
  if (bedrockAnalysis.totalCost > 0) {
    analyses.push(bedrockAnalysis);
  }

  // Sort by waste cost (highest first)
  return analyses.sort((a, b) => b.wasteCost - a.wasteCost);
}
