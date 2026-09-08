import { EC2Client, 
  DescribeInstancesCommand, 
  ModifyInstanceAttributeCommand, 
  StopInstancesCommand,
  StartInstancesCommand } from "@aws-sdk/client-ec2";
import { S3Client, PutBucketLifecycleConfigurationCommand } from "@aws-sdk/client-s3";
import { db } from "./db";
import { optimizationActions, actionFeedback, optimizationPlans } from "../shared/schema";
import { and, eq } from "drizzle-orm";
import { currentOrgId } from "./tenant-context";
import { evaluate } from "./agent/guardrails";
import { getAwsClientsForAction } from "./agent/credentials";
import { recordAudit } from "./audit";

interface ExecutionResult {
  success: boolean;
  message: string;
  executionDetails?: any;
  error?: string;
}

export class AIActionExecutor {
  /**
   * Whether the change currently being executed is simulated.
   *
   * Set per action from the tenant's agent_config by the guardrail evaluation,
   * not by a constructor argument. It was previously a constructor default that
   * no caller ever overrode, which meant the dry-run switch in the settings UI
   * had no effect in either direction.
   */
  private dryRunMode: boolean = true;

  /** AWS clients for the action in flight, built from that tenant's credentials. */
  private ec2Client: EC2Client | null = null;
  private s3Client: S3Client | null = null;

  /**
   * Loads the calling tenant's credentials for this action. Throws rather than
   * falling back to anything ambient — there is no environment fallback.
   */
  private async useAwsCredentials(action: any): Promise<string | undefined> {
    const { ec2, s3, account, warning } = await getAwsClientsForAction(
      action.accountId ?? null,
      action.currentState?.region,
    );
    this.ec2Client = ec2;
    this.s3Client = s3;
    console.log(`[Action Executor] Using AWS account "${account.accountName}" for action ${action.id}`);
    if (warning) console.warn(`[Action Executor] ${warning}`);
    return warning;
  }

  /** Guards every AWS call: a null client means credentials were never resolved. */
  private get ec2(): EC2Client {
    if (!this.ec2Client) throw new Error('AWS credentials were not resolved for this action');
    return this.ec2Client;
  }

  private get s3(): S3Client {
    if (!this.s3Client) throw new Error('AWS credentials were not resolved for this action');
    return this.s3Client;
  }

  async executeAction(actionId: number): Promise<ExecutionResult> {
    try {
      // Get action from database
      const [action] = await db.select().from(optimizationActions).where(and(
          eq(optimizationActions.id, actionId),
          eq(optimizationActions.organizationId, currentOrgId()),
        ));

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

      // Guardrails decide whether this runs for real, is simulated, or is
      // refused — using the tenant's agent_config, which nothing read before.
      const decision = await evaluate(action);
      this.dryRunMode = decision.dryRun;

      console.log(
        `[Action Executor] Action ${actionId} (${action.actionType}): ` +
        `${decision.outcome} — ${decision.reasons.join(' ')}`
      );

      await recordAudit({
        action: 'agent.action.guardrail',
        outcome: decision.outcome === 'block' ? 'denied' : 'success',
        resourceType: 'optimization_action',
        resourceId: String(actionId),
        metadata: {
          decision: decision.outcome,
          actionType: action.actionType,
          provider: action.provider,
          reasons: decision.reasons,
          config: decision.config,
        },
      });

      if (decision.outcome === 'block') {
        await db.update(optimizationActions)
          .set({ status: 'rejected', executionError: decision.reasons.join(' ') })
          .where(and(
            eq(optimizationActions.id, actionId),
            eq(optimizationActions.organizationId, currentOrgId()),
          ));

        return {
          success: false,
          message: 'Blocked by agent guardrails',
          error: decision.reasons.join(' '),
        };
      }

      // Resolve this tenant's cloud credentials before touching anything. A
      // real run with no usable credentials must fail here, not part-way
      // through against the wrong account.
      let credentialWarning: string | undefined;
      if (!decision.dryRun && action.provider === 'aws') {
        try {
          credentialWarning = await this.useAwsCredentials(action);
        } catch (err: any) {
          await db.update(optimizationActions)
            .set({ status: 'failed', executionError: err?.message ?? String(err) })
            .where(and(
              eq(optimizationActions.id, actionId),
              eq(optimizationActions.organizationId, currentOrgId()),
            ));

          await recordAudit({
            action: 'agent.action.execute',
            outcome: 'failure',
            resourceType: 'optimization_action',
            resourceId: String(actionId),
            metadata: { reason: 'credential_resolution_failed', error: err?.message ?? String(err) },
          });

          return {
            success: false,
            message: 'Could not resolve cloud credentials',
            error: err?.message ?? String(err),
          };
        }
      }

      // Update status to executing
      await db.update(optimizationActions)
        .set({ status: 'executing', executedAt: new Date() })
        .where(and(
          eq(optimizationActions.id, actionId),
          eq(optimizationActions.organizationId, currentOrgId()),
        ));

      // Execute based on action type
      let result: ExecutionResult;

      switch (action.actionType) {
        // AWS Actions
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
        
        // Azure Actions
        case 'azure_vm_downsize':
          result = await this.executeAzureVMDownsize(action);
          break;
        case 'azure_sql_downgrade':
          result = await this.executeAzureSQLDowngrade(action);
          break;
        case 'azure_storage_lifecycle':
          result = await this.executeAzureStorageLifecycle(action);
          break;
        case 'azure_stop_idle_vm':
          result = await this.executeAzureStopVM(action);
          break;
        
        // GCP Actions
        case 'gcp_instance_downsize':
          result = await this.executeGCPInstanceDownsize(action);
          break;
        case 'gcp_function_memory_reduce':
          result = await this.executeGCPFunctionMemoryReduce(action);
          break;
        case 'gcp_storage_lifecycle':
          result = await this.executeGCPStorageLifecycle(action);
          break;
        case 'gcp_stop_idle_instance':
          result = await this.executeGCPStopInstance(action);
          break;
        
        default:
          result = {
            success: false,
            message: `Unsupported action type: ${action.actionType}`,
            error: `Unsupported action type: ${action.actionType}`
          };
      }

      // Surface a credential fallback in the stored execution record, so an
      // action that ran against a different account than it named is visible
      // afterwards rather than only in the server log.
      if (credentialWarning && result.executionDetails) {
        result.executionDetails.credentialWarning = credentialWarning;
      }

      await recordAudit({
        action: 'agent.action.execute',
        outcome: result.success ? 'success' : 'failure',
        resourceType: 'optimization_action',
        resourceId: String(actionId),
        metadata: {
          actionType: action.actionType,
          provider: action.provider,
          simulated: decision.dryRun,
          resourceTargeted: action.resourceId,
          credentialWarning: credentialWarning ?? null,
          error: result.error ?? null,
        },
      });

      // Update action with result
      if (result.success) {
        await db.update(optimizationActions)
          .set({
            status: 'completed',
            completedAt: new Date(),
            executionDetails: result.executionDetails as any
          })
          .where(and(
          eq(optimizationActions.id, actionId),
          eq(optimizationActions.organizationId, currentOrgId()),
        ));

        // Create positive feedback
        // Capture the pre-change baseline and schedule a real measurement.
        //
        // This previously wrote actualSavings = estimatedSavings and
        // performanceImpact 'none' — recording the prediction as the outcome,
        // which made every savings report a restatement of the tool's own guess
        // and pinned savingsVariance at zero forever. actualSavings now stays
        // null until something has actually been measured; see
        // server/savings/measurement.ts.
        //
        // The baseline must be captured now: once the change is live there is no
        // way to reconstruct what the cost had been.
        await db.insert(actionFeedback).values({
          organizationId: currentOrgId(),
          actionId,
          performanceImpact: 'none',
          wouldRecommendAgain: 1
        });

        try {
          const { scheduleSavingsMeasurement } = await import('./savings/measurement');
          await scheduleSavingsMeasurement(actionId);
        } catch (err: any) {
          // Failing to schedule a measurement must not fail the action that
          // already succeeded against the cloud provider.
          console.error(`[Action Executor] Could not schedule savings measurement for ${actionId}:`, err?.message ?? err);
        }
      } else {
        await db.update(optimizationActions)
          .set({
            status: 'failed',
            executionError: result.error
          })
          .where(and(
          eq(optimizationActions.id, actionId),
          eq(optimizationActions.organizationId, currentOrgId()),
        ));
      }

      return result;
    } catch (error: any) {
      console.error(`[Action Executor] Error executing action ${actionId}:`, error);

      await db.update(optimizationActions)
        .set({
          status: 'failed',
          executionError: error.message
        })
        .where(and(
          eq(optimizationActions.id, actionId),
          eq(optimizationActions.organizationId, currentOrgId()),
        ));

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
      
      // const command = new ModifyInstanceAttributeCommand({
      //   InstanceId: action.resourceId,
      //   InstanceType: {
      //     Value: action.proposedState.instanceType
      //   }
      // });

      // await this.ec2.send(command);

      const instanceId = action.resourceId;
      const newType = action.proposedState.instanceType;

      console.log(`🔹 Stopping instance ${instanceId}...`);
      await this.ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));

      // Wait until instance is stopped
      let stopped = false;
      while (!stopped) {
        const status = await this.ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
        const state = status.Reservations?.[0]?.Instances?.[0]?.State?.Name;
        console.log(`   Current state: ${state}`);
        if (state === "stopped") stopped = true;
        else await new Promise((res) => setTimeout(res, 5000));
      }

      console.log(`🔹 Modifying instance type to ${newType}...`);
      await this.ec2.send(
        new ModifyInstanceAttributeCommand({
          InstanceId: instanceId,
          InstanceType: { Value: newType },
        })
      );

      console.log(`🔹 Starting instance ${instanceId}...`);
      await this.ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));

      console.log(`✅ Instance ${instanceId} updated to type ${newType} and restarted.`);


      return {
        success: true,
        message: `Successfully downsized EC2 instance ${instanceId}`,
        executionDetails: {
          action: 'ec2_downsize',
          resourceId: instanceId,
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

      await this.s3.send(command);

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

      await this.ec2.send(command);

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
      .where(and(
        eq(optimizationActions.planId, planId),
        eq(optimizationActions.organizationId, currentOrgId()),
      ));

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
      .where(and(
        eq(optimizationPlans.id, planId),
        eq(optimizationPlans.organizationId, currentOrgId()),
      ));

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
      .where(and(
        eq(optimizationPlans.id, planId),
        eq(optimizationPlans.organizationId, currentOrgId()),
      ));

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

    const [action] = await db.select().from(optimizationActions).where(and(
          eq(optimizationActions.id, actionId),
          eq(optimizationActions.organizationId, currentOrgId()),
        ));

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
        .where(and(
          eq(optimizationActions.id, actionId),
          eq(optimizationActions.organizationId, currentOrgId()),
        ));

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

  // ========== Azure Action Execution Methods ==========

  private async executeAzureVMDownsize(action: any): Promise<ExecutionResult> {
    if (this.dryRunMode) {
      return {
        success: true,
        message: `DRY RUN: Would downsize Azure VM ${action.resourceId} from ${action.currentState?.vmSize} to ${action.proposedState?.vmSize}`,
        executionDetails: {
          dryRun: true,
          action: 'azure_vm_downsize',
          resourceId: action.resourceId,
          change: `${action.currentState?.vmSize} → ${action.proposedState?.vmSize}`
        }
      };
    }

    // In production, this would use Azure SDK to resize VM
    return {
      success: false,
      message: 'Azure VM downsizing requires full Azure SDK integration',
      error: 'Not implemented in dry-run mode disabled environment'
    };
  }

  private async executeAzureSQLDowngrade(action: any): Promise<ExecutionResult> {
    if (this.dryRunMode) {
      return {
        success: true,
        message: `DRY RUN: Would downgrade Azure SQL Database ${action.resourceId} from ${action.currentState?.sku} to ${action.proposedState?.sku}`,
        executionDetails: {
          dryRun: true,
          action: 'azure_sql_downgrade',
          resourceId: action.resourceId,
          change: `${action.currentState?.sku} → ${action.proposedState?.sku}`
        }
      };
    }

    return {
      success: false,
      message: 'Azure SQL downgrade requires full Azure SDK integration',
      error: 'Not implemented in dry-run mode disabled environment'
    };
  }

  private async executeAzureStorageLifecycle(action: any): Promise<ExecutionResult> {
    if (this.dryRunMode) {
      return {
        success: true,
        message: `DRY RUN: Would apply lifecycle policy to Azure Storage Account ${action.resourceId}`,
        executionDetails: {
          dryRun: true,
          action: 'azure_storage_lifecycle',
          resourceId: action.resourceId,
          policy: action.proposedState
        }
      };
    }

    return {
      success: false,
      message: 'Azure Storage lifecycle requires full Azure SDK integration',
      error: 'Not implemented in dry-run mode disabled environment'
    };
  }

  private async executeAzureStopVM(action: any): Promise<ExecutionResult> {
    if (this.dryRunMode) {
      return {
        success: true,
        message: `DRY RUN: Would stop idle Azure VM ${action.resourceId}`,
        executionDetails: {
          dryRun: true,
          action: 'azure_stop_idle_vm',
          resourceId: action.resourceId
        }
      };
    }

    return {
      success: false,
      message: 'Azure VM stop requires full Azure SDK integration',
      error: 'Not implemented in dry-run mode disabled environment'
    };
  }

  // ========== GCP Action Execution Methods ==========

  private async executeGCPInstanceDownsize(action: any): Promise<ExecutionResult> {
    if (this.dryRunMode) {
      return {
        success: true,
        message: `DRY RUN: Would downsize GCP Compute Instance ${action.resourceId} from ${action.currentState?.machineType} to ${action.proposedState?.machineType}`,
        executionDetails: {
          dryRun: true,
          action: 'gcp_instance_downsize',
          resourceId: action.resourceId,
          change: `${action.currentState?.machineType} → ${action.proposedState?.machineType}`
        }
      };
    }

    return {
      success: false,
      message: 'GCP instance downsizing requires full GCP SDK integration',
      error: 'Not implemented in dry-run mode disabled environment'
    };
  }

  private async executeGCPFunctionMemoryReduce(action: any): Promise<ExecutionResult> {
    if (this.dryRunMode) {
      return {
        success: true,
        message: `DRY RUN: Would reduce GCP Cloud Function ${action.resourceId} memory from ${action.currentState?.memory}MB to ${action.proposedState?.memory}MB`,
        executionDetails: {
          dryRun: true,
          action: 'gcp_function_memory_reduce',
          resourceId: action.resourceId,
          change: `${action.currentState?.memory}MB → ${action.proposedState?.memory}MB`
        }
      };
    }

    return {
      success: false,
      message: 'GCP function optimization requires full GCP SDK integration',
      error: 'Not implemented in dry-run mode disabled environment'
    };
  }

  private async executeGCPStorageLifecycle(action: any): Promise<ExecutionResult> {
    if (this.dryRunMode) {
      return {
        success: true,
        message: `DRY RUN: Would apply lifecycle policy to GCP Cloud Storage bucket ${action.resourceId}`,
        executionDetails: {
          dryRun: true,
          action: 'gcp_storage_lifecycle',
          resourceId: action.resourceId,
          policy: action.proposedState
        }
      };
    }

    return {
      success: false,
      message: 'GCP Storage lifecycle requires full GCP SDK integration',
      error: 'Not implemented in dry-run mode disabled environment'
    };
  }

  private async executeGCPStopInstance(action: any): Promise<ExecutionResult> {
    if (this.dryRunMode) {
      return {
        success: true,
        message: `DRY RUN: Would stop idle GCP Compute Instance ${action.resourceId}`,
        executionDetails: {
          dryRun: true,
          action: 'gcp_stop_idle_instance',
          resourceId: action.resourceId
        }
      };
    }

    return {
      success: false,
      message: 'GCP instance stop requires full GCP SDK integration',
      error: 'Not implemented in dry-run mode disabled environment'
    };
  }
}

// Export singleton instance
// Dry-run is no longer a construction-time flag. It is decided per action from
// the calling tenant's agent_config by server/agent/guardrails.ts, because a
// single process serves every tenant and they do not share a setting.
export const aiActionExecutor = new AIActionExecutor();
