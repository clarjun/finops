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

/** Routes reachable without a session. Everything else under /api requires one. */
const PUBLIC_PATHS: Array<RegExp> = [
  /^\/api\/health$/,
  /^\/api\/auth\/login$/,
  /^\/api\/auth\/logout$/,
  /^\/api\/auth\/me$/,   // returns 401 itself, so the client can probe cheaply
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
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.use(authGuard);
}
