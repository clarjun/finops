/**
 * Assembles the dataset every policy in a sweep shares.
 *
 * Loaded once per run, not once per policy. Twenty policies each running their
 * own scan of cost_facts would be twenty full table scans for one dashboard
 * refresh, and the aggregates they need are almost identical. Aggregation
 * happens in Postgres for the same reason it does in ingestion/queries.ts: a
 * few million rows a month does not belong in a Node heap.
 *
 * Every query is filtered on currentOrgId(). A policy therefore cannot see
 * another tenant's estate even if it wanted to, because it never issues a query
 * at all.
 */
import { and, eq, gte, sql, desc } from "drizzle-orm";
import { db } from "../db";
import {
  costFacts,
  resourceInventory,
  cloudAccounts,
  budgets,
  anomalyEvents,
  users,
  agentConfig,
  ingestionRuns,
} from "@shared/schema";
import { currentOrgId } from "../tenant-context";
import { inspectDatabaseUrl } from "../db-url";
import type {
  GovernanceDataset,
  ResourceSpend,
  AccountSpend,
  InventoryResource,
  ConnectedAccount,
  BudgetRecord,
  AnomalyRecord,
  PlatformUser,
  AgentSafety,
  IngestionFreshness,
  PlatformPosture,
} from "./types";

/** The session secret shipped in server/index.ts for local development. */
const DEV_SESSION_SECRET = 'dev-secret-change-in-production';

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
};

const asTags = (v: unknown): Record<string, string> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val === null || val === undefined) continue;
    const s = String(val);
    // A tag key present with an empty value is how "untagged" usually looks in
    // a provider export, and treating it as present would defeat the point of
    // the required-tags policy.
    if (s.trim() === '') continue;
    out[k] = s;
  }
  return out;
};

const asRecord = (v: unknown): Record<string, unknown> =>
  (v && typeof v === 'object' && !Array.isArray(v)) ? (v as Record<string, unknown>) : {};

/**
 * Flags set by server/index.ts once the corresponding middleware is installed.
 *
 * Read from a module-level register rather than from process.env so the
 * platform-hardening policy reports what this process is *actually* doing, not
 * what a configuration file claims it should be doing.
 */
const installed = {
  securityHeaders: false,
  rateLimit: false,
  csrf: false,
};

export function markSecurityMiddlewareInstalled(which: 'securityHeaders' | 'rateLimit' | 'csrf'): void {
  installed[which] = true;
}

export function readPlatformPosture(): PlatformPosture {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const secret = process.env.SESSION_SECRET ?? '';
  const encryptionKey = process.env.ENCRYPTION_KEY ?? '';

  let databaseTlsEnforced = false;
  try {
    const url = process.env.DATABASE_URL;
    if (url) {
      const verdict = inspectDatabaseUrl(url);
      // Local plaintext is not a finding: the traffic never leaves the machine.
      databaseTlsEnforced = !verdict.insecure;
    }
  } catch {
    // An unparseable URL is a configuration error the boot check already
    // reports; here it simply means we cannot claim TLS is enforced.
    databaseTlsEnforced = false;
  }

  return {
    nodeEnv,
    sessionSecretIsDefault: secret === '' || secret === DEV_SESSION_SECRET,
    sessionSecretLength: secret.length,
    databaseTlsEnforced,
    credentialEncryptionConfigured: encryptionKey.length >= 32,
    securityHeadersEnabled: installed.securityHeaders,
    rateLimitEnabled: installed.rateLimit,
    csrfProtectionEnabled: installed.csrf,
    secureCookies: nodeEnv === 'production',
  };
}

// ── Cost aggregates ───────────────────────────────────────────────────────────

/**
 * Resource-level spend over the window.
 *
 * Grouped by resource rather than returned row by row, and capped: a policy
 * that needs to reason about individual resources needs the expensive ones, and
 * the tail below a dollar a month cannot change any verdict it would reach.
 *
 * Tags are taken from the most recent charge for the resource. A resource that
 * was tagged yesterday should not read as untagged because it was untagged for
 * the first three weeks of the window.
 */
const RESOURCE_ROW_LIMIT = 20_000;

async function loadResourceSpend(orgId: number, start: Date, end: Date, windowDays: number): Promise<ResourceSpend[]> {
  const rows = await db.execute(sql`
    WITH latest_tags AS (
      SELECT DISTINCT ON (provider, sub_account_id, resource_id)
             provider, sub_account_id, resource_id, tags, commitment_discount_id
        FROM cost_facts
       WHERE organization_id = ${orgId}
         AND charge_period_start >= ${start}
         AND charge_period_start <= ${end}
         AND resource_id IS NOT NULL
       ORDER BY provider, sub_account_id, resource_id, charge_period_start DESC
    )
    SELECT f.provider,
           f.sub_account_id                                     AS account_id,
           MAX(f.sub_account_name)                              AS account_name,
           MAX(f.region_id)                                     AS region,
           MAX(f.service_name)                                  AS service_name,
           MAX(f.service_category)                              AS service_category,
           f.resource_id,
           MAX(f.resource_name)                                 AS resource_name,
           SUM(COALESCE(f.effective_cost, f.billed_cost))       AS window_cost,
           BOOL_OR(f.commitment_discount_id IS NOT NULL)        AS has_commitment,
           MAX(t.tags::text)                                    AS tags_json
      FROM cost_facts f
      LEFT JOIN latest_tags t
        ON t.provider = f.provider
       AND t.sub_account_id = f.sub_account_id
       AND t.resource_id = f.resource_id
     WHERE f.organization_id = ${orgId}
       AND f.charge_period_start >= ${start}
       AND f.charge_period_start <= ${end}
       AND f.resource_id IS NOT NULL
       AND f.charge_category <> 'Tax'
     GROUP BY f.provider, f.sub_account_id, f.resource_id
     ORDER BY window_cost DESC
     LIMIT ${RESOURCE_ROW_LIMIT}
  `);

  const scale = windowDays > 0 ? 30 / windowDays : 1;

  return (rows.rows as any[]).map((r): ResourceSpend => {
    const windowCost = num(r.window_cost);
    let tags: Record<string, string> = {};
    if (typeof r.tags_json === 'string' && r.tags_json.trim() !== '') {
      try { tags = asTags(JSON.parse(r.tags_json)); } catch { tags = {}; }
    } else if (r.tags_json) {
      tags = asTags(r.tags_json);
    }
    return {
      provider: String(r.provider),
      accountId: String(r.account_id),
      accountName: r.account_name ?? null,
      region: r.region ?? null,
      serviceName: r.service_name ?? 'Unknown',
      serviceCategory: r.service_category ?? null,
      resourceId: r.resource_id ?? null,
      resourceName: r.resource_name ?? null,
      tags,
      monthlyCost: windowCost * scale,
      windowCost,
      hasCommitment: r.has_commitment === true,
    };
  });
}

/**
 * Account-level spend, including the untagged share.
 *
 * Computed independently of the resource aggregate rather than summed from it,
 * because the resource aggregate is capped and excludes charges with no
 * resource id — support, marketplace, data transfer. Those are real spend and
 * must not silently vanish from an account total the CFO reads.
 */
async function loadAccountSpend(orgId: number, start: Date, end: Date, windowDays: number): Promise<AccountSpend[]> {
  const rows = await db.execute(sql`
    SELECT provider,
           sub_account_id                                   AS account_id,
           MAX(sub_account_name)                            AS account_name,
           SUM(COALESCE(effective_cost, billed_cost))       AS window_cost,
           SUM(CASE
                 WHEN tags IS NULL OR tags::text IN ('{}', 'null') THEN COALESCE(effective_cost, billed_cost)
                 ELSE 0
               END)                                          AS untagged_cost
      FROM cost_facts
     WHERE organization_id = ${orgId}
       AND charge_period_start >= ${start}
       AND charge_period_start <= ${end}
       AND charge_category <> 'Tax'
     GROUP BY provider, sub_account_id
  `);

  const scale = windowDays > 0 ? 30 / windowDays : 1;

  return (rows.rows as any[]).map((r): AccountSpend => ({
    provider: String(r.provider),
    accountId: String(r.account_id),
    accountName: r.account_name ?? null,
    monthlyCost: num(r.window_cost) * scale,
    windowCost: num(r.window_cost),
    untaggedCost: num(r.untagged_cost) * scale,
  }));
}

/**
 * Commitment coverage over compute-like spend.
 *
 * "Eligible" is approximated as the Compute service category, which is where
 * reservations and savings plans actually apply on all three providers. It is
 * an approximation, and the policy says so in its evidence rather than
 * presenting a precise-looking number it cannot defend.
 */
async function loadCommitment(orgId: number, start: Date, end: Date, windowDays: number) {
  const rows = await db.execute(sql`
    SELECT SUM(COALESCE(effective_cost, billed_cost))                                              AS eligible,
           SUM(CASE WHEN commitment_discount_id IS NOT NULL
                    THEN COALESCE(effective_cost, billed_cost) ELSE 0 END)                         AS covered
      FROM cost_facts
     WHERE organization_id = ${orgId}
       AND charge_period_start >= ${start}
       AND charge_period_start <= ${end}
       AND charge_category = 'Usage'
       AND service_category = 'Compute'
  `);

  const scale = windowDays > 0 ? 30 / windowDays : 1;
  const row = (rows.rows as any[])[0] ?? {};
  return {
    eligibleMonthlyCost: num(row.eligible) * scale,
    coveredMonthlyCost: num(row.covered) * scale,
  };
}

// ── Everything else ───────────────────────────────────────────────────────────

async function loadInventory(orgId: number, since: Date): Promise<InventoryResource[]> {
  const rows = await db
    .select()
    .from(resourceInventory)
    .where(and(
      eq(resourceInventory.organizationId, orgId),
      // A resource not seen in a fortnight has almost certainly been deleted.
      // Governing over it produces findings nobody can act on.
      gte(resourceInventory.lastSeenAt, since),
    ))
    .limit(RESOURCE_ROW_LIMIT);

  return rows.map((r): InventoryResource => ({
    provider: r.provider,
    accountId: r.accountId,
    resourceId: r.resourceId,
    resourceType: r.resourceType,
    resourceName: r.resourceName,
    region: r.region,
    state: r.state,
    size: r.size,
    monthlyCost: num(r.monthlyCost),
    utilizationPercent: r.utilizationPercent === null ? null : num(r.utilizationPercent),
    tags: asTags(r.tags),
    metadata: asRecord(r.metadata),
    lastSeenAt: r.lastSeenAt,
  }));
}

async function loadAccounts(orgId: number): Promise<ConnectedAccount[]> {
  const rows = await db.select().from(cloudAccounts).where(eq(cloudAccounts.organizationId, orgId));
  return rows.map((a): ConnectedAccount => ({
    id: a.id,
    provider: a.provider,
    accountId: a.accountId,
    accountName: a.accountName,
    isActive: a.isActive,
    authType: a.authType,
    // updatedAt moves whenever the credential is re-saved, which is the closest
    // signal we have to "when was this key last rotated". It over-reports
    // freshness if an unrelated field is edited; it never under-reports, so it
    // cannot produce a false rotation alarm.
    credentialsUpdatedAt: a.updatedAt,
    lastSyncAt: a.lastSyncAt,
    lastValidatedAt: a.lastValidatedAt,
    lastValidationError: a.lastValidationError,
  }));
}

async function loadBudgets(orgId: number): Promise<BudgetRecord[]> {
  const rows = await db.select().from(budgets).where(eq(budgets.organizationId, orgId));
  return rows.map((b): BudgetRecord => {
    const thresholds = b.alertThresholds;
    const hasThresholds =
      !!thresholds && typeof thresholds === 'object' &&
      Object.values(thresholds as Record<string, unknown>).some(v => v === true || v === 1);
    return {
      id: b.id,
      name: b.budgetName,
      provider: b.provider,
      accountId: b.accountId,
      amount: num(b.amount),
      period: b.period,
      isActive: b.isActive,
      hasEmailRecipients: !!b.emailRecipients && b.emailRecipients.trim().length > 0,
      hasWebhook: !!b.webhookUrl && b.webhookUrl.trim().length > 0,
      hasThresholds,
    };
  });
}

async function loadAnomalies(orgId: number, since: Date): Promise<AnomalyRecord[]> {
  const rows = await db
    .select()
    .from(anomalyEvents)
    .where(and(eq(anomalyEvents.organizationId, orgId), gte(anomalyEvents.detectedAt, since)))
    .orderBy(desc(anomalyEvents.detectedAt))
    .limit(2000);

  return rows.map((a): AnomalyRecord => ({
    id: a.id,
    provider: a.provider,
    accountId: a.accountId,
    serviceName: a.serviceName,
    severity: a.severity,
    status: a.status ?? 'active',
    detectedAt: a.detectedAt,
    expectedCost: num(a.expectedCost),
    actualCost: num(a.actualCost),
  }));
}

async function loadUsers(orgId: number): Promise<PlatformUser[]> {
  const rows = await db.select().from(users).where(eq(users.organizationId, orgId));
  return rows.map((u): PlatformUser => ({
    id: u.id,
    username: u.username,
    email: u.email,
    role: u.role,
    isActive: u.isActive,
    isPlatformAdmin: u.isPlatformAdmin,
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
  }));
}

async function loadAgentSafety(orgId: number): Promise<AgentSafety | null> {
  const [row] = await db.select().from(agentConfig).where(eq(agentConfig.organizationId, orgId)).limit(1);
  if (!row) return null;
  return {
    autoExecuteEnabled: row.autoExecuteEnabled === 1,
    safetyMode: row.safetyMode === 1,
    dryRunMode: row.dryRunMode === 1,
    maxCostImpactWithoutApproval: num(row.maxCostImpactWithoutApproval),
  };
}

async function loadIngestion(orgId: number): Promise<IngestionFreshness[]> {
  const rows = await db.execute(sql`
    SELECT provider,
           MAX(CASE WHEN status IN ('success', 'partial') THEN finished_at END) AS last_success_at,
           (ARRAY_AGG(status ORDER BY started_at DESC))[1]                      AS last_status
      FROM ingestion_runs
     WHERE organization_id = ${orgId}
     GROUP BY provider
  `);

  return (rows.rows as any[]).map((r): IngestionFreshness => ({
    provider: String(r.provider),
    accountId: null,
    lastSuccessAt: r.last_success_at ? new Date(r.last_success_at) : null,
    lastStatus: r.last_status ?? null,
  }));
}

// ── Entry point ───────────────────────────────────────────────────────────────

export interface DatasetOptions {
  lookbackDays?: number;
  now?: Date;
}

/** How far back cost aggregates reach. A month smooths weekly usage cycles. */
const DEFAULT_LOOKBACK_DAYS = 30;
/** Inventory older than this is assumed deleted rather than merely unscanned. */
const INVENTORY_STALE_DAYS = 14;
/** Anomalies older than this are history, not an open triage queue. */
const ANOMALY_WINDOW_DAYS = 90;

export async function loadDataset(options: DatasetOptions = {}): Promise<GovernanceDataset> {
  const orgId = currentOrgId();
  const now = options.now ?? new Date();
  const lookbackDays = options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const windowStart = new Date(now.getTime() - lookbackDays * 86_400_000);
  const inventorySince = new Date(now.getTime() - INVENTORY_STALE_DAYS * 86_400_000);
  const anomalySince = new Date(now.getTime() - ANOMALY_WINDOW_DAYS * 86_400_000);

  // Sequential, NOT Promise.all.
  //
  // The parallel version deadlocked against the connection pool: ten concurrent
  // queries here, plus the connection the scheduler's advisory lock holds for
  // the duration of the tick, exceeds the default PGPOOL_MAX of 10. The eleventh
  // query waits for a connection that cannot be released until it completes, and
  // the tick dies with "Connection terminated due to connection timeout".
  //
  // Even with a larger pool this should stay sequential. The pool is shared with
  // live HTTP traffic, and a background sweep that seizes every connection makes
  // every dashboard request queue behind it. A sweep runs every six hours and
  // nobody is waiting on it — latency here is free, starvation is not.
  const resourceSpend = await loadResourceSpend(orgId, windowStart, now, lookbackDays);
  const accountSpend = await loadAccountSpend(orgId, windowStart, now, lookbackDays);
  const commitment = await loadCommitment(orgId, windowStart, now, lookbackDays);
  const inventory = await loadInventory(orgId, inventorySince);
  const accounts = await loadAccounts(orgId);
  const budgetRows = await loadBudgets(orgId);
  const anomalies = await loadAnomalies(orgId, anomalySince);
  const userRows = await loadUsers(orgId);
  const agent = await loadAgentSafety(orgId);
  const ingestion = await loadIngestion(orgId);

  return {
    lookbackDays,
    windowStart,
    windowEnd: now,
    resourceSpend,
    accountSpend,
    totalMonthlySpend: accountSpend.reduce((sum, a) => sum + a.monthlyCost, 0),
    inventory,
    accounts,
    budgets: budgetRows,
    anomalies,
    users: userRows,
    agent,
    ingestion,
    platform: readPlatformPosture(),
    commitment,
  };
}
