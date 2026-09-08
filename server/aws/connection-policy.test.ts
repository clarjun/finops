/**
 * The authorization surface for AWS connection endpoints.
 *
 * Asserted directly rather than through HTTP, because rule ORDER is the thing
 * most likely to be got wrong: findRule() returns the first match, so a general
 * pattern placed above a specific one silently shadows it. That failure is
 * invisible in normal use and only shows up as the wrong role being able — or
 * unable — to act.
 */
import { describe, it, expect } from 'vitest';
import { requiredPermission } from '../middleware/route-policy';
import { ROLE_PERMISSIONS, roleHasPermission } from '../rbac';

const can = (role: keyof typeof ROLE_PERMISSIONS, method: string, path: string) => {
  const needed = requiredPermission(method, path);
  return needed === null ? true : roleHasPermission(role, needed);
};

describe('AWS connection endpoint permissions', () => {
  it('requires account:write to create, change or revoke a connection', () => {
    expect(requiredPermission('POST', '/api/aws/connections')).toBe('account:write');
    expect(requiredPermission('PATCH', '/api/aws/connections/1')).toBe('account:write');
    expect(requiredPermission('DELETE', '/api/aws/connections/1')).toBe('account:write');
  });

  it('requires only account:read to validate', () => {
    // The specific rule must win over the general POST rule that follows it.
    expect(requiredPermission('POST', '/api/aws/connections/1/validate')).toBe('account:read');
    expect(requiredPermission('POST', '/api/aws/connections/12345/validate')).toBe('account:read');
  });

  it('requires account:read to list or view', () => {
    expect(requiredPermission('GET', '/api/aws/connections')).toBe('account:read');
    expect(requiredPermission('GET', '/api/aws/connections/1')).toBe('account:read');
  });
});

describe('who can do what', () => {
  it('lets viewer and finops see connections but not change them', () => {
    for (const role of ['viewer', 'finops'] as const) {
      expect(can(role, 'GET', '/api/aws/connections')).toBe(true);
      expect(can(role, 'POST', '/api/aws/connections/1/validate')).toBe(true);

      // Re-pointing a connection at a different AWS account is not a viewer's
      // decision, and a remediation role ARN grants write capability.
      expect(can(role, 'POST', '/api/aws/connections')).toBe(false);
      expect(can(role, 'PATCH', '/api/aws/connections/1')).toBe(false);
      expect(can(role, 'DELETE', '/api/aws/connections/1')).toBe(false);
    }
  });

  it('lets admin and owner manage connections', () => {
    for (const role of ['admin', 'owner'] as const) {
      expect(can(role, 'POST', '/api/aws/connections')).toBe(true);
      expect(can(role, 'PATCH', '/api/aws/connections/1')).toBe(true);
      expect(can(role, 'DELETE', '/api/aws/connections/1')).toBe(true);
    }
  });

  it('never leaves an AWS connection endpoint unprotected', () => {
    // The policy fails closed, but an endpoint matching no rule would be
    // rejected outright rather than served — so an unmatched path is a bug
    // either way and should be caught here.
    for (const [method, path] of [
      ['POST', '/api/aws/connections'],
      ['GET', '/api/aws/connections'],
      ['GET', '/api/aws/connections/1'],
      ['PATCH', '/api/aws/connections/1'],
      ['DELETE', '/api/aws/connections/1'],
      ['POST', '/api/aws/connections/1/validate'],
    ] as const) {
      expect(requiredPermission(method, path), `${method} ${path}`).not.toBeNull();
    }
  });
});
