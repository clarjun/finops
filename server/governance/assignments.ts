/**
 * Resolving "what does this policy actually do for this tenant".
 *
 * The catalog ships defaults; a tenant stores only what it changed. Everything
 * that needs the effective configuration — the engine, the API, the UI — goes
 * through resolveAssignments() so there is exactly one place where a default
 * becomes a decision, and no caller has to remember that a missing row means
 * "enabled with catalog defaults" rather than "disabled".
 */
import { eq } from "drizzle-orm";
import { db } from "../db";
import { governancePolicyAssignments, users } from "@shared/schema";
import { currentOrgId } from "../tenant-context";
import {
  POLICY_SEVERITIES,
  ENFORCEMENT_MODES,
  type PolicyDescriptor,
  type PolicyScope,
  type PolicySeverity,
  type EnforcementMode,
  type PolicyAssignmentView,
} from "@shared/governance";
import { POLICIES, defaultParameters } from "./catalog";
import { sanitizeScope } from "./scope";

export interface ResolvedAssignment {
  descriptor: PolicyDescriptor;
  enabled: boolean;
  severity: PolicySeverity;
  enforcement: EnforcementMode;
  parameters: Record<string, unknown>;
  scope: PolicyScope;
  isDefault: boolean;
  updatedAt: Date | null;
  updatedBy: number | null;
}

function asSeverity(v: unknown, fallback: PolicySeverity): PolicySeverity {
  return POLICY_SEVERITIES.includes(v as PolicySeverity) ? (v as PolicySeverity) : fallback;
}

function asEnforcement(v: unknown, fallback: EnforcementMode): EnforcementMode {
  return ENFORCEMENT_MODES.includes(v as EnforcementMode) ? (v as EnforcementMode) : fallback;
}

/**
 * Stored parameters are merged over the catalog defaults rather than replacing
 * them. Adding a parameter to an existing policy in a later release therefore
 * cannot leave tenants who customised it running with that parameter undefined.
 */
function mergeParameters(descriptor: PolicyDescriptor, stored: unknown): Record<string, unknown> {
  const merged = defaultParameters(descriptor);
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
      // Only keys the catalog declares. A stale key from a removed parameter
      // would otherwise persist forever and confuse the next reader.
      if (descriptor.parameters.some(p => p.key === k)) merged[k] = v;
    }
  }
  return merged;
}

export async function resolveAssignments(): Promise<ResolvedAssignment[]> {
  const orgId = currentOrgId();
  const stored = await db
    .select()
    .from(governancePolicyAssignments)
    .where(eq(governancePolicyAssignments.organizationId, orgId));

  const byKey = new Map(stored.map(row => [row.policyKey, row]));

  return POLICIES.map(({ descriptor }): ResolvedAssignment => {
    const row = byKey.get(descriptor.key);
    if (!row) {
      return {
        descriptor,
        enabled: descriptor.defaultEnabled,
        severity: descriptor.severity,
        enforcement: descriptor.defaultEnforcement,
        parameters: defaultParameters(descriptor),
        scope: {},
        isDefault: true,
        updatedAt: null,
        updatedBy: null,
      };
    }

    return {
      descriptor,
      enabled: row.enabled,
      severity: asSeverity(row.severity, descriptor.severity),
      enforcement: asEnforcement(row.enforcement, descriptor.defaultEnforcement),
      parameters: mergeParameters(descriptor, row.parameters),
      scope: sanitizeScope(row.scope),
      isDefault: false,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    };
  });
}

/** Serialises an assignment for the client, resolving the editor's username. */
export async function toAssignmentViews(
  assignments: ResolvedAssignment[],
): Promise<Map<string, PolicyAssignmentView>> {
  const editorIds = Array.from(new Set(assignments.map(a => a.updatedBy).filter((id): id is number => id !== null)));

  const names = new Map<number, string>();
  if (editorIds.length > 0) {
    const rows = await db.select({ id: users.id, username: users.username }).from(users);
    for (const r of rows) names.set(r.id, r.username);
  }

  return new Map(assignments.map(a => [a.descriptor.key, {
    policyKey: a.descriptor.key,
    enabled: a.enabled,
    severity: a.severity,
    enforcement: a.enforcement,
    parameters: a.parameters,
    scope: a.scope,
    updatedAt: a.updatedAt ? a.updatedAt.toISOString() : null,
    updatedByUsername: a.updatedBy !== null ? names.get(a.updatedBy) ?? null : null,
    isDefault: a.isDefault,
  }]));
}

/**
 * Validates a parameter bag against what the policy declares.
 *
 * Coerces rather than rejects where the intent is unambiguous — "90" for a
 * number, a comma-separated string for a list — because these values arrive
 * from form inputs, and rejecting a string that obviously means 90 is hostile
 * for no security benefit. Anything genuinely unresolvable is dropped and named
 * in the returned errors so the caller can say which field was ignored.
 */
export function validateParameters(
  descriptor: PolicyDescriptor,
  input: unknown,
): { parameters: Record<string, unknown>; errors: string[] } {
  const errors: string[] = [];
  const out = defaultParameters(descriptor);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { parameters: out, errors };

  const raw = input as Record<string, unknown>;

  for (const spec of descriptor.parameters) {
    if (!(spec.key in raw)) continue;
    const value = raw[spec.key];

    switch (spec.type) {
      case 'number':
      case 'percent':
      case 'currency': {
        const n = typeof value === 'string' ? Number(value) : value;
        if (typeof n !== 'number' || !Number.isFinite(n)) {
          errors.push(`${spec.label}: "${String(value)}" is not a number; keeping the default.`);
          break;
        }
        const min = spec.min ?? (spec.type === 'percent' ? 0 : undefined);
        const max = spec.max ?? (spec.type === 'percent' ? 100 : undefined);
        if (min !== undefined && n < min) {
          errors.push(`${spec.label}: raised to the minimum of ${min}.`);
          out[spec.key] = min;
        } else if (max !== undefined && n > max) {
          errors.push(`${spec.label}: lowered to the maximum of ${max}.`);
          out[spec.key] = max;
        } else {
          out[spec.key] = n;
        }
        break;
      }
      case 'boolean':
        out[spec.key] = value === true || value === 'true';
        break;
      case 'string':
        if (typeof value === 'string' && value.trim()) out[spec.key] = value.trim().slice(0, 255);
        else errors.push(`${spec.label}: empty value ignored.`);
        break;
      case 'stringList': {
        const list = Array.isArray(value)
          ? value
          : typeof value === 'string' ? value.split(',') : null;
        if (list === null) {
          errors.push(`${spec.label}: expected a list; keeping the default.`);
          break;
        }
        out[spec.key] = list
          .filter((v): v is string => typeof v === 'string')
          .map(v => v.trim())
          .filter(Boolean)
          .slice(0, 200);
        break;
      }
    }
  }

  return { parameters: out, errors };
}
