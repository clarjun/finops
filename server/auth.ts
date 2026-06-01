/**
 * Local Authentication — username/password with express-session
 */
import { type Express, type Request, type Response, type NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { db } from './db';
import { users } from '@shared/schema';
import { eq } from 'drizzle-orm';

// ── Session type augmentation ─────────────────────────────────────────────────
declare module 'express-session' {
  interface SessionData {
    userId: number;
    username: string;
    role: string;
  }
}

// ── Middleware ────────────────────────────────────────────────────────────────
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Unauthorized' });
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  next();
}

// ── Register auth routes ──────────────────────────────────────────────────────
export function registerAuthRoutes(app: Express) {

  // POST /api/auth/login
  app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    try {
      const [user] = await db.select().from(users).where(eq(users.username, username));
      if (!user || !user.isActive) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.role = user.role;
      res.json({ success: true, user: { id: user.id, username: user.username, role: user.role } });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/auth/logout
  app.post('/api/auth/logout', (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
  });

  // GET /api/auth/me
  app.get('/api/auth/me', (req, res) => {
    if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
    res.json({ id: req.session.userId, username: req.session.username, role: req.session.role });
  });

  // ── User management (admin only) ────────────────────────────────────────────

  // GET /api/users
  app.get('/api/users', requireAdmin, async (_req, res) => {
    const all = await db.select({
      id: users.id, username: users.username, role: users.role,
      isActive: users.isActive, createdAt: users.createdAt,
    }).from(users);
    res.json({ users: all });
  });

  // POST /api/users
  app.post('/api/users', requireAdmin, async (req, res) => {
    const { username, password, role = 'user' } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    try {
      const hash = await bcrypt.hash(password, 10);
      const [created] = await db.insert(users).values({
        username, passwordHash: hash, role,
        createdBy: req.session.userId,
      }).returning({ id: users.id, username: users.username, role: users.role });
      res.json({ success: true, user: created });
    } catch (e: any) {
      if (e.message?.includes('unique')) return res.status(409).json({ error: 'Username already exists' });
      res.status(500).json({ error: e.message });
    }
  });

  // PATCH /api/users/:id
  app.patch('/api/users/:id', requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const { username, password, role, isActive } = req.body;
    // Prevent admin from deactivating themselves
    if (id === req.session.userId && isActive === false) {
      return res.status(400).json({ error: 'Cannot deactivate your own account' });
    }
    const updates: any = { updatedAt: new Date() };
    if (username) updates.username = username;
    if (role) updates.role = role;
    if (isActive !== undefined) updates.isActive = isActive;
    if (password) updates.passwordHash = await bcrypt.hash(password, 10);
    const [updated] = await db.update(users).set(updates).where(eq(users.id, id))
      .returning({ id: users.id, username: users.username, role: users.role, isActive: users.isActive });
    if (!updated) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, user: updated });
  });

  // DELETE /api/users/:id
  app.delete('/api/users/:id', requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (id === req.session.userId) return res.status(400).json({ error: 'Cannot delete your own account' });
    await db.delete(users).where(eq(users.id, id));
    res.json({ success: true });
  });
}
