/**
 * The deployment engine.
 *
 * A durable state machine over infra_runs / infra_run_nodes. Everything that
 * matters about it is a consequence of one fact: a deployment takes tens of
 * minutes, must stop for a human, and must survive the process dying in between.
 *
 * That rules out holding run state in memory. The platform this is modelled on
 * keeps live runs in a Map with five-minute retention and cannot pause at all;
 * a run there does not survive a restart, let alone an approval that arrives the
 * next morning. Here, progress is a row, and `advance()` is a pure function of
 * what the database says has already happened.
 *
 * advance() is therefore safe to call repeatedly and from anywhere — a worker
 * tick, an approval decision, an operator retry. It takes a lease so two callers
 * cannot drive the same run at once, works out the next thing to do, does one
 * step, and returns. Nothing is held across the pause.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  infraPlans, infraPlanNodes, infraRuns, infraRunNodes, infraApprovals, infraDeployments,
} from '@shared/schema';
import { currentOrgId, currentUserId, currentUsername } from '../tenant-context';
import { recordAudit } from '../audit';
import { appendEvent } from './events';
import { computeStages, stageTargets, type Stage } from './staging';
import { compileArchitecture } from './compiler';
import { generateTerraform } from './terraform/generator';
import { awsMapper } from './providers/aws';
import { terraformExecutor } from './terraform/executor';
import { resolveTerraformCredentials } from './tools/credentials';
import { runTool, authorizingRole, ToolDenied, type ApprovalEvidence } from './tools/invoke';
import { extractStepsFromRun } from './knowledge/step-library';
import { attachProvenanceForRun } from './knowledge/docs';
import {
  classifyFailure, shouldRetry, retryDelayMs, terminalStatusFor, MAX_ATTEMPTS,
  type Classification,
} from './failure';
import type { Clarifications, EstimatorLayer, LamNode, LogicalArchitecture } from './types';

/** How long a worker may hold a run before another may take it over. */
export const LEASE_MS = 5 * 60_000;

/** What terraform_plan returns, which the staging logic reads. */
interface PlanResult {
  toAdd: number;
  toChange: number;
  toDestroy: number;
  changes: Array<{ address: string; action: string }>;
  destructive: Array<{ address: string; action: string }>;
}

/**
 * Approval evidence for calls that cannot create infrastructure.
 *
 * init and validate never contact a cloud, and a plan reads without changing —
 * gating a plan would mean approving before seeing what would happen, which
 * inverts the point of the plan/apply split. Both are still schema-checked,
 * authorized, timed out and audited; only the signature is not required.
 */
const WAIVED_LOCAL = {
  kind: 'waived' as const,
  by: 'tool-risk-policy',
  reason: 'local operation; contacts no cloud and creates nothing',
};

const WAIVED_READ = {
  kind: 'waived' as const,
  by: 'tool-risk-policy',
  reason: 'read-only plan; approving before the plan exists would invert the plan/apply split',
};

export type RunStatus =
  | 'queued' | 'initializing' | 'planning' | 'awaiting_approval'
  | 'applying' | 'verifying' | 'succeeded' | 'failed' | 'cancelled' | 'paused';

export interface AdvanceResult {
  runId: number;
  status: RunStatus;
  /** What the engine did on this call, for the caller's log. */
  action: string;
  /** Set when the run stopped for a human. */
  awaitingApprovalRef?: string;
  done: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Creating a run                                                             */
/* -------------------------------------------------------------------------- */

export interface CreateRunInput {
  planId: number;
  mode?: 'plan' | 'apply';
  /**
   * simulate stops after producing a plan and never applies. Recorded on the
   * row so a simulated run can never later be read as a deployment.
   */
  executionMode?: 'live' | 'simulate';
}

export async function createRun(input: CreateRunInput): Promise<number> {
  const organizationId = currentOrgId();

  const [plan] = await db.select().from(infraPlans)
    .where(and(eq(infraPlans.id, input.planId), eq(infraPlans.organizationId, organizationId)));
  if (!plan) throw new Error(`Plan ${input.planId} not found`);

  const nodes = await db.select().from(infraPlanNodes)
    .where(and(eq(infraPlanNodes.planId, input.planId), eq(infraPlanNodes.organizationId, organizationId)))
    .orderBy(asc(infraPlanNodes.nodeKey));
  if (nodes.length === 0) throw new Error(`Plan ${input.planId} has no nodes; compile it first.`);

  const [run] = await db.insert(infraRuns).values({
    organizationId,
    planId: input.planId,
    mode: input.mode ?? 'apply',
    executionMode: input.executionMode ?? 'live',
    status: 'queued',
    startedByUserId: currentUserId(),
  }).returning();

  const runId = Number(run.id);

  // One row per node up front. Resume reads these; without them a restart would
  // have nothing to tell it what had already been done.
  await db.insert(infraRunNodes).values(
    nodes.map((n) => ({
      organizationId,
      runId,
      nodeKey: n.nodeKey,
      status: 'pending' as const,
    })),
  );

  await appendEvent({
    runId,
    eventType: 'AGENT_STARTED',
    message: `Deployment run created for "${plan.name}" (${nodes.length} resources, ${input.executionMode ?? 'live'} mode).`,
    data: { planId: input.planId, mode: input.mode ?? 'apply' },
  });

  await recordAudit({
    action: 'infra.run.created',
    outcome: 'success',
    resourceType: 'infra_run',
    resourceId: String(runId),
    metadata: { planId: input.planId, executionMode: input.executionMode ?? 'live', nodes: nodes.length },
  });

  return runId;
}

/* -------------------------------------------------------------------------- */
/*  Advancing a run                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Performs the next step of a run.
 *
 * Idempotent by construction: it derives what to do from persisted node status
 * rather than from anything held in memory, so calling it twice does the next
 * thing once.
 */
export async function advance(runId: number): Promise<AdvanceResult> {
  const organizationId = currentOrgId();
  const owner = `${process.pid}-${randomUUID().slice(0, 8)}`;

  const leased = await acquireLease(runId, organizationId, owner);
  if (!leased) {
    return { runId, status: leased === null ? 'failed' : 'queued', action: 'another worker holds this run', done: false };
  }

  try {
    const run = await loadRun(runId, organizationId);
    if (!run) throw new Error(`Run ${runId} not found`);

    // A teardown run shares this table and these statuses, and this function
    // applies the plan's configuration. Driving one through here would recreate
    // exactly the infrastructure someone asked to have removed — so the guard is
    // here as well as in the worker's dispatch, because the worker is not the
    // only caller.
    if (run.mode === 'destroy') {
      return { runId, status: run.status as RunStatus, action: 'teardown run; not for the deploy engine', done: false };
    }

    if (['succeeded', 'failed', 'cancelled'].includes(run.status)) {
      return { runId, status: run.status as RunStatus, action: 'run already finished', done: true };
    }

    // Every tool call this run makes is authorized as the person who started
    // it, not as the worker. Revoking their permission stops the next stage.
    const role = await authorizingRole(runId, organizationId);

    const { plan, architecture, nodes } = await loadPlanContext(run.planId, organizationId);
    const { stages, errors } = computeStages(nodes);
    if (errors.length > 0) {
      return failRun(runId, `Plan cannot be staged: ${errors.join('; ')}`);
    }

    // Workspace and config are regenerated from the stored plan, never cached in
    // memory. A resumed run in a fresh process rebuilds exactly what the
    // approved plan described.
    const generated = generateTerraform({
      architecture,
      mapper: awsMapper,
      region: plan.region ?? 'us-east-1',
      namePrefix: namePrefixFor(plan.name, plan.environment ?? 'dev'),
    });

    const workspace = run.workspacePath ?? await terraformExecutor.createWorkspace(runId, generated);
    if (!run.workspacePath) {
      await db.update(infraRuns).set({ workspacePath: workspace, updatedAt: new Date() })
        .where(eq(infraRuns.id, runId));
    }

    /* --- init ----------------------------------------------------------- */

    if (run.status === 'queued' || run.status === 'initializing') {
      await setRunStatus(runId, 'initializing');
      await appendEvent({ runId, eventType: 'PLAN_CREATED', message: 'Preparing Terraform workspace…' });

      // Through the policy engine, like everything else that touches a
      // workspace. Both are local and low risk, so neither is gated — but both
      // are schema-checked, authorized, timed out and audited.
      try {
        await runTool('terraform_init', { workspacePath: workspace }, {
          runId, organizationId, role,
          approval: WAIVED_LOCAL,
          context: { emit: (e) => void appendEvent({ runId, eventType: 'PLAN_CREATED', level: e.level, message: e.message }) },
        });
        await runTool('terraform_validate', { workspacePath: workspace }, {
          runId, organizationId, role, approval: WAIVED_LOCAL,
        });
      } catch (err) {
        if (err instanceof ToolDenied) return failRun(runId, err.message);
        return handleStageFailure(runId, stages[0], 'plan', (err as Error)?.message ?? String(err));
      }

      await appendEvent({ runId, eventType: 'PLAN_VALIDATED', message: 'Configuration validated.' });
      await setRunStatus(runId, 'planning');
    }

    /* --- reconcile: what already exists --------------------------------- */

    // The idempotency step. Terraform state is the source of truth for what is
    // real; anything already present is marked applied so a resumed run does not
    // try to create it again.
    //
    // Credentials are resolved for BOTH modes. `terraform plan` is read-only —
    // it creates nothing — but it must reach the provider to refresh state, so a
    // simulation without credentials cannot produce a plan at all; it fails with
    // an unhelpful IMDS timeout. Simulating therefore means "produce a real plan
    // and stop", not "pretend without talking to the cloud", which is also the
    // only version worth showing someone: a fabricated plan is exactly what
    // must never be presented as a deployment.
    //
    // Resolved and discarded: the tools resolve their own from the account id,
    // so the value is never held here. Doing it anyway turns a missing
    // credential into one clear failure at the start rather than an obscure one
    // several minutes into a deployment.
    if (plan.cloudAccountId) {
      try {
        await resolveTerraformCredentials(plan.cloudAccountId);
      } catch (err) {
        return failRun(runId, `Cloud credentials unavailable: ${(err as Error).message}`);
      }
    } else {
      return failRun(
        runId,
        'This plan has no connected cloud account. Even a simulation needs read-only credentials, ' +
        'because Terraform must reach the provider to produce a plan.',
      );
    }

    const existing = new Set(await runTool<{ addresses: string[] }>('terraform_state_list', {
      workspacePath: workspace,
      cloudAccountId: plan.cloudAccountId!,
    }, { runId, organizationId, role, approval: WAIVED_LOCAL }).then((r) => r.addresses).catch(() => []));
    if (existing.size > 0) {
      const already = Object.entries(generated.addressByNode)
        .filter(([, address]) => existing.has(address))
        .map(([nodeKey]) => nodeKey);

      if (already.length > 0) {
        await markNodes(runId, already, 'applied');
        await appendEvent({
          runId,
          eventType: 'RUN_RESUMED',
          message: `Resuming: ${already.length} resource(s) already exist and will not be recreated.`,
          data: { nodeKeys: already },
        });
      }
    }

    /* --- find the next stage -------------------------------------------- */

    const nodeStatus = await loadNodeStatus(runId, organizationId);
    const stage = nextStage(stages, nodeStatus);

    if (!stage) {
      return completeRun(runId, run.planId, plan, workspace, role, run.executionMode);
    }

    const targets = stageTargets(stage, generated.addressByNode);
    if (targets.length === 0) {
      // Every node in this stage is one the mapper cannot build; skip it rather
      // than plan with no targets, which Terraform would read as "everything".
      // Its own status rather than 'skipped'. A simulation marks every node
      // skipped by design, so sharing one value made "19 not deployed
      // (unsupported or skipped)" the only thing the summary could say — which
      // reads as nineteen failures on a run that did exactly what was asked.
      await markNodes(runId, stage.nodeKeys, 'unsupported');
      // Recorded, and at warn level. Without this the stage leaves no trace in
      // the event stream at all: someone watching a deployment of seventeen
      // resources sees twelve stages go by and a green "succeeded", with
      // nothing anywhere saying the database was never built. The compile-time
      // warning is on a screen they may never have looked at.
      await appendEvent({
        runId,
        eventType: 'RESOURCE_SKIPPED',
        level: 'warn',
        message:
          `Stage ${stage.index + 1} skipped — the mapper cannot build ${stage.nodeKeys.join(', ')}. ` +
          `Nothing was deployed for these resources.`,
        data: { nodeKeys: stage.nodeKeys },
      });
      return { runId, status: 'planning', action: `stage ${stage.index} skipped (unsupported resources)`, done: false };
    }

    /* --- plan the stage -------------------------------------------------- */

    await setRunStatus(runId, 'planning');
    await markNodes(runId, stage.nodeKeys, 'running');
    await appendEvent({
      runId,
      eventType: 'RESOURCE_CREATING',
      message: `Planning stage ${stage.index + 1}: ${stage.nodeKeys.join(', ')}`,
      data: { stage: stage.index, targets },
    });

    let planned: PlanResult;
    try {
      planned = await runTool<PlanResult>('terraform_plan', {
        workspacePath: workspace,
        cloudAccountId: plan.cloudAccountId!,
        targets,
      }, {
        runId, organizationId, role,
        // Planning is explicitly not gated: approving before seeing what would
        // happen inverts the point of the plan/apply split.
        approval: WAIVED_READ,
        context: {
          nodeKey: stage.nodeKeys[0],
          emit: (e) => void appendEvent({ runId, eventType: 'RESOURCE_CREATING', level: e.level, message: e.message.slice(0, 500) }),
        },
      });
    } catch (err) {
      if (err instanceof ToolDenied) return failRun(runId, err.message);
      return handleStageFailure(runId, stage, 'plan', (err as Error)?.message ?? String(err));
    }

    await db.update(infraRuns).set({
      planSummary: planned.changes as never,
      resourcesToAdd: planned.toAdd,
      resourcesToChange: planned.toChange,
      resourcesToDestroy: planned.toDestroy,
      updatedAt: new Date(),
    }).where(eq(infraRuns.id, runId));

    /* --- simulation stops here ------------------------------------------ */

    if (run.executionMode === 'simulate') {
      await markNodes(runId, stage.nodeKeys, 'skipped');
      await appendEvent({
        runId,
        eventType: 'PLAN_VALIDATED',
        message: `Simulation: ${planned.toAdd} resource(s) would be created. Nothing was applied.`,
        data: { simulated: true, changes: planned.changes },
      });
      if (stage.index === stages.length - 1) {
        await setRunStatus(runId, 'succeeded', { finishedAt: new Date() });
        return { runId, status: 'succeeded', action: 'simulation complete', done: true };
      }
      return { runId, status: 'planning', action: `stage ${stage.index} simulated`, done: false };
    }

    /* --- approval gate --------------------------------------------------- */

    // Held so the apply below can name the decision that permitted it, rather
    // than asserting to the tool layer that one exists somewhere.
    let gateApproval: Awaited<ReturnType<typeof pendingOrNewApproval>> | null = null;

    if (stage.requiresApproval || planned.destructive.length > 0) {
      const approval = await pendingOrNewApproval(runId, stage, planned.destructive.length, planned.toAdd);
      gateApproval = approval;

      if (approval.status === 'pending') {
        await markNodes(runId, stage.nodeKeys, 'awaiting_approval');
        await setRunStatus(runId, 'awaiting_approval');
        await appendEvent({
          runId,
          eventType: 'APPROVAL_REQUIRED',
          nodeKey: stage.nodeKeys[0],
          level: 'warn',
          message: `Human approval required before creating: ${stage.nodeKeys.join(', ')}`,
          data: { approvalRef: approval.ref, risk: stage.riskLevel, reasons: stage.riskReasons },
        });
        return { runId, status: 'awaiting_approval', action: 'paused for approval', awaitingApprovalRef: approval.ref, done: false };
      }

      if (approval.status === 'rejected') {
        await markNodes(runId, stage.nodeKeys, 'skipped');
        await appendEvent({
          runId, eventType: 'REJECTED', level: 'warn',
          message: `Stage rejected by ${approval.decidedBy ?? 'a reviewer'}: ${approval.decisionReason ?? 'no reason given'}`,
        });
        return failRun(runId, 'A required approval was rejected; deployment stopped.');
      }
    }

    /* --- apply ----------------------------------------------------------- */

    await setRunStatus(runId, 'applying');

    // The one call that creates real infrastructure, and the only place the
    // approval evidence is a human decision rather than a policy waiver.
    const evidence: ApprovalEvidence = gateApproval
      ? { kind: 'granted', approvalId: Number(gateApproval.id) }
      : {
          kind: 'waived',
          by: 'staging-policy',
          reason: `stage ${stage.index + 1} assessed as ${stage.riskLevel} risk by the compiler; no resource in it requires approval`,
        };

    try {
      await runTool('terraform_apply', {
        workspacePath: workspace,
        cloudAccountId: plan.cloudAccountId!,
      }, {
        runId, organizationId, role,
        approval: evidence,
        context: {
          nodeKey: stage.nodeKeys[0],
          emit: (e) => void appendEvent({ runId, eventType: 'RESOURCE_CREATING', level: e.level, message: e.message.slice(0, 500) }),
        },
      });
    } catch (err) {
      if (err instanceof ToolDenied) {
        // Refused, not failed: the system declined to act. Recorded as a
        // failure of the run so it cannot be mistaken for a completed stage.
        return failRun(runId, err.message);
      }
      // Retrying an apply means re-planning first, never re-running the saved
      // plan: after a partial apply the saved plan describes a world that no
      // longer exists. Returning done:false sends the worker back through the
      // plan step above, which is what makes a retry safe here.
      return handleStageFailure(runId, stage, 'apply', (err as Error)?.message ?? String(err));
    }

    await markNodes(runId, stage.nodeKeys, 'applied');
    await db.update(infraRuns)
      .set({ resourcesCreated: sql`${infraRuns.resourcesCreated} + ${stage.nodeKeys.length}`, updatedAt: new Date() })
      .where(eq(infraRuns.id, runId));

    await appendEvent({
      runId,
      eventType: 'RESOURCE_CREATED',
      message: `Stage ${stage.index + 1} applied: ${stage.nodeKeys.join(', ')}`,
      data: { stage: stage.index },
    });

    return { runId, status: 'applying', action: `stage ${stage.index} applied`, done: false };
  } finally {
    await releaseLease(runId, owner);
  }
}

/* -------------------------------------------------------------------------- */
/*  Approvals                                                                  */
/* -------------------------------------------------------------------------- */

export async function decideApproval(
  approvalRef: string,
  decision: 'approved' | 'rejected',
  reason?: string,
): Promise<{ runId: number; status: string }> {
  const organizationId = currentOrgId();

  const [approval] = await db.select().from(infraApprovals)
    .where(and(eq(infraApprovals.ref, approvalRef), eq(infraApprovals.organizationId, organizationId)));
  if (!approval) throw new Error('Approval not found');

  if (approval.status !== 'pending') {
    // Deciding twice must not silently re-run a stage.
    throw new Error(`Approval ${approvalRef} was already ${approval.status}.`);
  }

  await db.update(infraApprovals).set({
    status: decision,
    decidedByUserId: currentUserId(),
    decidedBy: currentUsername() ?? 'unknown',
    decisionReason: reason ?? null,
    decidedAt: new Date(),
  }).where(eq(infraApprovals.id, approval.id));

  const runId = Number(approval.runId);

  await appendEvent({
    runId,
    eventType: decision === 'approved' ? 'APPROVED' : 'REJECTED',
    nodeKey: approval.nodeKey,
    level: decision === 'approved' ? 'info' : 'warn',
    message: `${decision === 'approved' ? 'Approved' : 'Rejected'} by ${currentUsername() ?? 'a reviewer'}${reason ? `: ${reason}` : ''}`,
  });

  await recordAudit({
    action: `infra.approval.${decision}`,
    outcome: 'success',
    resourceType: 'infra_approval',
    resourceId: String(approval.id),
    metadata: { runId, nodeKey: approval.nodeKey, riskLevel: approval.riskLevel, reason },
  });

  if (decision === 'approved') {
    await db.update(infraRuns)
      .set({ approvalsGranted: sql`${infraRuns.approvalsGranted} + 1`, status: 'applying', updatedAt: new Date() })
      .where(eq(infraRuns.id, runId));
  }

  return { runId, status: decision };
}

/* -------------------------------------------------------------------------- */
/*  Internals                                                                  */
/* -------------------------------------------------------------------------- */

/** The first stage with any node not yet applied or skipped. */
/**
 * Node statuses the engine will not revisit.
 *
 * Every terminal outcome must be listed here. A status missing from this set
 * makes nextStage() return the same stage forever, because the engine keeps
 * looking for work on nodes it has already finished with — which is exactly
 * what happened when 'unsupported' was introduced and only the summary was
 * taught about it.
 */
const SETTLED_NODE_STATUS = ['applied', 'skipped', 'unsupported'] as const;

function nextStage(stages: Stage[], status: Map<string, string>): Stage | null {
  for (const stage of stages) {
    const settled = stage.nodeKeys.every((k) =>
      (SETTLED_NODE_STATUS as readonly string[]).includes(status.get(k) ?? 'pending'),
    );
    if (!settled) return stage;
  }
  return null;
}

async function pendingOrNewApproval(runId: number, stage: Stage, destructiveCount: number, toAdd: number) {
  const organizationId = currentOrgId();

  const [existing] = await db.select().from(infraApprovals)
    .where(and(
      eq(infraApprovals.organizationId, organizationId),
      eq(infraApprovals.runId, runId),
      eq(infraApprovals.nodeKey, stage.nodeKeys[0]),
    ))
    .orderBy(asc(infraApprovals.id));

  if (existing) return existing;

  const [created] = await db.insert(infraApprovals).values({
    organizationId,
    runId,
    nodeKey: stage.nodeKeys[0],
    ref: randomUUID().replace(/-/g, ''),
    summary: `Create ${stage.nodeKeys.join(', ')}`,
    details:
      `${toAdd} resource(s) will be created.` +
      (destructiveCount > 0 ? ` ${destructiveCount} existing resource(s) would be destroyed or replaced.` : '') +
      (stage.riskReasons.length > 0 ? ` Risk: ${stage.riskReasons.join(', ')}.` : ''),
    riskLevel: stage.riskLevel,
    riskReasons: stage.riskReasons as never,
    proposedAction: { stage: stage.index, nodeKeys: stage.nodeKeys } as never,
    estimatedCostImpact: String(stage.estimatedMonthlyCost),
    status: 'pending',
  }).returning();

  await db.update(infraRuns)
    .set({ approvalsRequired: sql`${infraRuns.approvalsRequired} + 1`, updatedAt: new Date() })
    .where(eq(infraRuns.id, runId));

  return created;
}

async function completeRun(
  runId: number,
  planId: number,
  plan: typeof infraPlans.$inferSelect,
  workspace: string,
  role: Awaited<ReturnType<typeof authorizingRole>>,
  executionMode: string,
) {
  const organizationId = currentOrgId();
  const auth = { runId, organizationId, role };
  await setRunStatus(runId, 'verifying');

  // Final untargeted apply. HashiCorp is explicit that a workspace where
  // -target has been used should be converged with a full run; without this the
  // configuration and the real infrastructure can quietly diverge.
  //
  // Guarded on executionMode. Without the guard a simulation reaching this point
  // performs a real apply and creates real infrastructure — the single worst
  // thing this system could do, because the user was told nothing would be
  // created. Every stage below correctly skipped applying; the convergence step
  // did not, and only a test caught it.
  if (executionMode !== 'simulate') {
    try {
      const finalPlan = await runTool<PlanResult>('terraform_plan', {
        workspacePath: workspace,
        cloudAccountId: plan.cloudAccountId!,
      }, { ...auth, approval: WAIVED_READ });

      if (finalPlan.toAdd > 0 || finalPlan.toChange > 0) {
        await appendEvent({
          runId, eventType: 'RESOURCE_CREATING',
          message: `Converging: ${finalPlan.toAdd} to add, ${finalPlan.toChange} to change after staged apply.`,
        });

        // Real infrastructure, so it goes through the policy engine like every
        // other apply. The waiver names the reason no separate signature is
        // required: every resource here was already approved as part of a
        // stage, and this run only reconciles what -target left behind.
        await runTool('terraform_apply', {
          workspacePath: workspace,
          cloudAccountId: plan.cloudAccountId!,
        }, {
          ...auth,
          approval: {
            kind: 'waived',
            by: 'staging-policy',
            reason: 'convergence of resources already approved stage by stage; -target leaves no new resource unapproved',
          },
        });
      }
    } catch (err) {
      if (err instanceof ToolDenied) return failRun(runId, err.message);
      return failRun(runId, `final convergence apply failed: ${(err as Error)?.message ?? err}`);
    }
  }

  // In a simulation nothing was created, so the resource list must be empty
  // rather than whatever state happens to contain — otherwise the summary would
  // report resources the user does not have.
  const addresses = executionMode === 'simulate'
    ? []
    : await runTool<{ addresses: string[] }>('terraform_state_list', {
        workspacePath: workspace,
        cloudAccountId: plan.cloudAccountId!,
      }, { ...auth, approval: WAIVED_LOCAL }).then((r) => r.addresses).catch(() => []);

  const [run] = await db.select().from(infraRuns).where(eq(infraRuns.id, runId));
  const durationSeconds = run?.startedAt ? Math.round((Date.now() - run.startedAt.getTime()) / 1000) : null;

  await db.insert(infraDeployments).values({
    organizationId: currentOrgId(),
    planId,
    runId,
    name: plan.name,
    provider: plan.provider ?? 'aws',
    region: plan.region,
    environment: plan.environment,
    executionMode: run?.executionMode ?? 'live',
    resources: addresses as never,
    resourceCount: addresses.length,
    estimatedMonthlyCost: plan.estimatedMonthlyCost,
    // A reference, never the state itself: state contains resource secrets.
    stateRef: workspace,
    durationSeconds,
    status: 'active',
  });

  await setRunStatus(runId, 'succeeded', { finishedAt: new Date() });
  await appendEvent({
    runId,
    eventType: 'DEPLOYMENT_COMPLETED',
    message: `Deployment complete: ${addresses.length} resource(s) exist.`,
    data: { resources: addresses, durationSeconds },
  });

  // Learn from what worked. Failing to record knowledge must never fail the
  // deployment that produced it — the infrastructure exists either way.
  try {
    await extractStepsFromRun(runId);
    // Then find the provider documentation for whatever was just learned, so a
    // step arrives in the library with a source rather than acquiring one later.
    await attachProvenanceForRun(runId);
  } catch (err) {
    console.error(`[Engine] Could not extract steps from run ${runId}:`, (err as Error)?.message ?? err);
  }

  await recordAudit({
    action: 'infra.deployment.completed',
    outcome: 'success',
    resourceType: 'infra_run',
    resourceId: String(runId),
    metadata: { planId, resourceCount: addresses.length, durationSeconds },
  });

  return { runId, status: 'succeeded' as RunStatus, action: 'deployment complete', done: true };
}

/**
 * Decides what a failed stage means and what happens next.
 *
 * Replaces the previous behaviour, which was to stop on anything. A throttled
 * request is not a reason to abandon a half-built environment, and an invalid
 * instance type will not fix itself on the third attempt — so the answer depends
 * on what actually went wrong.
 */
async function handleStageFailure(
  runId: number,
  stage: Stage,
  phase: 'plan' | 'apply',
  detail: string,
): Promise<AdvanceResult> {
  const classification = classifyFailure(detail);
  const attemptsSoFar = (await maxAttempts(runId, stage.nodeKeys)) + 1;
  await bumpAttempts(runId, stage.nodeKeys);

  const summary = detail.trim().slice(-400) || `terraform ${phase} failed`;

  if (shouldRetry(classification, attemptsSoFar)) {
    const wait = retryDelayMs(attemptsSoFar);

    await appendEvent({
      runId,
      eventType: 'RETRY_STARTED',
      level: 'warn',
      nodeKey: stage.nodeKeys[0],
      message:
        `${phase === 'plan' ? 'Plan' : 'Apply'} failed because ${classification.reason}. ` +
        `Retrying in ${Math.round(wait / 1000)}s (attempt ${attemptsSoFar + 1} of ${MAX_ATTEMPTS}).`,
      data: { phase, kind: classification.kind, reason: classification.reason, attempt: attemptsSoFar, detail: summary },
    });

    // Waiting here holds the lease, which is the point: no other worker should
    // pick this run up mid-retry. The delays are far shorter than the lease.
    await delay(wait);

    // Back to a working status so the next advance() re-plans this stage. The
    // nodes stay 'running' rather than 'failed' — they are still in progress.
    await setRunStatus(runId, 'planning');
    return { runId, status: 'planning', action: `retrying stage ${stage.index} after a transient failure`, done: false };
  }

  await markNodes(runId, stage.nodeKeys, 'failed', summary);
  await appendEvent({
    runId,
    eventType: 'RESOURCE_FAILED',
    level: 'error',
    nodeKey: stage.nodeKeys[0],
    message: `${phase === 'plan' ? 'Plan' : 'Apply'} failed: ${classification.reason}.`,
    data: { phase, kind: classification.kind, attempts: attemptsSoFar, detail: summary },
  });

  const status = terminalStatusFor(classification.kind);

  if (status === 'failed') return failRun(runId, `terraform ${phase} failed: ${summary}`);

  // Paused, not failed. Whatever was created still exists, the cause may be
  // fixable outside this system — a quota increase, a permission — and the run
  // can then be resumed. Reporting "failed" would suggest there is nothing left
  // to do and would strand a half-built environment.
  return pauseRun(runId, classification, phase, summary, attemptsSoFar);
}

async function pauseRun(
  runId: number,
  classification: Classification,
  phase: string,
  detail: string,
  attempts: number,
): Promise<AdvanceResult> {
  const message =
    classification.kind === 'unknown'
      ? `Stopped during ${phase}: ${classification.reason}. Nothing further will be attempted automatically.`
      : `Stopped during ${phase} because ${classification.reason}. ` +
        `Fix it and resume — what has already been created is untouched.`;

  await setRunStatus(runId, 'paused', { error: `${message}\n\n${detail}` });
  await appendEvent({ runId, eventType: 'RUN_PAUSED', level: 'warn', message, data: { kind: classification.kind, attempts, detail } });

  await recordAudit({
    action: 'infra.deployment.paused',
    outcome: 'failure',
    resourceType: 'infra_run',
    resourceId: String(runId),
    metadata: { kind: classification.kind, reason: classification.reason, phase, attempts },
  });

  // done: the run has stopped and a human owns it. Without this the worker loop
  // would call advance() again immediately and retry what was just classified
  // as not worth retrying.
  return { runId, status: 'paused', action: message, done: true };
}

/** Highest attempt count recorded against any node in a stage. */
async function maxAttempts(runId: number, nodeKeys: string[]): Promise<number> {
  const rows = await db.select({ attempts: infraRunNodes.attempts }).from(infraRunNodes)
    .where(and(
      eq(infraRunNodes.runId, runId),
      eq(infraRunNodes.organizationId, currentOrgId()),
      inArray(infraRunNodes.nodeKey, nodeKeys),
    ));
  return rows.reduce((max, r) => Math.max(max, r.attempts ?? 0), 0);
}

async function bumpAttempts(runId: number, nodeKeys: string[]): Promise<void> {
  if (nodeKeys.length === 0) return;
  await db.update(infraRunNodes)
    .set({ attempts: sql`${infraRunNodes.attempts} + 1`, updatedAt: new Date() })
    .where(and(
      eq(infraRunNodes.runId, runId),
      eq(infraRunNodes.organizationId, currentOrgId()),
      inArray(infraRunNodes.nodeKey, nodeKeys),
    ));
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function failRun(runId: number, error: string): Promise<AdvanceResult> {
  await setRunStatus(runId, 'failed', { finishedAt: new Date(), error });
  await appendEvent({ runId, eventType: 'DEPLOYMENT_FAILED', level: 'error', message: error });
  await recordAudit({
    action: 'infra.deployment.failed', outcome: 'failure',
    resourceType: 'infra_run', resourceId: String(runId), metadata: { error },
  });
  return { runId, status: 'failed', action: error, done: true };
}

async function setRunStatus(runId: number, status: RunStatus, extra: Record<string, unknown> = {}): Promise<void> {
  await db.update(infraRuns)
    .set({ status, updatedAt: new Date(), ...(status === 'initializing' ? { startedAt: new Date() } : {}), ...extra })
    .where(and(eq(infraRuns.id, runId), eq(infraRuns.organizationId, currentOrgId())));
}

async function markNodes(runId: number, nodeKeys: string[], status: string, error?: string): Promise<void> {
  if (nodeKeys.length === 0) return;
  await db.update(infraRunNodes).set({
    status,
    error: error ?? null,
    updatedAt: new Date(),
    ...(status === 'running' ? { startedAt: new Date() } : {}),
    ...(['applied', 'failed', 'skipped'].includes(status) ? { finishedAt: new Date() } : {}),
  }).where(and(
    eq(infraRunNodes.runId, runId),
    eq(infraRunNodes.organizationId, currentOrgId()),
    inArray(infraRunNodes.nodeKey, nodeKeys),
  ));
}

async function loadNodeStatus(runId: number, organizationId: number): Promise<Map<string, string>> {
  const rows = await db.select().from(infraRunNodes)
    .where(and(eq(infraRunNodes.runId, runId), eq(infraRunNodes.organizationId, organizationId)));
  return new Map(rows.map((r) => [r.nodeKey, r.status]));
}

async function loadRun(runId: number, organizationId: number) {
  const [row] = await db.select().from(infraRuns)
    .where(and(eq(infraRuns.id, runId), eq(infraRuns.organizationId, organizationId)));
  return row ?? null;
}

async function loadPlanContext(planId: number, organizationId: number): Promise<{
  plan: typeof infraPlans.$inferSelect;
  architecture: LogicalArchitecture;
  nodes: LamNode[];
}> {
  const [plan] = await db.select().from(infraPlans)
    .where(and(eq(infraPlans.id, planId), eq(infraPlans.organizationId, organizationId)));
  if (!plan) throw new Error(`Plan ${planId} not found`);

  // The stored logical model is authoritative: recompiling could produce a
  // different topology if the compiler changed since approval, and the plan a
  // human approved must be the plan that runs.
  const stored = plan.logicalModel as LogicalArchitecture | null;
  if (stored?.nodes?.length) {
    return { plan, architecture: stored, nodes: stored.nodes };
  }

  const architecture = compileArchitecture(
    (plan.estimatorOutput as EstimatorLayer[]) ?? [],
    (plan.clarifications as Clarifications) ?? {},
    plan.requirements,
  );
  return { plan, architecture, nodes: architecture.nodes };
}

function namePrefixFor(name: string, environment: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'app';
  return `${slug}-${environment.slice(0, 4)}`;
}

/**
 * Takes the run lease.
 *
 * A run may be advanced by a worker tick, an approval decision or an operator
 * retry, potentially at the same moment and on different replicas. The lease
 * makes those safe: exactly one caller proceeds, the rest return immediately.
 * It expires, so a worker that dies mid-step does not strand the run forever.
 */
export async function acquireLease(runId: number, organizationId: number, owner: string): Promise<boolean> {
  const expires = new Date(Date.now() + LEASE_MS);
  const updated = await db.update(infraRuns)
    .set({ leaseOwner: owner, leaseExpiresAt: expires, updatedAt: new Date() })
    .where(and(
      eq(infraRuns.id, runId),
      eq(infraRuns.organizationId, organizationId),
      // lease_expires_at is timestamptz (migration 0013), so now() compares
      // instant to instant. It was previously a timezone-less timestamp, which
      // Postgres cast using the session zone — off by 5.5 hours here, so a held
      // lease read as expired and two workers could drive one deployment.
      sql`(${infraRuns.leaseOwner} is null or ${infraRuns.leaseExpiresAt} < now())`,
    ))
    .returning({ id: infraRuns.id });

  return updated.length > 0;
}

export async function releaseLease(runId: number, owner: string): Promise<void> {
  await db.update(infraRuns)
    .set({ leaseOwner: null, leaseExpiresAt: null })
    .where(and(eq(infraRuns.id, runId), eq(infraRuns.leaseOwner, owner)));
}
