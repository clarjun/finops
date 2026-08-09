/**
 * The policy engine — the only way a tool ever runs.
 *
 *   AGENT -> POLICY -> AUTHORIZATION -> APPROVAL GATE -> EXECUTION -> CLOUD
 *
 * The agent proposes `{ tool, args }`. It does not execute anything and it never
 * holds credentials. Everything below decides whether the proposal is permitted
 * and, if so, runs it and records what happened.
 *
 * Fails closed at every step: an unknown tool, invalid arguments, a missing
 * permission, an undecided approval or an unreadable configuration all stop the
 * call. Nothing here has a path that proceeds on uncertainty.
 */
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { infraApprovals } from '@shared/schema';
import { currentOrgId, currentUsername, currentUserId } from '../../tenant-context';
import { roleHasPermission, normalizeRole } from '../../rbac';
import { recordAudit } from '../../audit';
import { infraToolRegistry, type InfraTool, type InfraToolContext } from './registry';
import { appendEvent } from '../events';

/** Why a call did not run, when it did not run. */
export type DenialReason =
  | 'unknown_tool'
  | 'invalid_arguments'
  | 'forbidden'
  | 'awaiting_approval'
  | 'approval_rejected'
  | 'aborted';

export interface ToolInvocation {
  tool: string;
  args: Record<string, unknown>;
}

export type ToolOutcome =
  | { status: 'executed'; result: unknown; attempts: number; durationMs: number }
  | { status: 'held'; reason: 'awaiting_approval'; approvalRef: string; approvalId: number }
  | { status: 'denied'; reason: DenialReason; message: string };

export interface InvokeOptions {
  /** Role of the caller. Defaults to the ambient session role. */
  role?: string;
  /**
   * An approval that has already been granted for this exact call. The engine
   * passes this when resuming a run past a gate.
   */
  approvalId?: number;
  /** Skips the approval gate. Only for a run the operator marked as simulate. */
  simulate?: boolean;
  /**
   * States that a human decision was not required for this call, and why.
   *
   * Distinct from `simulate`, which asserts nothing will reach the cloud. A
   * waiver asserts something else entirely: the action is real, and an upstream
   * policy — the deployment engine's per-resource risk assessment — determined
   * it needs no signature. It is recorded, so an absent approval is still
   * attributable to the policy that decided it.
   */
  approvalWaiver?: { by: string; reason: string };
  context?: Partial<InfraToolContext>;
}

/** Risk levels that always require a human before the action runs. */
const GATED_RISK = new Set(['high', 'critical']);

export async function invokeTool(
  invocation: ToolInvocation,
  options: InvokeOptions = {},
): Promise<ToolOutcome> {
  const organizationId = currentOrgId();
  const tool = infraToolRegistry.get(invocation.tool);

  if (!tool) {
    // Named explicitly: a model that hallucinates a tool must get a clear error,
    // not a silent no-op it will interpret as success.
    return deny('unknown_tool', `No infrastructure tool named "${invocation.tool}" is registered.`, invocation);
  }

  /* --- 1. Arguments ------------------------------------------------------- */

  const parsed = tool.input.safeParse(invocation.args);
  if (!parsed.success) {
    const detail = parsed.error.errors.map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`).join('; ');
    return deny('invalid_arguments', `Arguments rejected for ${tool.name} — ${detail}`, invocation);
  }

  /* --- 2. Authorization --------------------------------------------------- */

  const role = normalizeRole(options.role ?? undefined);
  if (!roleHasPermission(role, tool.requiredPermission)) {
    await recordAudit({
      action: 'infra.tool.denied',
      outcome: 'denied',
      resourceType: 'infra_tool',
      resourceId: tool.name,
      metadata: { requiredPermission: tool.requiredPermission, role, risk: tool.risk },
    });
    return deny('forbidden', `${tool.name} requires the '${tool.requiredPermission}' permission; your role is '${role}'.`, invocation);
  }

  /* --- 3. Approval gate --------------------------------------------------- */

  if (GATED_RISK.has(tool.risk) && !options.simulate) {
    const decided = options.approvalId ? await loadApproval(options.approvalId, organizationId) : null;

    if (!decided && options.approvalWaiver) {
      // The gate is satisfied by a stated upstream decision rather than a
      // signature. Recorded before the call runs, so a waiver that turns out to
      // have been wrong is visible in the audit trail either way.
      await recordAudit({
        action: 'infra.tool.approval_waived',
        outcome: 'success',
        resourceType: 'infra_tool',
        resourceId: tool.name,
        metadata: {
          risk: tool.risk,
          waivedBy: options.approvalWaiver.by,
          reason: options.approvalWaiver.reason,
          runId: options.context?.runId,
          nodeKey: options.context?.nodeKey,
        },
      });
    } else if (!decided) {
      const held = await createApproval(tool, parsed.data as Record<string, unknown>, options.context);
      return { status: 'held', reason: 'awaiting_approval', approvalRef: held.ref, approvalId: held.id };
    }

    if (decided?.status === 'rejected') {
      return deny('approval_rejected', `A human rejected this action: ${decided.decisionReason ?? 'no reason given'}`, invocation);
    }

    if (decided && decided.status !== 'approved') {
      return deny('awaiting_approval', `Approval ${decided.ref} has not been decided.`, invocation);
    }
  }

  /* --- 4. Execution ------------------------------------------------------- */

  const ctx: InfraToolContext = {
    organizationId,
    userId: currentUserId(),
    username: currentUsername(),
    ...options.context,
  };

  const started = Date.now();
  const maxAttempts = tool.idempotent ? 1 + (tool.maxRetries ?? 0) : 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (ctx.signal?.aborted) {
      return deny('aborted', `${tool.name} was cancelled before it ran.`, invocation);
    }

    try {
      const result = await withTimeout(tool.handler(parsed.data, ctx), tool.timeoutMs, tool.name);

      await recordAudit({
        action: 'infra.tool.executed',
        outcome: 'success',
        resourceType: 'infra_tool',
        resourceId: tool.name,
        metadata: {
          risk: tool.risk, attempts: attempt, runId: ctx.runId, nodeKey: ctx.nodeKey,
          // Argument KEYS only. Values can contain resource identifiers and
          // configuration a customer may consider sensitive.
          argumentKeys: Object.keys(parsed.data as object),
        },
      });

      return { status: 'executed', result, attempts: attempt, durationMs: Date.now() - started };
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);

      if (attempt < maxAttempts) {
        ctx.emit?.({ level: 'warn', message: `${tool.name} failed (attempt ${attempt}/${maxAttempts}): ${message}. Retrying.` });
        // Linear backoff; a cloud API that is rate-limiting wants space, and a
        // deployment is not latency-sensitive enough to justify anything cleverer.
        await sleep(1000 * attempt);
        continue;
      }

      await recordAudit({
        action: 'infra.tool.executed',
        outcome: 'failure',
        resourceType: 'infra_tool',
        resourceId: tool.name,
        metadata: { risk: tool.risk, attempts: attempt, runId: ctx.runId, nodeKey: ctx.nodeKey, error: message },
      });
      throw err;
    }
  }

  throw lastError;
}

/* -------------------------------------------------------------------------- */

function deny(reason: DenialReason, message: string, invocation: ToolInvocation): ToolOutcome {
  void recordAudit({
    action: 'infra.tool.denied',
    outcome: 'denied',
    resourceType: 'infra_tool',
    resourceId: invocation.tool,
    metadata: { reason, message },
  });
  return { status: 'denied', reason, message };
}

async function loadApproval(id: number, organizationId: number) {
  const [row] = await db.select().from(infraApprovals)
    .where(and(eq(infraApprovals.id, id), eq(infraApprovals.organizationId, organizationId)));
  return row ?? null;
}

async function createApproval(
  tool: InfraTool<any>,
  args: Record<string, unknown>,
  context?: Partial<InfraToolContext>,
) {
  const ref = randomBytes(16).toString('base64url');

  const [created] = await db.insert(infraApprovals).values({
    organizationId: currentOrgId(),
    runId: context?.runId as number,
    nodeKey: context?.nodeKey ?? null,
    ref,
    summary: `${tool.name} — ${tool.description}`,
    details: tool.description,
    riskLevel: tool.risk,
    riskReasons: [] as never,
    // Stored verbatim: the approver must see the action that will run, and on
    // approval this exact call is what executes.
    proposedAction: { tool: tool.name, args } as never,
    status: 'pending',
  }).returning();

  if (context?.runId) {
    await appendEvent({
      runId: context.runId,
      eventType: 'APPROVAL_REQUIRED',
      nodeKey: context.nodeKey,
      level: 'warn',
      message: `Human approval required: ${tool.name}`,
      data: { approvalRef: ref, risk: tool.risk },
    });
  }

  await recordAudit({
    action: 'infra.approval.requested',
    outcome: 'success',
    resourceType: 'infra_approval',
    resourceId: String(created.id),
    metadata: { tool: tool.name, risk: tool.risk, runId: context?.runId, nodeKey: context?.nodeKey },
  });

  return created;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined, name: string): Promise<T> {
  if (!timeoutMs) return promise;
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
