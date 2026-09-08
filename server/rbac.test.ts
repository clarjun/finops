import { describe, it, expect } from 'vitest';
import { USER_ROLES, type UserRole } from '@shared/schema';
import { ROLE_PERMISSIONS, roleHasPermission, permissionsForRole, normalizeRole, PERMISSIONS, type Permission } from './rbac';

describe('role/permission matrix', () => {
  it('defines permissions for every role', () => {
    for (const role of USER_ROLES) {
      expect(ROLE_PERMISSIONS[role], `no permissions defined for '${role}'`).toBeDefined();
    }
  });

  it('grants only permissions that exist', () => {
    for (const role of USER_ROLES) {
      for (const permission of ROLE_PERMISSIONS[role]) {
        expect(PERMISSIONS).toContain(permission);
      }
    }
  });

  it('is strictly cumulative as privilege increases', () => {
    // Each role must be a superset of the one below it. If this breaks, someone
    // has been promoted and lost an ability, which is the kind of bug that
    // surfaces as a confusing 403 in production.
    const ladder: UserRole[] = ['viewer', 'engineer', 'finops', 'admin', 'owner'];
    for (let i = 1; i < ladder.length; i++) {
      const lower = ROLE_PERMISSIONS[ladder[i - 1]];
      const higher = ROLE_PERMISSIONS[ladder[i]];
      for (const permission of lower) {
        expect(higher, `'${ladder[i]}' is missing '${permission}' held by '${ladder[i - 1]}'`).toContain(permission);
      }
    }
  });

  it('separates propose, approve and execute', () => {
    // The core safety property of the agent. Whoever proposes a change to live
    // infrastructure must not automatically be able to apply it.
    expect(roleHasPermission('engineer', 'agent:propose')).toBe(true);
    expect(roleHasPermission('engineer', 'agent:approve')).toBe(false);
    expect(roleHasPermission('engineer', 'agent:execute')).toBe(false);

    expect(roleHasPermission('finops', 'agent:approve')).toBe(true);
    expect(roleHasPermission('finops', 'agent:execute')).toBe(false);

    expect(roleHasPermission('admin', 'agent:execute')).toBe(true);
  });

  it('keeps viewers read-only', () => {
    const writes: Permission[] = [
      'budget:write', 'report:write', 'account:write',
      'agent:propose', 'agent:approve', 'agent:execute', 'agent:configure',
      'user:manage', 'org:manage',
    ];
    for (const permission of writes) {
      expect(roleHasPermission('viewer', permission), `viewer should not have '${permission}'`).toBe(false);
    }
    expect(roleHasPermission('viewer', 'cost:read')).toBe(true);
  });

  it('restricts credential and agent-safety changes to admin and above', () => {
    for (const role of ['viewer', 'engineer', 'finops'] as UserRole[]) {
      expect(roleHasPermission(role, 'account:write'), `${role} must not write credentials`).toBe(false);
      expect(roleHasPermission(role, 'agent:configure'), `${role} must not change agent safety`).toBe(false);
      expect(roleHasPermission(role, 'audit:read'), `${role} must not read the audit log`).toBe(false);
    }
  });

  it('reserves organization settings for the owner', () => {
    expect(roleHasPermission('admin', 'org:manage')).toBe(false);
    expect(roleHasPermission('owner', 'org:manage')).toBe(true);
  });

  it('gives the owner every permission', () => {
    for (const permission of PERMISSIONS) {
      expect(roleHasPermission('owner', permission), `owner missing '${permission}'`).toBe(true);
    }
  });
});

describe('normalizeRole', () => {
  it('passes through current roles', () => {
    for (const role of USER_ROLES) {
      expect(normalizeRole(role)).toBe(role);
    }
  });

  it('maps the legacy "user" role to finops, matching migration 0006', () => {
    // Behaviour-preserving: a legacy 'user' could reach every screen except
    // user management. If this mapping changes, the migration must change too.
    expect(normalizeRole('user')).toBe('finops');
  });

  it('falls back to least privilege for anything unrecognized', () => {
    expect(normalizeRole(undefined)).toBe('viewer');
    expect(normalizeRole('')).toBe('viewer');
    expect(normalizeRole('superadmin')).toBe('viewer');
    expect(normalizeRole('ADMIN')).toBe('viewer'); // case-sensitive by design
  });
});

describe('permissionsForRole', () => {
  it('returns an empty list rather than throwing for an unknown role', () => {
    expect(permissionsForRole(undefined)).toEqual([]);
    expect(permissionsForRole('nonsense' as UserRole)).toEqual([]);
  });
});
