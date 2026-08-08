/**
 * Role/permission matrix.
 *
 * Routes ask for a permission, never a role, so the matrix can change without
 * hunting through route handlers for role-name string comparisons.
 *
 * The split that matters most here is agent:propose / agent:approve /
 * agent:execute. An engineer may propose an optimization; approving and
 * executing one mutates live cloud infrastructure and belongs to different
 * people. Collapsing those three into "can use the agent" is how a FinOps tool
 * ends up terminating production instances.
 */
import type { UserRole } from "@shared/schema";

export const PERMISSIONS = [
  'cost:read',        // dashboards, reports, forecasts, anomalies
  'export:read',      // CSV/PDF export of cost data
  'budget:write',     // create/update budgets and alert rules
  'report:write',     // create/update report schedules
  'account:read',     // list cloud accounts (never returns credentials)
  'account:write',    // add/update/remove cloud accounts and their credentials
  'agent:propose',    // generate optimization plans and recommendations
  'agent:approve',    // approve a proposed action
  'agent:execute',    // execute or roll back an approved action
  'agent:configure',  // change agent safety settings (dry-run, auto-execute)
  'user:manage',      // create/update/remove users in the tenant
  'org:manage',       // organization settings
  'audit:read',       // read the audit log
] as const;

export type Permission = typeof PERMISSIONS[number];

const VIEWER: Permission[] = ['cost:read', 'account:read'];

const ENGINEER: Permission[] = [
  ...VIEWER,
  'export:read',
  'agent:propose',
];

const FINOPS: Permission[] = [
  ...ENGINEER,
  'budget:write',
  'report:write',
  'agent:approve',
];

const ADMIN: Permission[] = [
  ...FINOPS,
  'account:write',
  'agent:execute',
  'agent:configure',
  'user:manage',
  'audit:read',
];

const OWNER: Permission[] = [
  ...ADMIN,
  'org:manage',
];

export const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  viewer: VIEWER,
  engineer: ENGINEER,
  finops: FINOPS,
  admin: ADMIN,
  owner: OWNER,
};

export function roleHasPermission(role: UserRole | undefined, permission: Permission): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

export function permissionsForRole(role: UserRole | undefined): readonly Permission[] {
  if (!role) return [];
  return ROLE_PERMISSIONS[role] ?? [];
}

/**
 * Legacy roles predate the five-role model. The migration rewrites stored
 * values, but a session issued before the deploy still carries the old string.
 */
export function normalizeRole(role: string | undefined): UserRole {
  switch (role) {
    case 'owner':
    case 'admin':
    case 'finops':
    case 'engineer':
    case 'viewer':
      return role;
    case 'user':
      return 'finops';   // matches the migration's behaviour-preserving mapping
    default:
      return 'viewer';   // unknown role gets the least privilege
  }
}
