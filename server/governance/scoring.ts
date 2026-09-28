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
  /**
   * What fixing each policy would be worth, worst first.
   *
   * The finding COUNT does not answer this and never could: 14 failures out of
   * 20 examined is a 70% failure rate that dominates the score, while the same
   * 14 out of 3,000 is a rounding error. Both render as "14 findings". Without
   * the denominator no one — reader or author — can tell which they are looking
   * at, so the queue of work has to be guessed.
   */
  impacts: PolicyImpact[];
}

/** What one policy is doing to the score, and what fixing it would recover. */
export interface PolicyImpact {
  policyKey: string;
  domain: PolicyDomain;
  severity: PolicySeverity;
  /** Units examined. The denominator that makes the rest meaningful. */
  checked: number;
  /** Units in violation, after exemptions. */
  violating: number;
  /** violating / checked, clamped to [0,1]. */
  failRate: number;
  /**
   * Points the OVERALL score would gain if this policy were brought to zero
   * violations, holding everything else constant.
   *
   * Exact rather than a heuristic ranking. With
   *   score = 100 * (1 - Σ(wᵢ·gapᵢ) / Σwᵢ)
   * setting gap_P to zero removes exactly w_P·gap_P from the numerator, so
   *   gain_P = 100 · w_P · gap_P / Σw
   * Gains are therefore additive across policies, which is what lets the UI say
   * "fix these three and you reach 78".
   */
  potentialGain: number;
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

/**
 * Per-policy score impact.
 *
 * Shares the denominator with weightedScore deliberately — computing it from a
 * second, slightly different notion of "which policies count" is how the
 * headline score and the sum of its parts drift apart.
 */
function policyImpacts(outcomes: PolicyOutcome[]): PolicyImpact[] {
  const scorable = outcomes.filter(isScorable);
  if (scorable.length === 0) return [];

  let totalWeight = scorable.reduce((sum, o) => sum + SEVERITY_WEIGHT[o.severity], 0);
  let useEqualWeights = false;

  // Mirrors the fallback in weightedScore: when every scorable policy is
  // informational the score is computed on equal weights, so the impacts must
  // be too, or they would sum to something the score never moves by.
  if (totalWeight === 0) {
    totalWeight = scorable.length;
    useEqualWeights = true;
  }

  return scorable
    .map(o => {
      const weight = useEqualWeights ? 1 : SEVERITY_WEIGHT[o.severity];
      const failRate = gap(o);
      return {
        policyKey: o.policyKey,
        domain: o.domain,
        severity: o.severity,
        checked: o.checked,
        violating: o.violatingUnits,
        failRate: Math.round(failRate * 1000) / 1000,
        // Deliberately NOT rounded. Rounding each gain to one decimal and then
        // summing them accumulates the error: a running total over five rows
        // drifted far enough to promise a score the next run would not deliver.
        // The UI rounds for display; the model keeps the exact value so the
        // gains stay additive.
        potentialGain: 100 * weight * failRate / totalWeight,
      };
    })
    .filter(i => i.violating > 0)
    .sort((a, b) => b.potentialGain - a.potentialGain || b.violating - a.violating);
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
    impacts: policyImpacts(outcomes),
  };
}
