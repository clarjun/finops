/**
 * Audit trail.
 *
 * Two ways in:
 *   1. auditMiddleware — blanket coverage of every state-changing HTTP request,
 *      so a new route is audited the day it is written rather than the day
 *      someone remembers to instrument it.
 *   2. recordAudit — explicit calls for things that are not a plain mutation:
 *      login outcomes, permission denials, agent executions, org switches.
 *
 * Writes never throw. An audit failure must not take down the request that
 * triggered it, but it is logged at error level so it surfaces in monitoring.
 */
import type { Request, Response, NextFunction } from "express";
import { db } from "./db";
import { auditLogs } from "@shared/schema";
import { getTenantContext } from "./tenant-context";

export interface AuditEntry {
  organizationId?: number;
  actorUserId?: number | null;
  actorUsername?: string | null;
  actorIp?: string | null;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  method?: string | null;
  path?: string | null;
  statusCode?: number | null;
  outcome?: 'success' | 'failure' | 'denied';
  metadata?: Record<string, unknown> | null;
}

export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    const ctx = getTenantContext();
    const organizationId = entry.organizationId ?? ctx?.organizationId;

    // An event with no tenant cannot be filed. Log it rather than dropping it
    // silently or writing it to an arbitrary org.
    if (!organizationId) {
      console.error('[Audit] Dropped event with no organization:', entry.action);
      return;
    }

    await db.insert(auditLogs).values({
      organizationId,
      actorUserId: entry.actorUserId ?? ctx?.userId ?? null,
      actorUsername: entry.actorUsername ?? ctx?.username ?? null,
      actorIp: entry.actorIp ?? null,
      action: entry.action,
      resourceType: entry.resourceType ?? null,
      resourceId: entry.resourceId ?? null,
      method: entry.method ?? null,
      path: entry.path ?? null,
      statusCode: entry.statusCode ?? null,
      outcome: entry.outcome ?? 'success',
      metadata: (entry.metadata ?? null) as any,
    });
  } catch (err: any) {
    console.error('[Audit] Failed to write audit entry:', err?.message ?? err);
  }
}

// ── Request → action naming ───────────────────────────────────────────────────

/**
 * Maps a request to a stable action name. Ordered longest-prefix-first; the
 * first match wins. Anything unmatched falls back to a derived name so new
 * routes are still recorded, just less prettily.
 */
const ACTION_RULES: Array<{ test: RegExp; resourceType: string; action: (method: string) => string }> = [
  { test: /^\/api\/agent\/actions\/[^/]+\/execute/,   resourceType: 'optimization_action', action: () => 'agent.action.execute' },
  { test: /^\/api\/agent\/actions\/[^/]+\/rollback/,  resourceType: 'optimization_action', action: () => 'agent.action.rollback' },
  { test: /^\/api\/agent\/actions\/[^/]+\/approve/,   resourceType: 'optimization_action', action: () => 'agent.action.approve' },
  { test: /^\/api\/agent\/actions\/[^/]+\/reject/,    resourceType: 'optimization_action', action: () => 'agent.action.reject' },
  { test: /^\/api\/agent\/actions\/[^/]+\/retry/,     resourceType: 'optimization_action', action: () => 'agent.action.retry' },
  { test: /^\/api\/agent\/plans\/[^/]+\/execute/,     resourceType: 'optimization_plan',   action: () => 'agent.plan.execute' },
  { test: /^\/api\/agent\/auto-correct/,              resourceType: 'optimization_action', action: () => 'agent.auto_correct' },
  { test: /^\/api\/agent\/config/,                    resourceType: 'agent_config',        action: () => 'agent.config.update' },
  { test: /^\/api\/agent\/plans/,                     resourceType: 'optimization_plan',   action: (m) => `agent.plan.${verb(m)}` },
  { test: /^\/api\/agent\/actions/,                   resourceType: 'optimization_action', action: (m) => `agent.action.${verb(m)}` },
  { test: /^\/api\/cloud-accounts/,                   resourceType: 'cloud_account',       action: (m) => `cloud_account.${verb(m)}` },
  { test: /^\/api\/azure\/config/,                    resourceType: 'cloud_account',       action: () => 'cloud_account.azure_config' },
  { test: /^\/api\/budgets/,                          resourceType: 'budget',              action: (m) => `budget.${verb(m)}` },
  { test: /^\/api\/alerts\/rules/,                    resourceType: 'alert_rule',          action: (m) => `alert_rule.${verb(m)}` },
  { test: /^\/api\/reports\/schedules/,               resourceType: 'report_schedule',     action: (m) => `report_schedule.${verb(m)}` },
  { test: /^\/api\/optimization\/recommendations/,    resourceType: 'recommendation',      action: (m) => `recommendation.${verb(m)}` },
  { test: /^\/api\/users/,                            resourceType: 'user',                action: (m) => `user.${verb(m)}` },
  { test: /^\/api\/organizations/,                    resourceType: 'organization',        action: (m) => `organization.${verb(m)}` },
];

function verb(method: string): string {
  switch (method) {
    case 'POST': return 'create';
    case 'PUT':
    case 'PATCH': return 'update';
    case 'DELETE': return 'delete';
    default: return method.toLowerCase();
  }
}

function describe(method: string, path: string): { action: string; resourceType: string | null } {
  for (const rule of ACTION_RULES) {
    if (rule.test.test(path)) {
      return { action: rule.action(method), resourceType: rule.resourceType };
    }
  }
  return { action: `http.${method.toLowerCase()}`, resourceType: null };
}

function clientIp(req: Request): string | null {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  return req.ip ?? null;
}

// Bodies can carry cloud credentials. Record which fields were sent, never
// their values.
const REDACT = /(secret|password|key|token|credential|clientsecret|privatekey)/i;

function safeMetadata(req: Request): Record<string, unknown> | null {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (REDACT.test(k)) {
      fields[k] = '[redacted]';
    } else if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
      fields[k] = typeof v === 'string' && v.length > 200 ? `${v.slice(0, 200)}…` : v;
    } else {
      fields[k] = `[${Array.isArray(v) ? 'array' : typeof v}]`;
    }
  }
  return Object.keys(fields).length > 0 ? { body: fields } : null;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Records every mutating API request once the response is known, so the entry
 * carries the real outcome rather than the intent.
 */
export function auditMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!MUTATING.has(req.method) || !req.path.startsWith('/api')) return next();

  // Login/logout are audited explicitly in auth.ts, where the username and the
  // reason for failure are known.
  if (req.path.startsWith('/api/auth/')) return next();

  const { action, resourceType } = describe(req.method, req.path);
  const metadata = safeMetadata(req);
  const ip = clientIp(req);
  // req.params is empty in app-level middleware (it is populated by route
  // matching, which has not happened yet), so take the id from the path.
  const resourceId = req.path.match(/\/(\d+)(?:\/|$)/)?.[1] ?? null;

  res.on('finish', () => {
    const outcome: AuditEntry['outcome'] =
      res.statusCode === 403 || res.statusCode === 401 ? 'denied'
      : res.statusCode >= 400 ? 'failure'
      : 'success';

    void recordAudit({
      action,
      resourceType,
      resourceId,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      statusCode: res.statusCode,
      outcome,
      actorIp: ip,
      metadata,
    });
  });

  next();
}
