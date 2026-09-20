/**
 * The built-in policy catalog.
 *
 * Every policy here answers a question an organization has already been asked
 * by somebody — an auditor, a CFO, a security review — and can answer from data
 * Cloudwise already holds. Nothing in this file calls a cloud API or the
 * database: policies are pure functions over the dataset assembled in
 * ./data.ts, which is what makes them unit-testable and what guarantees they
 * cannot leak across tenants.
 *
 * Adding a policy is: write the descriptor, write evaluate(), append to
 * POLICIES. The engine, the API, the scoring and the UI pick it up with no
 * further changes — the catalog is the single source of truth, and
 * catalog.test.ts asserts the structural invariants that keeps true.
 *
 * Two rules for authors:
 *
 *   1. `checked` must be the real denominator. Reporting 3 findings out of 3
 *      resources is a crisis; 3 out of 3000 is a Tuesday. Scoring needs both.
 *   2. When a policy cannot reach a verdict — no ingested data yet, an
 *      allow-list nobody has filled in — return `inconclusive`. Never return
 *      zero findings, because that renders as a green tick over an unanswered
 *      question.
 */
import type { PolicyDescriptor } from "@shared/governance";
import {
  type PolicyDefinition,
  type EvaluationInput,
  type PolicyResult,
  type Finding,
  numberParam,
  listParam,
  stringParam,
} from "./types";
import { filterByScope, tagValue } from "./scope";

// ── Small shared helpers ──────────────────────────────────────────────────────

const money = (n: number): string =>
  n >= 1000 ? `$${Math.round(n).toLocaleString('en-US')}` : `$${n.toFixed(2)}`;

const pct = (n: number): string => `${n.toFixed(1)}%`;

const daysBetween = (later: Date, earlier: Date): number =>
  Math.floor((later.getTime() - earlier.getTime()) / 86_400_000);

const hoursBetween = (later: Date, earlier: Date): number =>
  Math.floor((later.getTime() - earlier.getTime()) / 3_600_000);

/**
 * Findings are capped per policy. One misconfigured tagging standard across a
 * 50,000-resource estate would otherwise write 50,000 rows every sweep, and the
 * 501st identical finding tells an operator nothing the first 500 did not.
 * The omitted count is reported on the summary finding so the cap is visible
 * rather than silent.
 */
const MAX_FINDINGS_PER_POLICY = 500;

function capped(findings: Finding[]): Finding[] {
  if (findings.length <= MAX_FINDINGS_PER_POLICY) return findings;
  const kept = findings.slice(0, MAX_FINDINGS_PER_POLICY);
  const omitted = findings.length - kept.length;
  kept.push({
    key: '__truncated__',
    title: `${omitted.toLocaleString('en-US')} further violations not listed individually`,
    detail:
      `This policy matched ${findings.length.toLocaleString('en-US')} resources. The first ` +
      `${MAX_FINDINGS_PER_POLICY} are listed individually; the rest are counted here. ` +
      `Narrow the policy scope, or fix the pattern rather than the instances.`,
    evidence: { totalViolations: findings.length, listed: MAX_FINDINGS_PER_POLICY, omitted },
  });
  return kept;
}

// Severity escalation by blast radius. A missing tag on a $3/month bucket and
// on a $40,000/month cluster are not the same finding.
function escalateByCost(monthlyCost: number, threshold: number): 'high' | undefined {
  return monthlyCost >= threshold ? 'high' : undefined;
}

// ══════════════════════════════════════════════════════════════════════════════
// Tagging & allocation
// ══════════════════════════════════════════════════════════════════════════════

const requiredTags: PolicyDefinition = {
  descriptor: {
    key: 'tagging.required-tags',
    title: 'Required tags present on billable resources',
    domain: 'tagging',
    severity: 'medium',
    description: 'Every resource generating meaningful spend carries the organization’s mandatory tag keys.',
    rationale:
      'Untagged spend cannot be charged back, cannot be attributed to an owner when it spikes, and cannot ' +
      'be safely optimized — nobody knows who to ask before turning it off. This is the single policy ' +
      'that most determines whether every other FinOps practice is possible.',
    remediation:
      'Apply the missing tag keys at the source — in the IaC template or the account’s tag policy — ' +
      'rather than by hand, or the same resources reappear next month.',
    appliesTo: ['aws', 'azure', 'gcp'],
    parameters: [
      {
        key: 'requiredTags',
        label: 'Mandatory tag keys',
        type: 'stringList',
        default: ['Environment', 'Owner', 'CostCenter'],
        help: 'Matched case-insensitively, so Environment and environment both satisfy the rule.',
        suggestions: ['Environment', 'Owner', 'CostCenter', 'Application', 'Team', 'Project', 'DataClassification'],
      },
      {
        key: 'minMonthlyCost',
        label: 'Ignore resources under',
        type: 'currency',
        default: 5,
        min: 0,
        help: 'Keeps the finding list about spend that matters instead of every $0.02 log stream.',
      },
    ],
    frameworks: [
      { framework: 'FinOps Framework', control: 'Allocation' },
      { framework: 'FinOps Framework', control: 'Managing Shared Cost' },
      { framework: 'ISO/IEC 27001', control: 'A.5.9 Inventory of information and other associated assets' },
      { framework: 'NIST CSF 2.0', control: 'ID.AM-01' },
    ],
    supportsScope: true,
    defaultEnabled: true,
    defaultEnforcement: 'audit',
  },

  evaluate({ parameters, scope, data }: EvaluationInput): PolicyResult {
    const required = listParam(parameters, 'requiredTags', ['Environment', 'Owner', 'CostCenter']);
    const floor = numberParam(parameters, 'minMonthlyCost', 5);

    if (required.length === 0) {
      return { checked: 0, findings: [], inconclusive: 'No mandatory tag keys configured.' };
    }

    const candidates = filterByScope(data.resourceSpend, scope)
      .filter(r => r.resourceId && r.monthlyCost >= floor);

    if (candidates.length === 0) {
      return {
        checked: 0,
        findings: [],
        inconclusive: `No ingested resource-level spend above ${money(floor)}/month to evaluate.`,
      };
    }

    const findings: Finding[] = [];
    for (const r of candidates) {
      const missing = required.filter(key => {
        const v = tagValue(r.tags, key);
        return v === undefined || v.trim() === '';
      });
      if (missing.length === 0) continue;

      findings.push({
        key: `${r.provider}:${r.accountId}:${r.resourceId}`,
        title: `${r.resourceName ?? r.resourceId} is missing ${missing.join(', ')}`,
        detail:
          `${money(r.monthlyCost)}/month of ${r.serviceName} spend in ${r.accountName ?? r.accountId} ` +
          `cannot be allocated: the tag${missing.length === 1 ? '' : 's'} ${missing.join(', ')} ` +
          `${missing.length === 1 ? 'is' : 'are'} absent.`,
        provider: r.provider,
        accountId: r.accountId,
        region: r.region,
        resourceId: r.resourceId,
        resourceName: r.resourceName,
        monthlyCostImpact: r.monthlyCost,
        evidence: { missingTags: missing, presentTags: Object.keys(r.tags), service: r.serviceName },
        severity: escalateByCost(r.monthlyCost, 1000),
      });
    }

    return { checked: candidates.length, findings: capped(findings) };
  },
};

const allowedTagValues: PolicyDefinition = {
  descriptor: {
    key: 'tagging.allowed-values',
    title: 'Controlled tag values',
    domain: 'tagging',
    severity: 'low',
    description: 'A governed tag key only ever carries a value from the approved list.',
    rationale:
      'A tag key with 40 spellings of "production" is the same as no tag at all. Free-text values are why ' +
      'allocation reports never reconcile and why "show me non-production spend" returns the wrong number.',
    remediation:
      'Correct the value on the listed resources, then enforce the vocabulary upstream with an AWS tag ' +
      'policy, Azure Policy or a GCP organization policy so drift cannot recur.',
    appliesTo: ['aws', 'azure', 'gcp'],
    parameters: [
      { key: 'tagKey', label: 'Tag key to govern', type: 'string', default: 'Environment', placeholder: 'Environment' },
      {
        key: 'allowedValues',
        label: 'Approved values',
        type: 'stringList',
        default: ['production', 'staging', 'development', 'sandbox'],
        help: 'Compared case-insensitively. A resource with no such tag is handled by the required-tags policy, not this one.',
      },
      { key: 'minMonthlyCost', label: 'Ignore resources under', type: 'currency', default: 5, min: 0 },
    ],
    frameworks: [
      { framework: 'FinOps Framework', control: 'Allocation' },
      { framework: 'FinOps Framework', control: 'Data Analysis and Showback' },
    ],
    supportsScope: true,
    defaultEnabled: true,
    defaultEnforcement: 'audit',
  },

  evaluate({ parameters, scope, data }: EvaluationInput): PolicyResult {
    const key = stringParam(parameters, 'tagKey', 'Environment');
    const allowed = listParam(parameters, 'allowedValues');
    const floor = numberParam(parameters, 'minMonthlyCost', 5);

    if (allowed.length === 0) {
      return { checked: 0, findings: [], inconclusive: `No approved values configured for "${key}".` };
    }

    const allowedFold = new Set(allowed.map(v => v.toLowerCase()));
    // Only resources that actually carry the key. Absence is the required-tags
    // policy's business; flagging it twice doubles the noise for one problem.
    const tagged = filterByScope(data.resourceSpend, scope)
      .filter(r => r.resourceId && r.monthlyCost >= floor && tagValue(r.tags, key) !== undefined);

    if (tagged.length === 0) {
      return { checked: 0, findings: [], inconclusive: `No resources carry the "${key}" tag yet.` };
    }

    const findings: Finding[] = [];
    for (const r of tagged) {
      const value = (tagValue(r.tags, key) ?? '').trim();
      if (value === '' || allowedFold.has(value.toLowerCase())) continue;

      findings.push({
        key: `${r.provider}:${r.accountId}:${r.resourceId}:${key}`,
        title: `${key}="${value}" is not an approved value`,
        detail:
          `${r.resourceName ?? r.resourceId} in ${r.accountName ?? r.accountId} is tagged ${key}="${value}". ` +
          `Approved values are ${allowed.join(', ')}. ${money(r.monthlyCost)}/month reports under the wrong bucket.`,
        provider: r.provider,
        accountId: r.accountId,
        region: r.region,
        resourceId: r.resourceId,
        resourceName: r.resourceName,
        monthlyCostImpact: r.monthlyCost,
        evidence: { tagKey: key, actualValue: value, allowedValues: allowed },
      });
    }

    return { checked: tagged.length, findings: capped(findings) };
  },
};

const untaggedSpendCeiling: PolicyDefinition = {
  descriptor: {
    key: 'tagging.untagged-spend-ceiling',
    title: 'Unallocated spend below the agreed ceiling',
    domain: 'tagging',
    severity: 'high',
    description: 'The share of each account’s spend that carries no tags stays under the agreed limit.',
    rationale:
      'This is the number a FinOps practice is graded on. Per-resource findings tell an engineer what to fix; ' +
      'this tells a leadership team whether the practice is winning, per account, in one figure.',
    remediation:
      'Work the largest untagged resources first — unallocated spend is almost always concentrated in a ' +
      'handful of services rather than spread evenly.',
    appliesTo: ['aws', 'azure', 'gcp'],
    parameters: [
      { key: 'maxUntaggedPercent', label: 'Maximum unallocated spend', type: 'percent', default: 10, min: 0, max: 100 },
      {
        key: 'minAccountMonthlyCost',
        label: 'Ignore accounts under',
        type: 'currency',
        default: 100,
        min: 0,
        help: 'A sandbox with $12 of spend does not need an allocation programme.',
      },
    ],
    frameworks: [
      { framework: 'FinOps Framework', control: 'Allocation' },
      { framework: 'FinOps Framework', control: 'Data Analysis and Showback' },
    ],
    supportsScope: true,
    defaultEnabled: true,
    defaultEnforcement: 'warn',
  },

  evaluate({ parameters, scope, data }: EvaluationInput): PolicyResult {
    const ceiling = numberParam(parameters, 'maxUntaggedPercent', 10);
    const floor = numberParam(parameters, 'minAccountMonthlyCost', 100);

    const accounts = filterByScope(data.accountSpend, scope).filter(a => a.monthlyCost >= floor);
    if (accounts.length === 0) {
      return { checked: 0, findings: [], inconclusive: `No account has more than ${money(floor)}/month of ingested spend.` };
    }

    const findings: Finding[] = [];
    for (const a of accounts) {
      const share = a.monthlyCost > 0 ? (a.untaggedCost / a.monthlyCost) * 100 : 0;
      if (share <= ceiling) continue;

      findings.push({
        key: `${a.provider}:${a.accountId}`,
        title: `${pct(share)} of ${a.accountName ?? a.accountId} is unallocated`,
        detail:
          `${money(a.untaggedCost)}/month of ${money(a.monthlyCost)} carries no tags at all — ` +
          `${pct(share)} against a ceiling of ${pct(ceiling)}.`,
        provider: a.provider,
        accountId: a.accountId,
        resourceType: 'account',
        resourceName: a.accountName,
        monthlyCostImpact: a.untaggedCost,
        evidence: {
          untaggedMonthlyCost: Math.round(a.untaggedCost * 100) / 100,
          totalMonthlyCost: Math.round(a.monthlyCost * 100) / 100,
          untaggedPercent: Math.round(share * 10) / 10,
          ceilingPercent: ceiling,
        },
        // A majority-unallocated account is a different class of problem from
        // one that is a few points over.
        severity: share >= 50 ? 'critical' : undefined,
      });
    }

    return { checked: accounts.length, findings };
  },
};

const allocationCoverage: PolicyDefinition = {
  descriptor: {
    key: 'tagging.allocation-coverage',
    title: 'Chargeback key covers the estate',
    domain: 'tagging',
    severity: 'medium',
    description: 'Spend attributable to the nominated chargeback dimension stays above the coverage floor.',
    rationale:
      'Showback needs tags to exist; chargeback needs one specific key to be present nearly everywhere. ' +
      'Below roughly 90% coverage the unattributed remainder gets socialised across teams, and the ' +
      'chargeback model loses credibility with the teams paying for it.',
    remediation:
      'Backfill the chargeback key on the largest uncovered resources, and add it to the mandatory tag set ' +
      'so new resources cannot be created without it.',
    appliesTo: ['aws', 'azure', 'gcp'],
    parameters: [
      { key: 'allocationKey', label: 'Chargeback tag key', type: 'string', default: 'CostCenter' },
      { key: 'minCoveragePercent', label: 'Minimum coverage', type: 'percent', default: 90, min: 0, max: 100 },
    ],
    frameworks: [
      { framework: 'FinOps Framework', control: 'Chargeback and Finance Integration' },
      { framework: 'SOC 2', control: 'CC3.2' },
    ],
    supportsScope: true,
    defaultEnabled: false,
    defaultEnforcement: 'audit',
  },

  evaluate({ parameters, scope, data }: EvaluationInput): PolicyResult {
    const key = stringParam(parameters, 'allocationKey', 'CostCenter');
    const floorPercent = numberParam(parameters, 'minCoveragePercent', 90);

    const rows = filterByScope(data.resourceSpend, scope);
    const total = rows.reduce((sum, r) => sum + r.monthlyCost, 0);
    if (total <= 0) {
      return { checked: 0, findings: [], inconclusive: 'No ingested spend in scope to evaluate coverage against.' };
    }

    const covered = rows
      .filter(r => (tagValue(r.tags, key) ?? '').trim() !== '')
      .reduce((sum, r) => sum + r.monthlyCost, 0);
    const coverage = (covered / total) * 100;

    if (coverage >= floorPercent) return { checked: rows.length, findings: [] };

    const uncovered = total - covered;
    return {
      checked: rows.length,
      findings: [{
        key: `coverage:${key}`,
        title: `${key} covers only ${pct(coverage)} of spend`,
        detail:
          `${money(uncovered)}/month of ${money(total)} carries no ${key} tag, against a floor of ` +
          `${pct(floorPercent)}. That remainder cannot be charged back and has to be socialised.`,
        resourceType: 'allocation',
        monthlyCostImpact: uncovered,
        evidence: {
          allocationKey: key,
          coveragePercent: Math.round(coverage * 10) / 10,
          requiredPercent: floorPercent,
          uncoveredMonthlyCost: Math.round(uncovered * 100) / 100,
        },
      }],
    };
  },
};

// ══════════════════════════════════════════════════════════════════════════════
// Cost guardrails
// ══════════════════════════════════════════════════════════════════════════════

const accountBudgetRequired: PolicyDefinition = {
  descriptor: {
    key: 'cost.account-budget-required',
    title: 'Every spending account has a budget',
    domain: 'cost',
    severity: 'high',
    description: 'Each account with material spend is covered by an active budget.',
    rationale:
      'An account with no budget has no threshold to breach, so nothing ever fires. Overspend in an ' +
      'unbudgeted account is discovered on the invoice, which is between one and thirty days too late.',
    remediation: 'Create a budget covering the account, or a provider-wide budget if the account is genuinely small.',
    appliesTo: ['aws', 'azure', 'gcp'],
    parameters: [
      { key: 'minMonthlyCost', label: 'Require a budget above', type: 'currency', default: 100, min: 0 },
    ],
    frameworks: [
      { framework: 'FinOps Framework', control: 'Budgeting' },
      { framework: 'FinOps Framework', control: 'Forecasting' },
      { framework: 'SOC 2', control: 'CC3.1' },
    ],
    supportsScope: true,
    defaultEnabled: true,
    defaultEnforcement: 'warn',
  },

  evaluate({ parameters, scope, data }: EvaluationInput): PolicyResult {
    const floor = numberParam(parameters, 'minMonthlyCost', 100);
    const accounts = filterByScope(data.accountSpend, scope).filter(a => a.monthlyCost >= floor);

    if (accounts.length === 0) {
      return { checked: 0, findings: [], inconclusive: `No account exceeds ${money(floor)}/month.` };
    }

    const active = data.budgets.filter(b => b.isActive);
    const findings: Finding[] = [];

    for (const a of accounts) {
      // A budget with no account and no provider is estate-wide and covers
      // everything; a provider budget covers every account in that provider.
      const covered = active.some(b =>
        (b.accountId === null || b.accountId === a.accountId) &&
        (b.provider === null || b.provider.toLowerCase() === a.provider.toLowerCase())
      );
      if (covered) continue;

      findings.push({
        key: `${a.provider}:${a.accountId}`,
        title: `${a.accountName ?? a.accountId} has no budget`,
        detail:
          `${money(a.monthlyCost)}/month of ${a.provider.toUpperCase()} spend is not covered by any active ` +
          `budget, so no threshold alert can fire for it.`,
        provider: a.provider,
        accountId: a.accountId,
        resourceType: 'account',
        resourceName: a.accountName,
        monthlyCostImpact: a.monthlyCost,
        evidence: { monthlyCost: Math.round(a.monthlyCost * 100) / 100, activeBudgets: active.length },
      });
    }

    return { checked: accounts.length, findings };
  },
};

const budgetNotificationRequired: PolicyDefinition = {
  descriptor: {
    key: 'cost.budget-notification-required',
    title: 'Budgets can actually reach somebody',
    domain: 'cost',
    severity: 'medium',
    description: 'Every active budget has both alert thresholds and a delivery channel configured.',
    rationale:
      'A budget with no recipients is a number in a database. The control only exists at the moment somebody ' +
      'is told, and this is the check that finds budgets which were configured once and then quietly orphaned ' +
      'when their owner left.',
    remediation: 'Add email recipients or a Teams/Slack webhook, and at least one threshold, to the listed budgets.',
    appliesTo: ['aws', 'azure', 'gcp'],
    parameters: [],
    frameworks: [
      { framework: 'FinOps Framework', control: 'Budgeting' },
      { framework: 'SOC 2', control: 'CC7.2' },
    ],
    supportsScope: false,
    defaultEnabled: true,
    defaultEnforcement: 'audit',
  },

  evaluate({ data }: EvaluationInput): PolicyResult {
    const active = data.budgets.filter(b => b.isActive);
    if (active.length === 0) {
      return { checked: 0, findings: [], inconclusive: 'No active budgets are configured.' };
    }

    const findings: Finding[] = [];
    for (const b of active) {
      const problems: string[] = [];
      if (!b.hasEmailRecipients && !b.hasWebhook) problems.push('no email recipients or webhook');
      if (!b.hasThresholds) problems.push('no alert thresholds');
      if (problems.length === 0) continue;

      findings.push({
        key: `budget:${b.id}`,
        title: `Budget "${b.name}" cannot notify anyone`,
        detail:
          `The ${b.period} budget of ${money(b.amount)} has ${problems.join(' and ')}. ` +
          `It will be breached silently.`,
        provider: b.provider,
        accountId: b.accountId,
        resourceType: 'budget',
        resourceId: String(b.id),
        resourceName: b.name,
        evidence: { problems, amount: b.amount, period: b.period },
      });
    }

    return { checked: active.length, findings };
  },
};

const idleResourceWaste: PolicyDefinition = {
  descriptor: {
    key: 'cost.idle-resource-waste',
    title: 'Idle resources are not left running',
    domain: 'cost',
    severity: 'medium',
    description: 'Resources below the utilization floor are not accumulating cost indefinitely.',
    rationale:
      'Idle capacity is the cheapest saving available — no negotiation, no architecture change, no risk ' +
      'to a running workload. It is also the saving most often lost to nobody owning the decision, which is ' +
      'why this is a policy with a threshold rather than a recommendation in a list.',
    remediation:
      'Stop, right-size, schedule or delete the resource. Where it is genuinely needed idle, record a ' +
      'time-boxed exemption stating why, so the next review does not re-litigate it.',
    appliesTo: ['aws', 'azure', 'gcp'],
    parameters: [
      { key: 'maxUtilizationPercent', label: 'Idle below', type: 'percent', default: 5, min: 0, max: 100 },
      { key: 'minMonthlyCost', label: 'Only flag above', type: 'currency', default: 25, min: 0 },
    ],
    frameworks: [
      { framework: 'FinOps Framework', control: 'Workload Optimization' },
      { framework: 'FinOps Framework', control: 'Cloud Sustainability' },
    ],
    supportsScope: true,
    defaultEnabled: true,
    defaultEnforcement: 'audit',
  },

  evaluate({ parameters, scope, data }: EvaluationInput): PolicyResult {
    const maxUtil = numberParam(parameters, 'maxUtilizationPercent', 5);
    const floor = numberParam(parameters, 'minMonthlyCost', 25);

    const candidates = filterByScope(data.inventory, scope).filter(r => r.monthlyCost >= floor);
    if (candidates.length === 0) {
      return { checked: 0, findings: [], inconclusive: 'No inventoried resources above the cost floor. Run a resource inventory sync first.' };
    }

    const findings: Finding[] = [];
    for (const r of candidates) {
      const idleByState = (r.state ?? '').toLowerCase() === 'idle';
      const idleByUtil = r.utilizationPercent !== null && r.utilizationPercent <= maxUtil;
      if (!idleByState && !idleByUtil) continue;

      const reason = idleByUtil
        ? `${pct(r.utilizationPercent ?? 0)} utilization against an idle threshold of ${pct(maxUtil)}`
        : 'reported idle by the provider';

      findings.push({
        key: `${r.provider}:${r.accountId}:${r.resourceId}`,
        title: `${r.resourceName ?? r.resourceId} is idle at ${money(r.monthlyCost)}/month`,
        detail: `${r.resourceType} in ${r.region ?? 'an unknown region'}: ${reason}.`,
        provider: r.provider,
        accountId: r.accountId,
        region: r.region,
        resourceId: r.resourceId,
        resourceType: r.resourceType,
        resourceName: r.resourceName,
        monthlyCostImpact: r.monthlyCost,
        evidence: {
          utilizationPercent: r.utilizationPercent,
          state: r.state,
          size: r.size,
          thresholdPercent: maxUtil,
        },
        severity: escalateByCost(r.monthlyCost, 2000),
      });
    }

    return { checked: candidates.length, findings: capped(findings) };
  },
};

const commitmentCoverage: PolicyDefinition = {
  descriptor: {
    key: 'cost.commitment-coverage',
    title: 'Commitment coverage above the floor',
    domain: 'cost',
    severity: 'medium',
    description: 'Enough steady-state compute spend is covered by reservations or savings plans.',
    rationale:
      'Steady-state workloads paid at on-demand rates are a standing 20-40% overpayment. A coverage floor ' +
      'turns "we should look at savings plans" into a measurable control with an owner and a number.',
    remediation:
      'Review the commitment recommendations for the uncovered baseline. Buy to the floor, not to 100% — ' +
      'over-commitment is the more expensive mistake.',
    appliesTo: ['aws', 'azure', 'gcp'],
    parameters: [
      { key: 'minCoveragePercent', label: 'Minimum coverage', type: 'percent', default: 60, min: 0, max: 100 },
      { key: 'minEligibleMonthlyCost', label: 'Only assess above', type: 'currency', default: 500, min: 0 },
    ],
    frameworks: [
      { framework: 'FinOps Framework', control: 'Rate Optimization' },
      { framework: 'FinOps Framework', control: 'Managing Commitment Based Discounts' },
    ],
    supportsScope: false,
    defaultEnabled: true,
    defaultEnforcement: 'audit',
  },

  evaluate({ parameters, data }: EvaluationInput): PolicyResult {
    const floorPercent = numberParam(parameters, 'minCoveragePercent', 60);
    const minEligible = numberParam(parameters, 'minEligibleMonthlyCost', 500);
    const { coveredMonthlyCost, eligibleMonthlyCost } = data.commitment;

    if (eligibleMonthlyCost < minEligible) {
      return {
        checked: 0,
        findings: [],
        inconclusive:
          `Commitment-eligible spend is ${money(eligibleMonthlyCost)}/month, below the ${money(minEligible)} ` +
          `threshold at which a commitment is worth the lock-in.`,
      };
    }

    const coverage = (coveredMonthlyCost / eligibleMonthlyCost) * 100;
    if (coverage >= floorPercent) return { checked: 1, findings: [] };

    // What buying up to the floor would save, at a conservative 25% discount.
    const gapSpend = eligibleMonthlyCost * ((floorPercent - coverage) / 100);
    return {
      checked: 1,
      findings: [{
        key: 'commitment:coverage',
        title: `Commitment coverage is ${pct(coverage)}, below the ${pct(floorPercent)} floor`,
        detail:
          `${money(coveredMonthlyCost)} of ${money(eligibleMonthlyCost)}/month of eligible compute is covered. ` +
          `Reaching the floor would move about ${money(gapSpend)}/month off on-demand rates, worth roughly ` +
          `${money(gapSpend * 0.25)}/month at a conservative discount.`,
        resourceType: 'commitment',
        monthlyCostImpact: Math.round(gapSpend * 0.25 * 100) / 100,
        evidence: {
          coveragePercent: Math.round(coverage * 10) / 10,
          requiredPercent: floorPercent,
          coveredMonthlyCost: Math.round(coveredMonthlyCost * 100) / 100,
          eligibleMonthlyCost: Math.round(eligibleMonthlyCost * 100) / 100,
        },
      }],
    };
  },
};

const anomalyReviewSla: PolicyDefinition = {
  descriptor: {
    key: 'cost.anomaly-review-sla',
    title: 'Cost anomalies are triaged within the SLA',
    domain: 'cost',
    severity: 'high',
    description: 'No detected cost anomaly stays unresolved past the agreed review window.',
    rationale:
      'Detection without triage is theatre. An anomaly open for three weeks has either been silently accepted ' +
      'as the new baseline or has been forgotten; either way the detector has stopped being a control.',
    remediation: 'Resolve the anomaly, or record why the new level is expected so the baseline can move deliberately.',
    appliesTo: ['aws', 'azure', 'gcp'],
    parameters: [
      { key: 'maxOpenDays', label: 'Triage within', type: 'number', default: 7, min: 1, max: 365, help: 'Days before an unresolved anomaly is a violation.' },
      { key: 'minDeviationCost', label: 'Only track anomalies above', type: 'currency', default: 50, min: 0, help: 'Difference between actual and expected spend.' },
    ],
    frameworks: [
      { framework: 'FinOps Framework', control: 'Anomaly Management' },
      { framework: 'NIST CSF 2.0', control: 'DE.AE-02' },
      { framework: 'SOC 2', control: 'CC7.3' },
    ],
    supportsScope: true,
    defaultEnabled: true,
    defaultEnforcement: 'warn',
  },

  evaluate({ parameters, scope, now, data }: EvaluationInput): PolicyResult {
    const maxDays = numberParam(parameters, 'maxOpenDays', 7);
    const minDeviation = numberParam(parameters, 'minDeviationCost', 50);

    const open = filterByScope(data.anomalies, scope)
      .filter(a => a.status !== 'resolved' && Math.abs(a.actualCost - a.expectedCost) >= minDeviation);

    if (data.anomalies.length === 0) {
      return { checked: 0, findings: [], inconclusive: 'No anomalies have been detected in this window.' };
    }

    const findings: Finding[] = [];
    for (const a of open) {
      const age = daysBetween(now, a.detectedAt);
      if (age <= maxDays) continue;

      const delta = a.actualCost - a.expectedCost;
      findings.push({
        key: `anomaly:${a.id}`,
        title: `Anomaly in ${a.serviceName ?? a.provider.toUpperCase()} open for ${age} days`,
        detail:
          `Detected ${age} days ago in ${a.accountId} with ${money(a.actualCost)} against an expected ` +
          `${money(a.expectedCost)} (${delta >= 0 ? '+' : ''}${money(delta)}). The review SLA is ${maxDays} days.`,
        provider: a.provider,
        accountId: a.accountId,
        resourceType: 'anomaly',
        resourceId: String(a.id),
        resourceName: a.serviceName,
        monthlyCostImpact: delta > 0 ? delta : null,
        evidence: {
          ageDays: age,
          slaDays: maxDays,
          status: a.status,
          expectedCost: a.expectedCost,
          actualCost: a.actualCost,
        },
        severity: age > maxDays * 3 ? 'critical' : undefined,
      });
    }

    return { checked: open.length, findings };
  },
};

const restrictedService: PolicyDefinition = {
  descriptor: {
    key: 'cost.restricted-service',
    title: 'Only approved cloud services are in use',
    domain: 'cost',
    severity: 'medium',
    description: 'No spend appears on services the organization has not approved.',
    rationale:
      'Unapproved services arrive without a security review, without a cost model and without anyone on the ' +
      'team who can operate them. Catching them at the first invoice line is far cheaper than catching them ' +
      'during an incident.',
    remediation:
      'Either approve the service through the normal review and add it to the list, or migrate the workload ' +
      'and remove the spend.',
    appliesTo: ['aws', 'azure', 'gcp'],
    parameters: [
      {
        key: 'restrictedServices',
        label: 'Restricted services',
        type: 'stringList',
        default: [],
        help: 'Matched as a case-insensitive substring of the billed service name, so "SageMaker" catches every SageMaker line.',
        suggestions: ['SageMaker', 'Bedrock', 'Redshift', 'Snowball', 'Outposts', 'Global Accelerator'],
      },
      { key: 'minMonthlyCost', label: 'Ignore spend under', type: 'currency', default: 1, min: 0 },
    ],
    frameworks: [
      { framework: 'FinOps Framework', control: 'Cloud Policy and Governance' },
      { framework: 'ISO/IEC 27001', control: 'A.5.23 Information security for use of cloud services' },
      { framework: 'SOC 2', control: 'CC6.8' },
    ],
    supportsScope: true,
    requiresConfiguration: true,
    defaultEnabled: false,
    defaultEnforcement: 'warn',
  },

  evaluate({ parameters, scope, data }: EvaluationInput): PolicyResult {
    const restricted = listParam(parameters, 'restrictedServices');
    const floor = numberParam(parameters, 'minMonthlyCost', 1);

    if (restricted.length === 0) {
      return { checked: 0, findings: [], inconclusive: 'No restricted services configured, so nothing is being checked.' };
    }

    const rows = filterByScope(data.resourceSpend, scope);
    if (rows.length === 0) {
      return { checked: 0, findings: [], inconclusive: 'No ingested spend in scope.' };
    }

    // Group by (account, service): the finding is "this account is using
    // SageMaker", not one row per notebook instance.
    const grouped = new Map<string, { provider: string; accountId: string; accountName: string | null; service: string; match: string; cost: number; resources: number }>();
    const needles = restricted.map(s => s.toLowerCase());

    for (const r of rows) {
      const service = r.serviceName.toLowerCase();
      const hit = needles.find(n => service.includes(n));
      if (!hit) continue;

      const k = `${r.provider}:${r.accountId}:${r.serviceName}`;
      const entry = grouped.get(k) ?? {
        provider: r.provider, accountId: r.accountId, accountName: r.accountName,
        service: r.serviceName, match: hit, cost: 0, resources: 0,
      };
      entry.cost += r.monthlyCost;
      entry.resources += 1;
      grouped.set(k, entry);
    }

    const findings: Finding[] = [];
    for (const [key, g] of grouped) {
      if (g.cost < floor) continue;
      findings.push({
        key,
        title: `Restricted service ${g.service} in use`,
        detail:
          `${g.accountName ?? g.accountId} is spending ${money(g.cost)}/month on ${g.service} across ` +
          `${g.resources} billed item${g.resources === 1 ? '' : 's'}. It matches the restricted entry "${g.match}".`,
        provider: g.provider,
        accountId: g.accountId,
        resourceType: 'service',
        resourceName: g.service,
        monthlyCostImpact: g.cost,
        evidence: { matchedRule: g.match, billedItems: g.resources, monthlyCost: Math.round(g.cost * 100) / 100 },
      });
    }

    return { checked: rows.length, findings };
  },
};

// ══════════════════════════════════════════════════════════════════════════════
// Security & residency
// ══════════════════════════════════════════════════════════════════════════════

const dataResidency: PolicyDefinition = {
  descriptor: {
    key: 'security.data-residency',
    title: 'Workloads stay inside approved regions',
    domain: 'security',
    severity: 'critical',
    description: 'No spend or resource appears outside the approved region list.',
    rationale:
      'Region is where a data-protection obligation becomes concrete. For a GDPR, sovereignty or ' +
      'contractual-residency commitment, a single resource in the wrong region is a reportable breach of the ' +
      'commitment — and it usually arrives as a default-region deployment nobody reviewed.',
    remediation:
      'Migrate or delete the out-of-region resources, then enforce the boundary with an SCP, Azure Policy ' +
      'or GCP organization policy so a default region cannot recreate the problem.',
    appliesTo: ['aws', 'azure', 'gcp'],
    parameters: [
      {
        key: 'allowedRegions',
        label: 'Approved regions',
        type: 'stringList',
        default: [],
        help: 'Leave empty and the policy reports as unconfigured rather than as passing.',
        suggestions: ['us-east-1', 'us-west-2', 'eu-west-1', 'eu-central-1', 'westeurope', 'northeurope', 'europe-west1', 'ap-southeast-2'],
      },
      { key: 'minMonthlyCost', label: 'Ignore spend under', type: 'currency', default: 0, min: 0 },
    ],
    frameworks: [
      { framework: 'GDPR', control: 'Art. 44 – 45 International transfers' },
      { framework: 'ISO/IEC 27001', control: 'A.5.31 Legal, statutory and contractual requirements' },
      { framework: 'NIST CSF 2.0', control: 'GV.OC-03' },
      { framework: 'SOC 2', control: 'CC6.7' },
    ],
    supportsScope: true,
    requiresConfiguration: true,
    defaultEnabled: false,
    defaultEnforcement: 'block',
  },

  evaluate({ parameters, scope, data }: EvaluationInput): PolicyResult {
    const allowed = listParam(parameters, 'allowedRegions');
    const floor = numberParam(parameters, 'minMonthlyCost', 0);

    if (allowed.length === 0) {
      return {
        checked: 0,
        findings: [],
        inconclusive: 'No approved regions configured. Residency is not being enforced.',
      };
    }

    const allowedFold = new Set(allowed.map(r => r.toLowerCase()));
    // Region is unknowable for some charge types (support, marketplace), and a
    // null region is not evidence of a breach.
    const rows = filterByScope(data.resourceSpend, scope)
      .filter(r => r.region && r.monthlyCost >= floor);

    if (rows.length === 0) {
      return { checked: 0, findings: [], inconclusive: 'No region-attributed spend in scope.' };
    }

    const grouped = new Map<string, { provider: string; accountId: string; accountName: string | null; region: string; cost: number; resources: number; services: Set<string> }>();
    for (const r of rows) {
      const region = (r.region as string);
      if (allowedFold.has(region.toLowerCase())) continue;
      const k = `${r.provider}:${r.accountId}:${region}`;
      const entry = grouped.get(k) ?? {
        provider: r.provider, accountId: r.accountId, accountName: r.accountName,
        region, cost: 0, resources: 0, services: new Set<string>(),
      };
      entry.cost += r.monthlyCost;
      entry.resources += 1;
      entry.services.add(r.serviceName);
      grouped.set(k, entry);
    }

    const findings: Finding[] = [];
    for (const [key, g] of grouped) {
      findings.push({
        key,
        title: `Spend in unapproved region ${g.region}`,
        detail:
          `${g.accountName ?? g.accountId} is running ${money(g.cost)}/month across ${g.resources} billed ` +
          `item${g.resources === 1 ? '' : 's'} in ${g.region}, which is outside the approved list ` +
          `(${allowed.join(', ')}).`,
        provider: g.provider,
        accountId: g.accountId,
        region: g.region,
        resourceType: 'region',
        monthlyCostImpact: g.cost,
        evidence: {
          region: g.region,
          allowedRegions: allowed,
          billedItems: g.resources,
          services: Array.from(g.services).slice(0, 20),
        },
      });
    }

    return { checked: rows.length, findings };
  },
};

/**
 * Inventory metadata is provider-shaped and inconsistently populated, so these
 * two policies read a small set of well-known keys rather than pretending there
 * is a normalised schema. A resource whose metadata does not carry the key is
 * not counted in the denominator: absence of evidence is not evidence that the
 * bucket is private.
 */
function readBool(metadata: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    for (const [k, v] of Object.entries(metadata)) {
      if (k.toLowerCase() !== key.toLowerCase()) continue;
      if (typeof v === 'boolean') return v;
      if (v === 'true' || v === 'True') return true;
      if (v === 'false' || v === 'False') return false;
      if (v === 'Enabled' || v === 'enabled') return true;
      if (v === 'Disabled' || v === 'disabled') return false;
    }
  }
  return undefined;
}

const PUBLIC_KEYS = ['publiclyAccessible', 'publicAccess', 'isPublic', 'publicNetworkAccess', 'allowBlobPublicAccess'];
const ENCRYPTION_KEYS = ['encrypted', 'encryptionEnabled', 'storageEncrypted', 'serverSideEncryption', 'kmsEncrypted'];

const publicExposure: PolicyDefinition = {
  descriptor: {
    key: 'security.public-exposure',
    title: 'No resource is publicly reachable unintentionally',
    domain: 'security',
    severity: 'critical',
    description: 'Inventoried resources are not reported as publicly accessible.',
    rationale:
      'Public exposure of a data store is the single most common root cause of a cloud data breach, and it ' +
      'is almost always a default that nobody changed rather than a decision anybody made.',
    remediation:
      'Restrict network access to the resource. If public reachability is intentional — a static site, a ' +
      'public API — record a time-boxed exemption naming who accepted the risk.',
    appliesTo: ['aws', 'azure', 'gcp'],
    parameters: [
      {
        key: 'exemptResourceTypes',
        label: 'Resource types expected to be public',
        type: 'stringList',
        default: ['CloudFront', 'ApplicationLoadBalancer', 'PublicIP'],
        help: 'Types whose whole purpose is to face the internet.',
      },
    ],
    frameworks: [
      { framework: 'CIS Benchmarks', control: 'Storage — public access blocked' },
      { framework: 'ISO/IEC 27001', control: 'A.8.20 Network security' },
      { framework: 'NIST CSF 2.0', control: 'PR.AA-05' },
      { framework: 'SOC 2', control: 'CC6.6' },
    ],
    supportsScope: true,
    defaultEnabled: true,
    defaultEnforcement: 'warn',
  },

  evaluate({ parameters, scope, data }: EvaluationInput): PolicyResult {
    const exempt = listParam(parameters, 'exemptResourceTypes').map(t => t.toLowerCase());

    const assessable = filterByScope(data.inventory, scope)
      .filter(r => !exempt.includes(r.resourceType.toLowerCase()))
      .map(r => ({ r, isPublic: readBool(r.metadata, PUBLIC_KEYS) }))
      .filter(x => x.isPublic !== undefined);

    if (assessable.length === 0) {
      return {
        checked: 0,
        findings: [],
        inconclusive:
          'No inventoried resource reports a public-access attribute. Exposure is not being assessed — ' +
          'this is an unknown, not a pass.',
      };
    }

    const findings: Finding[] = assessable
      .filter(x => x.isPublic === true)
      .map(({ r }) => ({
        key: `${r.provider}:${r.accountId}:${r.resourceId}`,
        title: `${r.resourceName ?? r.resourceId} is publicly accessible`,
        detail:
          `${r.resourceType} in ${r.region ?? 'an unknown region'} (${r.accountId}) reports public network ` +
          `access. ${money(r.monthlyCost)}/month.`,
        provider: r.provider,
        accountId: r.accountId,
        region: r.region,
        resourceId: r.resourceId,
        resourceType: r.resourceType,
        resourceName: r.resourceName,
        monthlyCostImpact: null,
        evidence: { state: r.state, size: r.size, tags: r.tags },
      }));

    return { checked: assessable.length, findings: capped(findings) };
  },
};

const unencryptedStorage: PolicyDefinition = {
  descriptor: {
    key: 'security.unencrypted-storage',
    title: 'Data at rest is encrypted',
    domain: 'security',
    severity: 'critical',
    description: 'Inventoried storage and database resources report encryption at rest as enabled.',
    rationale:
      'Encryption at rest is assumed by every framework and by every customer contract, it costs nothing on ' +
      'every major provider, and it can only be set at creation time for several resource types — which ' +
      'is exactly why unencrypted volumes survive for years once created.',
    remediation:
      'Enable encryption where the provider allows it in place; otherwise snapshot, recreate encrypted, and ' +
      'cut over. Then require it in the IaC module so new resources cannot repeat it.',
    appliesTo: ['aws', 'azure', 'gcp'],
    parameters: [],
    frameworks: [
      { framework: 'CIS Benchmarks', control: 'Encryption at rest enabled' },
      { framework: 'ISO/IEC 27001', control: 'A.8.24 Use of cryptography' },
      { framework: 'NIST CSF 2.0', control: 'PR.DS-01' },
      { framework: 'SOC 2', control: 'CC6.1' },
      { framework: 'GDPR', control: 'Art. 32 Security of processing' },
    ],
    supportsScope: true,
    defaultEnabled: true,
    defaultEnforcement: 'warn',
  },

  evaluate({ scope, data }: EvaluationInput): PolicyResult {
    const assessable = filterByScope(data.inventory, scope)
      .map(r => ({ r, encrypted: readBool(r.metadata, ENCRYPTION_KEYS) }))
      .filter(x => x.encrypted !== undefined);

    if (assessable.length === 0) {
      return {
        checked: 0,
        findings: [],
        inconclusive:
          'No inventoried resource reports an encryption attribute. Encryption at rest is not being ' +
          'verified — this is an unknown, not a pass.',
      };
    }

    const findings: Finding[] = assessable
      .filter(x => x.encrypted === false)
      .map(({ r }) => ({
        key: `${r.provider}:${r.accountId}:${r.resourceId}`,
        title: `${r.resourceName ?? r.resourceId} is not encrypted at rest`,
        detail:
          `${r.resourceType} in ${r.region ?? 'an unknown region'} (${r.accountId}) reports encryption ` +
          `disabled.`,
        provider: r.provider,
        accountId: r.accountId,
        region: r.region,
        resourceId: r.resourceId,
        resourceType: r.resourceType,
        resourceName: r.resourceName,
        evidence: { state: r.state, size: r.size },
      }));

    return { checked: assessable.length, findings: capped(findings) };
  },
};

const credentialRotation: PolicyDefinition = {
  descriptor: {
    key: 'security.credential-rotation',
    title: 'Cloud credentials are rotated',
    domain: 'security',
    severity: 'high',
    description: 'Long-lived cloud credentials held by Cloudwise are not older than the rotation window.',
    rationale:
      'A static key that is never rotated is a key that stays valid for as long as it is leaked. Rotation ' +
      'bounds the useful life of a credential that has already escaped without anyone knowing.',
    remediation:
      'Rotate the key in the provider and update the connection — or better, migrate the connection to ' +
      'role assumption, which removes the standing credential entirely and makes this policy inapplicable.',
    appliesTo: ['aws', 'azure', 'gcp'],
    parameters: [
      { key: 'maxAgeDays', label: 'Rotate within', type: 'number', default: 90, min: 1, max: 3650 },
    ],
    frameworks: [
      { framework: 'CIS Benchmarks', control: 'Rotate access keys every 90 days' },
      { framework: 'ISO/IEC 27001', control: 'A.5.17 Authentication information' },
      { framework: 'NIST CSF 2.0', control: 'PR.AA-01' },
      { framework: 'SOC 2', control: 'CC6.1' },
    ],
    supportsScope: true,
    defaultEnabled: true,
    defaultEnforcement: 'warn',
  },

  evaluate({ parameters, scope, now, data }: EvaluationInput): PolicyResult {
    const maxAge = numberParam(parameters, 'maxAgeDays', 90);

    // Role assumption mints short-lived credentials per call, so there is no
    // standing secret to age. Only the access-key path is in scope here.
    const keyed = filterByScope(data.accounts, scope)
      .filter(a => a.isActive && a.authType === 'access_keys');

    if (keyed.length === 0) {
      return {
        checked: 0,
        findings: [],
        inconclusive: 'No connection uses long-lived access keys. Nothing to rotate.',
      };
    }

    const findings: Finding[] = [];
    for (const a of keyed) {
      const age = daysBetween(now, a.credentialsUpdatedAt);
      if (age <= maxAge) continue;

      findings.push({
        key: `account:${a.id}`,
        title: `${a.accountName} credentials are ${age} days old`,
        detail:
          `The ${a.provider.toUpperCase()} connection to ${a.accountId} still uses the access key stored ` +
          `${age} days ago, against a ${maxAge}-day rotation window.`,
        provider: a.provider,
        accountId: a.accountId,
        resourceType: 'cloud_account',
        resourceId: String(a.id),
        resourceName: a.accountName,
        evidence: { ageDays: age, maxAgeDays: maxAge, authType: a.authType },
        severity: age > maxAge * 2 ? 'critical' : undefined,
      });
    }

    return { checked: keyed.length, findings };
  },
};

const staticCredentials: PolicyDefinition = {
  descriptor: {
    key: 'security.static-credentials',
    title: 'Connections use role assumption, not stored keys',
    domain: 'security',
    severity: 'high',
    description: 'Cloud connections authenticate with short-lived assumed-role credentials.',
    rationale:
      'A stored access key is a standing credential in our database: if it leaks, it is immediately usable ' +
      'against the customer’s cloud. An assumed-role connection stores only a role ARN and an external ' +
      'id, which are worthless without control of the Cloudwise principal named in the trust policy.',
    remediation:
      'Re-onboard the account through the cross-account role wizard, then delete the access key at the ' +
      'provider so the old path cannot be used.',
    appliesTo: ['aws', 'azure', 'gcp'],
    parameters: [],
    frameworks: [
      { framework: 'CIS Benchmarks', control: 'Avoid long-lived access keys' },
      { framework: 'ISO/IEC 27001', control: 'A.5.17 Authentication information' },
      { framework: 'NIST CSF 2.0', control: 'PR.AA-01' },
      { framework: 'SOC 2', control: 'CC6.1' },
    ],
    supportsScope: true,
    defaultEnabled: true,
    defaultEnforcement: 'audit',
  },

  evaluate({ scope, data }: EvaluationInput): PolicyResult {
    const active = filterByScope(data.accounts, scope).filter(a => a.isActive);
    if (active.length === 0) {
      return { checked: 0, findings: [], inconclusive: 'No active cloud connections.' };
    }

    const findings: Finding[] = active
      .filter(a => a.authType === 'access_keys')
      .map(a => ({
        key: `account:${a.id}`,
        title: `${a.accountName} authenticates with a stored access key`,
        detail:
          `The ${a.provider.toUpperCase()} connection to ${a.accountId} holds a long-lived credential in ` +
          `Cloudwise rather than assuming a role for each operation.`,
        provider: a.provider,
        accountId: a.accountId,
        resourceType: 'cloud_account',
        resourceId: String(a.id),
        resourceName: a.accountName,
        evidence: { authType: a.authType },
      }));

    return { checked: active.length, findings };
  },
};

const platformHardening: PolicyDefinition = {
  descriptor: {
    key: 'security.platform-hardening',
    title: 'Cloudwise itself is deployed securely',
    domain: 'security',
    severity: 'critical',
    description: 'The Cloudwise deployment has its own transport, session and secret-handling protections enabled.',
    rationale:
      'Cloudwise holds credentials to the customer’s entire cloud estate. A governance tool that audits ' +
      'the estate while running with a default session secret or an unencrypted database connection is the ' +
      'softest target in the architecture, and no customer security review misses it.',
    remediation: 'Each finding names the environment variable or deployment setting to change.',
    appliesTo: ['platform'],
    parameters: [],
    frameworks: [
      { framework: 'ISO/IEC 27001', control: 'A.8.24 Use of cryptography' },
      { framework: 'NIST CSF 2.0', control: 'PR.DS-02' },
      { framework: 'SOC 2', control: 'CC6.1' },
      { framework: 'SOC 2', control: 'CC6.7' },
    ],
    supportsScope: false,
    defaultEnabled: true,
    defaultEnforcement: 'audit',
  },

  evaluate({ data }: EvaluationInput): PolicyResult {
    const p = data.platform;
    const isProd = p.nodeEnv === 'production';
    const checks: Array<{ key: string; ok: boolean; title: string; detail: string; severity?: 'critical' | 'high' | 'medium' }> = [
      {
        key: 'session-secret',
        ok: !p.sessionSecretIsDefault && p.sessionSecretLength >= 32,
        title: 'Session secret is weak or still the shipped default',
        detail:
          p.sessionSecretIsDefault
            ? 'SESSION_SECRET is unset or still the development placeholder. Anyone who reads the source can ' +
              'forge a session cookie for any user, including an owner.'
            : `SESSION_SECRET is ${p.sessionSecretLength} characters. Use at least 32 random characters.`,
        severity: 'critical',
      },
      {
        key: 'database-tls',
        ok: p.databaseTlsEnforced,
        title: 'Database connection does not require TLS',
        detail:
          'DATABASE_URL does not request sslmode=require. Credentials and every cost row cross the network ' +
          'in plaintext.',
        severity: 'critical',
      },
      {
        key: 'credential-encryption',
        ok: p.credentialEncryptionConfigured,
        title: 'Cloud credentials are not encrypted at rest',
        detail:
          'ENCRYPTION_KEY is not configured, so cloud_accounts.credentials is not protected by an ' +
          'application-layer key. A database backup would expose usable cloud credentials.',
        severity: 'critical',
      },
      {
        key: 'security-headers',
        ok: p.securityHeadersEnabled,
        title: 'Security response headers are not being sent',
        detail:
          'Content-Security-Policy, HSTS, X-Content-Type-Options and frame protections are disabled, leaving ' +
          'the console open to clickjacking and injected-script exfiltration of cost data.',
        severity: 'high',
      },
      {
        key: 'rate-limit',
        ok: p.rateLimitEnabled,
        title: 'Request rate limiting is disabled',
        detail:
          'The login endpoint accepts unlimited attempts, so password guessing is bounded only by network ' +
          'speed.',
        severity: 'high',
      },
      {
        key: 'csrf',
        ok: p.csrfProtectionEnabled,
        title: 'CSRF protection is disabled',
        detail:
          'State-changing requests are authenticated by a cookie with no accompanying token, so another ' +
          'origin can make a signed-in browser execute agent actions.',
        severity: 'high',
      },
      {
        key: 'secure-cookies',
        // Only meaningful in production; a local dev server is served over HTTP
        // by design and flagging it every sweep trains people to ignore this.
        ok: !isProd || p.secureCookies,
        title: 'Session cookie is not marked Secure',
        detail: 'Running in production without Secure cookies allows the session to be sent over plain HTTP.',
        severity: 'critical',
      },
    ];

    const findings: Finding[] = checks
      .filter(c => !c.ok)
      .map(c => ({
        key: `platform:${c.key}`,
        title: c.title,
        detail: c.detail,
        resourceType: 'platform',
        resourceId: c.key,
        resourceName: 'Cloudwise deployment',
        evidence: { nodeEnv: p.nodeEnv, check: c.key },
        severity: c.severity,
      }));

    return { checked: checks.length, findings };
  },
};

// ══════════════════════════════════════════════════════════════════════════════
// Access governance
// ══════════════════════════════════════════════════════════════════════════════

const privilegedUserCeiling: PolicyDefinition = {
  descriptor: {
    key: 'access.privileged-user-ceiling',
    title: 'Administrative access stays scarce',
    domain: 'access',
    severity: 'high',
    description: 'The number of active admin and owner accounts stays at or below the agreed ceiling.',
    rationale:
      'Admin and owner can add cloud credentials and execute agent actions against live infrastructure. ' +
      'Privilege accumulates quietly — granted for one incident, never revoked — until half the ' +
      'organization can terminate production. A ceiling forces the conversation.',
    remediation:
      'Move users who do not need credential or execution rights to finops or engineer. Both can still ' +
      'approve work; neither can add a cloud credential.',
    appliesTo: ['platform'],
    parameters: [
      { key: 'maxPrivilegedUsers', label: 'Maximum privileged users', type: 'number', default: 3, min: 1, max: 100 },
    ],
    frameworks: [
      { framework: 'ISO/IEC 27001', control: 'A.8.2 Privileged access rights' },
      { framework: 'NIST CSF 2.0', control: 'PR.AA-05' },
      { framework: 'SOC 2', control: 'CC6.3' },
      { framework: 'CIS Benchmarks', control: 'Least privilege' },
    ],
    supportsScope: false,
    defaultEnabled: true,
    defaultEnforcement: 'audit',
  },

  evaluate({ parameters, data }: EvaluationInput): PolicyResult {
    const ceiling = numberParam(parameters, 'maxPrivilegedUsers', 3);
    const active = data.users.filter(u => u.isActive);
    if (active.length === 0) {
      return { checked: 0, findings: [], inconclusive: 'No active users.' };
    }

    const privileged = active.filter(u => u.role === 'admin' || u.role === 'owner');
    if (privileged.length <= ceiling) return { checked: active.length, findings: [] };

    return {
      checked: active.length,
      findings: [{
        key: 'privileged-count',
        title: `${privileged.length} privileged accounts, ceiling is ${ceiling}`,
        detail:
          `${privileged.length} of ${active.length} active users hold admin or owner. Each can add cloud ` +
          `credentials and execute changes against live infrastructure.`,
        resourceType: 'access',
        evidence: {
          privilegedCount: privileged.length,
          ceiling,
          activeUsers: active.length,
          privilegedUsers: privileged.map(u => ({ username: u.username, role: u.role })),
        },
      }],
    };
  },
};

const dormantUser: PolicyDefinition = {
  descriptor: {
    key: 'access.dormant-user',
    title: 'Dormant accounts are deactivated',
    domain: 'access',
    severity: 'medium',
    description: 'No active account has gone unused for longer than the dormancy window.',
    rationale:
      'The account of someone who left is the one nobody notices being used. Dormancy is the cheapest ' +
      'available proxy for "should this still exist", and it catches the leaver whose offboarding ticket was ' +
      'closed without touching this system.',
    remediation:
      'Deactivate the account. Deactivation preserves its audit history, whereas deleting it would leave ' +
      'past actions attributed to a user id nobody can resolve.',
    appliesTo: ['platform'],
    parameters: [
      { key: 'maxIdleDays', label: 'Dormant after', type: 'number', default: 60, min: 7, max: 730 },
      {
        key: 'includeNeverLoggedIn',
        label: 'Include accounts that never signed in',
        type: 'boolean',
        default: true,
        help: 'Counts from the creation date instead of the last sign-in.',
      },
    ],
    frameworks: [
      { framework: 'ISO/IEC 27001', control: 'A.5.18 Access rights' },
      { framework: 'NIST CSF 2.0', control: 'PR.AA-01' },
      { framework: 'SOC 2', control: 'CC6.2' },
    ],
    supportsScope: false,
    defaultEnabled: true,
    defaultEnforcement: 'audit',
  },

  evaluate({ parameters, now, data }: EvaluationInput): PolicyResult {
    const maxIdle = numberParam(parameters, 'maxIdleDays', 60);
    const includeNever = parameters.includeNeverLoggedIn !== false;

    const active = data.users.filter(u => u.isActive);
    if (active.length === 0) {
      return { checked: 0, findings: [], inconclusive: 'No active users.' };
    }

    const findings: Finding[] = [];
    for (const u of active) {
      const since = u.lastLoginAt ?? (includeNever ? u.createdAt : null);
      if (!since) continue;
      const idle = daysBetween(now, since);
      if (idle <= maxIdle) continue;

      findings.push({
        key: `user:${u.id}`,
        title: u.lastLoginAt
          ? `${u.username} has not signed in for ${idle} days`
          : `${u.username} has never signed in (created ${idle} days ago)`,
        detail:
          `Role ${u.role}. Dormancy window is ${maxIdle} days. ` +
          (u.role === 'admin' || u.role === 'owner'
            ? 'This is a privileged account, so the unused access is also unmonitored privilege.'
            : 'The account remains able to sign in and read cost data.'),
        resourceType: 'user',
        resourceId: String(u.id),
        resourceName: u.username,
        evidence: { idleDays: idle, role: u.role, lastLoginAt: u.lastLoginAt, neverLoggedIn: !u.lastLoginAt },
        severity: (u.role === 'admin' || u.role === 'owner') ? 'high' : undefined,
      });
    }

    return { checked: active.length, findings };
  },
};

const agentBlastRadius: PolicyDefinition = {
  descriptor: {
    key: 'access.agent-blast-radius',
    title: 'Automation agent is bounded',
    domain: 'access',
    severity: 'high',
    description: 'The optimization agent cannot make unbounded changes to live infrastructure without approval.',
    rationale:
      'The agent can stop, resize and delete real resources. Auto-execute with safety mode off and a high ' +
      'unattended cost ceiling is the configuration that turns a cost tool into an outage, and it is usually ' +
      'reached one convenient setting at a time.',
    remediation:
      'Keep safety mode on, and either require approval or hold the unattended cost ceiling low enough that ' +
      'an unsupervised mistake is affordable.',
    appliesTo: ['platform'],
    parameters: [
      {
        key: 'maxUnattendedCostImpact',
        label: 'Maximum unattended change',
        type: 'currency',
        default: 500,
        min: 0,
        help: 'Largest monthly cost impact the agent may act on without a human approval.',
      },
      { key: 'requireSafetyMode', label: 'Require safety mode', type: 'boolean', default: true },
    ],
    frameworks: [
      { framework: 'ISO/IEC 27001', control: 'A.8.32 Change management' },
      { framework: 'NIST CSF 2.0', control: 'PR.PS-06' },
      { framework: 'SOC 2', control: 'CC8.1' },
      { framework: 'FinOps Framework', control: 'Cloud Policy and Governance' },
    ],
    supportsScope: false,
    defaultEnabled: true,
    defaultEnforcement: 'audit',
  },

  evaluate({ parameters, data }: EvaluationInput): PolicyResult {
    const agent = data.agent;
    if (!agent) {
      return { checked: 0, findings: [], inconclusive: 'No agent configuration exists yet, so the agent is at its safe defaults.' };
    }

    const maxUnattended = numberParam(parameters, 'maxUnattendedCostImpact', 500);
    const requireSafety = parameters.requireSafetyMode !== false;
    const findings: Finding[] = [];

    if (requireSafety && !agent.safetyMode) {
      findings.push({
        key: 'agent:safety-mode',
        title: 'Agent safety mode is disabled',
        detail: 'Destructive action types are no longer blocked, so the agent may terminate and delete resources.',
        resourceType: 'agent_config',
        resourceId: 'safety-mode',
        evidence: { safetyMode: agent.safetyMode },
        severity: 'critical',
      });
    }

    if (agent.autoExecuteEnabled && agent.maxCostImpactWithoutApproval > maxUnattended) {
      findings.push({
        key: 'agent:unattended-ceiling',
        title: `Agent may act unattended up to ${money(agent.maxCostImpactWithoutApproval)}`,
        detail:
          `Auto-execute is on and the approval-free ceiling is ${money(agent.maxCostImpactWithoutApproval)}, ` +
          `above the governed maximum of ${money(maxUnattended)}.`,
        resourceType: 'agent_config',
        resourceId: 'unattended-ceiling',
        evidence: {
          autoExecuteEnabled: agent.autoExecuteEnabled,
          maxCostImpactWithoutApproval: agent.maxCostImpactWithoutApproval,
          governedMaximum: maxUnattended,
        },
      });
    }

    if (agent.autoExecuteEnabled && !agent.dryRunMode && !agent.safetyMode) {
      findings.push({
        key: 'agent:unrestricted',
        title: 'Agent is executing for real with no safety rails',
        detail:
          'Auto-execute is on, dry run is off and safety mode is off simultaneously. Nothing stands between ' +
          'a generated plan and live infrastructure.',
        resourceType: 'agent_config',
        resourceId: 'unrestricted',
        evidence: { autoExecuteEnabled: true, dryRunMode: false, safetyMode: false },
        severity: 'critical',
      });
    }

    return { checked: 3, findings };
  },
};

// ══════════════════════════════════════════════════════════════════════════════
// Operational assurance
// ══════════════════════════════════════════════════════════════════════════════

const ingestionFreshness: PolicyDefinition = {
  descriptor: {
    key: 'ops.ingestion-freshness',
    title: 'Cost data is current',
    domain: 'operations',
    severity: 'high',
    description: 'Every connected provider has ingested cost data within the freshness window.',
    rationale:
      'Every other policy, budget and forecast reads the fact store. Stale data does not produce an error, ' +
      'it produces confident wrong answers — and a governance report over three-week-old data is worse ' +
      'than no report, because people act on it.',
    remediation:
      'Check the connection credentials and the ingestion log for the named provider. A failing connection ' +
      'usually means an expired secret or a revoked permission.',
    appliesTo: ['aws', 'azure', 'gcp'],
    parameters: [
      { key: 'maxStaleHours', label: 'Data must be no older than', type: 'number', default: 48, min: 1, max: 720 },
    ],
    frameworks: [
      { framework: 'FinOps Framework', control: 'Data Ingestion' },
      { framework: 'SOC 2', control: 'CC7.2' },
      { framework: 'NIST CSF 2.0', control: 'DE.CM-09' },
    ],
    supportsScope: true,
    defaultEnabled: true,
    defaultEnforcement: 'warn',
  },

  evaluate({ parameters, scope, now, data }: EvaluationInput): PolicyResult {
    const maxStale = numberParam(parameters, 'maxStaleHours', 48);
    const active = filterByScope(data.accounts, scope).filter(a => a.isActive);

    if (active.length === 0) {
      return { checked: 0, findings: [], inconclusive: 'No active cloud connections to ingest from.' };
    }

    const byProvider = new Map<string, Date | null>();
    for (const run of data.ingestion) {
      const existing = byProvider.get(run.provider);
      if (existing === undefined || (run.lastSuccessAt && (!existing || run.lastSuccessAt > existing))) {
        byProvider.set(run.provider, run.lastSuccessAt);
      }
    }

    const providers = Array.from(new Set(active.map(a => a.provider)));
    const findings: Finding[] = [];

    for (const provider of providers) {
      const last = byProvider.get(provider) ?? null;
      if (last === null) {
        findings.push({
          key: `ingestion:${provider}`,
          title: `${provider.toUpperCase()} has never ingested cost data`,
          detail:
            `An active ${provider.toUpperCase()} connection exists but no ingestion run has ever succeeded, ` +
            `so this provider's spend is missing from every figure in the product.`,
          provider,
          resourceType: 'ingestion',
          evidence: { lastSuccessAt: null, maxStaleHours: maxStale },
          severity: 'critical',
        });
        continue;
      }

      const age = hoursBetween(now, last);
      if (age <= maxStale) continue;

      findings.push({
        key: `ingestion:${provider}`,
        title: `${provider.toUpperCase()} cost data is ${age} hours old`,
        detail:
          `The last successful ingestion was ${age} hours ago, against a freshness window of ${maxStale} ` +
          `hours. Dashboards, budgets and every policy above are reading stale figures.`,
        provider,
        resourceType: 'ingestion',
        evidence: { lastSuccessAt: last.toISOString(), ageHours: age, maxStaleHours: maxStale },
        severity: age > maxStale * 3 ? 'critical' : undefined,
      });
    }

    return { checked: providers.length, findings };
  },
};

const connectionHealth: PolicyDefinition = {
  descriptor: {
    key: 'ops.connection-health',
    title: 'Cloud connections are healthy',
    domain: 'operations',
    severity: 'high',
    description: 'No active cloud connection is failing validation or has never been validated.',
    rationale:
      'A broken connection is a blind spot, and a blind spot reads as good news: the account with the ' +
      'problem simply stops appearing in reports. This policy makes the absence visible.',
    remediation:
      'Re-run validation for the connection. A failure is almost always an expired secret, a changed trust ' +
      'policy, or a removed billing permission.',
    appliesTo: ['aws', 'azure', 'gcp'],
    parameters: [
      { key: 'maxValidationAgeDays', label: 'Re-validate within', type: 'number', default: 30, min: 1, max: 365 },
    ],
    frameworks: [
      { framework: 'FinOps Framework', control: 'Data Ingestion' },
      { framework: 'SOC 2', control: 'CC7.2' },
    ],
    supportsScope: true,
    defaultEnabled: true,
    defaultEnforcement: 'audit',
  },

  evaluate({ parameters, scope, now, data }: EvaluationInput): PolicyResult {
    const maxAge = numberParam(parameters, 'maxValidationAgeDays', 30);
    const active = filterByScope(data.accounts, scope).filter(a => a.isActive);

    if (active.length === 0) {
      return { checked: 0, findings: [], inconclusive: 'No active cloud connections.' };
    }

    const findings: Finding[] = [];
    for (const a of active) {
      if (a.lastValidationError) {
        findings.push({
          key: `connection:${a.id}`,
          title: `${a.accountName} is failing validation`,
          detail: `Last validation of the ${a.provider.toUpperCase()} connection to ${a.accountId} failed: ${a.lastValidationError}`,
          provider: a.provider,
          accountId: a.accountId,
          resourceType: 'cloud_account',
          resourceId: String(a.id),
          resourceName: a.accountName,
          evidence: { error: a.lastValidationError, lastValidatedAt: a.lastValidatedAt?.toISOString() ?? null },
          severity: 'critical',
        });
        continue;
      }

      // Never-validated connections predate the validation flow; they are stale
      // by definition rather than broken, so they get the ordinary severity.
      const age = a.lastValidatedAt ? daysBetween(now, a.lastValidatedAt) : null;
      if (age !== null && age <= maxAge) continue;

      findings.push({
        key: `connection:${a.id}`,
        title: age === null
          ? `${a.accountName} has never been validated`
          : `${a.accountName} was last validated ${age} days ago`,
        detail:
          `The ${a.provider.toUpperCase()} connection to ${a.accountId} has not been proved to work within ` +
          `the ${maxAge}-day window, so a silent permission change would not have been noticed.`,
        provider: a.provider,
        accountId: a.accountId,
        resourceType: 'cloud_account',
        resourceId: String(a.id),
        resourceName: a.accountName,
        evidence: { lastValidatedAt: a.lastValidatedAt?.toISOString() ?? null, maxValidationAgeDays: maxAge },
      });
    }

    return { checked: active.length, findings };
  },
};

// ══════════════════════════════════════════════════════════════════════════════

export const POLICIES: PolicyDefinition[] = [
  // tagging
  requiredTags,
  allowedTagValues,
  untaggedSpendCeiling,
  allocationCoverage,
  // cost
  accountBudgetRequired,
  budgetNotificationRequired,
  idleResourceWaste,
  commitmentCoverage,
  anomalyReviewSla,
  restrictedService,
  // security
  dataResidency,
  publicExposure,
  unencryptedStorage,
  credentialRotation,
  staticCredentials,
  platformHardening,
  // access
  privilegedUserCeiling,
  dormantUser,
  agentBlastRadius,
  // operations
  ingestionFreshness,
  connectionHealth,
];

const BY_KEY = new Map(POLICIES.map(p => [p.descriptor.key, p]));

export function getPolicy(key: string): PolicyDefinition | undefined {
  return BY_KEY.get(key);
}

export function policyDescriptors(): PolicyDescriptor[] {
  return POLICIES.map(p => p.descriptor);
}

/** Catalog defaults for a policy's parameters, used wherever no override exists. */
export function defaultParameters(descriptor: PolicyDescriptor): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of descriptor.parameters) out[spec.key] = spec.default;
  return out;
}
