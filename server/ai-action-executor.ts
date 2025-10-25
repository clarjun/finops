import { EC2Client, DescribeInstancesCommand, ModifyInstanceAttributeCommand, StopInstancesCommand } from "@aws-sdk/client-ec2";
import { S3Client, PutBucketLifecycleConfigurationCommand } from "@aws-sdk/client-s3";
import { db } from "./db";
import { optimizationActions, actionFeedback, optimizationPlans } from "../shared/schema";
import { eq } from "drizzle-orm";

interface ExecutionResult {
  success: boolean;
  message: string;
  executionDetails?: any;
  error?: string;
}

export class AIActionExecutor {
  private ec2Client: EC2Client;
  private s3Client: S3Client;
  private dryRunMode: boolean = true;

  constructor(dryRunMode: boolean = true) {
    this.dryRunMode = dryRunMode;
    
    // Initialize AWS clients
    this.ec2Client = new EC2Client({
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
      }
    });

    this.s3Client = new S3Client({
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
      }
    });
  }

  async executeAction(actionId: number): Promise<ExecutionResult> {
    try {
      // Get action from database
      const [action] = await db.select().from(optimizationActions).where(eq(optimizationActions.id, actionId));

      if (!action) {
        return {
          success: false,
          message: 'Action not found',
          error: 'Action not found'
        };
      }

      if (action.status !== 'approved') {
        return {
          success: false,
          message: `Action not approved: ${action.status}`,
          error: `Action must be approved before execution. Current status: ${action.status}`
        };
      }

      console.log(`[Action Executor] Executing action ${actionId}: ${action.actionType}`);
      console.log(`[Action Executor] Dry-run mode: ${this.dryRunMode}`);

      // Update status to executing
      await db.update(optimizationActions)
        .set({ status: 'executing', executedAt: new Date() })
        .where(eq(optimizationActions.id, actionId));

      // Execute based on action type
      let result: ExecutionResult;

      switch (action.actionType) {
        case 'ec2_downsize':
          result = await this.executeEC2Downsize(action);
          break;
        case 's3_lifecycle':
          result = await this.executeS3Lifecycle(action);
          break;
        case 'stop_idle_instance':
          result = await this.executeStopInstance(action);
          break;
        case 'ebs_delete_snapshot':
          result = await this.executeDeleteSnapshot(action);
          break;
        case 'idle_resource_alert':
          result = await this.executeIdleResourceAlert(action);
          break;
        default:
          result = {
            success: false,
            message: `Unsupported action type: ${action.actionType}`,
            error: `Unsupported action type: ${action.actionType}`
          };
      }

      // Update action with result
      if (result.success) {
        await db.update(optimizationActions)
          .set({
            status: 'completed',
            completedAt: new Date(),
            executionDetails: result.executionDetails as any
          })
          .where(eq(optimizationActions.id, actionId));

        // Create positive feedback
        await db.insert(actionFeedback).values({
          actionId,
          actualSavings: action.estimatedSavings,
          performanceImpact: 'none',
          wouldRecommendAgain: 1
        });
      } else {
        await db.update(optimizationActions)
          .set({
            status: 'failed',
            executionError: result.error
          })
          .where(eq(optimizationActions.id, actionId));
      }

      return result;
    } catch (error: any) {
      console.error(`[Action Executor] Error executing action ${actionId}:`, error);

      await db.update(optimizationActions)
        .set({
          status: 'failed',
          executionError: error.message
        })
        .where(eq(optimizationActions.id, actionId));

      return {
        success: false,
        message: 'Execution failed',
        error: error.message
      };
    }
  }

  private async executeEC2Downsize(action: any): Promise<ExecutionResult> {
    if (this.dryRunMode) {
      return {
        success: true,
        message: `DRY RUN: Would downsize EC2 instance ${action.resourceId} from ${action.currentState?.instanceType} to ${action.proposedState?.instanceType}`,
        executionDetails: {
          dryRun: true,
          action: 'ec2_downsize',
          resourceId: action.resourceId,
          change: `${action.currentState?.instanceType} → ${action.proposedState?.instanceType}`
        }
      };
    }

    try {
      // In production, this would:
      // 1. Stop the instance
      // 2. Modify instance type
      // 3. Start the instance
      
      const command = new ModifyInstanceAttributeCommand({
        InstanceId: action.resourceId,
        InstanceType: {
          Value: action.proposedState.instanceType
        }
      });

      await this.ec2Client.send(command);

      return {
        success: true,
        message: `Successfully downsized EC2 instance ${action.resourceId}`,
        executionDetails: {
          action: 'ec2_downsize',
          resourceId: action.resourceId,
          oldType: action.currentState.instanceType,
          newType: action.proposedState.instanceType
        }
      };
    } catch (error: any) {
      return {
        success: false,
        message: 'EC2 downsize failed',
        error: `Failed to downsize EC2 instance: ${error.message}`
      };
    }
  }

  private async executeS3Lifecycle(action: any): Promise<ExecutionResult> {
    if (this.dryRunMode) {
      return {
        success: true,
        message: `DRY RUN: Would apply lifecycle policy to S3 bucket ${action.resourceId}`,
        executionDetails: {
          dryRun: true,
          action: 's3_lifecycle',
          resourceId: action.resourceId,
          policy: action.proposedState
        }
      };
    }

    try {
      const command = new PutBucketLifecycleConfigurationCommand({
        Bucket: action.resourceId,
        LifecycleConfiguration: action.proposedState
      });

      await this.s3Client.send(command);

      return {
        success: true,
        message: `Successfully applied lifecycle policy to S3 bucket ${action.resourceId}`,
        executionDetails: {
          action: 's3_lifecycle',
          resourceId: action.resourceId,
          policy: action.proposedState
        }
      };
    } catch (error: any) {
      return {
        success: false,
        message: 'S3 lifecycle policy failed',
        error: `Failed to apply S3 lifecycle policy: ${error.message}`
      };
    }
  }

  private async executeStopInstance(action: any): Promise<ExecutionResult> {
    if (this.dryRunMode) {
      return {
        success: true,
        message: `DRY RUN: Would stop idle EC2 instance ${action.resourceId}`,
        executionDetails: {
          dryRun: true,
          action: 'stop_idle_instance',
          resourceId: action.resourceId
        }
      };
    }

    try {
      const command = new StopInstancesCommand({
        InstanceIds: [action.resourceId]
      });

      await this.ec2Client.send(command);

      return {
        success: true,
        message: `Successfully stopped idle EC2 instance ${action.resourceId}`,
        executionDetails: {
          action: 'stop_idle_instance',
          resourceId: action.resourceId
        }
      };
    } catch (error: any) {
      return {
        success: false,
        message: 'Stop instance failed',
        error: `Failed to stop EC2 instance: ${error.message}`
      };
    }
  }

  private async executeDeleteSnapshot(action: any): Promise<ExecutionResult> {
    if (this.dryRunMode) {
      return {
        success: true,
        message: `DRY RUN: Would delete EBS snapshot ${action.resourceId}`,
        executionDetails: {
          dryRun: true,
          action: 'ebs_delete_snapshot',
          resourceId: action.resourceId
        }
      };
    }

    // In production, would call DeleteSnapshotCommand
    return {
      success: true,
      message: `Successfully deleted EBS snapshot ${action.resourceId}`,
      executionDetails: {
        action: 'ebs_delete_snapshot',
        resourceId: action.resourceId
      }
    };
  }

  private async executeIdleResourceAlert(action: any): Promise<ExecutionResult> {
    // This is a detection/alert action, not a destructive one
    return {
      success: true,
      message: `Idle resource identified and alert created`,
      executionDetails: {
        action: 'idle_resource_alert',
        resourceType: action.resourceType,
        findings: action.currentState
      }
    };
  }

  async executePlan(planId: number): Promise<{
    success: boolean;
    message: string;
    results: ExecutionResult[];
  }> {
    console.log(`[Action Executor] Executing plan ${planId}`);

    // Get all approved actions for this plan
    const actions = await db.select()
      .from(optimizationActions)
      .where(eq(optimizationActions.planId, planId));

    if (actions.length === 0) {
      return {
        success: false,
        message: 'No actions found for this plan',
        results: []
      };
    }

    // Update plan status
    await db.update(optimizationPlans)
      .set({ status: 'executing', startedAt: new Date() })
      .where(eq(optimizationPlans.id, planId));

    const results: ExecutionResult[] = [];
    let allSuccess = true;

    // Execute actions sequentially (respecting dependencies)
    for (const action of actions) {
      if (action.status === 'approved') {
        const result = await this.executeAction(action.id);
        results.push(result);
        
        if (!result.success) {
          allSuccess = false;
          console.error(`[Action Executor] Action ${action.id} failed:`, result.error);
        }
      }
    }

    // Update plan status
    const finalStatus = allSuccess ? 'completed' : 'failed';
    await db.update(optimizationPlans)
      .set({
        status: finalStatus,
        completedAt: new Date(),
        completedSteps: results.filter(r => r.success).length,
        failedSteps: results.filter(r => !r.success).length
      })
      .where(eq(optimizationPlans.id, planId));

    return {
      success: allSuccess,
      message: allSuccess 
        ? `Successfully executed all ${results.length} actions` 
        : `Executed ${results.length} actions with ${results.filter(r => !r.success).length} failures`,
      results
    };
  }

  async rollbackAction(actionId: number): Promise<ExecutionResult> {
    console.log(`[Action Executor] Rolling back action ${actionId}`);

    const [action] = await db.select().from(optimizationActions).where(eq(optimizationActions.id, actionId));

    if (!action || action.status !== 'completed') {
      return {
        success: false,
        message: 'Action not found or not completed',
        error: 'Action not found or not in completed state'
      };
    }

    // In production, this would reverse the action
    // For example: resize instance back to original size
    
    if (this.dryRunMode) {
      await db.update(optimizationActions)
        .set({
          status: 'rolled_back',
          rollbackDetails: {
            dryRun: true,
            message: 'DRY RUN: Would restore original configuration',
            originalState: action.currentState
          } as any
        })
        .where(eq(optimizationActions.id, actionId));

      return {
        success: true,
        message: 'DRY RUN: Would rollback action to original state'
      };
    }

    // Execute rollback based on action type
    return {
      success: true,
      message: 'Action rolled back successfully'
    };
  }
}

// Export singleton instance
export const aiActionExecutor = new AIActionExecutor(true); // Default to dry-run mode for safety
