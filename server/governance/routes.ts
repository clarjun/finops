/**
 * Governance API.
 *
 * Authentication, tenant resolution and authorization all happen upstream —
 * server/middleware/auth-guard.ts and route-policy.ts — so nothing here checks
 * a role. What these handlers do own is the shape of what leaves the server and
 * the recording of decisions that change what the organization is measured
 * against.
 */
import type { Express, Request, Response } from "express";
import { and, desc, eq, inArray, sql, gt, isNull, or } from "drizzle-orm";
import { db } from "../db";
import {
  governancePolicyAssignments,
  governanceRuns,
  governanceViolations,
  governanceExemptions,
  users,
} from "@shared/schema";
import { currentOrgId, currentUserId } from "../tenant-context";
import { recordAudit } from "../audit";
import {
  FRAMEWORKS,
  POLICY_SEVERITIES,
  VIOLATION_STATUSES,
  ENFORCEMENT_MODES,
  gradeForScore,
  MAX_EXEMPTION_DAYS,
  type PolicySeverity,
  type ViolationStatus,
  type EnforcementMode,
  type PostureSummary,
  type PolicyImpact,
  type PolicyCatalogEntry,
  type ViolationView,
  type ExemptionView,
  type FrameworkCoverage,
  type DomainScore,
  type NotAssessedPolicy,
} from "@shared/governance";
import { POLICIES, getPolicy } from "./catalog";
import { resolveAssignments, toAssignmentViews, validateParameters } from "./assignments";
import { sanitizeScope, describeScope } from "./scope";
import { evaluateGovernance } from "./engine";

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
};

const TITLES = new Map(POLICIES.map(p => [p.descriptor.key, p.descriptor.title]));
const DOMAINS = new Map(POLICIES.map(p => [p.descriptor.key, p.descriptor.domain]));

/**
 * Reads the run's not-assessed column.
 *
 * Runs recorded before this column carried reasons hold a bare array of keys.
 * Upgrading them in place would mean inventing a reason we never captured, so
 * they are widened with an honest placeholder instead and the panel still
 * renders rather than crashing on a shape it did not expect.
 */
/**
 * Reads the per-policy impacts off a run.
 *
 * Defensive because the column is nullable by design: every run recorded before
 * migration 0026 has no impacts, and `checked` cannot be reconstructed from the
 * findings alone. Those runs return an empty list so the UI can say "not
 * available for this run" rather than showing a fabricated priority order.
 */
function readPolicyImpacts(raw: unknown): PolicyImpact[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (r): r is PolicyImpact =>
      !!r && typeof r === 'object' &&
      typeof (r as any).policyKey === 'string' &&
      typeof (r as any).potentialGain === 'number',
  );
}

function readNotAssessed(raw: unknown): NotAssessedPolicy[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry): NotAssessedPolicy | null => {
    if (typeof entry === 'string') {
      return {
        policyKey: entry,
        title: TITLES.get(entry) ?? entry,
        domain: (DOMAINS.get(entry) ?? 'cost') as NotAssessedPolicy['domain'],
        reason: 'Recorded before reasons were captured. Re-run the evaluation to see why.',
        failed: false,
      };
    }
    if (entry && typeof entry === 'object') {
      const e = entry as Record<string, unknown>;
      const key = typeof e.policyKey === 'string' ? e.policyKey : null;
      if (!key) return null;
      return {
        policyKey: key,
        title: typeof e.title === 'string' ? e.title : TITLES.get(key) ?? key,
        domain: (typeof e.domain === 'string' ? e.domain : DOMAINS.get(key) ?? 'cost') as NotAssessedPolicy['domain'],
        reason: typeof e.reason === 'string' ? e.reason : 'No reason recorded.',
        failed: e.failed === true,
      };
    }
    return null;
  }).filter((v): v is NotAssessedPolicy => v !== null);
}

/**
 * A sweep is not cheap — it scans the fact store and the inventory — so a user
 * holding the refresh button must not be able to queue twenty of them. The
 * cooldown is per tenant and lives in memory: it is a courtesy limit on a
 * button, not a security control, and the route permission is what actually
 * governs access.
 */
const MANUAL_RUN_COOLDOWN_MS = 60_000;
const lastManualRun = new Map<number, number>();

export function registerGovernanceRoutes(app: Express) {

  // ── Posture summary ─────────────────────────────────────────────────────────

  app.get('/api/governance/summary', async (_req: Request, res: Response) => {
    try {
      const orgId = currentOrgId();

      const [assignments, [lastRun], severityRows, [totals]] = await Promise.all([
        resolveAssignments(),
        db.select().from(governanceRuns)
          .where(eq(governanceRuns.organizationId, orgId))
          .orderBy(desc(governanceRuns.startedAt))
          .limit(1),
        db.select({
          severity: governanceViolations.severity,
          count: sql<number>`count(*)::int`,
        })
          .from(governanceViolations)
          .where(and(
            eq(governanceViolations.organizationId, orgId),
            inArray(governanceViolations.status, ['open', 'acknowledged']),
          ))
          .groupBy(governanceViolations.severity),
        db.select({
          open: sql<number>`count(*) FILTER (WHERE status IN ('open','acknowledged'))::int`,
          exempt: sql<number>`count(*) FILTER (WHERE status = 'exempt')::int`,
          costAtRisk: sql<string>`COALESCE(SUM(monthly_cost_impact) FILTER (WHERE status IN ('open','acknowledged')), 0)`,
        }).from(governanceViolations).where(eq(governanceViolations.organizationId, orgId)),
      ]);

      const severityCounts = Object.fromEntries(
        POLICY_SEVERITIES.map(s => [s, 0]),
      ) as Record<PolicySeverity, number>;
      for (const row of severityRows) {
        if (POLICY_SEVERITIES.includes(row.severity as PolicySeverity)) {
          severityCounts[row.severity as PolicySeverity] = row.count;
        }
      }

      const score = lastRun?.score != null ? num(lastRun.score) : 0;
      const domains = Array.isArray(lastRun?.domainScores)
        ? (lastRun!.domainScores as unknown as DomainScore[])
        : [];

      const summary: PostureSummary = {
        score,
        grade: gradeForScore(score),
        domains,
        severityCounts,
        openViolations: totals?.open ?? 0,
        exemptViolations: totals?.exempt ?? 0,
        costAtRisk: num(totals?.costAtRisk),
        policiesEnabled: assignments.filter(a => a.enabled).length,
        policiesAvailable: assignments.length,
        lastRunAt: lastRun?.startedAt ? lastRun.startedAt.toISOString() : null,
        lastRunStatus: lastRun?.status ?? null,
        lastRunError: lastRun?.error ?? null,
        notAssessed: readNotAssessed(lastRun?.notAssessed),
        policyImpacts: readPolicyImpacts(lastRun?.policyImpacts),
      };

      res.json(summary);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  /** Score over time. What a steering committee actually looks at. */
  app.get('/api/governance/history', async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 30, 180);
      const rows = await db
        .select({
          id: governanceRuns.id,
          startedAt: governanceRuns.startedAt,
          status: governanceRuns.status,
          score: governanceRuns.score,
          openViolations: governanceRuns.openViolations,
          costAtRisk: governanceRuns.costAtRisk,
          domainScores: governanceRuns.domainScores,
        })
        .from(governanceRuns)
        .where(and(
          eq(governanceRuns.organizationId, currentOrgId()),
          eq(governanceRuns.status, 'success'),
        ))
        .orderBy(desc(governanceRuns.startedAt))
        .limit(limit);

      res.json({
        runs: rows.reverse().map(r => ({
          id: r.id,
          at: r.startedAt.toISOString(),
          score: num(r.score),
          openViolations: r.openViolations,
          costAtRisk: num(r.costAtRisk),
          domains: r.domainScores ?? [],
        })),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Policy catalog ──────────────────────────────────────────────────────────

  app.get('/api/governance/policies', async (_req: Request, res: Response) => {
    try {
      const orgId = currentOrgId();
      const assignments = await resolveAssignments();
      const views = await toAssignmentViews(assignments);

      const counts = await db
        .select({ policyKey: governanceViolations.policyKey, count: sql<number>`count(*)::int` })
        .from(governanceViolations)
        .where(and(
          eq(governanceViolations.organizationId, orgId),
          inArray(governanceViolations.status, ['open', 'acknowledged']),
        ))
        .groupBy(governanceViolations.policyKey);

      const byPolicy = new Map(counts.map(c => [c.policyKey, c.count]));

      const entries: PolicyCatalogEntry[] = assignments.map(a => ({
        descriptor: a.descriptor,
        assignment: views.get(a.descriptor.key)!,
        openViolations: byPolicy.get(a.descriptor.key) ?? 0,
      }));

      res.json({ policies: entries });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * Update one policy's assignment.
   *
   * Upserts rather than requiring the row to exist, because the common case is
   * the first change to a policy that has been running on catalog defaults.
   */
  app.put('/api/governance/policies/:key', async (req: Request, res: Response) => {
    try {
      const key = req.params.key;
      const policy = getPolicy(key);
      if (!policy) return res.status(404).json({ error: `Unknown policy "${key}"` });

      const { descriptor } = policy;
      const body = req.body ?? {};

      const enabled = body.enabled === undefined ? descriptor.defaultEnabled : body.enabled === true;

      const severity: PolicySeverity | null =
        body.severity === null || body.severity === undefined
          ? null
          : POLICY_SEVERITIES.includes(body.severity) ? body.severity : null;

      const enforcement: EnforcementMode =
        ENFORCEMENT_MODES.includes(body.enforcement) ? body.enforcement : descriptor.defaultEnforcement;

      const { parameters, errors } = validateParameters(descriptor, body.parameters);
      const scope = descriptor.supportsScope ? sanitizeScope(body.scope) : {};

      const orgId = currentOrgId();
      const userId = currentUserId() ?? null;

      await db
        .insert(governancePolicyAssignments)
        .values({
          organizationId: orgId,
          policyKey: key,
          enabled,
          severity,
          enforcement,
          parameters: parameters as any,
          scope: scope as any,
          updatedBy: userId,
        })
        .onConflictDoUpdate({
          target: [governancePolicyAssignments.organizationId, governancePolicyAssignments.policyKey],
          set: {
            enabled: sql`excluded.enabled`,
            severity: sql`excluded.severity`,
            enforcement: sql`excluded.enforcement`,
            parameters: sql`excluded.parameters`,
            scope: sql`excluded.scope`,
            updatedBy: sql`excluded.updated_by`,
            updatedAt: new Date(),
          },
        });

      // Changing a threshold changes what the organization reports as
      // compliant, which is exactly the kind of decision an audit asks about
      // months later. Record the resulting configuration, not just that an
      // edit happened.
      void recordAudit({
        action: 'governance.policy.update',
        resourceType: 'governance_policy',
        resourceId: key,
        metadata: {
          policy: descriptor.title,
          enabled,
          severity: severity ?? descriptor.severity,
          enforcement,
          parameters,
          scope: describeScope(scope),
        },
      });

      const assignments = await resolveAssignments();
      const views = await toAssignmentViews(assignments);
      res.json({ assignment: views.get(key), warnings: errors });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  /** Discard the tenant's customisation and fall back to catalog defaults. */
  app.post('/api/governance/policies/:key/reset', async (req: Request, res: Response) => {
    try {
      const key = req.params.key;
      const policy = getPolicy(key);
      if (!policy) return res.status(404).json({ error: `Unknown policy "${key}"` });

      await db.delete(governancePolicyAssignments).where(and(
        eq(governancePolicyAssignments.organizationId, currentOrgId()),
        eq(governancePolicyAssignments.policyKey, key),
      ));

      void recordAudit({
        action: 'governance.policy.reset',
        resourceType: 'governance_policy',
        resourceId: key,
        metadata: { policy: policy.descriptor.title },
      });

      const assignments = await resolveAssignments();
      const views = await toAssignmentViews(assignments);
      res.json({ assignment: views.get(key) });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Violations ──────────────────────────────────────────────────────────────

  app.get('/api/governance/violations', async (req: Request, res: Response) => {
    try {
      const orgId = currentOrgId();
      const limit = Math.min(Number(req.query.limit) || 200, 1000);

      const statusParam = String(req.query.status ?? 'open');
      const statuses: ViolationStatus[] =
        statusParam === 'all'
          ? [...VIOLATION_STATUSES]
          : statusParam === 'open'
            // "Open" in the UI means "still counts against you", which includes
            // findings a human has acknowledged but not yet fixed.
            ? ['open', 'acknowledged']
            : VIOLATION_STATUSES.includes(statusParam as ViolationStatus)
              ? [statusParam as ViolationStatus]
              : ['open', 'acknowledged'];

      const conditions = [
        eq(governanceViolations.organizationId, orgId),
        inArray(governanceViolations.status, statuses),
      ];

      if (req.query.policyKey) conditions.push(eq(governanceViolations.policyKey, String(req.query.policyKey)));
      if (req.query.provider) conditions.push(eq(governanceViolations.provider, String(req.query.provider)));
      if (req.query.accountId) conditions.push(eq(governanceViolations.accountId, String(req.query.accountId)));
      if (req.query.severity && POLICY_SEVERITIES.includes(String(req.query.severity) as PolicySeverity)) {
        conditions.push(eq(governanceViolations.severity, String(req.query.severity)));
      }
      if (req.query.domain) {
        const keys = POLICIES
          .filter(p => p.descriptor.domain === req.query.domain)
          .map(p => p.descriptor.key);
        conditions.push(keys.length ? inArray(governanceViolations.policyKey, keys) : sql`FALSE`);
      }

      const rows = await db
        .select()
        .from(governanceViolations)
        .where(and(...conditions))
        .orderBy(
          // Worst first, then most expensive. A critical finding on a $4
          // resource still outranks a medium one on a $4,000 cluster.
          sql`CASE severity
                WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2
                WHEN 'low' THEN 3 ELSE 4 END`,
          desc(governanceViolations.monthlyCostImpact),
        )
        .limit(limit);

      const assignments = await resolveAssignments();
      const enforcementByKey = new Map(assignments.map(a => [a.descriptor.key, a.enforcement]));
      const remediationByKey = new Map(assignments.map(a => [a.descriptor.key, a.descriptor.remediation]));

      const violations: ViolationView[] = rows.map(r => ({
        id: r.id,
        policyKey: r.policyKey,
        policyTitle: TITLES.get(r.policyKey) ?? r.policyKey,
        domain: (DOMAINS.get(r.policyKey) ?? 'cost') as ViolationView['domain'],
        severity: r.severity as PolicySeverity,
        enforcement: enforcementByKey.get(r.policyKey) ?? 'audit',
        status: r.status as ViolationStatus,
        provider: r.provider,
        accountId: r.accountId,
        region: r.region,
        resourceId: r.resourceId,
        resourceType: r.resourceType,
        resourceName: r.resourceName,
        title: r.title,
        detail: r.detail,
        remediation: remediationByKey.get(r.policyKey) ?? '',
        monthlyCostImpact: r.monthlyCostImpact != null ? num(r.monthlyCostImpact) : null,
        evidence: (r.evidence ?? null) as Record<string, unknown> | null,
        firstSeenAt: r.firstSeenAt.toISOString(),
        lastSeenAt: r.lastSeenAt.toISOString(),
        resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
      }));

      res.json({ violations, truncated: rows.length === limit });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * Acknowledge: "we have seen this and it is in hand".
   *
   * Deliberately does NOT suppress the finding or remove it from the score.
   * Suppression is what an exemption is for, and it costs a stated reason, an
   * expiry and a higher permission. Conflating the two is how every finding
   * ends up acknowledged and nothing ever gets fixed.
   */
  app.post('/api/governance/violations/:id/acknowledge', async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid violation id' });

      const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 2000) : null;

      const [updated] = await db
        .update(governanceViolations)
        .set({
          status: 'acknowledged',
          acknowledgedBy: currentUserId() ?? null,
          acknowledgedAt: new Date(),
          acknowledgeNote: note,
        })
        .where(and(
          eq(governanceViolations.organizationId, currentOrgId()),
          eq(governanceViolations.id, id),
          // Re-acknowledging something already resolved or exempted would
          // silently reopen it in the UI.
          inArray(governanceViolations.status, ['open', 'acknowledged']),
        ))
        .returning();

      if (!updated) return res.status(404).json({ error: 'No open violation with that id' });

      void recordAudit({
        action: 'governance.violation.acknowledge',
        resourceType: 'governance_violation',
        resourceId: String(id),
        metadata: { policyKey: updated.policyKey, title: updated.title, note },
      });

      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Exemptions ──────────────────────────────────────────────────────────────

  app.get('/api/governance/exemptions', async (_req: Request, res: Response) => {
    try {
      const orgId = currentOrgId();
      const [rows, userRows] = await Promise.all([
        db.select().from(governanceExemptions)
          .where(eq(governanceExemptions.organizationId, orgId))
          .orderBy(desc(governanceExemptions.createdAt)),
        db.select({ id: users.id, username: users.username }).from(users)
          .where(eq(users.organizationId, orgId)),
      ]);

      const names = new Map(userRows.map(u => [u.id, u.username]));
      const now = new Date();

      const exemptions: ExemptionView[] = rows.map(r => ({
        id: r.id,
        policyKey: r.policyKey,
        policyTitle: TITLES.get(r.policyKey) ?? r.policyKey,
        scope: sanitizeScope(r.scope),
        resourceId: r.resourceId,
        reason: r.reason,
        requestedByUsername: r.requestedBy !== null ? names.get(r.requestedBy) ?? null : null,
        approvedByUsername: r.approvedBy !== null ? names.get(r.approvedBy) ?? null : null,
        expiresAt: r.expiresAt.toISOString(),
        revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
        isActive: !r.revokedAt && r.expiresAt > now,
      }));

      res.json({ exemptions });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/governance/exemptions', async (req: Request, res: Response) => {
    try {
      const { policyKey, resourceId, reason, expiresInDays } = req.body ?? {};

      const policy = getPolicy(String(policyKey ?? ''));
      if (!policy) return res.status(400).json({ error: 'A known policyKey is required' });

      // The reason is the artefact. Without it an exemption is indistinguishable
      // from someone having silenced an alarm, and the database CHECK enforces
      // the same floor so this cannot be bypassed by another caller.
      const text = typeof reason === 'string' ? reason.trim() : '';
      if (text.length < 10) {
        return res.status(400).json({
          error: 'A reason of at least 10 characters is required. It is the record of who accepted this risk and why.',
        });
      }

      const days = Number(expiresInDays);
      if (!Number.isFinite(days) || days < 1 || days > MAX_EXEMPTION_DAYS) {
        return res.status(400).json({
          error: `expiresInDays must be between 1 and ${MAX_EXEMPTION_DAYS}. An exemption that never expires is a policy change nobody approved.`,
        });
      }

      const scope = sanitizeScope(req.body?.scope);
      const expiresAt = new Date(Date.now() + days * 86_400_000);
      const userId = currentUserId() ?? null;

      const [created] = await db
        .insert(governanceExemptions)
        .values({
          organizationId: currentOrgId(),
          policyKey: policy.descriptor.key,
          resourceId: typeof resourceId === 'string' && resourceId.trim() ? resourceId.trim().slice(0, 500) : null,
          scope: scope as any,
          reason: text.slice(0, 4000),
          requestedBy: userId,
          // Single-step today: the permission required to create one is the
          // approval. The column exists so a request/approve split can be added
          // without a migration once customers ask for it.
          approvedBy: userId,
          expiresAt,
        })
        .returning();

      void recordAudit({
        action: 'governance.exemption.grant',
        resourceType: 'governance_exemption',
        resourceId: String(created.id),
        metadata: {
          policyKey: policy.descriptor.key,
          policy: policy.descriptor.title,
          resourceId: created.resourceId,
          scope: describeScope(scope),
          reason: text.slice(0, 500),
          expiresAt: expiresAt.toISOString(),
          expiresInDays: days,
        },
      });

      // Findings already recorded stay 'open' until the next sweep reclassifies
      // them. Marking them here keeps the UI honest about what the exemption
      // just did.
      await db
        .update(governanceViolations)
        .set({ status: 'exempt' })
        .where(and(
          eq(governanceViolations.organizationId, currentOrgId()),
          eq(governanceViolations.policyKey, policy.descriptor.key),
          inArray(governanceViolations.status, ['open', 'acknowledged']),
          created.resourceId ? eq(governanceViolations.resourceId, created.resourceId) : sql`TRUE`,
        ));

      res.status(201).json({ exemption: created });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  /** Revoke, never delete: the record that the risk was once accepted must survive. */
  app.delete('/api/governance/exemptions/:id', async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid exemption id' });

      const [updated] = await db
        .update(governanceExemptions)
        .set({ revokedAt: new Date(), revokedBy: currentUserId() ?? null })
        .where(and(
          eq(governanceExemptions.organizationId, currentOrgId()),
          eq(governanceExemptions.id, id),
          isNull(governanceExemptions.revokedAt),
        ))
        .returning();

      if (!updated) return res.status(404).json({ error: 'No active exemption with that id' });

      void recordAudit({
        action: 'governance.exemption.revoke',
        resourceType: 'governance_exemption',
        resourceId: String(id),
        metadata: { policyKey: updated.policyKey, reason: updated.reason.slice(0, 500) },
      });

      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Framework coverage ──────────────────────────────────────────────────────

  /**
   * Which named controls this tenant's configuration actually covers.
   *
   * A control is only "compliant" if a policy claiming it is enabled AND has no
   * open findings. A control nobody monitors is reported as not-monitored — not
   * as compliant — because an unasked question is not a passed one, and that
   * distinction is the whole value of the view to an auditor.
   */
  app.get('/api/governance/frameworks', async (_req: Request, res: Response) => {
    try {
      const orgId = currentOrgId();
      const assignments = await resolveAssignments();
      const enabled = new Set(assignments.filter(a => a.enabled).map(a => a.descriptor.key));

      const counts = await db
        .select({ policyKey: governanceViolations.policyKey, count: sql<number>`count(*)::int` })
        .from(governanceViolations)
        .where(and(
          eq(governanceViolations.organizationId, orgId),
          inArray(governanceViolations.status, ['open', 'acknowledged']),
        ))
        .groupBy(governanceViolations.policyKey);
      const violationsByPolicy = new Map(counts.map(c => [c.policyKey, c.count]));

      const coverage: FrameworkCoverage[] = FRAMEWORKS.map(framework => {
        const byControl = new Map<string, string[]>();
        for (const { descriptor } of POLICIES) {
          for (const fc of descriptor.frameworks) {
            if (fc.framework !== framework) continue;
            byControl.set(fc.control, [...(byControl.get(fc.control) ?? []), descriptor.key]);
          }
        }

        const controls = Array.from(byControl.entries()).map(([control, policyKeys]) => {
          const enabledPolicies = policyKeys.filter(k => enabled.has(k));
          const violations = enabledPolicies.reduce((sum, k) => sum + (violationsByPolicy.get(k) ?? 0), 0);
          return {
            control,
            policyKeys,
            enabledPolicies: enabledPolicies.length,
            totalPolicies: policyKeys.length,
            violations,
            status: (enabledPolicies.length === 0
              ? 'not-monitored'
              : violations > 0 ? 'violations' : 'compliant') as 'compliant' | 'violations' | 'not-monitored',
          };
        }).sort((a, b) => a.control.localeCompare(b.control));

        return {
          framework,
          controls,
          monitoredControls: controls.filter(c => c.status !== 'not-monitored').length,
          compliantControls: controls.filter(c => c.status === 'compliant').length,
          totalControls: controls.length,
        };
      });

      res.json({ frameworks: coverage });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Run a sweep ─────────────────────────────────────────────────────────────

  app.post('/api/governance/evaluate', async (_req: Request, res: Response) => {
    try {
      const orgId = currentOrgId();
      const last = lastManualRun.get(orgId) ?? 0;
      const waited = Date.now() - last;
      if (waited < MANUAL_RUN_COOLDOWN_MS) {
        return res.status(429).json({
          error: 'A governance sweep ran moments ago.',
          retryAfterSeconds: Math.ceil((MANUAL_RUN_COOLDOWN_MS - waited) / 1000),
        });
      }
      lastManualRun.set(orgId, Date.now());

      const summary = await evaluateGovernance({ trigger: 'manual' });
      if (summary.status === 'failed') {
        return res.status(500).json({ error: summary.error ?? 'Evaluation failed', summary });
      }
      res.json(summary);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
