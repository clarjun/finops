/**
 * These helpers are security controls, not formatting utilities. Each test
 * below corresponds to a way the cross-account trust model can be broken:
 * a guessable External ID, an ARN that points somewhere it should not, or a
 * session name AWS will reject at the worst possible moment.
 */
import { describe, it, expect } from 'vitest';
import {
  generateExternalId,
  isPlausibleExternalId,
  parseRoleArn,
  isValidRoleArn,
  buildSessionName,
} from './identity';

describe('External ID generation', () => {
  it('produces a recognisable, prefixed value', () => {
    expect(generateExternalId()).toMatch(/^cloudwise-[A-Za-z0-9_-]{43,}$/);
  });

  it('never repeats', () => {
    // 500 draws from a 256-bit space. A collision here means the generator is
    // not actually random, which is the whole failure mode being guarded.
    const seen = new Set(Array.from({ length: 500 }, () => generateExternalId()));
    expect(seen.size).toBe(500);
  });

  it('carries at least 256 bits of entropy', () => {
    // base64url: 4 chars per 3 bytes. 43 chars => 32 bytes => 256 bits.
    const body = generateExternalId().replace(/^cloudwise-/, '');
    expect(body.length).toBeGreaterThanOrEqual(43);
  });

  it('cannot be derived from tenant data, because it accepts none', () => {
    // The structural guarantee, and the strongest one available: a generator
    // that takes no input cannot encode a tenant id, account id or email.
    expect(generateExternalId.length).toBe(0);
  });

  it('does not embed identifiers a customer would know', () => {
    // Multi-character needles only. Asserting on a single character would fail
    // by chance against random base64url output roughly half the time — which
    // is a flaky test, not a security check.
    const id = generateExternalId().toLowerCase();
    for (const known of ['org1', '123456789012', 'acme', 'user@example.com', 'cirruslabs']) {
      expect(id).not.toContain(known.toLowerCase());
    }
  });

  it('accepts its own output and rejects weak values', () => {
    expect(isPlausibleExternalId(generateExternalId())).toBe(true);

    for (const weak of [
      'cloudwise-1',                                   // too short
      '550e8400-e29b-41d4-a716-446655440000',          // a UUID, unprefixed
      'cloudwise',                                     // prefix only
      '',
      null,
      undefined,
      12345,
    ]) {
      expect(isPlausibleExternalId(weak)).toBe(false);
    }
  });
});

describe('role ARN parsing', () => {
  it('extracts account, role name and path', () => {
    expect(parseRoleArn('arn:aws:iam::123456789012:role/CloudwiseFinOpsReadOnlyRole')).toEqual({
      accountId: '123456789012',
      roleName: 'CloudwiseFinOpsReadOnlyRole',
      path: '/',
    });
  });

  it('handles roles created under a path', () => {
    const parsed = parseRoleArn('arn:aws:iam::123456789012:role/service-roles/CloudwiseRole');
    expect(parsed).toEqual({
      accountId: '123456789012',
      roleName: 'CloudwiseRole',
      path: '/service-roles/',
    });
  });

  it('accepts non-commercial partitions', () => {
    // The ARN belongs to the customer, so GovCloud and China must parse.
    expect(parseRoleArn('arn:aws-us-gov:iam::123456789012:role/R')?.accountId).toBe('123456789012');
    expect(parseRoleArn('arn:aws-cn:iam::123456789012:role/R')?.accountId).toBe('123456789012');
  });

  it('rejects anything that is not an IAM role', () => {
    const rejected = [
      'arn:aws:iam::123456789012:user/alice',          // a user, not a role
      'arn:aws:iam::123456789012:policy/SomePolicy',   // a policy
      'arn:aws:s3:::my-bucket',                        // not IAM at all
      'arn:aws:sts::123456789012:assumed-role/X/Y',    // already-assumed session
      'arn:aws:iam::12345:role/TooShortAccount',       // account not 12 digits
      'arn:aws:iam::123456789012:role/',               // empty role name
      'arn:aws:iam::123456789012:role/bad name',       // space is not permitted
      'not-an-arn',
      '',
      null,
      undefined,
      42,
    ];
    for (const value of rejected) {
      expect(parseRoleArn(value as never), `should reject: ${String(value)}`).toBeNull();
      expect(isValidRoleArn(value as never)).toBe(false);
    }
  });

  it('tolerates surrounding whitespace from a pasted value', () => {
    // Users paste ARNs out of the AWS console; a trailing newline should not
    // read as a malformed configuration.
    expect(isValidRoleArn('  arn:aws:iam::123456789012:role/R\n')).toBe(true);
  });
});

describe('session names', () => {
  it('identifies the product, tier and tenant', () => {
    const name = buildSessionName(42, 'readonly');
    expect(name).toBe('cloudwise-readonly-org42');
  });

  it('stays inside the characters AWS permits', () => {
    // Rejected at the API otherwise, and it would surface as an opaque
    // validation error in the middle of a cost fetch rather than at setup.
    for (const tier of ['readonly', 'remediation', 'deploy']) {
      for (const org of [1, 999999, 2 ** 31 - 1]) {
        const name = buildSessionName(org, tier);
        expect(name).toMatch(/^[\w+=,.@-]{2,64}$/);
      }
    }
  });

  it('distinguishes tiers, so CloudTrail shows which role acted', () => {
    const names = ['readonly', 'remediation', 'deploy'].map((t) => buildSessionName(7, t));
    expect(new Set(names).size).toBe(3);
  });

  it('does not leak identifying detail beyond the tenant number', () => {
    const name = buildSessionName(42, 'readonly');
    expect(name).not.toMatch(/@/);          // no emails
    expect(name.length).toBeLessThanOrEqual(64);
  });
});
