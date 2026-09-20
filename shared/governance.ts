/**
 * The governance vocabulary, shared by the server engine and the React client.
 *
 * Policy *definitions* live in server/governance/catalog.ts and are code, not
 * rows: a policy is an evaluation function, and shipping those as data would
 * mean either a rules DSL nobody can debug or arbitrary code in the database.
 * What a tenant owns is the *assignment* — enabled, parameters, scope,
 * severity, enforcement — which is exactly the part that must differ per
 * customer without a deploy.
 *
 * This file is imported by the browser, so it must stay free of server imports.
 */

// ── Severity ──────────────────────────────────────────────────────────────────

export const POLICY_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type PolicySeverity = (typeof POLICY_SEVERITIES)[number];

/**
 * Scoring weights. A posture score that treats an unencrypted database the same
 * as a missing cost-centre tag tells an executive nothing, so severity has to
 * carry real weight rather than just a colour.
 */
export const SEVERITY_WEIGHT: Record<PolicySeverity, number> = {
  critical: 10,
  high: 6,
  medium: 3,
  low: 1,
  info: 0,
};

export const SEVERITY_LABEL: Record<PolicySeverity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Informational',
};

// ── Domains ───────────────────────────────────────────────────────────────────

export const POLICY_DOMAINS = [
  'tagging',     // allocation hygiene: required keys, allowed values, coverage
  'cost',        // FinOps guardrails: budgets, commitments, waste, anomalies
  'security',    // posture of the cloud estate: residency, exposure, credentials
  'access',      // who can do what, inside Cloudwise and towards the clouds
  'operations',  // is the data we govern on actually trustworthy and fresh
] as const;
export type PolicyDomain = (typeof POLICY_DOMAINS)[number];

export const DOMAIN_LABEL: Record<PolicyDomain, string> = {
  tagging: 'Tagging & Allocation',
  cost: 'Cost Guardrails',
  security: 'Security & Residency',
  access: 'Access Governance',
  operations: 'Operational Assurance',
};

export const DOMAIN_DESCRIPTION: Record<PolicyDomain, string> = {
  tagging: 'Whether spend can be attributed to an owner, a team and a cost centre.',
  cost: 'Budgets, commitments, waste and anomalies — the financial control loop.',
  security: 'Where data lives, what is exposed, and how cloud credentials are held.',
  access: 'Privilege inside Cloudwise and the blast radius of the automation agent.',
  operations: 'Whether the estate is actually being observed, and how recently.',
};

// ── Enforcement ───────────────────────────────────────────────────────────────

/**
 * What a violation *does*, beyond appearing on a dashboard.
 *
 * `block` is the one that matters: it is consulted by the agent guardrails, so
 * a resource that violates a blocking policy cannot be the target of an
 * automated change until the violation is resolved or exempted. Governance that
 * only reports is a report, not governance.
 */
export const ENFORCEMENT_MODES = ['audit', 'warn', 'block'] as const;
export type EnforcementMode = (typeof ENFORCEMENT_MODES)[number];

export const ENFORCEMENT_LABEL: Record<EnforcementMode, string> = {
  audit: 'Audit only',
  warn: 'Warn & notify',
  block: 'Block changes',
};

export const ENFORCEMENT_DESCRIPTION: Record<EnforcementMode, string> = {
  audit: 'Record the violation. Nothing else changes.',
  warn: 'Record it and raise its severity in the governance digest.',
  block: 'Record it and refuse automated changes to the offending resource until it is fixed or exempted.',
};

// ── Violation lifecycle ───────────────────────────────────────────────────────

export const VIOLATION_STATUSES = ['open', 'acknowledged', 'exempt', 'resolved'] as const;
export type ViolationStatus = (typeof VIOLATION_STATUSES)[number];

// ── Parameters ────────────────────────────────────────────────────────────────

export type PolicyParameterType = 'number' | 'percent' | 'currency' | 'string' | 'boolean' | 'stringList';

export interface PolicyParameterSpec {
  key: string;
  label: string;
  type: PolicyParameterType;
  /** Shown under the control. Say what the number means, not what it is called. */
  help?: string;
  default: unknown;
  min?: number;
  max?: number;
  placeholder?: string;
  /** For stringList/string: offer these, but do not restrict to them. */
  suggestions?: string[];
}

// ── Scope ─────────────────────────────────────────────────────────────────────

/**
 * Narrows a policy to part of the estate. Empty means "everywhere", which is
 * the right default: a policy that silently applies to nothing is worse than no
 * policy, because it reads as a green tick.
 */
export interface PolicyScope {
  providers?: string[];
  accountIds?: string[];
  regions?: string[];
  /** Only resources carrying these tag key=value pairs. */
  includeTags?: Record<string, string>;
  /** Never flag these, whatever else matches. Prefer a time-boxed exemption. */
  excludeResourceIds?: string[];
}

export function isScopeEmpty(scope: PolicyScope | null | undefined): boolean {
  if (!scope) return true;
  return !(
    scope.providers?.length ||
    scope.accountIds?.length ||
    scope.regions?.length ||
    scope.excludeResourceIds?.length ||
    (scope.includeTags && Object.keys(scope.includeTags).length)
  );
}

// ── Framework mapping ─────────────────────────────────────────────────────────

/**
 * What an auditor asks for. The control identifiers let a policy result be
 * handed over as evidence against a named framework rather than as a screenshot
 * of a dashboard.
 */
export const FRAMEWORKS = [
  'FinOps Framework',
  'CIS Benchmarks',
  'ISO/IEC 27001',
  'SOC 2',
  'NIST CSF 2.0',
  'GDPR',
] as const;
export type Framework = (typeof FRAMEWORKS)[number];

export interface FrameworkControl {
  framework: Framework;
  /** e.g. 'CC6.1', 'A.8.10', 'PR.DS-01', 'Allocation'. */
  control: string;
}

// ── Policy descriptor (the catalog entry, safe to send to a browser) ──────────

export type PolicyTarget = 'aws' | 'azure' | 'gcp' | 'platform';

export interface PolicyDescriptor {
  key: string;
  title: string;
  domain: PolicyDomain;
  /** Catalog default; a tenant may raise or lower it. */
  severity: PolicySeverity;
  /** One sentence: what must be true. */
  description: string;
  /** Why an organization should care. Shown when the row is expanded. */
  rationale: string;
  /** What to do about a violation. Shown on every finding. */
  remediation: string;
  appliesTo: PolicyTarget[];
  parameters: PolicyParameterSpec[];
  frameworks: FrameworkControl[];
  /** False for platform self-checks, where provider/region scoping is meaningless. */
  supportsScope: boolean;
  /**
   * True when the policy does nothing until a parameter is filled in — a
   * residency allow-list, for example. The UI has to say so, or an unconfigured
   * policy looks like a passing one.
   */
  requiresConfiguration?: boolean;
  /** Off unless the tenant opts in. Used for policies that are noisy by default. */
  defaultEnabled: boolean;
  defaultEnforcement: EnforcementMode;
}

// ── Wire shapes shared with the client ────────────────────────────────────────

export interface PolicyAssignmentView {
  policyKey: string;
  enabled: boolean;
  severity: PolicySeverity;
  enforcement: EnforcementMode;
  parameters: Record<string, unknown>;
  scope: PolicyScope;
  updatedAt: string | null;
  updatedByUsername: string | null;
  /** True when nothing is stored and the catalog defaults are in force. */
  isDefault: boolean;
}

export interface PolicyCatalogEntry {
  descriptor: PolicyDescriptor;
  assignment: PolicyAssignmentView;
  /** Open violations attributed to this policy at the last evaluation. */
  openViolations: number;
}

export interface ViolationView {
  id: number;
  policyKey: string;
  policyTitle: string;
  domain: PolicyDomain;
  severity: PolicySeverity;
  enforcement: EnforcementMode;
  status: ViolationStatus;
  provider: string | null;
  accountId: string | null;
  region: string | null;
  resourceId: string | null;
  resourceType: string | null;
  resourceName: string | null;
  title: string;
  detail: string;
  remediation: string;
  monthlyCostImpact: number | null;
  evidence: Record<string, unknown> | null;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
}

export interface DomainScore {
  domain: PolicyDomain;
  score: number;
  policiesEvaluated: number;
  policiesPassing: number;
  violations: number;
}

/**
 * A policy that ran but reached no verdict, or failed outright.
 *
 * Carries the reason, not just the key. "5 policies not assessed" is a puzzle;
 * "Required tags: no ingested resource-level spend above $5/month to evaluate"
 * is an instruction. The title and domain are resolved server-side so the
 * browser never needs the catalog to render this.
 */
export interface NotAssessedPolicy {
  policyKey: string;
  title: string;
  domain: PolicyDomain;
  reason: string;
  /** True when the policy threw. A different problem from having no data. */
  failed: boolean;
}

export interface PostureSummary {
  score: number;
  grade: string;
  domains: DomainScore[];
  severityCounts: Record<PolicySeverity, number>;
  openViolations: number;
  exemptViolations: number;
  costAtRisk: number;
  policiesEnabled: number;
  policiesAvailable: number;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunError: string | null;
  /**
   * Policies that ran but reached no verdict, and policies that failed to run.
   * Surfaced beside the score because an unanswered question presented as a
   * green tick is the failure mode that makes posture dashboards fiction.
   */
  notAssessed: NotAssessedPolicy[];
}

export interface FrameworkCoverage {
  framework: Framework;
  controls: Array<{
    control: string;
    policyKeys: string[];
    enabledPolicies: number;
    totalPolicies: number;
    status: 'compliant' | 'violations' | 'not-monitored';
    violations: number;
  }>;
  monitoredControls: number;
  compliantControls: number;
  totalControls: number;
}

export interface ExemptionView {
  id: number;
  policyKey: string;
  policyTitle: string;
  scope: PolicyScope;
  resourceId: string | null;
  reason: string;
  requestedByUsername: string | null;
  approvedByUsername: string | null;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  /** Derived: expired exemptions stop suppressing findings without being deleted. */
  isActive: boolean;
}

// ── Grading ───────────────────────────────────────────────────────────────────

/** A letter is what gets repeated in a board deck; the number is what moves it. */
export function gradeForScore(score: number): string {
  if (score >= 95) return 'A';
  if (score >= 85) return 'B';
  if (score >= 70) return 'C';
  if (score >= 50) return 'D';
  return 'F';
}

/** Maximum time an exemption may suppress a finding, in days. */
export const MAX_EXEMPTION_DAYS = 365;
/** Default offered in the UI. Short enough that it gets revisited. */
export const DEFAULT_EXEMPTION_DAYS = 90;
