import { describe, it, expect } from 'vitest';
import { parsePlanJson, redact, toHostMountPath } from './executor';

describe('plan parsing', () => {
  it('counts creates', () => {
    const r = parsePlanJson(JSON.stringify({
      resource_changes: [
        { address: 'aws_vpc.main', type: 'aws_vpc', change: { actions: ['create'] } },
        { address: 'aws_subnet.a', type: 'aws_subnet', change: { actions: ['create'] } },
      ],
    }));
    expect(r.toAdd).toBe(2);
    expect(r.toDestroy).toBe(0);
    expect(r.destructive).toEqual([]);
  });

  it('treats a replacement as destructive, not as a create', () => {
    // Terraform expresses replacement as ["delete","create"]. Reading only the
    // "create" would report destroying live infrastructure as an addition —
    // and it would skip the approval gate that destruction must trigger.
    const r = parsePlanJson(JSON.stringify({
      resource_changes: [
        { address: 'aws_db_instance.main', type: 'aws_db_instance', change: { actions: ['delete', 'create'] } },
      ],
    }));
    expect(r.changes[0].action).toBe('replace');
    expect(r.toAdd).toBe(1);
    expect(r.toDestroy).toBe(1);
    expect(r.destructive).toHaveLength(1);
  });

  it('classifies deletes and updates', () => {
    const r = parsePlanJson(JSON.stringify({
      resource_changes: [
        { address: 'aws_s3_bucket.old', type: 'aws_s3_bucket', change: { actions: ['delete'] } },
        { address: 'aws_security_group.x', type: 'aws_security_group', change: { actions: ['update'] } },
      ],
    }));
    expect(r.toDestroy).toBe(1);
    expect(r.toChange).toBe(1);
    expect(r.destructive.map((c) => c.address)).toEqual(['aws_s3_bucket.old']);
  });

  it('ignores no-op changes', () => {
    const r = parsePlanJson(JSON.stringify({
      resource_changes: [{ address: 'aws_vpc.main', type: 'aws_vpc', change: { actions: ['no-op'] } }],
    }));
    expect(r.changes).toEqual([]);
    expect(r.toAdd).toBe(0);
  });

  it('surfaces diagnostics', () => {
    const r = parsePlanJson(JSON.stringify({
      resource_changes: [],
      diagnostics: [{ severity: 'error', summary: 'Invalid AMI', detail: 'no such image' }],
    }));
    expect(r.diagnostics[0].summary).toBe('Invalid AMI');
  });

  it('returns an empty result rather than throwing on malformed output', () => {
    // A parse failure must not be mistaken for "no changes"; the caller checks
    // the command's own ok flag, and this only guarantees no exception.
    expect(parsePlanJson('not json').changes).toEqual([]);
    expect(parsePlanJson('').toAdd).toBe(0);
  });
});

describe('secret redaction', () => {
  it('removes credential values from captured output', () => {
    const secret = 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY';
    const out = redact(`Error using key ${secret} in region`, [secret]);
    expect(out).not.toContain(secret);
    expect(out).toContain('[redacted]');
  });

  it('leaves short values alone, since redacting them would corrupt output', () => {
    // A two-character "secret" would match everywhere and destroy the log.
    expect(redact('region us-east-1', ['us'])).toBe('region us-east-1');
  });

  it('handles multiple occurrences and multiple secrets', () => {
    const a = 'AKIAIOSFODNN7EXAMPLE';
    const b = 'wJalrXUtnFEMIK7MDENG';
    expect(redact(`${a} then ${b} then ${a}`, [a, b])).toBe('[redacted] then [redacted] then [redacted]');
  });
});

describe('host mount paths', () => {
  it('normalises Windows separators for Docker', () => {
    // Docker cannot mount a Git Bash POSIX path, and a backslash path is
    // rejected outright; this is what stopped /wd resolving during development.
    expect(toHostMountPath('C:\\Users\\x\\y')).toBe('C:/Users/x/y');
  });

  it('returns an absolute path', () => {
    expect(toHostMountPath('.')).toMatch(/^([A-Za-z]:\/|\/)/);
  });
});
