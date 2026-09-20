/**
 * Turning findings into a number somebody will act on.
 *
 * Three properties the scoring has to have, and each one rules out the obvious
 * simpler formula:
 *
 *   1. Severity dominates count. "47 violations" is not a worse posture than
 *      "1 unencrypted production database", so a raw count is useless.
 *      Severity weights make a critical worth ten low findings.
 *
 *   2. The denominator is real. A policy flagging 2 of 3 resources is failing;
 *      flagging 2 of 3,000 is a good day with two exceptions. Scoring on the
 *      violation rate rather than the violation count is what keeps a large
 *      estate from scoring worse than a small careless one.
 *
 *   3. Unknowns are not passes. A policy that could not run — no ingested data,
 *      an unconfigured allow-list, an evaluation error — is excluded from the
 *      score and reported separately. Folding it in as 100% would let a broken
 *      pipeline read as perfect compliance, which is the specific failure mode
 *      that makes posture dashboards untrustworthy.
 *
 * Everything here is pure, so scoring.test.ts can assert the shape of the curve
 * without a database.
 */
import {
  SEVERITY_WEIGHT,
  POLICY_DOMAINS,
  gradeForScore,
  type PolicyDomain,
  type PolicySeverity,
  type DomainScore,
} from "@shared/governance";

export interface PolicyOutcome {
  policyKey: string;
  domain: PolicyDomain;
  /** After any tenant override. */
  severity: PolicySeverity;
  /** Units the policy examined. Zero means it examined nothing. */
  checked: number;
  /** Units found in violation, after exemptions are subtracted. */
  violatingUnits: number;
  /** Findings suppressed by an active exemption. Accepted risk, not compliance. */
  exemptUnits: number;
  costAtRisk: number;
  /** Set when the policy reached no verdict. Excluded from the score. */
  inconclusive?: string;
  /** Set when the policy threw. Excluded from the score, surfaced loudly. */
  error?: string;
}

/**
 * Why a policy contributed nothing.
 *
 * The reason travels with the key because "5 policies not assessed" is a puzzle
 * for whoever reads the dashboard, and "no ingested spend above $5/month" is an
 * instruction.
 */
export interface UnassessedPolicy {
  policyKey: string;
  domain: PolicyDomain;
  reason: string;
  /** True when the policy threw. A different problem from having no data. */
  failed: boolean;
}

export interface ScoreResult {
  score: number;
  grade: string;
  domains: DomainScore[];
  /** Policies excluded from the score, each with the reason it was excluded. */
  notAssessed: UnassessedPolicy[];
  /** Keys of the subset that failed outright. Kept for the run's failure count. */
  failed: string[];
  costAtRisk: number;
}

/** A policy contributes to the score only if it actually looked at something. */
function isScorable(o: PolicyOutcome): boolean {
  return !o.error && !o.inconclusive && o.checked > 0;
}

/**
 * Fraction of the policy's population that is in violation, clamped to [0,1].
 *
 * Clamping matters: a policy may legitimately emit more findings than `checked`
 * when one unit produces several distinct problems (the platform-hardening
 * check does exactly this), and a gap above 1 would drag the whole score
 * negative.
 */
function gap(o: PolicyOutcome): number {
  if (o.checked <= 0) return 0;
  return Math.min(1, o.violatingUnits / o.checked);
}

function weightedScore(outcomes: PolicyOutcome[]): number {
  const scorable = outcomes.filter(isScorable);
  if (scorable.length === 0) return 100;

  // Informational policies carry weight zero by design: they report without
  // moving the number, which is the whole point of marking something as
  // informational.
  let totalWeight = 0;
  let weightedGap = 0;

  for (const o of scorable) {
    const weight = SEVERITY_WEIGHT[o.severity];
    totalWeight += weight;
    weightedGap += weight * gap(o);
  }

  // Everything in scope is informational. Returning 100 here would report a
  // wholly failing set of checks as perfect, so fall back to equal weights and
  // let the result reflect what was actually found.
  if (totalWeight === 0) {
    totalWeight = scorable.length;
    weightedGap = scorable.reduce((sum, o) => sum + gap(o), 0);
  }

  const score = 100 * (1 - weightedGap / totalWeight);
  return Math.max(0, Math.min(100, Math.round(score * 10) / 10));
}

export function scorePolicies(outcomes: PolicyOutcome[]): ScoreResult {
  const domains: DomainScore[] = POLICY_DOMAINS.map(domain => {
    const inDomain = outcomes.filter(o => o.domain === domain);
    const scorable = inDomain.filter(isScorable);
    return {
      domain,
      score: weightedScore(inDomain),
      policiesEvaluated: scorable.length,
      policiesPassing: scorable.filter(o => o.violatingUnits === 0).length,
      violations: inDomain.reduce((sum, o) => sum + o.violatingUnits, 0),
    };
  });

  return {
    score: weightedScore(outcomes),
    grade: gradeForScore(weightedScore(outcomes)),
    domains,
    notAssessed: outcomes
      .filter(o => o.error || o.inconclusive || o.checked === 0)
      .map(o => ({
        policyKey: o.policyKey,
        domain: o.domain,
        reason: o.error
          ? `Evaluation failed: ${o.error}`
          : o.inconclusive ?? 'The policy found nothing in scope to examine.',
        failed: !!o.error,
      })),
    failed: outcomes.filter(o => o.error).map(o => o.policyKey),
    costAtRisk: outcomes.reduce((sum, o) => sum + o.costAtRisk, 0),
  };
}
