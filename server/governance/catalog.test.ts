/**
 * Catalog tests.
 *
 * Two kinds. The structural ones assert invariants that must hold for EVERY
 * policy, so a policy added next year is checked without anybody remembering to
 * write a test for it. The behavioural ones exercise the policies whose logic
 * is not obvious from reading them — the ones where getting it subtly wrong
 * produces a plausible number rather than an error.
 */
import { describe, it, expect } from 'vitest';
import { POLICIES, getPolicy, defaultParameters, policyDescriptors } from './catalog';
import { POLICY_DOMAINS, POLICY_SEVERITIES, ENFORCEMENT_MODES, FRAMEWORKS } from '@shared/governance';
import type { GovernanceDataset, ResourceSpend, InventoryResource, PlatformPosture } from './types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = new Date('2026-06-15T12:00:00Z');

const platform = (over: Partial<PlatformPosture> = {}): PlatformPosture => ({
  nodeEnv: 'production',
  sessionSecretIsDefault: false,
  sessionSecretLength: 64,
  databaseTlsEnforced: true,
  credentialEncryptionConfigured: true,
  securityHeadersEnabled: true,
  rateLimitEnabled: true,
  csrfProtectionEnabled: true,
  secureCookies: true,
  ...over,
});

const spend = (over: Partial<ResourceSpend> = {}): ResourceSpend => ({
  provider: 'aws',
  accountId: '111122223333',
  accountName: 'production',
  region: 'us-east-1',
  serviceName: 'Amazon EC2',
  serviceCategory: 'Compute',
  resourceId: 'i-abc123',
  resourceName: 'web-1',
  tags: { Environment: 'production', Owner: 'platform', CostCenter: 'CC-100' },
  monthlyCost: 100,
  windowCost: 100,
  hasCommitment: false,
  ...over,
});

const inventory = (over: Partial<InventoryResource> = {}): InventoryResource => ({
  provider: 'aws',
  accountId: '111122223333',
  resourceId: 'i-abc123',
  resourceType: 'EC2',
  resourceName: 'web-1',
  region: 'us-east-1',
  state: 'running',
  size: 't3.large',
  monthlyCost: 100,
  utilizationPercent: 40,
  tags: {},
  metadata: {},
  lastSeenAt: NOW,
  ...over,
});

const dataset = (over: Partial<GovernanceDataset> = {}): GovernanceDataset => ({
  lookbackDays: 30,
  windowStart: new Date('2026-05-16T12:00:00Z'),
  windowEnd: NOW,
  resourceSpend: [],
  accountSpend: [],
  totalMonthlySpend: 0,
  inventory: [],
  accounts: [],
  budgets: [],
  anomalies: [],
  users: [],
  agent: null,
  ingestion: [],
  platform: platform(),
  commitment: { coveredMonthlyCost: 0, eligibleMonthlyCost: 0 },
  ...over,
});

function run(key: string, data: GovernanceDataset, params: Record<string, unknown> = {}) {
  const policy = getPolicy(key);
  if (!policy) throw new Error(`No policy ${key}`);
  return policy.evaluate({
    parameters: { ...defaultParameters(policy.descriptor), ...params },
    scope: {},
    now: NOW,
    data,
  });
}

// ── Structural invariants ─────────────────────────────────────────────────────

describe('catalog structure', () => {
  it('has unique keys', () => {
    const keys = POLICIES.map(p => p.descriptor.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('declares valid domains, severities and enforcement modes', () => {
    for (const { descriptor } of POLICIES) {
      expect(POLICY_DOMAINS).toContain(descriptor.domain);
      expect(POLICY_SEVERITIES).toContain(descriptor.severity);
      expect(ENFORCEMENT_MODES).toContain(descriptor.defaultEnforcement);
    }
  });

  it('maps every policy to at least one named framework control', () => {
    // The framework view is only useful if it is complete. A policy with no
    // mapping silently contributes to nothing an auditor asked about.
    for (const { descriptor } of POLICIES) {
      expect(descriptor.frameworks.length, `${descriptor.key} maps to no control`).toBeGreaterThan(0);
      for (const fc of descriptor.frameworks) {
        expect(FRAMEWORKS).toContain(fc.framework);
        expect(fc.control.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('gives every parameter a usable default', () => {
    for (const { descriptor } of POLICIES) {
      for (const spec of descriptor.parameters) {
        expect(spec.default, `${descriptor.key}.${spec.key} has no default`).toBeDefined();
        if (spec.type === 'stringList') expect(Array.isArray(spec.default)).toBe(true);
        if (spec.type === 'number' || spec.type === 'percent' || spec.type === 'currency') {
          expect(typeof spec.default).toBe('number');
        }
      }
    }
  });

  it('writes prose a customer can act on', () => {
    // Not cosmetic. The remediation string is shown on every finding, and a
    // finding nobody knows how to fix is a finding nobody fixes.
    for (const { descriptor } of POLICIES) {
      expect(descriptor.description.length, `${descriptor.key} description`).toBeGreaterThan(20);
      expect(descriptor.rationale.length, `${descriptor.key} rationale`).toBeGreaterThan(40);
      expect(descriptor.remediation.length, `${descriptor.key} remediation`).toBeGreaterThan(20);
    }
  });

  it('turns off any policy that does nothing until configured', () => {
    // A policy that is on but has an empty allow-list reports as passing while
    // checking nothing. Defaulting those to off is what keeps the score honest
    // for a customer who has not configured anything yet.
    for (const { descriptor } of POLICIES) {
      if (descriptor.requiresConfiguration) {
        expect(descriptor.defaultEnabled, `${descriptor.key} is on by default but needs configuration`).toBe(false);
      }
    }
  });

  it('returns no findings for an empty estate', () => {
    // Every policy must survive a tenant that has connected nothing. This is
    // the first thing a new customer hits.
    const empty = dataset();
    for (const { descriptor } of POLICIES) {
      const result = run(descriptor.key, empty);
      expect(result.findings.length, `${descriptor.key} invented a finding from nothing`).toBe(0);
    }
  });

  it('exposes descriptors without evaluation functions', () => {
    // policyDescriptors() feeds the API, and a function on a descriptor would
    // silently serialise to nothing over JSON.
    for (const descriptor of policyDescriptors()) {
      expect(typeof (descriptor as unknown as { evaluate?: unknown }).evaluate).toBe('undefined');
    }
  });
});

// ── Tagging ───────────────────────────────────────────────────────────────────

describe('tagging.required-tags', () => {
  it('flags a resource missing a mandatory key', () => {
    const result = run('tagging.required-tags', dataset({
      resourceSpend: [spend({ tags: { Environment: 'production' } })],
    }));

    expect(result.checked).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].evidence?.missingTags).toEqual(['Owner', 'CostCenter']);
  });

  it('matches tag keys case-insensitively', () => {
    // AWS, Azure and GCP disagree about capitalisation, and a policy that
    // flagged `environment` as missing would be wrong on two of three clouds.
    const result = run('tagging.required-tags', dataset({
      resourceSpend: [spend({ tags: { environment: 'prod', owner: 'x', costcenter: 'CC-1' } })],
    }));
    expect(result.findings).toHaveLength(0);
  });

  it('treats an empty tag value as absent', () => {
    const result = run('tagging.required-tags', dataset({
      resourceSpend: [spend({ tags: { Environment: 'production', Owner: '   ', CostCenter: 'CC-1' } })],
    }));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].evidence?.missingTags).toEqual(['Owner']);
  });

  it('ignores resources below the cost floor', () => {
    const result = run('tagging.required-tags', dataset({
      resourceSpend: [spend({ monthlyCost: 0.4, tags: {} })],
    }), { minMonthlyCost: 5 });
    expect(result.checked).toBe(0);
    expect(result.inconclusive).toBeDefined();
  });

  it('escalates severity for expensive resources', () => {
    const result = run('tagging.required-tags', dataset({
      resourceSpend: [spend({ monthlyCost: 4000, tags: {} })],
    }));
    expect(result.findings[0].severity).toBe('high');
  });

  it('is inconclusive, not passing, with no ingested spend', () => {
    const result = run('tagging.required-tags', dataset());
    expect(result.inconclusive).toBeDefined();
    expect(result.checked).toBe(0);
  });
});

describe('tagging.untagged-spend-ceiling', () => {
  it('flags an account over the ceiling and reports the real share', () => {
    const result = run('tagging.untagged-spend-ceiling', dataset({
      accountSpend: [{
        provider: 'aws', accountId: '1', accountName: 'prod',
        monthlyCost: 1000, windowCost: 1000, untaggedCost: 300,
      }],
    }), { maxUntaggedPercent: 10 });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].evidence?.untaggedPercent).toBe(30);
    expect(result.findings[0].monthlyCostImpact).toBe(300);
  });

  it('escalates to critical when most of an account is unallocated', () => {
    const result = run('tagging.untagged-spend-ceiling', dataset({
      accountSpend: [{
        provider: 'aws', accountId: '1', accountName: 'prod',
        monthlyCost: 1000, windowCost: 1000, untaggedCost: 800,
      }],
    }));
    expect(result.findings[0].severity).toBe('critical');
  });

  it('leaves small accounts alone', () => {
    const result = run('tagging.untagged-spend-ceiling', dataset({
      accountSpend: [{
        provider: 'aws', accountId: '1', accountName: 'sandbox',
        monthlyCost: 12, windowCost: 12, untaggedCost: 12,
      }],
    }));
    expect(result.findings).toHaveLength(0);
    expect(result.inconclusive).toBeDefined();
  });
});

// ── Cost ──────────────────────────────────────────────────────────────────────

describe('cost.account-budget-required', () => {
  const account = {
    provider: 'aws', accountId: '111122223333', accountName: 'prod',
    monthlyCost: 5000, windowCost: 5000, untaggedCost: 0,
  };

  it('flags an account with no covering budget', () => {
    const result = run('cost.account-budget-required', dataset({ accountSpend: [account] }));
    expect(result.findings).toHaveLength(1);
  });

  it('accepts an estate-wide budget as cover', () => {
    // provider null + accountId null means "everything", and treating that as
    // uncovered would flag every account of a customer who budgets globally.
    const result = run('cost.account-budget-required', dataset({
      accountSpend: [account],
      budgets: [{
        id: 1, name: 'All cloud', provider: null, accountId: null, amount: 100000,
        period: 'monthly', isActive: true, hasEmailRecipients: true, hasWebhook: false, hasThresholds: true,
      }],
    }));
    expect(result.findings).toHaveLength(0);
  });

  it('does not accept another provider\'s budget as cover', () => {
    const result = run('cost.account-budget-required', dataset({
      accountSpend: [account],
      budgets: [{
        id: 1, name: 'Azure only', provider: 'azure', accountId: null, amount: 1000,
        period: 'monthly', isActive: true, hasEmailRecipients: true, hasWebhook: false, hasThresholds: true,
      }],
    }));
    expect(result.findings).toHaveLength(1);
  });

  it('does not accept an inactive budget as cover', () => {
    const result = run('cost.account-budget-required', dataset({
      accountSpend: [account],
      budgets: [{
        id: 1, name: 'Retired', provider: null, accountId: null, amount: 1000,
        period: 'monthly', isActive: false, hasEmailRecipients: true, hasWebhook: false, hasThresholds: true,
      }],
    }));
    expect(result.findings).toHaveLength(1);
  });
});

describe('cost.idle-resource-waste', () => {
  it('flags low utilization above the cost floor', () => {
    const result = run('cost.idle-resource-waste', dataset({
      inventory: [inventory({ utilizationPercent: 2, monthlyCost: 300 })],
    }));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].monthlyCostImpact).toBe(300);
  });

  it('flags a provider-reported idle state even without a utilization figure', () => {
    const result = run('cost.idle-resource-waste', dataset({
      inventory: [inventory({ state: 'idle', utilizationPercent: null, monthlyCost: 100 })],
    }));
    expect(result.findings).toHaveLength(1);
  });

  it('leaves busy resources alone', () => {
    const result = run('cost.idle-resource-waste', dataset({
      inventory: [inventory({ utilizationPercent: 65, monthlyCost: 900 })],
    }));
    expect(result.checked).toBe(1);
    expect(result.findings).toHaveLength(0);
  });
});

describe('cost.commitment-coverage', () => {
  it('is inconclusive below the spend at which a commitment makes sense', () => {
    const result = run('cost.commitment-coverage', dataset({
      commitment: { coveredMonthlyCost: 0, eligibleMonthlyCost: 100 },
    }));
    expect(result.inconclusive).toBeDefined();
    expect(result.findings).toHaveLength(0);
  });

  it('flags coverage under the floor and quantifies the gap', () => {
    const result = run('cost.commitment-coverage', dataset({
      commitment: { coveredMonthlyCost: 2000, eligibleMonthlyCost: 10000 },
    }), { minCoveragePercent: 60 });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].evidence?.coveragePercent).toBe(20);
    // 40% of $10,000 moved off on-demand at a 25% discount.
    expect(result.findings[0].monthlyCostImpact).toBeCloseTo(1000, 1);
  });

  it('passes at exactly the floor', () => {
    const result = run('cost.commitment-coverage', dataset({
      commitment: { coveredMonthlyCost: 6000, eligibleMonthlyCost: 10000 },
    }), { minCoveragePercent: 60 });
    expect(result.findings).toHaveLength(0);
  });
});

describe('cost.anomaly-review-sla', () => {
  const anomaly = (over: Record<string, unknown> = {}) => ({
    id: 1, provider: 'aws', accountId: '1', serviceName: 'EC2',
    severity: 'high', status: 'active',
    detectedAt: new Date('2026-06-01T00:00:00Z'),   // 14 days before NOW
    expectedCost: 100, actualCost: 900,
    ...over,
  });

  it('flags an anomaly past the SLA', () => {
    const result = run('cost.anomaly-review-sla', dataset({ anomalies: [anomaly()] }), { maxOpenDays: 7 });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].evidence?.ageDays).toBe(14);
  });

  it('ignores a resolved anomaly however old', () => {
    const result = run('cost.anomaly-review-sla', dataset({ anomalies: [anomaly({ status: 'resolved' })] }));
    expect(result.findings).toHaveLength(0);
  });

  it('ignores an anomaly below the material deviation', () => {
    const result = run('cost.anomaly-review-sla', dataset({
      anomalies: [anomaly({ expectedCost: 100, actualCost: 110 })],
    }), { minDeviationCost: 50 });
    expect(result.findings).toHaveLength(0);
  });
});

// ── Security ──────────────────────────────────────────────────────────────────

describe('security.data-residency', () => {
  it('reports unconfigured rather than compliant when no regions are set', () => {
    // The important one. An empty allow-list must never render as a pass, or a
    // customer believes residency is enforced when nothing is being checked.
    const result = run('security.data-residency', dataset({
      resourceSpend: [spend({ region: 'ap-south-1' })],
    }), { allowedRegions: [] });

    expect(result.findings).toHaveLength(0);
    expect(result.inconclusive).toBeDefined();
  });

  it('groups out-of-region spend by account and region', () => {
    const result = run('security.data-residency', dataset({
      resourceSpend: [
        spend({ region: 'ap-south-1', resourceId: 'a', monthlyCost: 10 }),
        spend({ region: 'ap-south-1', resourceId: 'b', monthlyCost: 15 }),
        spend({ region: 'eu-west-1', resourceId: 'c', monthlyCost: 50 }),
      ],
    }), { allowedRegions: ['eu-west-1'] });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].region).toBe('ap-south-1');
    expect(result.findings[0].monthlyCostImpact).toBe(25);
  });

  it('does not treat a charge with no region as a breach', () => {
    // Support and marketplace charges carry no region. Flagging them would
    // produce a permanent, unfixable critical finding.
    const result = run('security.data-residency', dataset({
      resourceSpend: [spend({ region: null })],
    }), { allowedRegions: ['eu-west-1'] });
    expect(result.findings).toHaveLength(0);
  });
});

describe('security.public-exposure', () => {
  it('is inconclusive when no resource reports the attribute', () => {
    const result = run('security.public-exposure', dataset({ inventory: [inventory({ metadata: {} })] }));
    expect(result.checked).toBe(0);
    expect(result.inconclusive).toBeDefined();
  });

  it('counts only resources that report the attribute, and flags the public ones', () => {
    const result = run('security.public-exposure', dataset({
      inventory: [
        inventory({ resourceId: 'a', metadata: { publiclyAccessible: true } }),
        inventory({ resourceId: 'b', metadata: { publiclyAccessible: false } }),
        inventory({ resourceId: 'c', metadata: {} }),   // unknown: excluded entirely
      ],
    }));
    expect(result.checked).toBe(2);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].resourceId).toBe('a');
  });

  it('skips resource types that exist to be public', () => {
    const result = run('security.public-exposure', dataset({
      inventory: [inventory({ resourceType: 'CloudFront', metadata: { publicAccess: true } })],
    }));
    expect(result.findings).toHaveLength(0);
  });
});

describe('security.credential-rotation', () => {
  const account = (over: Record<string, unknown> = {}) => ({
    id: 1, provider: 'aws', accountId: '1', accountName: 'prod', isActive: true,
    authType: 'access_keys',
    credentialsUpdatedAt: new Date('2026-01-01T00:00:00Z'),  // 165 days before NOW
    lastSyncAt: NOW, lastValidatedAt: NOW, lastValidationError: null,
    ...over,
  });

  it('flags a stale access key at the policy severity', () => {
    // 165 days old against a 90-day window: over, but not yet doubled.
    const result = run('security.credential-rotation', dataset({ accounts: [account()] }));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].evidence?.ageDays).toBe(165);
    expect(result.findings[0].severity).toBeUndefined();
  });

  it('escalates a key more than twice past the rotation window', () => {
    const result = run('security.credential-rotation', dataset({
      accounts: [account({ credentialsUpdatedAt: new Date('2025-01-01T00:00:00Z') })],
    }));
    expect(result.findings[0].severity).toBe('critical');
  });

  it('does not apply to role-based connections', () => {
    // Assumed-role credentials are minted per call; there is no standing secret
    // to age, so flagging them would be noise that teaches people to ignore it.
    const result = run('security.credential-rotation', dataset({
      accounts: [account({ authType: 'assume_role' })],
    }));
    expect(result.findings).toHaveLength(0);
    expect(result.inconclusive).toBeDefined();
  });
});

describe('security.platform-hardening', () => {
  it('passes a correctly configured deployment', () => {
    const result = run('security.platform-hardening', dataset());
    expect(result.findings).toHaveLength(0);
  });

  it('flags a default session secret as critical', () => {
    const result = run('security.platform-hardening', dataset({
      platform: platform({ sessionSecretIsDefault: true, sessionSecretLength: 29 }),
    }));
    const finding = result.findings.find(f => f.resourceId === 'session-secret');
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('critical');
  });

  it('flags plaintext database transport and missing credential encryption', () => {
    const result = run('security.platform-hardening', dataset({
      platform: platform({ databaseTlsEnforced: false, credentialEncryptionConfigured: false }),
    }));
    const keys = result.findings.map(f => f.resourceId);
    expect(keys).toContain('database-tls');
    expect(keys).toContain('credential-encryption');
  });

  it('does not demand Secure cookies from a development server', () => {
    // Local development is served over HTTP by design. Flagging it every sweep
    // is how a team learns to ignore this policy entirely.
    const result = run('security.platform-hardening', dataset({
      platform: platform({ nodeEnv: 'development', secureCookies: false }),
    }));
    expect(result.findings.map(f => f.resourceId)).not.toContain('secure-cookies');
  });
});

// ── Access ────────────────────────────────────────────────────────────────────

describe('access.privileged-user-ceiling', () => {
  const user = (over: Record<string, unknown> = {}) => ({
    id: 1, username: 'a', email: null, role: 'viewer', isActive: true,
    isPlatformAdmin: false, lastLoginAt: NOW, createdAt: NOW, ...over,
  });

  it('flags more admins than the ceiling allows', () => {
    const result = run('access.privileged-user-ceiling', dataset({
      users: [
        user({ id: 1, role: 'owner' }), user({ id: 2, role: 'admin' }),
        user({ id: 3, role: 'admin' }), user({ id: 4, role: 'admin' }),
        user({ id: 5, role: 'viewer' }),
      ],
    }), { maxPrivilegedUsers: 3 });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].evidence?.privilegedCount).toBe(4);
  });

  it('does not count deactivated accounts as privilege', () => {
    const result = run('access.privileged-user-ceiling', dataset({
      users: [
        user({ id: 1, role: 'admin' }), user({ id: 2, role: 'admin' }),
        user({ id: 3, role: 'admin' }), user({ id: 4, role: 'admin', isActive: false }),
      ],
    }), { maxPrivilegedUsers: 3 });
    expect(result.findings).toHaveLength(0);
  });
});

describe('access.dormant-user', () => {
  const user = (over: Record<string, unknown> = {}) => ({
    id: 1, username: 'leaver', email: null, role: 'finops', isActive: true,
    isPlatformAdmin: false,
    lastLoginAt: new Date('2026-01-01T00:00:00Z'),
    createdAt: new Date('2025-01-01T00:00:00Z'),
    ...over,
  });

  it('flags an account idle past the window', () => {
    const result = run('access.dormant-user', dataset({ users: [user()] }), { maxIdleDays: 60 });
    expect(result.findings).toHaveLength(1);
  });

  it('raises severity when the dormant account is privileged', () => {
    const result = run('access.dormant-user', dataset({ users: [user({ role: 'admin' })] }));
    expect(result.findings[0].severity).toBe('high');
  });

  it('counts from creation for an account that never signed in', () => {
    const result = run('access.dormant-user', dataset({ users: [user({ lastLoginAt: null })] }));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].evidence?.neverLoggedIn).toBe(true);
  });

  it('can be told to ignore accounts that never signed in', () => {
    const result = run('access.dormant-user', dataset({
      users: [user({ lastLoginAt: null })],
    }), { includeNeverLoggedIn: false });
    expect(result.findings).toHaveLength(0);
  });
});

describe('access.agent-blast-radius', () => {
  const agent = (over: Record<string, unknown> = {}) => ({
    autoExecuteEnabled: false, safetyMode: true, dryRunMode: true,
    maxCostImpactWithoutApproval: 100, ...over,
  });

  it('accepts the safe defaults', () => {
    const result = run('access.agent-blast-radius', dataset({ agent: agent() }));
    expect(result.findings).toHaveLength(0);
  });

  it('flags the fully unrestricted combination as critical', () => {
    const result = run('access.agent-blast-radius', dataset({
      agent: agent({ autoExecuteEnabled: true, safetyMode: false, dryRunMode: false }),
    }));
    const unrestricted = result.findings.find(f => f.resourceId === 'unrestricted');
    expect(unrestricted?.severity).toBe('critical');
  });

  it('does not complain about a high ceiling while auto-execute is off', () => {
    // Nothing runs unattended, so the ceiling cannot be reached without a human.
    const result = run('access.agent-blast-radius', dataset({
      agent: agent({ autoExecuteEnabled: false, maxCostImpactWithoutApproval: 100000 }),
    }));
    expect(result.findings.map(f => f.resourceId)).not.toContain('unattended-ceiling');
  });
});

// ── Operations ────────────────────────────────────────────────────────────────

describe('ops.ingestion-freshness', () => {
  const account = {
    id: 1, provider: 'aws', accountId: '1', accountName: 'prod', isActive: true,
    authType: 'assume_role', credentialsUpdatedAt: NOW, lastSyncAt: NOW,
    lastValidatedAt: NOW, lastValidationError: null,
  };

  it('treats a provider that has never ingested as critical', () => {
    const result = run('ops.ingestion-freshness', dataset({ accounts: [account], ingestion: [] }));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('critical');
  });

  it('flags stale data against the freshness window', () => {
    const result = run('ops.ingestion-freshness', dataset({
      accounts: [account],
      ingestion: [{ provider: 'aws', accountId: null, lastSuccessAt: new Date('2026-06-10T12:00:00Z'), lastStatus: 'success' }],
    }), { maxStaleHours: 48 });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].evidence?.ageHours).toBe(120);
  });

  it('passes on fresh data', () => {
    const result = run('ops.ingestion-freshness', dataset({
      accounts: [account],
      ingestion: [{ provider: 'aws', accountId: null, lastSuccessAt: new Date('2026-06-15T06:00:00Z'), lastStatus: 'success' }],
    }));
    expect(result.findings).toHaveLength(0);
  });
});

describe('ops.connection-health', () => {
  const account = (over: Record<string, unknown> = {}) => ({
    id: 1, provider: 'aws', accountId: '1', accountName: 'prod', isActive: true,
    authType: 'assume_role', credentialsUpdatedAt: NOW, lastSyncAt: NOW,
    lastValidatedAt: NOW, lastValidationError: null, ...over,
  });

  it('treats a failing connection as critical', () => {
    const result = run('ops.connection-health', dataset({
      accounts: [account({ lastValidationError: 'AccessDenied' })],
    }));
    expect(result.findings[0].severity).toBe('critical');
  });

  it('flags a connection that has never been validated', () => {
    const result = run('ops.connection-health', dataset({
      accounts: [account({ lastValidatedAt: null })],
    }));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBeUndefined();
  });

  it('ignores inactive connections', () => {
    const result = run('ops.connection-health', dataset({
      accounts: [account({ isActive: false, lastValidationError: 'AccessDenied' })],
    }));
    expect(result.findings).toHaveLength(0);
  });
});
