/**
 * A diagnosis is shown to someone deciding what to do about a stopped
 * deployment, so a confident wrong answer is worse than no answer — it sends
 * them looking in the wrong place. These tests are mostly about the cases where
 * this module must decline to guess.
 */
import { describe, it, expect } from 'vitest';
import { diagnose, isAutoApplicable } from './remedies';

describe('the spec’s own example: a database that cannot be placed', () => {
  const ERROR = 'Error creating DB Subnet Group: DBSubnetGroupDoesNotCoverEnoughAZs: The DB subnet group does not cover at least two availability zones.';

  it('names the cause rather than repeating the error', () => {
    const r = diagnose(ERROR, { clarifications: { availability: 'standard' } })!;
    expect(r.code).toBe('rds-subnet-group-azs');
    expect(r.title).toMatch(/two availability zones/i);
    expect(r.docUrl).toBeTruthy();
  });

  it('proposes the answer that would fix it', () => {
    const r = diagnose(ERROR, { clarifications: { availability: 'standard' } })!;
    expect(isAutoApplicable(r)).toBe(true);
    expect(r.change).toEqual({ field: 'availability', to: 'multi_az', describes: expect.any(String) });
  });

  it('does not propose a change that is already in place', () => {
    // The plan already asks for multiple zones, so "set it to multi_az" would
    // claim to fix something it cannot. Guidance, not a false remedy.
    const r = diagnose(ERROR, { clarifications: { availability: 'multi_az' } })!;
    expect(isAutoApplicable(r)).toBe(false);
    expect(r.manualSteps?.length).toBeGreaterThan(0);
  });
});

describe('permissions', () => {
  it('names the action AWS refused', () => {
    // The whole value of this diagnosis: the error contains the exact IAM
    // action, and repeating "AccessDenied" throws that away.
    const r = diagnose('UnauthorizedOperation: User: arn:aws:iam::1:user/ci is not authorized to perform: ec2:CreateVpc')!;
    expect(r.code).toBe('iam-permission-missing');
    expect(r.title).toContain('ec2:CreateVpc');
    expect(r.manualSteps?.join(' ')).toContain('ec2:CreateVpc');
  });

  it('still helps when no action is named', () => {
    const r = diagnose('AccessDenied')!;
    expect(r.code).toBe('iam-permission-missing');
    expect(r.title).toMatch(/missing a permission/i);
  });

  it('never proposes an automatic fix for a permission', () => {
    // Nothing this system can change makes an IAM grant appear.
    expect(isAutoApplicable(diagnose('AccessDenied: not authorized to perform: s3:PutObject'))).toBe(false);
  });
});

describe('account limits', () => {
  it('names the quota', () => {
    const r = diagnose('VcpuLimitExceeded: You have requested more vCPU capacity than your current quota allows')!;
    expect(r.code).toBe('quota-exhausted');
    expect(r.title).toContain('VcpuLimitExceeded');
  });

  it('says the architecture does not need to change', () => {
    const r = diagnose('AddressLimitExceeded')!;
    expect(r.explanation).toMatch(/account rather than a problem with the plan/i);
  });

  it('does not mistake throttling for an exhausted quota', () => {
    // RequestLimitExceeded contains "LimitExceeded". Diagnosing it as a quota
    // would send someone to Service Quotas over a two-second throttle.
    expect(diagnose('RequestLimitExceeded: Request limit exceeded')?.code).not.toBe('quota-exhausted');
  });
});

describe('other recognised failures', () => {
  it('recognises expired credentials', () => {
    const r = diagnose('ExpiredToken: The security token included in the request is expired')!;
    expect(r.code).toBe('credentials-expired');
    // It must not suggest reading them; they are encrypted and unreadable here.
    expect(r.explanation).toMatch(/not readable/i);
  });

  it('recognises a capacity shortage as temporary', () => {
    const r = diagnose('InsufficientInstanceCapacity: We currently do not have sufficient capacity')!;
    expect(r.code).toBe('no-capacity');
    expect(r.explanation).toMatch(/temporary/i);
  });

  it('quotes the value the provider rejected', () => {
    const r = diagnose('InvalidParameterValue: Invalid DB instance class: db.t9.enormous')!;
    expect(r.code).toBe('invalid-parameter');
    expect(r.title).toContain('db.t9.enormous');
    expect(r.docUrl).toBeTruthy();
  });

  it('recognises a name collision and points at the earlier deployment', () => {
    const r = diagnose('BucketAlreadyExists: The requested bucket name is not available')!;
    expect(r.code).toBe('name-taken');
    expect(r.manualSteps?.join(' ')).toMatch(/earlier deployment/i);
  });
});

describe('declining to guess', () => {
  it('returns nothing for an unrecognised error', () => {
    // No diagnosis beats a wrong one: this is what stops the UI asserting a
    // cause it cannot support.
    expect(diagnose('Error: the flux capacitor is misaligned')).toBeNull();
  });

  it('returns nothing for empty input', () => {
    expect(diagnose('')).toBeNull();
    expect(diagnose(undefined as unknown as string)).toBeNull();
  });

  it('treats a null remedy as not applicable', () => {
    expect(isAutoApplicable(null)).toBe(false);
  });
});
