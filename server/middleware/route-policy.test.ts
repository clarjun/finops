import { describe, it, expect } from 'vitest';
import { findRule, requiredPermission } from './route-policy';
import { roleHasPermission } from '../rbac';
import type { UserRole } from '@shared/schema';

/** What a role would get for a request: 'allow' or 'deny'. */
function access(role: UserRole, method: string, path: string): 'allow' | 'deny' {
  const permission = requiredPermission(method, path);
  if (permission === null) return findRule(method, path) ? 'deny' : 'deny'; // exempt paths tested separately
  return roleHasPermission(role, permission) ? 'allow' : 'deny';
}

describe('route policy: deny by default', () => {
  it('has no rule for an unknown endpoint, which the middleware turns into 403', () => {
    // This is the property that makes forgetting authorization a loud failure
    // in development rather than an open endpoint in production.
    expect(findRule('GET', '/api/something-nobody-thought-about')).toBeUndefined();
    expect(findRule('POST', '/api/v2/costs')).toBeUndefined();
    expect(findRule('DELETE', '/api/internal/reset')).toBeUndefined();
  });

  it('exempts only the login and health endpoints', () => {
    expect(requiredPermission('GET', '/api/health')).toBeNull();
    expect(requiredPermission('POST', '/api/auth/login')).toBeNull();
    expect(requiredPermission('POST', '/api/auth/logout')).toBeNull();
    expect(requiredPermission('GET', '/api/auth/me')).toBeNull();

    // Anything else under /api must resolve to a permission.
    expect(requiredPermission('GET', '/api/cost-data')).not.toBeNull();
    expect(requiredPermission('GET', '/api/cloud-accounts')).not.toBeNull();
  });
});

describe('route policy: agent execution', () => {
  it('requires agent:execute for anything that mutates infrastructure', () => {
    expect(requiredPermission('POST', '/api/agent/actions/1/execute')).toBe('agent:execute');
    expect(requiredPermission('POST', '/api/agent/actions/42/rollback')).toBe('agent:execute');
    expect(requiredPermission('POST', '/api/agent/actions/7/retry')).toBe('agent:execute');
    expect(requiredPermission('POST', '/api/agent/plans/3/execute')).toBe('agent:execute');
    expect(requiredPermission('POST', '/api/agent/auto-correct')).toBe('agent:execute');
  });

  it('requires a different permission to approve than to execute', () => {
    expect(requiredPermission('POST', '/api/agent/actions/1/approve')).toBe('agent:approve');
    expect(requiredPermission('POST', '/api/agent/actions/1/execute')).toBe('agent:execute');
  });

  it('requires agent:configure to change safety settings', () => {
    expect(requiredPermission('PUT', '/api/agent/config')).toBe('agent:configure');
    // ...but reading them is not privileged.
    expect(requiredPermission('GET', '/api/agent/config')).toBe('cost:read');
  });

  it('does not let a viewer or engineer execute', () => {
    for (const role of ['viewer', 'engineer', 'finops'] as UserRole[]) {
      expect(access(role, 'POST', '/api/agent/actions/1/execute')).toBe('deny');
    }
    expect(access('admin', 'POST', '/api/agent/actions/1/execute')).toBe('allow');
  });
});

describe('route policy: credentials', () => {
  it('separates reading accounts from writing them', () => {
    expect(requiredPermission('GET', '/api/cloud-accounts')).toBe('account:read');
    expect(requiredPermission('POST', '/api/cloud-accounts')).toBe('account:write');
    expect(requiredPermission('PATCH', '/api/cloud-accounts/3')).toBe('account:write');
    expect(requiredPermission('DELETE', '/api/cloud-accounts/3')).toBe('account:write');
  });

  it('does not let non-admins change cloud credentials', () => {
    for (const role of ['viewer', 'engineer', 'finops'] as UserRole[]) {
      expect(access(role, 'POST', '/api/cloud-accounts')).toBe('deny');
    }
    expect(access('admin', 'POST', '/api/cloud-accounts')).toBe('allow');
  });
});

describe('route policy: cost data', () => {
  it('lets any authenticated role read cost data', () => {
    for (const role of ['viewer', 'engineer', 'finops', 'admin', 'owner'] as UserRole[]) {
      expect(access(role, 'GET', '/api/costs/summary')).toBe('allow');
      expect(access(role, 'GET', '/api/costs/processed')).toBe('allow');
    }
  });

  it('treats triggering ingestion as an account action, because it spends money', () => {
    // Cost Explorer bills per request and a backfill issues many.
    expect(requiredPermission('POST', '/api/costs/ingest')).toBe('account:write');
    expect(access('viewer', 'POST', '/api/costs/ingest')).toBe('deny');
    expect(access('finops', 'POST', '/api/costs/ingest')).toBe('deny');
    expect(access('admin', 'POST', '/api/costs/ingest')).toBe('allow');
  });

  it('routes the more specific ingest rule before the general /api/costs/ rule', () => {
    // Ordering bug check: a general 'cost:read' rule placed first would make
    // ingestion readable by everyone.
    expect(requiredPermission('POST', '/api/costs/ingest')).not.toBe('cost:read');
  });
});

describe('route policy: users and audit', () => {
  it('restricts all user management to user:manage', () => {
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
      expect(requiredPermission(method, '/api/users')).toBe('user:manage');
    }
    expect(requiredPermission('PATCH', '/api/users/5')).toBe('user:manage');
  });

  it('restricts the audit log to audit:read', () => {
    expect(requiredPermission('GET', '/api/audit-logs')).toBe('audit:read');
    expect(access('finops', 'GET', '/api/audit-logs')).toBe('deny');
    expect(access('admin', 'GET', '/api/audit-logs')).toBe('allow');
  });

  it('reserves organization changes for the owner', () => {
    expect(requiredPermission('PATCH', '/api/organizations/1')).toBe('org:manage');
    expect(access('admin', 'PATCH', '/api/organizations/1')).toBe('deny');
    expect(access('owner', 'PATCH', '/api/organizations/1')).toBe('allow');
  });
});

describe('route policy: budgets and reports', () => {
  it('lets everyone read budgets but only finops and above change them', () => {
    expect(requiredPermission('GET', '/api/budgets')).toBe('cost:read');
    expect(requiredPermission('POST', '/api/budgets')).toBe('budget:write');
    expect(access('engineer', 'POST', '/api/budgets')).toBe('deny');
    expect(access('finops', 'POST', '/api/budgets')).toBe('allow');
  });

  it('requires report:write to schedule reports', () => {
    expect(requiredPermission('POST', '/api/reports/schedules')).toBe('report:write');
    expect(requiredPermission('GET', '/api/reports/schedules')).toBe('cost:read');
  });
});
