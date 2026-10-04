/**
 * Authentication, tenant resolution and authorization for the whole API.
 *
 * Applied once at the app level rather than per route. Before this, `requireAuth`
 * existed but was referenced by exactly zero of the 68 handlers in routes.ts —
 * every cost, credential and agent-execution endpoint was reachable
 * unauthenticated, with the React router as the only gate. A deny-by-default
 * guard with a short explicit allowlist makes "I forgot to protect this route"
 * impossible; the failure mode inverts to "I forgot to allowlist this public
 * route", which shows up immediately in testing.
 */
import type { Express, Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { users, organizations } from "@shared/schema";
import { runWithTenant } from "../tenant-context";
import { normalizeRole, roleHasPermission, type Permission } from "../rbac";
import { recordAudit } from "../audit";

declare module 'express-session' {
  interface SessionData {
    userId: number;
    username: string;
    role: string;
    /** Set only when a platform admin is viewing a tenant other than their own. */
    activeOrganizationId?: number;
  }
}

/**
 * Routes reachable without a session. Everything else under /api requires one.
 *
 * This list and the EXEMPT pattern in route-policy.ts must agree. They are two
 * separate middlewares, and a route allowlisted in only one of them is still
 * refused by the other — which is how the GitHub setup callback below returned
 * 401 to GitHub's redirect while looking correctly configured.
 */
const PUBLIC_PATHS: Array<RegExp> = [
  /^\/api\/health$/,
  /^\/api\/ready$/,
  /^\/api\/auth\/login$/,
  /^\/api\/auth\/logout$/,
  /^\/api\/auth\/me$/,   // returns 401 itself, so the client can probe cheaply

  // GitHub redirects the BROWSER to these after the App is created or
  // installed. It is a plain top-level navigation from github.com, so no
  // session cookie is guaranteed to survive it and a session check rejects the
  // very response the flow depends on.
  //
  // They are not unauthenticated: the organization arrives in an HMAC-signed,
  // ten-minute `state` that the handler verifies in constant time before it
  // writes anything, and it establishes its own tenant context from that.
  /^\/api\/infra\/git\/app\/setup$/,
  /^\/api\/infra\/git\/app\/installed$/,
];

function isPublic(path: string): boolean {
  return PUBLIC_PATHS.some((p) => p.test(path));
}

/**
 * Authenticates the request, loads the live user record, and runs the remainder
 * of the request inside a tenant context.
 *
 * The user is re-read from the database on every request rather than trusted
 * from the session. A session cookie lives 24 hours; without this, deactivating
 * a user or downgrading their role would not take effect until it expired.
 */
export async function authGuard(req: Request, res: Response, next: NextFunction) {
  if (!req.path.startsWith('/api') || isPublic(req.path)) return next();

  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const [user] = await db.select().from(users).where(eq(users.id, req.session.userId));

    if (!user || !user.isActive) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Account is inactive' });
    }

    // Platform admins may act inside another tenant for support work. Everyone
    // else is pinned to their home organization regardless of what the session
    // claims.
    const organizationId = user.isPlatformAdmin
      ? req.session.activeOrganizationId ?? user.organizationId
      : user.organizationId;

    const [org] = await db.select().from(organizations).where(eq(organizations.id, organizationId));
    if (!org || org.status !== 'active') {
      return res.status(403).json({ error: 'Organization is not active' });
    }

    runWithTenant(
      {
        organizationId,
        userId: user.id,
        username: user.username,
        role: normalizeRole(user.role),
        isPlatformAdmin: user.isPlatformAdmin,
      },
      next
    );
  } catch (err: any) {
    console.error('[AuthGuard] Failed to resolve session:', err?.message ?? err);
    res.status(500).json({ error: 'Authentication check failed' });
  }
}

/**
 * Route-level authorization. Denials are audited — a rejected attempt to
 * execute an agent action is exactly the event a security review asks for.
 */
export function requirePermission(permission: Permission) {
  return function (req: Request, res: Response, next: NextFunction) {
    const role = normalizeRole(req.session?.role);

    if (!roleHasPermission(role, permission)) {
      void recordAudit({
        action: 'authz.denied',
        outcome: 'denied',
        method: req.method,
        path: req.originalUrl.split('?')[0],
        statusCode: 403,
        metadata: { requiredPermission: permission, role },
      });
      return res.status(403).json({
        error: 'Forbidden',
        detail: `This action requires the '${permission}' permission; your role is '${role}'.`,
      });
    }

    next();
  };
}

/** Cross-tenant operations (organization CRUD, platform metrics). */
export function requirePlatformAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Unauthorized' });

  // The guard already verified this against the live user row; the session copy
  // is only a fast path, so re-check the authoritative value.
  db.select({ isPlatformAdmin: users.isPlatformAdmin })
    .from(users)
    .where(eq(users.id, req.session.userId))
    .then(([row]) => {
      if (!row?.isPlatformAdmin) {
        void recordAudit({ action: 'authz.denied', outcome: 'denied', method: req.method,
          path: req.originalUrl.split('?')[0], statusCode: 403,
          metadata: { required: 'platform_admin' } });
        return res.status(403).json({ error: 'Forbidden' });
      }
      next();
    })
    .catch((err) => {
      console.error('[AuthGuard] Platform admin check failed:', err?.message ?? err);
      res.status(500).json({ error: 'Authorization check failed' });
    });
}

/**
 * Installs the guard. Must run before any API route is registered — Express
 * middleware only applies to routes added after it.
 */
export function installAuthGuard(app: Express) {
  // ── Liveness ───────────────────────────────────────────────────────────────
  //
  // "Is this process running?" — nothing more. It must not touch the database:
  // an orchestrator uses liveness to decide whether to RESTART a container, and
  // a liveness probe that fails when the database is briefly unreachable turns
  // a database blip into a restart loop that makes the outage worse.
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

  // ── Readiness ──────────────────────────────────────────────────────────────
  //
  // "Can this process actually serve a request?" — which means its dependencies
  // have to answer. Separate from liveness because the right response differs:
  // not ready means take me out of the load balancer, not kill me.
  //
  // This is what a deployment smoke test should check. A 200 from /api/health
  // only proves node started; the container can be happily serving while every
  // request that needs data fails, which is precisely the deployment you want
  // to roll back.
  app.get('/api/ready', async (_req, res) => {
    const started = Date.now();
    try {
      // Cheapest possible round trip that proves the pool can hand out a
      // working connection. Anything heavier turns the probe into load.
      await db.execute(sql`SELECT 1`);
      res.json({ status: 'ready', database: 'ok', checkedInMs: Date.now() - started });
    } catch (err: any) {
      // 503, not 500: this is "not ready yet", which is a normal state during a
      // rollout and a retryable one for whatever is probing.
      //
      // The message is deliberately not echoed back. A connection failure from
      // node-postgres can carry the host, port and user from the connection
      // string, and this endpoint is unauthenticated.
      console.error('[Readiness] Database check failed:', err?.message ?? err);
      res.status(503).json({ status: 'not_ready', database: 'unreachable' });
    }
  });

  app.use(authGuard);
}
