/**
 * Local authentication and tenant-scoped user management.
 *
 * Session establishment only. Everything downstream — who you are, which tenant
 * you act in, what you may do — is enforced by server/middleware/auth-guard.ts,
 * which runs before these routes.
 */
import { type Express, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { and, eq } from 'drizzle-orm';
import { db } from './db';
import { users, organizations, USER_ROLES, type UserRole } from '@shared/schema';
import { currentOrgId } from './tenant-context';
import { normalizeRole, permissionsForRole } from './rbac';
import { validatePassword, BCRYPT_ROUNDS } from '@shared/password-policy';
import { requirePermission, requirePlatformAdmin } from './middleware/auth-guard';
import { mintCsrfToken, setCsrfCookie, clearCsrfCookie } from './middleware/csrf';
import { recordAudit } from './audit';

// Session shape is declared once, in middleware/auth-guard.ts.

/** Privilege ordering, used to stop an admin from minting a more powerful account than their own. */
const ROLE_RANK: Record<UserRole, number> = {
  viewer: 0, engineer: 1, finops: 2, admin: 3, owner: 4,
};

/**
 * Per-account lockout.
 *
 * Five attempts then fifteen minutes. Short enough that a user who genuinely
 * mistyped their password is not calling support, long enough that an automated
 * list of ten thousand passwords takes years rather than an afternoon.
 *
 * Deliberately NOT permanent: a permanent lock hands any anonymous attacker a
 * denial-of-service against a named user, which is a worse outcome than the
 * guessing it prevents.
 */
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

function clientIp(req: Request): string | null {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  return req.ip ?? null;
}

/** Never leak passwordHash to a client. */
function publicUser(u: typeof users.$inferSelect) {
  return {
    id: u.id,
    organizationId: u.organizationId,
    username: u.username,
    email: u.email,
    fullName: u.fullName,
    role: normalizeRole(u.role),
    isPlatformAdmin: u.isPlatformAdmin,
    isActive: u.isActive,
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
  };
}

export function registerAuthRoutes(app: Express) {

  // ── Session ─────────────────────────────────────────────────────────────────

  // POST /api/auth/login
  app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body ?? {};
    const ip = clientIp(req);

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    /** One response shape for every failure, so this cannot enumerate accounts. */
    const reject = (user: typeof users.$inferSelect | undefined, reason: string) => {
      void recordAudit({
        organizationId: user?.organizationId,
        action: 'auth.login',
        outcome: 'failure',
        actorUserId: user?.id ?? null,
        actorUsername: username,
        actorIp: ip,
        method: 'POST',
        path: '/api/auth/login',
        statusCode: 401,
        metadata: { reason },
      });
      return res.status(401).json({ error: 'Invalid credentials' });
    };

    try {
      const [user] = await db.select().from(users).where(eq(users.username, username));

      // Timing note: an unknown username skips bcrypt and so answers faster
      // than a wrong password does. Closing that gap means hashing against a
      // dummy digest on every miss — worth doing, and a separate change from
      // this one so it can be measured rather than assumed.
      if (!user) return reject(undefined, 'unknown_user');
      if (!user.isActive) return reject(user, 'inactive');

      const now = new Date();

      if (user.lockedUntil && user.lockedUntil > now) {
        const minutes = Math.ceil((user.lockedUntil.getTime() - now.getTime()) / 60_000);
        void recordAudit({
          organizationId: user.organizationId, action: 'auth.login', outcome: 'denied',
          actorUserId: user.id, actorUsername: user.username, actorIp: ip, statusCode: 423,
          metadata: { reason: 'locked_out', unlocksInMinutes: minutes },
        });
        // A distinct status, unlike the enumeration-safe 401 above. Whoever
        // triggered the lock already knows the account exists, so telling the
        // real owner why they cannot sign in leaks nothing and saves a support
        // call.
        return res.status(423).json({
          error: 'Account temporarily locked',
          detail: `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        });
      }

      if (!(await bcrypt.compare(password, user.passwordHash))) {
        // An expired lock resets the count: the previous window was already
        // served, and carrying its attempts forward would lock the account
        // again on the first typo after it unlocked.
        const priorAttempts = user.lockedUntil && user.lockedUntil <= now ? 0 : user.failedLoginAttempts;
        const attempts = priorAttempts + 1;
        const locking = attempts >= MAX_FAILED_ATTEMPTS;

        await db.update(users).set({
          failedLoginAttempts: locking ? 0 : attempts,
          lockedUntil: locking ? new Date(now.getTime() + LOCKOUT_MINUTES * 60_000) : null,
        }).where(eq(users.id, user.id));

        if (locking) {
          void recordAudit({
            organizationId: user.organizationId, action: 'auth.lockout', outcome: 'denied',
            actorUserId: user.id, actorUsername: user.username, actorIp: ip, statusCode: 423,
            metadata: { failedAttempts: attempts, lockoutMinutes: LOCKOUT_MINUTES },
          });
        }

        return reject(user, 'bad_password');
      }

      const [org] = await db.select().from(organizations).where(eq(organizations.id, user.organizationId));
      if (!org || org.status !== 'active') {
        void recordAudit({
          organizationId: user.organizationId, action: 'auth.login', outcome: 'denied',
          actorUserId: user.id, actorUsername: user.username, actorIp: ip, statusCode: 403,
          metadata: { reason: 'organization_suspended' },
        });
        return res.status(403).json({ error: 'Organization is not active' });
      }

      // Session fixation: take a NEW session id at the moment privilege
      // changes. Without this, anyone who can plant a cookie on the victim's
      // browser before sign-in — a shared parent domain, an XSS on a sibling
      // app — holds an id that silently becomes an authenticated session.
      req.session.regenerate((regenErr) => {
        if (regenErr) {
          console.error('[Auth] Session regeneration failed:', regenErr);
          return res.status(500).json({ error: 'Session error' });
        }

        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.role = normalizeRole(user.role);
        req.session.activeOrganizationId = user.organizationId;
        // Minted with the new session id, so a token observed before sign-in
        // cannot be replayed against the authenticated session.
        req.session.csrfToken = mintCsrfToken();

        // Save explicitly so the cookie is set before we respond.
        req.session.save(async (err) => {
          if (err) return res.status(500).json({ error: 'Session error' });

          setCsrfCookie(res, req.session.csrfToken!);

          // After the session exists: failing to clear the counter must not
          // cost the user the sign-in they just completed correctly.
          try {
            await db.update(users).set({
              lastLoginAt: new Date(),
              lastLoginIp: ip,
              failedLoginAttempts: 0,
              lockedUntil: null,
            }).where(eq(users.id, user.id));
          } catch (e: any) {
            console.error('[Auth] Failed to record successful login:', e?.message ?? e);
          }

          void recordAudit({
            organizationId: user.organizationId, action: 'auth.login', outcome: 'success',
            actorUserId: user.id, actorUsername: user.username, actorIp: ip,
            method: 'POST', path: '/api/auth/login', statusCode: 200,
            metadata: { priorFailedAttempts: user.failedLoginAttempts },
          });

          res.json({
            success: true,
            user: publicUser(user),
            organization: { id: org.id, name: org.name, slug: org.slug, plan: org.plan },
            permissions: permissionsForRole(normalizeRole(user.role)),
          });
        });
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/auth/logout
  app.post('/api/auth/logout', (req, res) => {
    const { userId, username, activeOrganizationId } = req.session ?? {};
    if (userId && activeOrganizationId) {
      void recordAudit({
        organizationId: activeOrganizationId, action: 'auth.logout', outcome: 'success',
        actorUserId: userId, actorUsername: username, actorIp: clientIp(req),
      });
    }
    req.session.destroy(() => {
      // The token is worthless without the session, but leaving it behind means
      // the next visitor to this browser sends a stale one and gets a confusing
      // 403 instead of a clean 401.
      clearCsrfCookie(res);
      res.json({ success: true });
    });
  });

  // GET /api/auth/me
  app.get('/api/auth/me', async (req, res) => {
    if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });

    const [user] = await db.select().from(users).where(eq(users.id, req.session.userId));
    if (!user || !user.isActive) return res.status(401).json({ error: 'Not authenticated' });

    const activeOrgId = user.isPlatformAdmin
      ? req.session.activeOrganizationId ?? user.organizationId
      : user.organizationId;
    const [org] = await db.select().from(organizations).where(eq(organizations.id, activeOrgId));

    res.json({
      ...publicUser(user),
      activeOrganizationId: activeOrgId,
      organization: org ? { id: org.id, name: org.name, slug: org.slug, plan: org.plan } : null,
      permissions: permissionsForRole(normalizeRole(user.role)),
    });
  });

  // POST /api/auth/switch-organization — platform-admin support access.
  app.post('/api/auth/switch-organization', requirePlatformAdmin, async (req, res) => {
    const targetId = Number(req.body?.organizationId);
    if (!Number.isInteger(targetId)) {
      return res.status(400).json({ error: 'organizationId is required' });
    }

    const [org] = await db.select().from(organizations).where(eq(organizations.id, targetId));
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    const previous = req.session.activeOrganizationId;
    req.session.activeOrganizationId = targetId;

    req.session.save((err) => {
      if (err) return res.status(500).json({ error: 'Session error' });

      // Recorded against the tenant being entered, so it appears in that
      // customer's audit trail rather than only in ours.
      void recordAudit({
        organizationId: targetId, action: 'auth.switch_organization', outcome: 'success',
        actorUserId: req.session.userId, actorUsername: req.session.username,
        actorIp: clientIp(req), resourceType: 'organization', resourceId: String(targetId),
        metadata: { from: previous ?? null, to: targetId },
      });

      res.json({ success: true, organization: { id: org.id, name: org.name, slug: org.slug } });
    });
  });

  // ── User management (tenant-scoped) ─────────────────────────────────────────

  // GET /api/users — users in the caller's organization only.
  app.get('/api/users', requirePermission('user:manage'), async (_req, res) => {
    const rows = await db.select().from(users).where(eq(users.organizationId, currentOrgId()));
    res.json({ users: rows.map(publicUser) });
  });

  // POST /api/users
  app.post('/api/users', requirePermission('user:manage'), async (req, res) => {
    const { username, password, role = 'viewer', email, fullName } = req.body ?? {};

    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    if (!USER_ROLES.includes(role)) {
      return res.status(400).json({ error: `Invalid role. Expected one of: ${USER_ROLES.join(', ')}` });
    }

    const callerRole = normalizeRole(req.session.role);
    if (ROLE_RANK[role as UserRole] > ROLE_RANK[callerRole]) {
      return res.status(403).json({ error: `You cannot grant '${role}' — it outranks your own role.` });
    }

    const policy = validatePassword(password);
    if (!policy.valid) {
      return res.status(400).json({ error: policy.error });
    }

    try {
      const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const [created] = await db.insert(users).values({
        organizationId: currentOrgId(),
        username,
        email: email ?? null,
        fullName: fullName ?? null,
        passwordHash: hash,
        role,
        createdBy: req.session.userId,
      }).returning();

      res.json({ success: true, user: publicUser(created) });
    } catch (e: any) {
      if (e.message?.includes('unique')) return res.status(409).json({ error: 'Username already exists' });
      res.status(500).json({ error: e.message });
    }
  });

  // PATCH /api/users/:id
  app.patch('/api/users/:id', requirePermission('user:manage'), async (req, res) => {
    const id = Number(req.params.id);
    const { username, password, role, isActive, email, fullName } = req.body ?? {};
    const callerRole = normalizeRole(req.session.role);

    if (id === req.session.userId && isActive === false) {
      return res.status(400).json({ error: 'Cannot deactivate your own account' });
    }

    // Scoping the lookup to the tenant is what stops one org's admin from
    // editing another org's users by guessing an id.
    const [target] = await db.select().from(users)
      .where(and(eq(users.id, id), eq(users.organizationId, currentOrgId())));
    if (!target) return res.status(404).json({ error: 'User not found' });

    if (ROLE_RANK[normalizeRole(target.role)] > ROLE_RANK[callerRole]) {
      return res.status(403).json({ error: 'You cannot modify a user who outranks you.' });
    }
    if (role !== undefined) {
      if (!USER_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
      if (ROLE_RANK[role as UserRole] > ROLE_RANK[callerRole]) {
        return res.status(403).json({ error: `You cannot grant '${role}' — it outranks your own role.` });
      }
    }
    if (password !== undefined) {
      const policy = validatePassword(password);
      if (!policy.valid) return res.status(400).json({ error: policy.error });
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (username) updates.username = username;
    if (email !== undefined) updates.email = email;
    if (fullName !== undefined) updates.fullName = fullName;
    if (role) updates.role = role;
    if (isActive !== undefined) updates.isActive = isActive;
    if (password) updates.passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const [updated] = await db.update(users).set(updates)
      .where(and(eq(users.id, id), eq(users.organizationId, currentOrgId())))
      .returning();

    res.json({ success: true, user: publicUser(updated) });
  });

  // DELETE /api/users/:id
  app.delete('/api/users/:id', requirePermission('user:manage'), async (req, res) => {
    const id = Number(req.params.id);
    if (id === req.session.userId) return res.status(400).json({ error: 'Cannot delete your own account' });

    const [target] = await db.select().from(users)
      .where(and(eq(users.id, id), eq(users.organizationId, currentOrgId())));
    if (!target) return res.status(404).json({ error: 'User not found' });

    if (ROLE_RANK[normalizeRole(target.role)] > ROLE_RANK[normalizeRole(req.session.role)]) {
      return res.status(403).json({ error: 'You cannot delete a user who outranks you.' });
    }

    await db.delete(users).where(and(eq(users.id, id), eq(users.organizationId, currentOrgId())));
    res.json({ success: true });
  });
}
