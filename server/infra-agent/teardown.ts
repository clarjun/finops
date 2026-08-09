/**
 * Teardown.
 *
 * The system could create infrastructure and had no way to remove it. That is
 * not a missing convenience: it meant the only route to deleting what the agent
 * built was someone running Terraform by hand against the workspace, outside
 * every approval gate and audit record this codebase exists to enforce.
 *
 * A teardown is a run, deliberately — the same infra_runs row, lease, event
 * stream, approval and audit trail as a deployment. Destroying production is at
 * least as consequential as creating it, so it gets no lighter a process.
 *
 * Two properties matter more than anything else here:
 *
 *   what was approved is what runs
 *     `plan -destroy -out` writes the exact set to a file and `apply <file>`
 *     executes that file. Plain `terraform destroy` re-plans at apply time, so
 *     anything that appeared in the account between the approval and the
 *     decision would be destroyed without a human ever seeing it.
 *
 *   drift narrows, never widens
 *     Before applying, the plan is taken again and compared to the approved
 *     set. Anything new refuses and demands a fresh approval. Fewer resources
 *     than approved is fine — something was already gone.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { infraPlans, infraRuns, infraApprovals, infraDeployments } from '@shared/schema';
import { currentOrgId, currentUserId, currentUsername } from '../tenant-context';
import { recordAudit } from '../audit';
import { appendEvent } from './events';
import { terraformExecutor } from './terraform/executor';
import { resolveTerraformCredentials } from './tools/credentials';
import { acquireLease, releaseLease, type AdvanceResult, type RunStatus } from './engine';
import { destroyAddresses, unapprovedAdditions } from './teardown-safety';

/** Runs created by this module. The deploy engine refuses to touch them. */
export const TEARDOWN_MODE = 'destroy';

/**
 * A refusal the caller can act on.
 *
 * Carries its own status because "this run does not exist" and "this deployment
 * was already destroyed" are different answers, and collapsing both to one code
 * makes a client unable to tell a typo from a race.
 */
export class TeardownError extends Error {
  constructor(message: string, readonly status: 404 | 409 = 409) { super(message); }
}

/* -------------------------------------------------------------------------- */
/*  Starting                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Creates a teardown run for what a deployment built.
 *
 * Refuses rather than guesses. Every check below has the same shape: if we
 * cannot be certain which real resources this would remove, we do not start.
 */
export async function startTeardown(sourceRunId: number): Promise<{ teardownRunId: number }> {
  const organizationId = currentOrgId();

  const [source] = await db.select().from(infraRuns)
    .where(and(eq(infraRuns.id, sourceRunId), eq(infraRuns.organizationId, organizationId)));
  if (!source) throw new TeardownError('Run not found.', 404);

  if (source.mode === TEARDOWN_MODE) {
    throw new TeardownError('That run is itself a teardown; there is nothing for it to remove.');
  }

  // A simulation created nothing. Offering to tear one down would imply
  // resources exist, which is the exact confusion simulate mode is designed to
  // prevent.
  if (source.executionMode === 'simulate') {
    throw new TeardownError('That run was a simulation. Nothing was created, so there is nothing to destroy.');
  }

  if (!source.workspacePath) {
    throw new TeardownError('That run has no Terraform workspace, so its state cannot be read.');
  }

  const [deployment] = await db.select().from(infraDeployments)
    .where(and(eq(infraDeployments.runId, sourceRunId), eq(infraDeployments.organizationId, organizationId)));

  if (deployment?.status === 'destroyed') {
    throw new TeardownError('This deployment has already been destroyed.');
  }

  // A second teardown against the same workspace would race the first: two
  // destroys of one state file, each reading a set the other is mid-way through
  // deleting.
  const [inFlight] = await db.select({ id: infraRuns.id }).from(infraRuns)
    .where(and(
      eq(infraRuns.organizationId, organizationId),
      eq(infraRuns.mode, TEARDOWN_MODE),
      eq(infraRuns.workspacePath, source.workspacePath),
      inArray(infraRuns.status, ['queued', 'planning', 'awaiting_approval', 'applying', 'verifying']),
    ))
    .limit(1);
  if (inFlight) {
    throw new TeardownError(`A teardown of this deployment is already in progress (run ${inFlight.id}).`);
  }

  const [plan] = await db.select().from(infraPlans)
    .where(and(eq(infraPlans.id, source.planId), eq(infraPlans.organizationId, organizationId)));

  const [run] = await db.insert(infraRuns).values({
    organizationId,
    planId: source.planId,
    mode: TEARDOWN_MODE,
    // A teardown is never simulated. There is no useful "pretend to delete".
    executionMode: 'live',
    status: 'queued',
    // Points at the same state the deployment wrote; that state is the only
    // record of what actually exists.
    workspacePath: source.workspacePath,
    startedByUserId: currentUserId(),
  }).returning();

  const teardownRunId = Number(run.id);

  await appendEvent({
    runId: teardownRunId,
    eventType: 'AGENT_STARTED',
    level: 'warn',
    message: `Teardown requested for "${plan?.name ?? `plan ${source.planId}`}" (deployed by run ${sourceRunId}).`,
    data: { sourceRunId, planId: source.planId },
  });

  await recordAudit({
    action: 'infra.teardown.requested',
    outcome: 'success',
    resourceType: 'infra_run',
    resourceId: String(teardownRunId),
    metadata: { sourceRunId, planId: source.planId, deploymentId: deployment?.id ?? null },
  });

  return { teardownRunId };
}

/* -------------------------------------------------------------------------- */
/*  Advancing                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Performs the next step of a teardown.
 *
 * Same contract as the deploy engine's advance(): takes the lease, does one
 * step, returns. Safe to call repeatedly.
 */
export async function advanceTeardown(runId: number): Promise<AdvanceResult> {
  const organizationId = currentOrgId();
  const owner = `${process.pid}-${randomUUID().slice(0, 8)}`;

  if (!await acquireLease(runId, organizationId, owner)) {
    return { runId, status: 'queued', action: 'another worker holds this run', done: false };
  }

  try {
    const [run] = await db.select().from(infraRuns)
      .where(and(eq(infraRuns.id, runId), eq(infraRuns.organizationId, organizationId)));
    if (!run) throw new TeardownError(`Run ${runId} not found`);

    if (run.mode !== TEARDOWN_MODE) {
      // Defence in depth. Applying a deploy run's configuration from here would
      // create infrastructure from a code path whose entire purpose is removal.
      throw new TeardownError(`Run ${runId} is not a teardown; refusing to advance it here.`);
    }

    if (['succeeded', 'failed', 'cancelled'].includes(run.status)) {
      return { runId, status: run.status as RunStatus, action: 'teardown already finished', done: true };
    }

    const workspace = run.workspacePath;
    if (!workspace) return fail(runId, 'The teardown has no workspace to read state from.');

    const [plan] = await db.select().from(infraPlans)
      .where(and(eq(infraPlans.id, run.planId), eq(infraPlans.organizationId, organizationId)));

    const creds = plan?.cloudAccountId
      ? await resolveTerraformCredentials(plan.cloudAccountId)
      : undefined;
    if (!creds) {
      return fail(runId, 'No usable cloud credentials for this account; a destroy cannot be planned without them.');
    }

    const [approval] = await db.select().from(infraApprovals)
      .where(and(eq(infraApprovals.runId, runId), eq(infraApprovals.organizationId, organizationId)))
      .orderBy(desc(infraApprovals.id))
      .limit(1);

    /* --- 1. propose ------------------------------------------------------- */

    if (!approval) return proposeDestroy(runId, workspace, creds);

    if (approval.status === 'pending') {
      return { runId, status: 'awaiting_approval', action: 'waiting for a decision', awaitingApprovalRef: approval.ref, done: false };
    }

    if (approval.status === 'rejected') {
      await setStatus(runId, 'cancelled', { finishedAt: new Date() });
      await appendEvent({
        runId, eventType: 'REJECTED', level: 'warn',
        message: 'Teardown rejected. Nothing was destroyed.',
      });
      return { runId, status: 'cancelled', action: 'teardown rejected', done: true };
    }

    /* --- 2. execute the approved set -------------------------------------- */

    return executeDestroy(runId, workspace, creds, approval);
  } catch (err) {
    return fail(runId, (err as Error)?.message ?? String(err));
  } finally {
    await releaseLease(runId, owner);
  }
}

/** Plans the destroy and stops for a human. */
async function proposeDestroy(
  runId: number,
  workspace: string,
  creds: Awaited<ReturnType<typeof resolveTerraformCredentials>>,
): Promise<AdvanceResult> {
  await setStatus(runId, 'planning');
  await appendEvent({ runId, eventType: 'PLAN_CREATED', message: 'Reading current state and planning the destroy…' });

  const init = await terraformExecutor.init(workspace, creds);
  if (!init.ok) return fail(runId, `terraform init failed: ${init.stderr.slice(-500)}`);

  const planned = await terraformExecutor.plan(workspace, creds, { destroy: true });
  if (!planned.ok) return fail(runId, `terraform plan -destroy failed: ${planned.stderr.slice(-500)}`);

  const addresses = destroyAddresses(planned);

  if (addresses.length === 0) {
    // Already gone — destroyed by hand, or never created. Succeeding is honest;
    // the desired end state holds.
    await appendEvent({
      runId, eventType: 'DEPLOYMENT_COMPLETED',
      message: 'Nothing to destroy: Terraform state contains no resources.',
    });
    await markDeploymentDestroyed(workspace);
    await setStatus(runId, 'succeeded', { finishedAt: new Date(), resourcesToDestroy: 0 });
    return { runId, status: 'succeeded', action: 'nothing to destroy', done: true };
  }

  const [created] = await db.insert(infraApprovals).values({
    organizationId: currentOrgId(),
    runId,
    nodeKey: null,
    ref: randomUUID().replace(/-/g, ''),
    summary: `Destroy ${addresses.length} resource(s)`,
    details:
      `${addresses.length} resource(s) will be permanently destroyed:\n` +
      `${addresses.join('\n')}\n\n` +
      `This cannot be undone. Data in any destroyed store is lost unless a snapshot exists.`,
    riskLevel: 'critical',
    riskReasons: ['destructive'] as never,
    // The approved set, kept so the decision can be checked against what the
    // plan says at execution time.
    proposedAction: { destroy: addresses } as never,
    estimatedCostImpact: null,
    status: 'pending',
  }).returning();

  await db.update(infraRuns).set({
    resourcesToDestroy: addresses.length,
    approvalsRequired: sql`${infraRuns.approvalsRequired} + 1`,
    updatedAt: new Date(),
  }).where(eq(infraRuns.id, runId));

  await setStatus(runId, 'awaiting_approval');
  await appendEvent({
    runId, eventType: 'APPROVAL_REQUIRED', level: 'warn',
    message: `Approval required to destroy ${addresses.length} resource(s).`,
    data: { addresses },
  });

  return { runId, status: 'awaiting_approval', action: 'destroy proposed', awaitingApprovalRef: created.ref, done: false };
}

/** Re-plans, checks nothing was added, then applies the saved plan. */
async function executeDestroy(
  runId: number,
  workspace: string,
  creds: Awaited<ReturnType<typeof resolveTerraformCredentials>>,
  approval: typeof infraApprovals.$inferSelect,
): Promise<AdvanceResult> {
  await setStatus(runId, 'applying');

  const approved: string[] = Array.isArray((approval.proposedAction as { destroy?: unknown })?.destroy)
    ? ((approval.proposedAction as { destroy: string[] }).destroy)
    : [];

  const replanned = await terraformExecutor.plan(workspace, creds, { destroy: true });
  if (!replanned.ok) return fail(runId, `terraform plan -destroy failed: ${replanned.stderr.slice(-500)}`);

  const current = destroyAddresses(replanned);

  // Only additions are a problem. A resource that has since disappeared means
  // the destroy does less than approved, which cannot surprise anyone.
  const unapproved = unapprovedAdditions(approved, current);
  if (unapproved.length > 0) {
    return fail(
      runId,
      `The destroy plan changed after approval: ${unapproved.join(', ')} ` +
      `${unapproved.length === 1 ? 'is' : 'are'} not in the approved set. ` +
      `Nothing was destroyed. Start a new teardown so the current set can be reviewed.`,
    );
  }

  if (current.length === 0) {
    await appendEvent({
      runId, eventType: 'DEPLOYMENT_COMPLETED',
      message: 'Nothing left to destroy; the resources were already gone.',
    });
    await markDeploymentDestroyed(workspace);
    await setStatus(runId, 'succeeded', { finishedAt: new Date() });
    return { runId, status: 'succeeded', action: 'already destroyed', done: true };
  }

  await appendEvent({
    runId, eventType: 'RESOURCE_CREATING', level: 'warn',
    message: `Destroying ${current.length} resource(s)…`,
    data: { addresses: current },
  });

  const applied = await terraformExecutor.apply(workspace, creds, {
    onOutput: (line) => {
      if (line) void appendEvent({ runId, eventType: 'RESOURCE_CREATING', message: line.slice(0, 500) });
    },
  });

  if (!applied.ok) {
    // Partial destroy is the normal failure here: a bucket with objects, a
    // database with deletion protection. State still holds whatever survived,
    // so the remaining resources are reported rather than assumed gone.
    const remaining = await terraformExecutor.listState(workspace, creds);
    await appendEvent({
      runId, eventType: 'RESOURCE_FAILED', level: 'error',
      message: `Destroy failed with ${remaining.length} resource(s) still present.`,
      data: { remaining },
    });
    return fail(runId, `terraform destroy failed: ${applied.stderr.slice(-500)}`);
  }

  await setStatus(runId, 'verifying');
  const remaining = await terraformExecutor.listState(workspace, creds);

  if (remaining.length > 0) {
    // Terraform exited zero but state is not empty. Reporting success here
    // would tell someone their bill had stopped when it had not.
    await appendEvent({
      runId, eventType: 'RESOURCE_FAILED', level: 'error',
      message: `Destroy reported success but ${remaining.length} resource(s) remain in state.`,
      data: { remaining },
    });
    return fail(runId, `Destroy incomplete: ${remaining.length} resource(s) still exist.`);
  }

  await markDeploymentDestroyed(workspace);
  await db.update(infraRuns).set({ resourcesToDestroy: current.length, updatedAt: new Date() })
    .where(eq(infraRuns.id, runId));
  await setStatus(runId, 'succeeded', { finishedAt: new Date() });

  await appendEvent({
    runId, eventType: 'DEPLOYMENT_COMPLETED',
    message: `Teardown complete: ${current.length} resource(s) destroyed. State is empty.`,
    data: { destroyed: current },
  });

  await recordAudit({
    action: 'infra.teardown.completed',
    outcome: 'success',
    resourceType: 'infra_run',
    resourceId: String(runId),
    metadata: { destroyed: current, count: current.length, decidedBy: currentUsername() ?? null },
  });

  return { runId, status: 'succeeded', action: `destroyed ${current.length} resource(s)`, done: true };
}

/* -------------------------------------------------------------------------- */

async function markDeploymentDestroyed(workspace: string): Promise<void> {
  await db.update(infraDeployments)
    .set({ status: 'destroyed', updatedAt: new Date() })
    .where(and(
      eq(infraDeployments.organizationId, currentOrgId()),
      eq(infraDeployments.stateRef, workspace),
    ));
}

async function setStatus(runId: number, status: RunStatus, extra: Record<string, unknown> = {}): Promise<void> {
  await db.update(infraRuns)
    .set({ status, updatedAt: new Date(), ...(status === 'planning' ? { startedAt: new Date() } : {}), ...extra })
    .where(and(eq(infraRuns.id, runId), eq(infraRuns.organizationId, currentOrgId())));
}

async function fail(runId: number, message: string): Promise<AdvanceResult> {
  await setStatus(runId, 'failed', { error: message, finishedAt: new Date() });
  await appendEvent({ runId, eventType: 'DEPLOYMENT_FAILED', level: 'error', message });
  await recordAudit({
    action: 'infra.teardown.failed',
    outcome: 'failure',
    resourceType: 'infra_run',
    resourceId: String(runId),
    metadata: { error: message },
  });
  return { runId, status: 'failed', action: message, done: true };
}

/** Teardown runs pending review, for the console. */
export async function listTeardowns(limit = 20) {
  return db.select().from(infraRuns)
    .where(and(eq(infraRuns.organizationId, currentOrgId()), eq(infraRuns.mode, TEARDOWN_MODE)))
    .orderBy(asc(infraRuns.id))
    .limit(limit);
}
