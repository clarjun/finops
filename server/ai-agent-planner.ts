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
      const response = await openai.chat.completions.create({
        model: "gpt-4o",
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
        temperature: 0.7,
        max_tokens: 2500,
      });

      const aiResponse = response.choices[0]?.message?.content || '';
      console.log('[AI Agent Planner] GPT-5 Response:', aiResponse);

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
      // Try to extract JSON from response
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in AI response');
      }

      const parsed = JSON.parse(jsonMatch[0]);
      
      return {
        strategy: parsed.strategy || 'AI-generated optimization strategy',
        steps: parsed.steps || []
      };
    } catch (error) {
      console.error('[AI Agent Planner] Failed to parse AI response:', error);
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
