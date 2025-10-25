import OpenAI from "openai";
import { db } from "./db";
import { optimizationActions, actionFeedback, InsertOptimizationAction } from "../shared/schema";
import { eq } from "drizzle-orm";
import { aiAgentPlanner } from "./ai-agent-planner";
import { aiActionExecutor } from "./ai-action-executor";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

interface RetryStrategy {
  approach: string;
  modifiedAction: any;
  reasoning: string;
  riskLevel: 'low' | 'medium' | 'high';
}

export class AISelfCorrectionEngine {
  private maxRetries = 3;

  async analyzeFailure(actionId: number): Promise<{
    rootCause: string;
    suggestedFixes: string[];
    shouldRetry: boolean;
  }> {
    console.log(`[Self-Correction] Analyzing failed action ${actionId}`);

    // Get the failed action
    const [action] = await db.select().from(optimizationActions).where(eq(optimizationActions.id, actionId));

    if (!action || action.status !== 'failed') {
      return {
        rootCause: 'Action not found or not in failed state',
        suggestedFixes: [],
        shouldRetry: false
      };
    }

    // Get historical feedback for similar actions
    const similarActions = await db.select()
      .from(optimizationActions)
      .where(eq(optimizationActions.actionType, action.actionType))
      .limit(10);

    const failureHistory = similarActions.filter(a => a.status === 'failed').length;
    const successHistory = similarActions.filter(a => a.status === 'completed').length;

    // Build AI prompt for root cause analysis
    const prompt = `Analyze this failed cloud cost optimization action and provide root cause analysis:

Action Type: ${action.actionType}
Provider: ${action.provider}
Resource: ${action.resourceId} (${action.resourceType})
Error: ${action.executionError}

Current State: ${JSON.stringify(action.currentState, null, 2)}
Proposed State: ${JSON.stringify(action.proposedState, null, 2)}

Historical Context:
- Similar actions succeeded: ${successHistory}
- Similar actions failed: ${failureHistory}

AI Reasoning for this action: ${action.aiReasoning}

Provide:
1. Root cause of the failure
2. 3 specific suggested fixes
3. Whether this action should be retried (true/false)

Respond in JSON format:
{
  "rootCause": "Brief explanation",
  "suggestedFixes": ["Fix 1", "Fix 2", "Fix 3"],
  "shouldRetry": true
}`;

    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: "You are an expert FinOps AI specializing in troubleshooting failed cloud cost optimizations. Provide concise, actionable analysis."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.5,
        max_tokens: 500,
      });

      const aiResponse = response.choices[0]?.message?.content || '{}';
      const analysis = JSON.parse(aiResponse.match(/\{[\s\S]*\}/)?.[0] || '{}');

      return {
        rootCause: analysis.rootCause || 'Unknown error',
        suggestedFixes: analysis.suggestedFixes || [],
        shouldRetry: analysis.shouldRetry || false
      };
    } catch (error: any) {
      console.error('[Self-Correction] Error analyzing failure:', error);
      
      // Fallback analysis
      return {
        rootCause: action.executionError || 'Unknown error',
        suggestedFixes: [
          'Check resource permissions',
          'Verify resource exists',
          'Review proposed configuration'
        ],
        shouldRetry: failureHistory < this.maxRetries
      };
    }
  }

  async generateAlternativeStrategy(actionId: number): Promise<RetryStrategy | null> {
    console.log(`[Self-Correction] Generating alternative strategy for action ${actionId}`);

    const [action] = await db.select().from(optimizationActions).where(eq(optimizationActions.id, actionId));

    if (!action) {
      return null;
    }

    // Analyze the failure first
    const analysis = await this.analyzeFailure(actionId);

    if (!analysis.shouldRetry) {
      console.log('[Self-Correction] Analysis suggests not retrying this action');
      return null;
    }

    // Generate alternative approach using AI
    const prompt = `Generate an alternative strategy for this failed optimization:

Action Type: ${action.actionType}
Original Error: ${action.executionError}
Root Cause: ${analysis.rootCause}
Suggested Fixes: ${analysis.suggestedFixes.join(', ')}

Original Approach:
Current State: ${JSON.stringify(action.currentState, null, 2)}
Proposed State: ${JSON.stringify(action.proposedState, null, 2)}

Generate a DIFFERENT, safer approach to achieve the same cost savings goal.

Respond in JSON format:
{
  "approach": "Brief description of alternative approach",
  "modifiedAction": {
    "proposedState": {...},
    "riskLevel": "low"
  },
  "reasoning": "Why this alternative is better"
}`;

    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: "You are an expert FinOps AI that generates safer, alternative optimization strategies when initial attempts fail."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.7,
        max_tokens: 600,
      });

      const aiResponse = response.choices[0]?.message?.content || '{}';
      const strategy = JSON.parse(aiResponse.match(/\{[\s\S]*\}/)?.[0] || '{}');

      return {
        approach: strategy.approach || 'Conservative retry',
        modifiedAction: strategy.modifiedAction || action.proposedState,
        reasoning: strategy.reasoning || 'Alternative approach generated',
        riskLevel: strategy.modifiedAction?.riskLevel || 'medium'
      };
    } catch (error: any) {
      console.error('[Self-Correction] Error generating alternative strategy:', error);
      return null;
    }
  }

  async retryWithCorrection(actionId: number): Promise<{
    success: boolean;
    message: string;
    newActionId?: number;
  }> {
    console.log(`[Self-Correction] Attempting retry with correction for action ${actionId}`);

    const [originalAction] = await db.select().from(optimizationActions).where(eq(optimizationActions.id, actionId));

    if (!originalAction) {
      return {
        success: false,
        message: 'Original action not found'
      };
    }

    // Check if we've exceeded retry limit
    const retryCount = await db.select()
      .from(optimizationActions)
      .where(eq(optimizationActions.resourceId, originalAction.resourceId || ''))
      .then(actions => actions.filter(a => a.status === 'failed').length);

    if (retryCount >= this.maxRetries) {
      return {
        success: false,
        message: `Maximum retry attempts (${this.maxRetries}) exceeded`
      };
    }

    // Generate alternative strategy
    const strategy = await this.generateAlternativeStrategy(actionId);

    if (!strategy) {
      return {
        success: false,
        message: 'Could not generate alternative strategy'
      };
    }

    // Create new action with alternative approach
    const newAction: InsertOptimizationAction = {
      planId: originalAction.planId,
      actionType: originalAction.actionType,
      provider: originalAction.provider,
      accountId: originalAction.accountId,
      resourceId: originalAction.resourceId,
      resourceType: originalAction.resourceType,
      currentState: originalAction.currentState as any,
      proposedState: strategy.modifiedAction as any,
      estimatedSavings: originalAction.estimatedSavings,
      riskLevel: strategy.riskLevel,
      status: 'proposed',
      aiReasoning: `RETRY: ${strategy.reasoning}. Original error: ${originalAction.executionError}`
    };

    const [createdAction] = await db.insert(optimizationActions)
      .values(newAction)
      .returning({ id: optimizationActions.id });

    // Record learning from the failure
    await db.insert(actionFeedback).values({
      actionId,
      performanceImpact: 'severe',
      performanceDetails: `Action failed: ${originalAction.executionError}`,
      lessonsLearned: `Alternative strategy: ${strategy.approach}. ${strategy.reasoning}`,
      wouldRecommendAgain: 0
    });

    return {
      success: true,
      message: `Created alternative action with strategy: ${strategy.approach}`,
      newActionId: createdAction.id
    };
  }

  async autoCorrectFailedActions(): Promise<{
    actionsAnalyzed: number;
    retryAttempts: number;
    successfulCorrections: number;
  }> {
    console.log('[Self-Correction] Running auto-correction for failed actions');

    // Get all failed actions from the last 24 hours
    const failedActions = await db.select()
      .from(optimizationActions)
      .where(eq(optimizationActions.status, 'failed'));

    let retryAttempts = 0;
    let successfulCorrections = 0;

    for (const action of failedActions) {
      // Check if this action already has a retry attempt
      const existingRetries = await db.select()
        .from(optimizationActions)
        .where(eq(optimizationActions.resourceId, action.resourceId || ''));

      const retryCount = existingRetries.filter(a => 
        a.status === 'failed' && 
        a.aiReasoning?.includes('RETRY:')
      ).length;

      if (retryCount < this.maxRetries) {
        const result = await this.retryWithCorrection(action.id);
        retryAttempts++;
        
        if (result.success) {
          successfulCorrections++;
        }
      }
    }

    return {
      actionsAnalyzed: failedActions.length,
      retryAttempts,
      successfulCorrections
    };
  }
}

export const aiSelfCorrection = new AISelfCorrectionEngine();
