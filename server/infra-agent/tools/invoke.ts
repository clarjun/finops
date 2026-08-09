/**
 * The execution path's entry into the tool layer.
 *
 *   AGENT -> POLICY ENGINE -> TOOL AUTHORIZATION -> APPROVAL GATE -> EXECUTION -> CLOUD
 *
 * That chain is a stated requirement, and until now the middle of it was not on
 * the path: the tools were registered at start-up and the engine called the
 * Terraform executor directly, so schema validation, per-tool authorization,
 * risk classification, timeouts and tool-level audit were written and never ran.
 * This module is what puts them back in the way.
 *
 * Two decisions worth stating, because both could be got wrong quietly:
 *
 *   who authorizes
 *     A deployment runs in a worker, with no session. Falling back to the
 *     ambient system identity would mean the most privileged possible caller
 *     executing every apply, which is the opposite of authorization. Instead the
 *     call is authorized as the person who started the run — so revoking their
 *     permission mid-deployment stops the next stage, and the audit trail names
 *     a human rather than "system".
 *
 *   who owns the approval
 *     The engine already gates stages, using risk assessed per resource by the
 *     compiler. The tool layer also gates by tool risk. Running both would make
 *     every apply need two signatures. The engine therefore passes the approval
 *     it already holds; where a stage was assessed as needing none, it passes an
 *     explicit, audited waiver naming the policy that decided so. A waiver is
 *     recorded and attributable — unlike a boolean that skips the gate.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { infraRuns, users, type UserRole } from '@shared/schema';
import { normalizeRole } from '../../rbac';
import { invokeTool, type ToolOutcome } from './policy';
import { registerTerraformTools } from './terraform-tools';
import type { InfraToolContext } from './registry';

export class ToolDenied extends Error {
  constructor(readonly outcome: Extract<ToolOutcome, { status: 'denied' | 'held' }>, message: string) {
    super(message);
  }
}

/**
 * The role a run's calls are authorized as: the role of whoever started it.
 *
 * Falls back to the least privilege on purpose. A run with no identifiable
 * initiator cannot be authorized to create infrastructure, and `viewer` makes
 * that a clear denial rather than a silent escalation.
 */
export async function authorizingRole(runId: number, organizationId: number): Promise<UserRole> {
  const [run] = await db.select({ startedByUserId: infraRuns.startedByUserId }).from(infraRuns)
    .where(and(eq(infraRuns.id, runId), eq(infraRuns.organizationId, organizationId)));

  if (!run?.startedByUserId) return 'viewer';

  const [user] = await db.select({ role: users.role }).from(users)
    .where(eq(users.id, run.startedByUserId));

  return normalizeRole(user?.role);
}

export type ApprovalEvidence =
  /** A human decided this exact action. */
  | { kind: 'granted'; approvalId: number }
  /**
   * No human decision was required, because the staging policy assessed the
   * resources as low risk. Recorded so the absence of a signature is itself
   * attributable.
   */
  | { kind: 'waived'; by: string; reason: string };

export interface RunToolOptions {
  runId: number;
  organizationId: number;
  role: UserRole;
  approval: ApprovalEvidence;
  context?: Partial<InfraToolContext>;
}

/**
 * Runs a tool through the policy engine and returns its result.
 *
 * Throws on denial rather than returning a value the caller might read as
 * success. A denial is not a failed deployment step — it is the system
 * refusing, and it has to be impossible to mistake for anything else.
 */
export async function runTool<T = unknown>(
  tool: string,
  args: Record<string, unknown>,
  options: RunToolOptions,
): Promise<T> {
  // Registration is idempotent, and doing it here means the path never depends
  // on start-up ordering.
  registerTerraformTools();

  const outcome = await invokeTool({ tool, args }, {
    role: options.role,
    approvalId: options.approval.kind === 'granted' ? options.approval.approvalId : undefined,
    // Not `simulate`: this call really does reach the cloud. The waiver says a
    // signature was not required and names the policy that decided that, and
    // the policy engine records it.
    approvalWaiver: options.approval.kind === 'waived'
      ? { by: options.approval.by, reason: options.approval.reason }
      : undefined,
    context: { runId: options.runId, organizationId: options.organizationId, ...options.context },
  });

  if (outcome.status === 'executed') return outcome.result as T;

  if (outcome.status === 'held') {
    throw new ToolDenied(outcome, `${tool} is held awaiting approval ${outcome.approvalRef}.`);
  }

  throw new ToolDenied(outcome, `${tool} was refused: ${outcome.message}`);
}
