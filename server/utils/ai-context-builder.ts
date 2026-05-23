/**
 * AI Context Builder
 * Builds comprehensive context for AI analysis including resource data
 */

import { QueryIntent } from './query-analyzer';
import { fetchAWSResources } from './aws-resource-fetcher';
import { fetchAzureResources } from './azure-resource-fetcher';
import { fetchGCPResources } from './gcp-resource-fetcher';

/**
 * Build enhanced context with service-level analysis for idle detection
 */
export async function buildEnhancedContext(
  query: string,
  intent: QueryIntent,
  costData: any,
  anomalyData: any
): Promise<string> {
  let context = buildBaseCostContext(costData, anomalyData, intent.provider);

  // Add resource-specific data if needed
  if (intent.needsResourceData) {
    // For idle detection, add service-level analysis
    if (intent.action === 'find-idle' && (intent.provider === 'aws' || intent.provider === 'all')) {
      console.log('[AI Context] Building service-level idle analysis...');
      const days = intent.filters?.age || 30; // Default to 30 days if not specified
      const awsResources = await fetchAWSResources(intent.resourceTypes, intent.action, days);
      
      // Add service-level analysis
      const { aggregateServiceIdleAnalysis } = await import('./service-level-idle-analyzer');
      const serviceAnalyses = aggregateServiceIdleAnalysis(awsResources, costData);
      
      context += '\n\n=== SERVICE-LEVEL IDLE ANALYSIS ===\n';
      context += `Analysis of AWS services showing idle/underutilized resources (${days}-day period):\n`;
      
      for (const analysis of serviceAnalyses) {
        context += `\n--- ${analysis.serviceName} ---`;
        context += `\n  Total Resources: ${analysis.totalResources}`;
        context += `\n  Idle Resources: ${analysis.idleResources} (${analysis.idlePercentage.toFixed(1)}%)`;
        context += `\n  Total Cost: $${analysis.totalCost.toFixed(2)}/month`;
        context += `\n  Waste Cost: $${analysis.wasteCost.toFixed(2)}/month (${analysis.wastePercentage.toFixed(1)}% waste)`;
        context += `\n  Details: ${analysis.details}`;
        context += `\n  Recommendation: ${analysis.recommendation}`;
        if (analysis.idleResourceIds.length > 0) {
          context += `\n  Idle Resource IDs: ${analysis.idleResourceIds.slice(0, 5).join(', ')}`;
          if (analysis.idleResourceIds.length > 5) {
            context += ` ... and ${analysis.idleResourceIds.length - 5} more`;
          }
        }
      }
      
      // Also add detailed resource context
      context += await buildResourceContext(intent);
    } else {
      // Regular resource context for non-idle queries
      const resourceContext = await buildResourceContext(intent);
      if (resourceContext) {
        context += `\n\n${resourceContext}`;
      }
    }
  }

  // Add instructions based on action
  context += buildActionInstructions(intent);

  return context;
}

/**
 * Build base cost context
 */
function buildBaseCostContext(costData: any, anomalyData: any, provider: string): string {
  const providerName = provider === 'all' ? 'multi-cloud' : provider.toUpperCase();
  
  let context = `You are an AI assistant analyzing ${providerName} cloud spending and resources. Answer questions clearly and concisely based on the data provided.

COST SUMMARY:
- Total Cost: $${costData.totalCost.toFixed(2)}
- Average Daily Cost: $${costData.avgDailyCost.toFixed(2)}
- Top Service: ${costData.topService.name} ($${costData.topService.cost.toFixed(2)})
- Number of Services: ${costData.serviceCount}
- Peak Day: ${costData.peakDay.date} ($${costData.peakDay.cost.toFixed(2)})

TOP 10 SERVICES BY COST:
${costData.serviceBreakdown.slice(0, 10).map((s: any, i: number) => 
  `${i + 1}. ${s.name}: $${s.cost.toFixed(2)} (${s.percentage.toFixed(1)}%)`
).join('\n')}`;

  if (anomalyData?.anomalies?.length > 0) {
    context += `\n\nDETECTED SPENDING ANOMALIES:
${anomalyData.anomalies.map((a: any) => 
  `- ${a.date}: $${a.cost.toFixed(2)} (${a.type}, ${a.severity} severity) - ${a.description}`
).join('\n')}

INSIGHTS:
${anomalyData.insights.join('\n')}`;
  }

  return context;
}

/**
 * Build resource-specific context
 */
async function buildResourceContext(intent: QueryIntent): Promise<string> {
  console.log('[AI Context] Building resource context for intent:', intent);
  let context = '\n=== RESOURCE INVENTORY ===\n';
  
  try {
    const days = intent.filters?.age || 30; // Default to 30 days if not specified
    
    if (intent.provider === 'aws' || intent.provider === 'all') {
      console.log('[AI Context] Fetching AWS resources...');
      const awsResources = await fetchAWSResources(intent.resourceTypes, intent.action, days);
      context += formatAWSResources(awsResources, intent);
    }

    if (intent.provider === 'azure' || intent.provider === 'all') {
      console.log('[AI Context] Fetching Azure resources...');
      const azureResources = await fetchAzureResources(intent);
      console.log('[AI Context] Azure resources fetched:', azureResources);
      context += formatAzureResources(azureResources, intent);
    }

    if (intent.provider === 'gcp' || intent.provider === 'all') {
      console.log('[AI Context] Fetching GCP resources...');
      const gcpResources = await fetchGCPResources(intent);
      context += formatGCPResources(gcpResources, intent);
    }

    console.log('[AI Context] Final context length:', context.length);
    return context;
  } catch (error) {
    console.error('[AI Context] Error building resource context:', error);
    return '';
  }
}

/**
 * Format AWS resources for context
 */
function formatAWSResources(resources: any, intent: QueryIntent): string {
  let context = '\n--- AWS RESOURCES ---\n';

  if (resources.volumes) {
    context += `\nEBS VOLUMES (${resources.volumes.length} total):`;
    if (resources.orphanedVolumes?.length > 0) {
      context += `\n  ORPHANED/UNATTACHED VOLUMES (${resources.orphanedVolumes.length}):`;
      resources.orphanedVolumes.slice(0, 20).forEach((vol: any) => {
        const age = Math.floor((Date.now() - new Date(vol.createTime).getTime()) / (1000 * 60 * 60 * 24));
        context += `\n    - ${vol.volumeId}: ${vol.size}GB, ${vol.volumeType}, created ${age} days ago`;
        if (vol.tags?.Name) context += ` (${vol.tags.Name})`;
      });
      if (resources.orphanedVolumes.length > 20) {
        context += `\n    ... and ${resources.orphanedVolumes.length - 20} more`;
      }
    }
  }

  if (resources.instances) {
    context += `\n\nEC2 INSTANCES (${resources.instances.length} total):`;
    
    // Show idle instances with metrics if available
    if (resources.idleInstances?.length > 0) {
      context += `\n  IDLE INSTANCES (${resources.idleInstances.length}) - Based on 30-day metrics:`;
      resources.idleInstances.slice(0, 15).forEach((metric: any) => {
        context += `\n    - ${metric.resourceId}: Avg CPU ${metric.avgCpuUtilization.toFixed(2)}%, Max CPU ${metric.maxCpuUtilization.toFixed(2)}%`;
        context += `\n      Network: ${metric.avgNetworkIn.toFixed(2)}MB in, ${metric.avgNetworkOut.toFixed(2)}MB out`;
      });
      if (resources.idleInstances.length > 15) {
        context += `\n    ... and ${resources.idleInstances.length - 15} more idle instances`;
      }
    }
    
    if (resources.stoppedInstances?.length > 0) {
      context += `\n  STOPPED INSTANCES (${resources.stoppedInstances.length}):`;
      resources.stoppedInstances.slice(0, 10).forEach((inst: any) => {
        context += `\n    - ${inst.instanceId}: ${inst.instanceType}, state: ${inst.state}`;
        if (inst.tags?.Name) context += ` (${inst.tags.Name})`;
      });
    }
  }

  if (resources.s3Buckets) {
    context += `\n\nS3 BUCKETS (${resources.s3Buckets.length} total)`;
  }

  if (resources.snapshots) {
    context += `\n\nEBS SNAPSHOTS (${resources.snapshots.length} total)`;
  }

  if (resources.elasticIPs) {
    context += `\n\nELASTIC IPs (${resources.elasticIPs.length} total):`;
    if (resources.unattachedIPs?.length > 0) {
      context += `\n  UNATTACHED IPs (${resources.unattachedIPs.length}):`;
      resources.unattachedIPs.forEach((ip: any) => {
        context += `\n    - ${ip.publicIp} (${ip.allocationId})`;
      });
    }
  }

  if (resources.rdsInstances) {
    context += `\n\nRDS INSTANCES (${resources.rdsInstances.length} total):`;
    
    // Show idle RDS instances with metrics if available
    if (resources.idleRDSInstances?.length > 0) {
      context += `\n  IDLE RDS INSTANCES (${resources.idleRDSInstances.length}) - Based on 30-day metrics:`;
      resources.idleRDSInstances.forEach((metric: any) => {
        context += `\n    - ${metric.resourceId}: ${metric.idleReason}`;
      });
    }
    
    resources.rdsInstances.slice(0, 10).forEach((db: any) => {
      context += `\n  - ${db.dbInstanceIdentifier}: ${db.engine}, ${db.dbInstanceClass}, status: ${db.dbInstanceStatus}`;
    });
  }

  return context;
}

/**
 * Format Azure resources for context
 */
function formatAzureResources(resources: any, intent: QueryIntent): string {
  let context = '\n--- AZURE RESOURCES ---\n';

  if (resources.disks) {
    context += `\nMANAGED DISKS (${resources.disks.length} total):`;
    if (resources.orphanedDisks?.length > 0) {
      context += `\n  ORPHANED/UNATTACHED DISKS (${resources.orphanedDisks.length}):`;
      resources.orphanedDisks.slice(0, 20).forEach((disk: any) => {
        context += `\n    - ${disk.name}: ${disk.diskSizeGB}GB, state: ${disk.diskState}, location: ${disk.location}`;
      });
      if (resources.orphanedDisks.length > 20) {
        context += `\n    ... and ${resources.orphanedDisks.length - 20} more`;
      }
    }
  }

  if (resources.vms) {
    context += `\n\nVIRTUAL MACHINES (${resources.vms.length} total):`;
    if (resources.stoppedVMs?.length > 0) {
      context += `\n  STOPPED/DEALLOCATED VMs (${resources.stoppedVMs.length}):`;
      resources.stoppedVMs.slice(0, 10).forEach((vm: any) => {
        context += `\n    - ${vm.name}: ${vm.vmSize}, power state: ${vm.powerState}`;
      });
    }
  }

  if (resources.storageAccounts) {
    context += `\n\nSTORAGE ACCOUNTS (${resources.storageAccounts.length} total)`;
  }

  return context;
}

/**
 * Format GCP resources for context
 */
function formatGCPResources(resources: any, intent: QueryIntent): string {
  let context = '\n--- GCP RESOURCES ---\n';

  if (resources.disks) {
    context += `\nPERSISTENT DISKS (${resources.disks.length} total):`;
    if (resources.orphanedDisks?.length > 0) {
      context += `\n  ORPHANED/UNATTACHED DISKS (${resources.orphanedDisks.length}):`;
      resources.orphanedDisks.slice(0, 20).forEach((disk: any) => {
        context += `\n    - ${disk.name}: ${disk.sizeGb}GB, type: ${disk.type}, zone: ${disk.zone}`;
      });
      if (resources.orphanedDisks.length > 20) {
        context += `\n    ... and ${resources.orphanedDisks.length - 20} more`;
      }
    }
  }

  if (resources.instances) {
    context += `\n\nCOMPUTE INSTANCES (${resources.instances.length} total):`;
    if (resources.stoppedInstances?.length > 0) {
      context += `\n  STOPPED INSTANCES (${resources.stoppedInstances.length}):`;
      resources.stoppedInstances.slice(0, 10).forEach((inst: any) => {
        context += `\n    - ${inst.name}: ${inst.machineType}, status: ${inst.status}`;
      });
    }
  }

  if (resources.buckets) {
    context += `\n\nSTORAGE BUCKETS (${resources.buckets.length} total)`;
  }

  return context;
}

/**
 * Build action-specific instructions
 */
function buildActionInstructions(intent: QueryIntent): string {
  let instructions = '\n\n=== INSTRUCTIONS ===\n';

  if (intent.action === 'find-orphaned') {
    instructions += `Focus on orphaned/unattached resources. List specific resource IDs and provide:
- Resource identifier (volume ID, disk name, etc.)
- Size and type
- Age (how long it's been orphaned)
- Estimated monthly cost
- Recommendation for action (delete, attach, or keep)`;
  } else if (intent.action === 'find-idle') {
    instructions += `IMPORTANT: Use the SERVICE-LEVEL IDLE ANALYSIS section above to answer questions about idle services.

The SERVICE-LEVEL IDLE ANALYSIS provides aggregated data by AWS service (EC2, RDS, ECS, Bedrock):
- Total resources and idle count per service
- Idle percentage and waste percentage
- Total cost and waste cost per service
- Specific recommendations for each service
- Sample idle resource IDs

When answering about "idle services", focus on the service-level summary, NOT individual resources.

Example answer format:
"Based on the analysis:
- EC2 service has X idle instances (Y% waste, $Z/month wasted)
- RDS service has X idle databases (Y% waste, $Z/month wasted)
- Total waste: $X/month across all services

Recommendations: [provide service-specific recommendations from the analysis]"

IDLE CRITERIA USED:
- EC2/VM: Average CPU < 5% AND Max CPU < 10% over the analysis period
- RDS: Average CPU < 5% AND Average connections < 2
- Stopped instances are definitely idle

Be specific with numbers from the SERVICE-LEVEL IDLE ANALYSIS section.`;
  } else if (intent.action === 'list') {
    instructions += `List the requested resources with key details:
- Resource identifiers
- Current state/status
- Important attributes (size, type, location)
- Any cost implications`;
  } else {
    instructions += `Analyze the data and provide actionable insights:
- Answer the specific question asked
- Include relevant numbers and resource IDs
- Provide recommendations when appropriate
- Be concise and clear`;
  }

  instructions += `\n\nWhen answering:
- Use specific resource IDs from the data
- Provide concrete numbers (costs, sizes, counts)
- Be actionable - tell users what they can do
- Format lists clearly with bullet points or numbers`;

  return instructions;
}
