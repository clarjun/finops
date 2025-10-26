import OpenAI from "openai";
import { db } from "./db";
import { 
  optimizationPlans, 
  optimizationActions,
  agentConfig,
  InsertOptimizationPlan,
  InsertOptimizationAction
} from "../shared/schema";
import { eq } from "drizzle-orm";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

interface PlanningContext {
  goal: string; // "Reduce AWS costs by 30%"
  provider?: string; // 'aws', 'gcp', 'azure', or 'all'
  currentCostData?: any; // Current cost analytics
  anomalies?: any[]; // Recent anomalies
  recommendations?: any[]; // Existing optimization recommendations
  budgets?: any[]; // Current budgets
  awsResources?: any; // AWS resource inventory
  awsInventoryWarning?: string; // Warning if AWS inventory fetch had errors
  azureResources?: any; // Azure resource inventory
  azureInventoryWarning?: string; // Warning if Azure inventory fetch had errors
  gcpResources?: any; // GCP resource inventory
  gcpInventoryWarning?: string; // Warning if GCP inventory fetch had errors
}

interface PlanStep {
  stepIndex: number;
  actionType: string;
  description: string;
  estimatedSavings: number;
  riskLevel: 'low' | 'medium' | 'high';
  dependencies: number[]; // Indices of steps that must complete first
  resourceDetails: {
    resourceId?: string;
    resourceType?: string;
    currentState?: any;
    proposedState?: any;
  };
}

interface OptimizationPlanResult {
  planId: number;
  goal: string;
  strategy: string;
  steps: PlanStep[];
  totalSavings: number;
  totalSteps: number;
}

export class AIAgentPlanner {
  async generateOptimizationPlan(context: PlanningContext): Promise<OptimizationPlanResult> {
    console.log('[AI Agent Planner] Generating optimization plan:', context.goal);

    // Get agent configuration
    const config = await db.select().from(agentConfig).limit(1);
    const agentSettings = config[0] || {
      aggressiveness: 'medium',
      enabled_providers: ['aws', 'gcp', 'azure'],
      enabled_action_types: ['ec2_downsize', 's3_lifecycle', 'ebs_delete_snapshot', 'ri_recommend'],
      safety_mode: 1,
    };

    // Build AI prompt with context
    const prompt = this.buildPlanningPrompt(context, agentSettings);

    try {
      // Call GPT-5 to generate the plan
      // Note: gpt-5 is the newest OpenAI model released August 7, 2025. Do not change unless explicitly requested.
      const response = await openai.chat.completions.create({
        model: "gpt-5",
        messages: [
          {
            role: "system",
            content: `You are an expert FinOps AI agent specializing in cloud cost optimization. 
Your job is to analyze cloud spending and create detailed, multi-step optimization plans.

You must respond with valid JSON in this exact format:
{
  "strategy": "Brief explanation of the overall strategy",
  "steps": [
    {
      "stepIndex": 0,
      "actionType": "ec2_downsize",
      "description": "Detailed description",
      "estimatedSavings": 1500.00,
      "riskLevel": "low",
      "dependencies": [],
      "resourceDetails": {
        "resourceId": "i-1234567890abcdef0",
        "resourceType": "ec2_instance",
        "currentState": {"instanceType": "t3.large"},
        "proposedState": {"instanceType": "t3.medium"}
      }
    }
  ]
}

Action types: ec2_downsize, s3_lifecycle, ebs_delete_snapshot, ri_recommend, idle_resource_alert, delete_unused_eip, stop_idle_instance, cloudwatch_log_retention

Risk levels: low (safe), medium (needs monitoring), high (potential impact)

Dependencies: Array of stepIndex values that must complete first.`
          },
          {
            role: "user",
            content: prompt
          }
        ],
        response_format: { type: "json_object" },
        max_completion_tokens: 8192, // GPT-5 uses reasoning tokens + output tokens, needs higher limit
      });

      const aiResponse = response.choices[0]?.message?.content || '';
      console.log('[AI Agent Planner] Successfully received GPT-5 response');

      // Parse AI response
      const plan = this.parseAIPlan(aiResponse);

      // Store plan in database
      const planId = await this.storePlan(context, plan, agentSettings);

      // Create optimization actions for each step
      await this.createActions(planId, plan.steps, context.provider || 'aws');

      return {
        planId,
        goal: context.goal,
        strategy: plan.strategy,
        steps: plan.steps,
        totalSavings: plan.steps.reduce((sum, step) => sum + step.estimatedSavings, 0),
        totalSteps: plan.steps.length,
      };
    } catch (error) {
      console.error('[AI Agent Planner] Error generating plan:', error);
      
      // Fallback: Generate a basic plan if AI fails
      return this.generateFallbackPlan(context);
    }
  }

  private buildPlanningPrompt(context: PlanningContext, agentSettings: any): string {
    const provider = context.provider || 'all';
    const aggressiveness = agentSettings.aggressiveness || 'medium';

    let prompt = `Goal: ${context.goal}\n\n`;
    prompt += `Cloud Provider: ${provider}\n`;
    prompt += `Optimization Aggressiveness: ${aggressiveness}\n\n`;

    if (context.currentCostData) {
      const data = context.currentCostData;
      prompt += `Current Spending:\n`;
      prompt += `- Total Cost: $${data.totalCost?.toFixed(2)}\n`;
      prompt += `- Average Daily Cost: $${data.avgDailyCost?.toFixed(2)}\n`;
      prompt += `- Top Service: ${data.topService?.name} ($${data.topService?.cost?.toFixed(2)})\n`;
      prompt += `- Total Services: ${data.serviceCount}\n\n`;

      if (data.serviceBreakdown?.length > 0) {
        prompt += `Service Breakdown:\n`;
        data.serviceBreakdown.slice(0, 5).forEach((s: any) => {
          prompt += `- ${s.name}: $${s.cost?.toFixed(2)} (${s.percentage?.toFixed(1)}%)\n`;
        });
        prompt += '\n';
      }
    }

    if (context.anomalies && context.anomalies.length > 0) {
      prompt += `Recent Anomalies:\n`;
      context.anomalies.slice(0, 3).forEach((a: any) => {
        prompt += `- ${a.description} (Severity: ${a.severity})\n`;
      });
      prompt += '\n';
    }

    if (context.recommendations && context.recommendations.length > 0) {
      prompt += `Existing Recommendations:\n`;
      context.recommendations.slice(0, 5).forEach((r: any) => {
        prompt += `- ${r.recommendation_type}: ${r.description} (Savings: $${r.estimated_savings?.toFixed(2)})\n`;
      });
      prompt += '\n';
    }

    // Include AWS resource inventory if available
    if (context.awsResources) {
      const aws = context.awsResources;
      
      prompt += `=== ACTUAL AWS RESOURCE INVENTORY ===\n\n`;
      
      // Include warning about inventory errors if present
      if (context.awsInventoryWarning) {
        prompt += `${context.awsInventoryWarning}\n\n`;
      }
      
      // EC2 Instances
      if (aws.ec2Instances && aws.ec2Instances.length > 0) {
        prompt += `EC2 Instances (${aws.ec2Instances.length} total):\n`;
        aws.ec2Instances.slice(0, 10).forEach((inst: any) => {
          prompt += `- ${inst.instanceId}: ${inst.instanceType}, State: ${inst.state}`;
          if (inst.launchTime) {
            prompt += `, Launched: ${new Date(inst.launchTime).toISOString().split('T')[0]}`;
          }
          prompt += '\n';
        });
        if (aws.ec2Instances.length > 10) {
          prompt += `... and ${aws.ec2Instances.length - 10} more instances\n`;
        }
        prompt += '\n';
      }
      
      // Lambda Functions
      if (aws.lambdaFunctions && aws.lambdaFunctions.length > 0) {
        prompt += `Lambda Functions (${aws.lambdaFunctions.length} total):\n`;
        aws.lambdaFunctions.slice(0, 10).forEach((fn: any) => {
          prompt += `- ${fn.functionName}: ${fn.memorySize}MB, Timeout: ${fn.timeout}s`;
          if (fn.runtime) {
            prompt += `, Runtime: ${fn.runtime}`;
          }
          prompt += '\n';
        });
        if (aws.lambdaFunctions.length > 10) {
          prompt += `... and ${aws.lambdaFunctions.length - 10} more functions\n`;
        }
        prompt += '\n';
      }
      
      // RDS Instances
      if (aws.rdsInstances && aws.rdsInstances.length > 0) {
        prompt += `RDS Instances (${aws.rdsInstances.length} total):\n`;
        aws.rdsInstances.slice(0, 10).forEach((db: any) => {
          prompt += `- ${db.instanceId}: ${db.instanceClass}, Engine: ${db.engine}`;
          if (db.allocatedStorage) {
            prompt += `, Storage: ${db.allocatedStorage}GB`;
          }
          if (db.multiAZ) {
            prompt += `, Multi-AZ`;
          }
          prompt += '\n';
        });
        if (aws.rdsInstances.length > 10) {
          prompt += `... and ${aws.rdsInstances.length - 10} more instances\n`;
        }
        prompt += '\n';
      }
      
      // S3 Buckets
      if (aws.s3Buckets && aws.s3Buckets.length > 0) {
        prompt += `S3 Buckets (${aws.s3Buckets.length} total):\n`;
        aws.s3Buckets.slice(0, 10).forEach((bucket: any) => {
          prompt += `- ${bucket.name}`;
          if (bucket.creationDate) {
            prompt += ` (Created: ${new Date(bucket.creationDate).toISOString().split('T')[0]})`;
          }
          prompt += '\n';
        });
        if (aws.s3Buckets.length > 10) {
          prompt += `... and ${aws.s3Buckets.length - 10} more buckets\n`;
        }
        prompt += '\n';
      }
      
      // EBS Volumes
      if (aws.ebsVolumes && aws.ebsVolumes.length > 0) {
        const unattachedVolumes = aws.ebsVolumes.filter((v: any) => !v.attachedTo);
        prompt += `EBS Volumes (${aws.ebsVolumes.length} total, ${unattachedVolumes.length} unattached):\n`;
        aws.ebsVolumes.slice(0, 5).forEach((vol: any) => {
          prompt += `- ${vol.volumeId}: ${vol.volumeType}, ${vol.size}GB, State: ${vol.state}`;
          if (!vol.attachedTo) {
            prompt += ` [UNATTACHED - POTENTIAL SAVINGS]`;
          }
          prompt += '\n';
        });
        if (aws.ebsVolumes.length > 5) {
          prompt += `... and ${aws.ebsVolumes.length - 5} more volumes\n`;
        }
        prompt += '\n';
      }
      
      // CloudWatch Log Groups
      if (aws.cloudwatchLogGroups && aws.cloudwatchLogGroups.length > 0) {
        const highRetention = aws.cloudwatchLogGroups.filter((lg: any) => !lg.retentionInDays || lg.retentionInDays > 365);
        prompt += `CloudWatch Log Groups (${aws.cloudwatchLogGroups.length} total, ${highRetention.length} with high/infinite retention):\n`;
        aws.cloudwatchLogGroups.slice(0, 5).forEach((lg: any) => {
          prompt += `- ${lg.logGroupName}: Retention: ${lg.retentionInDays || 'Never expires'}`;
          if (lg.storedBytes) {
            const sizeMB = (lg.storedBytes / (1024 * 1024)).toFixed(2);
            prompt += `, Size: ${sizeMB}MB`;
          }
          prompt += '\n';
        });
        if (aws.cloudwatchLogGroups.length > 5) {
          prompt += `... and ${aws.cloudwatchLogGroups.length - 5} more log groups\n`;
        }
        prompt += '\n';
      }
      
      // EBS Snapshots
      if (aws.ebsSnapshots && aws.ebsSnapshots.length > 0) {
        prompt += `EBS Snapshots: ${aws.ebsSnapshots.length} total\n`;
        prompt += `Consider reviewing for old/unused snapshots that can be deleted.\n\n`;
      }
      
      // Elastic IPs
      if (aws.elasticIPs && aws.elasticIPs.length > 0) {
        const unassociated = aws.elasticIPs.filter((eip: any) => !eip.AssociationId);
        prompt += `Elastic IPs: ${aws.elasticIPs.length} total`;
        if (unassociated.length > 0) {
          prompt += `, ${unassociated.length} UNASSOCIATED [COSTING MONEY]`;
        }
        prompt += '\n\n';
      }
      
      prompt += `=== END AWS INVENTORY ===\n\n`;
      
      prompt += `IMPORTANT: Use the ACTUAL resource IDs and details from the inventory above in your recommendations. `;
      prompt += `For example, if recommending EC2 rightsizing, reference specific instance IDs like "${aws.ec2Instances[0]?.instanceId || 'i-xxxxx'}". `;
      prompt += `If recommending Lambda optimization, use actual function names like "${aws.lambdaFunctions[0]?.functionName || 'my-function'}". \n\n`;
    }

    // Include Azure resource inventory if available
    if (context.azureResources) {
      const azure = context.azureResources;
      
      prompt += `=== ACTUAL AZURE RESOURCE INVENTORY ===\n\n`;
      
      // Include warning about inventory errors if present
      if (context.azureInventoryWarning) {
        prompt += `${context.azureInventoryWarning}\n\n`;
      }
      
      // Virtual Machines
      if (azure.virtualMachines && azure.virtualMachines.length > 0) {
        prompt += `Virtual Machines (${azure.virtualMachines.length} total):\n`;
        azure.virtualMachines.slice(0, 10).forEach((vm: any) => {
          prompt += `- ${vm.name}: ${vm.vmSize}, Location: ${vm.location}, State: ${vm.provisioningState || 'unknown'}`;
          if (vm.resourceGroup) {
            prompt += `, RG: ${vm.resourceGroup}`;
          }
          prompt += '\n';
        });
        if (azure.virtualMachines.length > 10) {
          prompt += `... and ${azure.virtualMachines.length - 10} more VMs\n`;
        }
        prompt += '\n';
      }
      
      // SQL Databases
      if (azure.sqlDatabases && azure.sqlDatabases.length > 0) {
        prompt += `SQL Databases (${azure.sqlDatabases.length} total):\n`;
        azure.sqlDatabases.slice(0, 10).forEach((db: any) => {
          prompt += `- ${db.name} (Server: ${db.serverName}): `;
          if (db.sku) {
            prompt += `${db.sku.name} ${db.sku.tier || ''}`;
          }
          prompt += `, Location: ${db.location}`;
          prompt += '\n';
        });
        if (azure.sqlDatabases.length > 10) {
          prompt += `... and ${azure.sqlDatabases.length - 10} more databases\n`;
        }
        prompt += '\n';
      }
      
      // Storage Accounts
      if (azure.storageAccounts && azure.storageAccounts.length > 0) {
        prompt += `Storage Accounts (${azure.storageAccounts.length} total):\n`;
        azure.storageAccounts.slice(0, 10).forEach((sa: any) => {
          prompt += `- ${sa.name}: ${sa.kind || 'Storage'}, SKU: ${sa.sku?.name || 'unknown'}`;
          prompt += `, Location: ${sa.location}`;
          prompt += '\n';
        });
        if (azure.storageAccounts.length > 10) {
          prompt += `... and ${azure.storageAccounts.length - 10} more storage accounts\n`;
        }
        prompt += '\n';
      }
      
      // Resource Groups
      if (azure.resourceGroups && azure.resourceGroups.length > 0) {
        prompt += `Resource Groups: ${azure.resourceGroups.length} total\n`;
        prompt += `Consider consolidating underutilized resource groups.\n\n`;
      }
      
      prompt += `=== END AZURE INVENTORY ===\n\n`;
      
      prompt += `IMPORTANT: Use the ACTUAL resource names and details from the Azure inventory above in your recommendations. `;
      prompt += `For example, if recommending VM rightsizing, reference specific VM names like "${azure.virtualMachines[0]?.name || 'my-vm'}". \n\n`;
    }

    // Include GCP resource inventory if available
    if (context.gcpResources) {
      const gcp = context.gcpResources;
      
      prompt += `=== ACTUAL GCP RESOURCE INVENTORY ===\n\n`;
      
      // Include warning about inventory errors if present
      if (context.gcpInventoryWarning) {
        prompt += `${context.gcpInventoryWarning}\n\n`;
      }
      
      // Compute Instances
      if (gcp.computeInstances && gcp.computeInstances.length > 0) {
        prompt += `Compute Engine Instances (${gcp.computeInstances.length} total):\n`;
        gcp.computeInstances.slice(0, 10).forEach((inst: any) => {
          prompt += `- ${inst.name}: ${inst.machineType}, Zone: ${inst.zone}, Status: ${inst.status || 'unknown'}`;
          prompt += '\n';
        });
        if (gcp.computeInstances.length > 10) {
          prompt += `... and ${gcp.computeInstances.length - 10} more instances\n`;
        }
        prompt += '\n';
      }
      
      // Cloud Functions
      if (gcp.cloudFunctions && gcp.cloudFunctions.length > 0) {
        prompt += `Cloud Functions (${gcp.cloudFunctions.length} total):\n`;
        gcp.cloudFunctions.slice(0, 10).forEach((fn: any) => {
          prompt += `- ${fn.name.split('/').pop()}: ${fn.availableMemoryMb || 256}MB`;
          if (fn.runtime) {
            prompt += `, Runtime: ${fn.runtime}`;
          }
          prompt += `, Region: ${fn.region}`;
          prompt += '\n';
        });
        if (gcp.cloudFunctions.length > 10) {
          prompt += `... and ${gcp.cloudFunctions.length - 10} more functions\n`;
        }
        prompt += '\n';
      }
      
      // Storage Buckets
      if (gcp.storageBuckets && gcp.storageBuckets.length > 0) {
        prompt += `Cloud Storage Buckets (${gcp.storageBuckets.length} total):\n`;
        gcp.storageBuckets.slice(0, 10).forEach((bucket: any) => {
          prompt += `- ${bucket.name}: ${bucket.storageClass || 'STANDARD'}, Location: ${bucket.location}`;
          prompt += '\n';
        });
        if (gcp.storageBuckets.length > 10) {
          prompt += `... and ${gcp.storageBuckets.length - 10} more buckets\n`;
        }
        prompt += '\n';
      }
      
      prompt += `=== END GCP INVENTORY ===\n\n`;
      
      prompt += `IMPORTANT: Use the ACTUAL resource names and details from the GCP inventory above in your recommendations. `;
      prompt += `For example, if recommending Compute Engine rightsizing, reference specific instance names like "${gcp.computeInstances[0]?.name || 'my-instance'}". \n\n`;
    }

    prompt += `Create a detailed, multi-step optimization plan to achieve the goal. `;
    prompt += `Consider resource rightsizing, idle resource elimination, storage lifecycle policies, and reserved capacity. `;
    prompt += `Make the plan ${aggressiveness} - `;
    
    if (aggressiveness === 'low') {
      prompt += `conservative, focusing only on safe, proven optimizations.`;
    } else if (aggressiveness === 'medium') {
      prompt += `balanced between savings and risk.`;
    } else {
      prompt += `aggressive, maximizing savings even with some risk.`;
    }

    prompt += `\n\nProvide your response as valid JSON only.`;

    return prompt;
  }

  private parseAIPlan(aiResponse: string): { strategy: string; steps: PlanStep[] } {
    try {
      // Remove markdown code blocks if present
      let cleanResponse = aiResponse.trim();
      
      // Remove ```json and ``` wrappers
      cleanResponse = cleanResponse.replace(/^```(?:json)?\s*/i, '');
      cleanResponse = cleanResponse.replace(/\s*```\s*$/, '');
      cleanResponse = cleanResponse.trim();
      
      // Try to extract JSON from response
      const jsonMatch = cleanResponse.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.error('[AI Agent Planner] No JSON found in cleaned response:', cleanResponse);
        throw new Error('No JSON found in AI response');
      }

      const parsed = JSON.parse(jsonMatch[0]);
      
      if (!parsed.strategy || !parsed.steps || !Array.isArray(parsed.steps)) {
        console.error('[AI Agent Planner] Invalid plan structure:', parsed);
        throw new Error('Invalid plan structure from AI');
      }
      
      console.log('[AI Agent Planner] Successfully parsed plan with', parsed.steps.length, 'steps');
      
      return {
        strategy: parsed.strategy,
        steps: parsed.steps
      };
    } catch (error) {
      console.error('[AI Agent Planner] Failed to parse AI response:', error);
      console.error('[AI Agent Planner] Raw AI response was:', aiResponse);
      throw error;
    }
  }

  private async storePlan(
    context: PlanningContext,
    plan: { strategy: string; steps: PlanStep[] },
    agentSettings: any
  ): Promise<number> {
    const totalSavings = plan.steps.reduce((sum, step) => sum + step.estimatedSavings, 0);

    const planData: InsertOptimizationPlan = {
      goal: context.goal,
      provider: context.provider || 'all',
      targetSavings: totalSavings.toString(),
      aiStrategy: plan.strategy,
      steps: plan.steps as any,
      totalSteps: plan.steps.length,
      status: 'planning',
    };

    const result = await db.insert(optimizationPlans).values(planData).returning({ id: optimizationPlans.id });
    return result[0].id;
  }

  private async createActions(planId: number, steps: PlanStep[], provider: string): Promise<void> {
    for (const step of steps) {
      const actionData: InsertOptimizationAction = {
        planId,
        actionType: step.actionType,
        provider,
        accountId: 'default', // TODO: Get from context
        resourceId: step.resourceDetails.resourceId,
        resourceType: step.resourceDetails.resourceType,
        currentState: step.resourceDetails.currentState as any,
        proposedState: step.resourceDetails.proposedState as any,
        estimatedSavings: step.estimatedSavings.toString(),
        riskLevel: step.riskLevel,
        status: 'proposed',
        aiReasoning: step.description,
      };

      await db.insert(optimizationActions).values(actionData);
    }
  }

  private async generateFallbackPlan(context: PlanningContext): Promise<OptimizationPlanResult> {
    console.log('[AI Agent Planner] Using fallback plan generation');

    const fallbackSteps: PlanStep[] = [
      {
        stepIndex: 0,
        actionType: 'idle_resource_alert',
        description: 'Identify and alert on idle EC2 instances with < 5% CPU utilization',
        estimatedSavings: 500,
        riskLevel: 'low',
        dependencies: [],
        resourceDetails: {
          resourceType: 'ec2_instance',
        }
      },
      {
        stepIndex: 1,
        actionType: 's3_lifecycle',
        description: 'Apply lifecycle policies to S3 buckets to transition old data to Glacier',
        estimatedSavings: 300,
        riskLevel: 'low',
        dependencies: [],
        resourceDetails: {
          resourceType: 's3_bucket',
        }
      }
    ];

    const plan = {
      strategy: 'Basic cost optimization focusing on identifying idle resources and optimizing storage',
      steps: fallbackSteps
    };

    const agentSettings = { aggressiveness: 'medium' };
    const planId = await this.storePlan(context, plan, agentSettings);
    await this.createActions(planId, fallbackSteps, context.provider || 'aws');

    return {
      planId,
      goal: context.goal,
      strategy: plan.strategy,
      steps: fallbackSteps,
      totalSavings: 800,
      totalSteps: 2,
    };
  }
}

export const aiAgentPlanner = new AIAgentPlanner();
