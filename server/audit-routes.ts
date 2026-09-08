/**
 * Audit log read API. Writes happen through server/audit.ts only — the table
 * has no update or delete path, by database trigger.
 */
import type { Express } from "express";
import { storage } from "./storage";

export function registerAuditRoutes(app: Express) {

  // GET /api/audit-logs?limit=100&offset=0&action=agent.action.execute
  app.get('/api/audit-logs', async (req, res) => {
    try {
      const limit = Number(req.query.limit ?? 100);
      const offset = Number(req.query.offset ?? 0);
      const action = typeof req.query.action === 'string' ? req.query.action : undefined;

      const logs = await storage.getAuditLogs({
        limit: Number.isFinite(limit) ? limit : 100,
        offset: Number.isFinite(offset) ? offset : 0,
        action,
      });

      res.json({ logs, count: logs.length });
    } catch (e: any) {
      console.error('[AuditRoutes] Failed to read audit logs:', e?.message ?? e);
      res.status(500).json({ error: 'Failed to read audit logs' });
    }
  });
}
