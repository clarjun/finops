/**
 * Privilege-tier logic, without a database.
 *
 * The tenant-isolation half of this lives in credential-provider.itest.ts,
 * because the isolation IS a SQL predicate — proving it with a mock would only
 * prove the mock.
 */
import { describe, it, expect } from 'vitest';
import {
  roleArnForTier,
  invalidateAwsSessions,
  awsSessionCacheStats,
  type AwsConnection,
} from './credential-provider';

const conn = (over: Partial<AwsConnection> = {}): AwsConnection => ({
  id: 1,
  organizationId: 42,
  accountId: '111111111111',
  accountName: 'acct',
  authType: 'assume_role',
  roleArn: 'arn:aws:iam::111111111111:role/ReadOnly',
  remediationRoleArn: 'arn:aws:iam::111111111111:role/Remediation',
  deployRoleArn: 'arn:aws:iam::111111111111:role/Deploy',
  externalId: null,
  credentials: {},
  ...over,
});

describe('privilege tier separation', () => {
  it('maps each tier to a distinct customer role', () => {
    const c = conn();
    const arns = [
      roleArnForTier(c, 'readonly'),
      roleArnForTier(c, 'remediation'),
      roleArnForTier(c, 'deploy'),
    ];
    // Three tiers, three roles. If any two collapsed, a read path would hold
    // write capability and the separation would be decorative.
    expect(new Set(arns).size).toBe(3);
  });

  it('does NOT fall back to the read-only role when a write tier is unset', () => {
    // The dangerous alternative is silently using the read-only role for a
    // remediation action: the call then fails deep inside an SDK request with an
    // opaque AccessDenied instead of "no remediation role configured".
    const c = conn({ remediationRoleArn: null, deployRoleArn: null });

    expect(roleArnForTier(c, 'remediation')).toBeNull();
    expect(roleArnForTier(c, 'deploy')).toBeNull();
    expect(roleArnForTier(c, 'readonly')).toBe('arn:aws:iam::111111111111:role/ReadOnly');
  });

  it('treats read-only as the safe default posture', () => {
    // A connection configured with only a read role is valid and expected —
    // most customers should start there and opt into write capability.
    const readOnly = conn({ remediationRoleArn: null, deployRoleArn: null });
    expect(roleArnForTier(readOnly, 'readonly')).not.toBeNull();
  });
});

describe('session cache', () => {
  it('clears completely on unscoped invalidation', () => {
    invalidateAwsSessions();
    expect(awsSessionCacheStats().sessions).toBe(0);
  });

  it('exposes only a count, never credential material', () => {
    const stats = awsSessionCacheStats();
    expect(Object.keys(stats)).toEqual(['sessions']);
    // Guards against someone later adding a debug field that leaks a session.
    expect(JSON.stringify(stats)).not.toMatch(/ASIA|aws_|secret|token/i);
  });
});
