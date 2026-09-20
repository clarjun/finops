/**
 * The evaluation sweep.
 *
 * One pass over the enabled policies for the current tenant, producing a run
 * row, a set of findings and a posture score.
 *
 * The part worth reading carefully is reconciliation. Findings are identified
 * by a fingerprint — policy key plus the identity of the thing being flagged —
 * and upserted, never appended. That gives three properties the naive
 * delete-and-reinsert approach loses:
 *
 *   - first_seen_at survives every sweep, so ageing and remediation SLAs are
 *     computable and a finding cannot silently reset its clock;
 *   - an acknowledgement made by a human sticks to the finding across runs;
 *   - a fixed problem is *resolved* with a timestamp rather than vanishing, so
 *     "what did we fix last quarter" is answerable.
 *
 * A policy that throws is isolated: its findings from the previous run are left
 * untouched (resolving them would report a crash as a fix), the run is marked
 * with a failure count, and the remaining policies still evaluate.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import {
  governanceRuns,
  governanceViolations,
  governanceExemptions,
  type GovernanceExemption,
} from "@shared/schema";
import { currentOrgId } from "../tenant-context";
import { recordAudit } from "../audit";
import type { PolicySeverity } from "@shared/governance";
import { getPolicy } from "./catalog";
import { resolveAssignments, type ResolvedAssignment } from "./assignments";
import { loadDataset } from "./data";
import { syncInventory } from "./inventory-sync";
import { matchesScope, sanitizeScope } from "./scope";
import { scorePolicies, type PolicyOutcome, type ScoreResult } from "./scoring";
import type { Finding, GovernanceDataset } from "./types";

export interface RunSummary {
  runId: number;
  status: 'success' | 'failed';
  score: number;
  grade: string;
  policiesEvaluated: number;
  policiesFailed: number;
  violationsOpened: number;
  violationsResolved: number;
  openViolations: number;
  exemptViolations: number;
  costAtRisk: number;
  notAssessed: string[];
  failed: string[];
  error?: string;
}

/**
 * Stable identity for a finding across runs.
 *
 * Deliberately excludes anything that changes between sweeps — cost, counts,
 * timestamps — because a fingerprint that moves would open a duplicate finding
 * every time the number changed, which is every run.
 */
export function fingerprint(policyKey: string, findingKey: string): string {
  return createHash('sha256').update(`${policyKey}|${findingKey}`).digest('hex');
}

function activeExemptions(rows: GovernanceExemption[], now: Date): GovernanceExemption[] {
  return rows.filter(e => !e.revokedAt && e.expiresAt > now);
}

/** An exemption suppresses a finding only if it matches both the resource and the scope. */
function isExempt(finding: Finding, policyKey: string, exemptions: GovernanceExemption[]): GovernanceExemption | null {
  for (const e of exemptions) {
    if (e.policyKey !== policyKey) continue;
    if (e.resourceId && e.resourceId !== (finding.resourceId ?? finding.key)) continue;
    const scope = sanitizeScope(e.scope);
    const matches = matchesScope(scope, {
      provider: finding.provider ?? null,
      accountId: finding.accountId ?? null,
      region: finding.region ?? null,
      resourceId: finding.resourceId ?? null,
    });
    if (matches) return e;
  }
  return null;
}

interface PendingViolation {
  fingerprint: string;
  policyKey: string;
  severity: PolicySeverity;
  exempt: boolean;
  finding: Finding;
}

function evaluateAll(
  assignments: ResolvedAssignment[],
  dataset: GovernanceDataset,
  exemptions: GovernanceExemption[],
  now: Date,
): { outcomes: PolicyOutcome[]; pending: PendingViolation[]; evaluatedKeys: string[] } {
  const outcomes: PolicyOutcome[] = [];
  const pending: PendingViolation[] = [];
  const evaluatedKeys: string[] = [];

  for (const assignment of assignments) {
    if (!assignment.enabled) continue;

    const policy = getPolicy(assignment.descriptor.key);
    if (!policy) continue;

    const key = assignment.descriptor.key;

    try {
      const result = policy.evaluate({
        parameters: assignment.parameters,
        scope: assignment.scope,
        now,
        data: dataset,
      });

      evaluatedKeys.push(key);

      let violating = 0;
      let exempt = 0;
      let costAtRisk = 0;

      for (const finding of result.findings) {
        const suppression = isExempt(finding, key, exemptions);
        const severity = finding.severity ?? assignment.severity;

        if (suppression) {
          exempt += 1;
        } else {
          violating += 1;
          costAtRisk += finding.monthlyCostImpact ?? 0;
        }

        pending.push({
          fingerprint: fingerprint(key, finding.key),
          policyKey: key,
          severity,
          exempt: suppression !== null,
          finding,
        });
      }

      outcomes.push({
        policyKey: key,
        domain: assignment.descriptor.domain,
        severity: assignment.severity,
        checked: result.checked,
        violatingUnits: violating,
        exemptUnits: exempt,
        costAtRisk,
        inconclusive: result.inconclusive,
      });
    } catch (err: any) {
      // Not evaluated: its existing findings must be left alone rather than
      // resolved, or a crash would render as a clean bill of health.
      console.error(`[Governance] Policy ${key} failed:`, err?.stack ?? err);
      outcomes.push({
        policyKey: key,
        domain: assignment.descriptor.domain,
        severity: assignment.severity,
        checked: 0,
        violatingUnits: 0,
        exemptUnits: 0,
        costAtRisk: 0,
        error: err?.message ?? String(err),
      });
    }
  }

  return { outcomes, pending, evaluatedKeys };
}

async function persistViolations(
  orgId: number,
  runId: number,
  pending: PendingViolation[],
  now: Date,
): Promise<number> {
  if (pending.length === 0) return 0;

  let opened = 0;

  // Chunked rather than one statement: a tenant with thousands of findings
  // would otherwise build a parameter list large enough to be rejected by the
  // protocol, and a partial write here is harmless because the whole thing is
  // idempotent on fingerprint.
  const CHUNK = 200;
  for (let i = 0; i < pending.length; i += CHUNK) {
    const chunk = pending.slice(i, i + CHUNK);

    const rows = chunk.map(p => ({
      organizationId: orgId,
      policyKey: p.policyKey,
      fingerprint: p.fingerprint,
      severity: p.severity,
      status: p.exempt ? 'exempt' : 'open',
      provider: p.finding.provider ?? null,
      accountId: p.finding.accountId ?? null,
      region: p.finding.region ?? null,
      resourceId: p.finding.resourceId ?? null,
      resourceType: p.finding.resourceType ?? null,
      resourceName: p.finding.resourceName ?? null,
      title: p.finding.title.slice(0, 500),
      detail: p.finding.detail,
      evidence: (p.finding.evidence ?? null) as any,
      monthlyCostImpact: p.finding.monthlyCostImpact != null ? String(p.finding.monthlyCostImpact) : null,
      firstSeenAt: now,
      lastSeenAt: now,
      resolvedAt: null,
      lastRunId: runId,
    }));

    const result = await db
      .insert(governanceViolations)
      .values(rows)
      .onConflictDoUpdate({
        target: [governanceViolations.organizationId, governanceViolations.fingerprint],
        set: {
          severity: sql`excluded.severity`,
          // A human acknowledgement outranks the engine's default of 'open',
          // but an exemption outranks everything: it is the newest decision.
          status: sql`CASE
            WHEN excluded.status = 'exempt' THEN 'exempt'
            WHEN ${governanceViolations.status} = 'acknowledged' THEN 'acknowledged'
            ELSE 'open'
          END`,
          title: sql`excluded.title`,
          detail: sql`excluded.detail`,
          evidence: sql`excluded.evidence`,
          monthlyCostImpact: sql`excluded.monthly_cost_impact`,
          provider: sql`excluded.provider`,
          accountId: sql`excluded.account_id`,
          region: sql`excluded.region`,
          resourceId: sql`excluded.resource_id`,
          resourceType: sql`excluded.resource_type`,
          resourceName: sql`excluded.resource_name`,
          lastSeenAt: now,
          lastRunId: runId,
          // A finding that came back was not fixed. Clearing the timestamp is
          // what makes a recurrence visible instead of it staying "resolved".
          resolvedAt: null,
        },
      })
      .returning({ id: governanceViolations.id, firstSeen: governanceViolations.firstSeenAt });

    opened += result.filter(r => r.firstSeen.getTime() === now.getTime()).length;
  }

  return opened;
}

/**
 * Closes findings the sweep did not reproduce.
 *
 * Scoped to the policies that actually ran. A policy that was disabled since
 * the last sweep also gets its findings closed — the tenant decided to stop
 * governing that, and leaving stale open findings behind would misreport the
 * posture — but a policy that *errored* is deliberately excluded, because we
 * do not know whether its findings still hold.
 */
async function resolveDisappeared(
  orgId: number,
  runId: number,
  evaluatedKeys: string[],
  disabledKeys: string[],
  now: Date,
): Promise<number> {
  let resolved = 0;

  if (evaluatedKeys.length > 0) {
    // "Not reproduced" is expressed as "the upsert did not stamp this run's id
    // on it", rather than as a NOT IN over every fingerprint we just saw. The
    // list form is correct but grows with the estate — ten thousand
    // fingerprints in one statement approaches Postgres's parameter limit for
    // no benefit, and this reads the same index either way.
    const rows = await db
      .update(governanceViolations)
      .set({ status: 'resolved', resolvedAt: now })
      .where(and(
        eq(governanceViolations.organizationId, orgId),
        inArray(governanceViolations.policyKey, evaluatedKeys),
        inArray(governanceViolations.status, ['open', 'acknowledged', 'exempt']),
        sql`(${governanceViolations.lastRunId} IS NULL OR ${governanceViolations.lastRunId} <> ${runId})`,
      ))
      .returning({ id: governanceViolations.id });
    resolved += rows.length;
  }

  if (disabledKeys.length > 0) {
    const rows = await db
      .update(governanceViolations)
      .set({ status: 'resolved', resolvedAt: now })
      .where(and(
        eq(governanceViolations.organizationId, orgId),
        inArray(governanceViolations.policyKey, disabledKeys),
        inArray(governanceViolations.status, ['open', 'acknowledged', 'exempt']),
      ))
      .returning({ id: governanceViolations.id });
    resolved += rows.length;
  }

  return resolved;
}

export interface EvaluateOptions {
  trigger?: 'scheduled' | 'manual';
  now?: Date;
  lookbackDays?: number;
  /**
   * Refresh the resource inventory before evaluating. On by default: the
   * estate-level policies read current state, and evaluating yesterday's
   * snapshot produces findings for resources that were deleted this morning.
   * Set false for a scoring-only re-run that must not call a cloud API.
   */
  syncInventory?: boolean;
}

/**
 * Runs a full sweep for the tenant in the ambient context.
 *
 * Must be called inside a tenant context — an authenticated request, or
 * runAsSystem(orgId, ...) from the scheduler.
 */
export async function evaluateGovernance(options: EvaluateOptions = {}): Promise<RunSummary> {
  const orgId = currentOrgId();
  const now = options.now ?? new Date();
  const trigger = options.trigger ?? 'scheduled';

  const [run] = await db
    .insert(governanceRuns)
    .values({ organizationId: orgId, trigger, status: 'running', startedAt: now })
    .returning({ id: governanceRuns.id });

  const runId = run.id;

  try {
    // Before loading the dataset, not in parallel with it — the point is for the
    // dataset to see what the sync just wrote. Never throws; a provider we could
    // not reach leaves the policies reading stale inventory, and the freshness
    // window in loadDataset() is what stops that being mistaken for current.
    if (options.syncInventory !== false && process.env.INVENTORY_SYNC_ENABLED !== 'false') {
      const results = await syncInventory(now);
      for (const r of results) {
        if (r.error) console.error(`[Governance] ${r.provider} inventory sync failed: ${r.error}`);
      }
    }

    const [assignments, dataset, exemptionRows] = await Promise.all([
      resolveAssignments(),
      loadDataset({ now, lookbackDays: options.lookbackDays }),
      db.select().from(governanceExemptions).where(eq(governanceExemptions.organizationId, orgId)),
    ]);

    const exemptions = activeExemptions(exemptionRows, now);
    const { outcomes, pending, evaluatedKeys } = evaluateAll(assignments, dataset, exemptions, now);

    const opened = await persistViolations(orgId, runId, pending, now);
    const resolved = await resolveDisappeared(
      orgId,
      runId,
      evaluatedKeys,
      assignments.filter(a => !a.enabled).map(a => a.descriptor.key),
      now,
    );

    const score: ScoreResult = scorePolicies(outcomes);

    // Titles resolved here rather than in the browser: the client would
    // otherwise have to fetch the whole catalog just to label this panel, and a
    // policy removed in a later release would render as a bare key forever.
    const titleOf = new Map(assignments.map(a => [a.descriptor.key, a.descriptor.title]));
    const notAssessed = score.notAssessed.map(n => ({
      ...n,
      title: titleOf.get(n.policyKey) ?? n.policyKey,
    }));
    const openViolations = outcomes.reduce((sum, o) => sum + o.violatingUnits, 0);
    const exemptViolations = outcomes.reduce((sum, o) => sum + o.exemptUnits, 0);
    const policiesFailed = outcomes.filter(o => o.error).length;

    await db
      .update(governanceRuns)
      .set({
        status: 'success',
        policiesEvaluated: evaluatedKeys.length,
        policiesFailed,
        violationsOpened: opened,
        violationsResolved: resolved,
        openViolations,
        score: String(score.score),
        domainScores: score.domains as any,
        notAssessed: notAssessed as any,
        costAtRisk: String(Math.round(score.costAtRisk * 100) / 100),
        finishedAt: new Date(),
      })
      .where(eq(governanceRuns.id, runId));

    void recordAudit({
      action: 'governance.evaluate',
      outcome: policiesFailed > 0 ? 'failure' : 'success',
      resourceType: 'governance_run',
      resourceId: String(runId),
      metadata: {
        trigger,
        score: score.score,
        policiesEvaluated: evaluatedKeys.length,
        policiesFailed,
        openViolations,
        exemptViolations,
        violationsOpened: opened,
        violationsResolved: resolved,
      },
    });

    return {
      runId,
      status: 'success',
      score: score.score,
      grade: score.grade,
      policiesEvaluated: evaluatedKeys.length,
      policiesFailed,
      violationsOpened: opened,
      violationsResolved: resolved,
      openViolations,
      exemptViolations,
      costAtRisk: score.costAtRisk,
      notAssessed: notAssessed.map(n => n.policyKey),
      failed: score.failed,
    };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    console.error('[Governance] Sweep failed:', err?.stack ?? err);

    await db
      .update(governanceRuns)
      .set({ status: 'failed', error: message, finishedAt: new Date() })
      .where(eq(governanceRuns.id, runId));

    void recordAudit({
      action: 'governance.evaluate',
      outcome: 'failure',
      resourceType: 'governance_run',
      resourceId: String(runId),
      metadata: { trigger, error: message },
    });

    return {
      runId,
      status: 'failed',
      score: 0,
      grade: 'F',
      policiesEvaluated: 0,
      policiesFailed: 0,
      violationsOpened: 0,
      violationsResolved: 0,
      openViolations: 0,
      exemptViolations: 0,
      costAtRisk: 0,
      notAssessed: [],
      failed: [],
      error: message,
    };
  }
}

// ── Enforcement hook ──────────────────────────────────────────────────────────

/**
 * Whether governance blocks an automated change to a resource.
 *
 * This is the difference between a compliance report and a control. Called by
 * the agent guardrails before an action touches live infrastructure: a resource
 * with an open finding under a `block` policy is off limits until the finding
 * is fixed or somebody signs a time-boxed exemption for it.
 *
 * Fails open on error, and says so. A governance lookup that cannot reach the
 * database must not become an outage in the optimization path — the guardrails
 * have their own independent limits, and this is an additional gate, not the
 * only one.
 */
export async function blockingViolationsFor(resourceId: string): Promise<Array<{ policyKey: string; title: string }>> {
  if (!resourceId) return [];

  try {
    const orgId = currentOrgId();

    const rows = await db
      .select({
        policyKey: governanceViolations.policyKey,
        title: governanceViolations.title,
      })
      .from(governanceViolations)
      .where(and(
        eq(governanceViolations.organizationId, orgId),
        eq(governanceViolations.resourceId, resourceId),
        // 'exempt' and 'resolved' are deliberately absent: an exemption is the
        // documented decision to allow exactly this, and blocking through one
        // would make exemptions useless.
        inArray(governanceViolations.status, ['open', 'acknowledged']),
      ));

    if (rows.length === 0) return [];

    // Enforcement is resolved through the same path as everything else rather
    // than read straight from the assignment table, so a policy left on catalog
    // defaults (no row) is evaluated by the same rule as a customised one.
    const blocking = new Set(
      (await resolveAssignments())
        .filter(a => a.enabled && a.enforcement === 'block')
        .map(a => a.descriptor.key),
    );

    return rows.filter(r => blocking.has(r.policyKey));
  } catch (err: any) {
    console.error('[Governance] Blocking check failed, allowing the action:', err?.message ?? err);
    return [];
  }
}

// Re-exported for the routes layer, which needs the same "is it live" rule.
export { activeExemptions };
