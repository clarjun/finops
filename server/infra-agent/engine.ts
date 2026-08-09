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
import { extractStepsFromRun } from './knowledge/step-library';
import { attachProvenanceForRun } from './knowledge/docs';
import type { Clarifications, EstimatorLayer, LamNode, LogicalArchitecture } from './types';

/** How long a worker may hold a run before another may take it over. */
const LEASE_MS = 5 * 60_000;

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

    if (['succeeded', 'failed', 'cancelled'].includes(run.status)) {
      return { runId, status: run.status as RunStatus, action: 'run already finished', done: true };
    }

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

      const init = await terraformExecutor.init(workspace);
      if (!init.ok) return failRun(runId, `terraform init failed: ${init.stderr.slice(-500)}`);

      const validate = await terraformExecutor.validate(workspace);
      if (!validate.ok) return failRun(runId, `terraform validate failed: ${validate.stderr.slice(-500)}`);

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
    let creds: Awaited<ReturnType<typeof resolveTerraformCredentials>> | undefined;
    if (plan.cloudAccountId) {
      try {
        creds = await resolveTerraformCredentials(plan.cloudAccountId);
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

    const existing = new Set(await terraformExecutor.listState(workspace, creds));
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
      return completeRun(runId, run.planId, plan, workspace, creds, run.executionMode);
    }

    const targets = stageTargets(stage, generated.addressByNode);
    if (targets.length === 0) {
      // Every node in this stage is one the mapper cannot build; skip it rather
      // than plan with no targets, which Terraform would read as "everything".
      await markNodes(runId, stage.nodeKeys, 'skipped');
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

    const planned = await terraformExecutor.plan(workspace, creds, { targets });
    if (!planned.ok) {
      await markNodes(runId, stage.nodeKeys, 'failed', planned.stderr.slice(-400));
      return failRun(runId, `terraform plan failed: ${planned.diagnostics.map((d) => d.summary).join('; ') || planned.stderr.slice(-400)}`);
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

    if (stage.requiresApproval || planned.destructive.length > 0) {
      const approval = await pendingOrNewApproval(runId, stage, planned.destructive.length, planned.toAdd);

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
    const applied = await terraformExecutor.apply(workspace, creds!, {
      onOutput: (chunk) => {
        const line = chunk.trim();
        if (line) void appendEvent({ runId, eventType: 'RESOURCE_CREATING', message: line.slice(0, 500) });
      },
    });

    if (!applied.ok) {
      await markNodes(runId, stage.nodeKeys, 'failed', applied.stderr.slice(-400));
      await appendEvent({ runId, eventType: 'RESOURCE_FAILED', level: 'error', message: `Apply failed: ${applied.stderr.slice(-300)}` });
      return failRun(runId, `terraform apply failed: ${applied.stderr.slice(-500)}`);
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
function nextStage(stages: Stage[], status: Map<string, string>): Stage | null {
  for (const stage of stages) {
    const settled = stage.nodeKeys.every((k) => ['applied', 'skipped'].includes(status.get(k) ?? 'pending'));
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
  creds: Awaited<ReturnType<typeof resolveTerraformCredentials>>,
  executionMode: string,
) {
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
    const finalPlan = await terraformExecutor.plan(workspace, creds);
    if (finalPlan.ok && (finalPlan.toAdd > 0 || finalPlan.toChange > 0)) {
      await appendEvent({
        runId, eventType: 'RESOURCE_CREATING',
        message: `Converging: ${finalPlan.toAdd} to add, ${finalPlan.toChange} to change after staged apply.`,
      });
      const applied = await terraformExecutor.apply(workspace, creds);
      if (!applied.ok) return failRun(runId, `final convergence apply failed: ${applied.stderr.slice(-400)}`);
    }
  }

  // In a simulation nothing was created, so the resource list must be empty
  // rather than whatever state happens to contain — otherwise the summary would
  // report resources the user does not have.
  const addresses = executionMode === 'simulate' ? [] : await terraformExecutor.listState(workspace, creds);

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
async function acquireLease(runId: number, organizationId: number, owner: string): Promise<boolean> {
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

async function releaseLease(runId: number, owner: string): Promise<void> {
  await db.update(infraRuns)
    .set({ leaseOwner: null, leaseExpiresAt: null })
    .where(and(eq(infraRuns.id, runId), eq(infraRuns.leaseOwner, owner)));
}
