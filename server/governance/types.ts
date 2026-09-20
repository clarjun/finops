/**
 * The contract between the governance engine and a policy.
 *
 * A policy is a pure function of a preloaded dataset. It does not touch the
 * database, does not know which tenant it is running for, and does not decide
 * whether its findings are suppressed, scored or blocked — the engine owns all
 * of that. That separation is what makes the catalog testable without a
 * database and what stops a policy from accidentally reading across tenants.
 */
import type {
  PolicyDescriptor,
  PolicyScope,
  PolicySeverity,
} from "@shared/governance";

// ── The dataset every policy shares ───────────────────────────────────────────

/** Spend aggregated per resource over the evaluation window. */
export interface ResourceSpend {
  provider: string;
  accountId: string;
  accountName: string | null;
  region: string | null;
  serviceName: string;
  serviceCategory: string | null;
  resourceId: string | null;
  resourceName: string | null;
  tags: Record<string, string>;
  /** Effective cost over the window, normalised to 30 days. */
  monthlyCost: number;
  /** Raw effective cost over the window, exactly as summed. */
  windowCost: number;
  hasCommitment: boolean;
}

export interface AccountSpend {
  provider: string;
  accountId: string;
  accountName: string | null;
  monthlyCost: number;
  windowCost: number;
  /** Spend that carried no tags at all. */
  untaggedCost: number;
}

export interface InventoryResource {
  provider: string;
  accountId: string;
  resourceId: string;
  resourceType: string;
  resourceName: string | null;
  region: string | null;
  state: string | null;
  size: string | null;
  monthlyCost: number;
  utilizationPercent: number | null;
  tags: Record<string, string>;
  metadata: Record<string, unknown>;
  lastSeenAt: Date;
}

export interface ConnectedAccount {
  id: number;
  provider: string;
  accountId: string;
  accountName: string;
  isActive: boolean;
  authType: string;
  /** Access-key connections age; role-based ones do not. */
  credentialsUpdatedAt: Date;
  lastSyncAt: Date | null;
  lastValidatedAt: Date | null;
  lastValidationError: string | null;
}

export interface BudgetRecord {
  id: number;
  name: string;
  provider: string | null;
  accountId: string | null;
  amount: number;
  period: string;
  isActive: boolean;
  hasEmailRecipients: boolean;
  hasWebhook: boolean;
  hasThresholds: boolean;
}

export interface AnomalyRecord {
  id: number;
  provider: string;
  accountId: string;
  serviceName: string | null;
  severity: string;
  status: string;
  detectedAt: Date;
  expectedCost: number;
  actualCost: number;
}

export interface PlatformUser {
  id: number;
  username: string;
  email: string | null;
  role: string;
  isActive: boolean;
  isPlatformAdmin: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export interface AgentSafety {
  autoExecuteEnabled: boolean;
  safetyMode: boolean;
  dryRunMode: boolean;
  maxCostImpactWithoutApproval: number;
}

export interface IngestionFreshness {
  provider: string;
  accountId: string | null;
  lastSuccessAt: Date | null;
  lastStatus: string | null;
}

/**
 * Facts about the Cloudwise deployment itself.
 *
 * Collected once by the engine rather than read from `process.env` inside a
 * policy, so the platform self-checks are testable by handing them a struct.
 */
export interface PlatformPosture {
  nodeEnv: string;
  /** True when SESSION_SECRET is absent or still the shipped development value. */
  sessionSecretIsDefault: boolean;
  sessionSecretLength: number;
  /** True when DATABASE_URL asks for TLS (or targets localhost, where it is moot). */
  databaseTlsEnforced: boolean;
  /** True when ENCRYPTION_KEY is configured, so cloud credentials are encrypted at rest. */
  credentialEncryptionConfigured: boolean;
  /** Whether the hardening middlewares are installed in this process. */
  securityHeadersEnabled: boolean;
  rateLimitEnabled: boolean;
  csrfProtectionEnabled: boolean;
  /** Cookies are only marked Secure when NODE_ENV is production. */
  secureCookies: boolean;
}

export interface GovernanceDataset {
  /** Days of cost data the aggregates cover. */
  lookbackDays: number;
  windowStart: Date;
  windowEnd: Date;
  resourceSpend: ResourceSpend[];
  accountSpend: AccountSpend[];
  totalMonthlySpend: number;
  inventory: InventoryResource[];
  accounts: ConnectedAccount[];
  budgets: BudgetRecord[];
  anomalies: AnomalyRecord[];
  users: PlatformUser[];
  agent: AgentSafety | null;
  ingestion: IngestionFreshness[];
  platform: PlatformPosture;
  /** Spend covered by a commitment discount, and spend eligible for one. */
  commitment: { coveredMonthlyCost: number; eligibleMonthlyCost: number };
}

// ── What a policy receives and returns ────────────────────────────────────────

export interface EvaluationInput {
  /** Catalog defaults already merged with the tenant's overrides. */
  parameters: Record<string, unknown>;
  scope: PolicyScope;
  now: Date;
  data: GovernanceDataset;
}

export interface Finding {
  /**
   * Identity of the thing being flagged, stable across runs and unique within
   * the policy. Usually a resource id or an account id — never a timestamp, or
   * every sweep would open a new finding for the same problem.
   */
  key: string;
  title: string;
  detail: string;
  provider?: string | null;
  accountId?: string | null;
  region?: string | null;
  resourceId?: string | null;
  resourceType?: string | null;
  resourceName?: string | null;
  /** Spend this finding puts at risk, or that it would release if fixed. */
  monthlyCostImpact?: number | null;
  evidence?: Record<string, unknown>;
  /** Escalate a single finding above the policy's severity (e.g. by cost). */
  severity?: PolicySeverity;
}

export interface PolicyResult {
  /**
   * How many units the policy examined. Drives per-policy compliance: a policy
   * that flags 2 of 400 resources is not as broken as one that flags 2 of 3.
   * Zero means there was nothing to examine, which scores as neither pass nor
   * fail.
   */
  checked: number;
  findings: Finding[];
  /**
   * Set when the policy could not reach a verdict — no ingested data, an
   * unconfigured allow-list. Must not be scored as compliant: a check that did
   * not run is an unknown, and reporting unknowns as green is how posture
   * dashboards become fiction.
   */
  inconclusive?: string;
}

export interface PolicyDefinition {
  descriptor: PolicyDescriptor;
  evaluate(input: EvaluationInput): PolicyResult;
}

// ── Parameter access ──────────────────────────────────────────────────────────
//
// Parameters arrive from JSONB and from HTTP bodies, so they are `unknown`
// until proven otherwise. These readers coerce and clamp rather than throw: a
// malformed stored parameter should degrade a single policy to its default, not
// fail the whole sweep.

export function numberParam(params: Record<string, unknown>, key: string, fallback: number): number {
  const raw = params[key];
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

export function boolParam(params: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const raw = params[key];
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return fallback;
}

export function stringParam(params: Record<string, unknown>, key: string, fallback: string): string {
  const raw = params[key];
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : fallback;
}

export function listParam(params: Record<string, unknown>, key: string, fallback: string[] = []): string[] {
  const raw = params[key];
  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map(v => v.trim());
  }
  // Tolerate the comma-separated form, because that is what people paste.
  if (typeof raw === 'string') {
    return raw.split(',').map(v => v.trim()).filter(Boolean);
  }
  return fallback;
}
