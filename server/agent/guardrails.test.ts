import { describe, it, expect } from 'vitest';
import { decide, isDestructive, type GuardrailConfig } from './guardrails';

/** Defaults matching a freshly created agent_config row: safe. */
const safeConfig = (over: Partial<GuardrailConfig> = {}): GuardrailConfig => ({
  dryRunMode: 1,
  safetyMode: 1,
  autoExecuteEnabled: 0,
  enabledProviders: null,
  enabledActionTypes: null,
  requireApprovalFor: null,
  maxCostImpactWithoutApproval: '100.00',
  ...over,
});

const action = (over: Partial<Parameters<typeof decide>[0]> = {}) => ({
  provider: 'aws',
  actionType: 'ec2_downsize',
  estimatedCostImpact: null,
  approvedBy: 'someone',
  ...over,
}) as Parameters<typeof decide>[0];

describe('guardrails: defaults', () => {
  it('simulates by default, so a fresh tenant cannot accidentally mutate infrastructure', () => {
    const d = decide(action(), safeConfig());
    expect(d.outcome).toBe('simulate');
    expect(d.dryRun).toBe(true);
  });

  it('executes only when dry-run is explicitly turned off', () => {
    const d = decide(action(), safeConfig({ dryRunMode: 0 }));
    expect(d.outcome).toBe('allow');
    expect(d.dryRun).toBe(false);
  });
});

describe('guardrails: safety mode', () => {
  const destructive = ['ebs_delete_snapshot', 'delete_volume', 'delete_bucket', 'terminate_instance'];

  it.each(destructive)('blocks %s while safety mode is on', (actionType) => {
    const d = decide(action({ actionType }), safeConfig({ dryRunMode: 0, safetyMode: 1 }));
    expect(d.outcome).toBe('block');
    expect(d.reasons.join(' ')).toMatch(/rollback cannot restore/);
  });

  it('blocks destructive actions even in dry-run mode', () => {
    // A block must not be downgraded to a harmless simulation, or turning
    // dry-run off later silently permits the action.
    const d = decide(action({ actionType: 'delete_volume' }), safeConfig({ dryRunMode: 1, safetyMode: 1 }));
    expect(d.outcome).toBe('block');
  });

  it('permits destructive actions when safety mode is deliberately off', () => {
    const d = decide(action({ actionType: 'delete_volume' }), safeConfig({ dryRunMode: 0, safetyMode: 0 }));
    expect(d.outcome).toBe('allow');
  });

  it('treats resize and lifecycle actions as non-destructive', () => {
    for (const t of ['ec2_downsize', 's3_lifecycle', 'stop_idle_instance', 'azure_vm_downsize']) {
      expect(isDestructive(t), `${t} should not be destructive`).toBe(false);
    }
  });
});

describe('guardrails: allow lists', () => {
  it('blocks a provider that is not enabled', () => {
    const d = decide(action({ provider: 'aws' }), safeConfig({ dryRunMode: 0, enabledProviders: ['azure', 'gcp'] }));
    expect(d.outcome).toBe('block');
    expect(d.reasons.join(' ')).toMatch(/Provider 'aws' is not enabled/);
  });

  it('allows a provider that is enabled', () => {
    const d = decide(action({ provider: 'aws' }), safeConfig({ dryRunMode: 0, enabledProviders: ['aws'] }));
    expect(d.outcome).toBe('allow');
  });

  it('blocks an action type that is not enabled', () => {
    const d = decide(action(), safeConfig({ dryRunMode: 0, enabledActionTypes: ['s3_lifecycle'] }));
    expect(d.outcome).toBe('block');
  });

  it('treats an empty or malformed list as "no restriction" rather than "block everything"', () => {
    // An empty array is ambiguous. Reading it as "nothing is allowed" would
    // brick the agent for anyone who cleared the field in the UI.
    expect(decide(action(), safeConfig({ dryRunMode: 0, enabledProviders: [] })).outcome).toBe('allow');
    expect(decide(action(), safeConfig({ dryRunMode: 0, enabledProviders: 'aws' })).outcome).toBe('allow');
    expect(decide(action(), safeConfig({ dryRunMode: 0, enabledActionTypes: [123, {}] })).outcome).toBe('allow');
  });
});

describe('guardrails: spend ceiling', () => {
  it('blocks a one-off charge above the ceiling with no named approver', () => {
    const d = decide(
      action({ estimatedCostImpact: '5000.00', approvedBy: null }),
      safeConfig({ dryRunMode: 0, maxCostImpactWithoutApproval: '100.00' }),
    );
    expect(d.outcome).toBe('block');
    expect(d.reasons.join(' ')).toMatch(/exceeds the \$100\.00 limit/);
  });

  it('allows the same charge once a human is named', () => {
    const d = decide(
      action({ estimatedCostImpact: '5000.00', approvedBy: 'finops-lead' }),
      safeConfig({ dryRunMode: 0, maxCostImpactWithoutApproval: '100.00' }),
    );
    expect(d.outcome).toBe('allow');
  });

  it('allows a charge at or below the ceiling', () => {
    const d = decide(
      action({ estimatedCostImpact: '100.00', approvedBy: null }),
      safeConfig({ dryRunMode: 0, maxCostImpactWithoutApproval: '100.00' }),
    );
    expect(d.outcome).toBe('allow');
  });

  it('ignores negative cost impact, which is a one-off saving not a charge', () => {
    const d = decide(
      action({ estimatedCostImpact: '-2000.00', approvedBy: null }),
      safeConfig({ dryRunMode: 0, maxCostImpactWithoutApproval: '100.00' }),
    );
    expect(d.outcome).toBe('allow');
  });

  it('does not apply a ceiling that is not configured', () => {
    const d = decide(
      action({ estimatedCostImpact: '999999.00', approvedBy: null }),
      safeConfig({ dryRunMode: 0, maxCostImpactWithoutApproval: null }),
    );
    expect(d.outcome).toBe('allow');
  });
});

describe('guardrails: always-approve list', () => {
  it('blocks a listed action type with no approver', () => {
    const d = decide(
      action({ approvedBy: null }),
      safeConfig({ dryRunMode: 0, requireApprovalFor: ['ec2_downsize'] }),
    );
    expect(d.outcome).toBe('block');
    expect(d.reasons.join(' ')).toMatch(/always requires named approval/);
  });

  it('allows it once approved', () => {
    const d = decide(
      action({ approvedBy: 'alice' }),
      safeConfig({ dryRunMode: 0, requireApprovalFor: ['ec2_downsize'] }),
    );
    expect(d.outcome).toBe('allow');
  });
});

describe('guardrails: precedence', () => {
  it('blocks rather than simulates when a rule is violated in dry-run mode', () => {
    // Ordering matters: if dry-run were checked first, a violation would be
    // reported as a harmless simulation and nobody would notice the rule.
    const d = decide(
      action({ provider: 'aws' }),
      safeConfig({ dryRunMode: 1, enabledProviders: ['gcp'] }),
    );
    expect(d.outcome).toBe('block');
  });

  it('always reports why', () => {
    for (const config of [safeConfig(), safeConfig({ dryRunMode: 0 }), safeConfig({ dryRunMode: 0, enabledProviders: ['gcp'] })]) {
      expect(decide(action(), config).reasons.length).toBeGreaterThan(0);
    }
  });
});
