/**
 * Measured-savings API.
 *
 * Served under /api/savings/measurements rather than replacing
 * /api/savings/plans, which reports commitment coverage and is unrelated.
 */
import type { Express } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { savingsMeasurements } from "@shared/schema";
import { currentOrgId } from "../tenant-context";
import { getRealizedSavingsSummary, runDueMeasurements, runMeasurement } from "./measurement";

export function registerSavingsRoutes(app: Express) {

  // GET /api/savings/measurements?status=measured
  app.get('/api/savings/measurements', async (req, res) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;

      const conditions = [eq(savingsMeasurements.organizationId, currentOrgId())];
      if (status) conditions.push(eq(savingsMeasurements.status, status));

      const rows = await db.select().from(savingsMeasurements)
        .where(and(...conditions))
        .orderBy(desc(savingsMeasurements.createdAt))
        .limit(200);

      res.json({ measurements: rows, count: rows.length });
    } catch (e: any) {
      console.error('[Savings] Failed to list measurements:', e?.message ?? e);
      res.status(500).json({ error: 'Failed to list measurements' });
    }
  });

  // GET /api/savings/realized — estimated vs realized, and how far off the
  // planner has been.
  app.get('/api/savings/realized', async (_req, res) => {
    try {
      res.json(await getRealizedSavingsSummary());
    } catch (e: any) {
      console.error('[Savings] Failed to summarize realized savings:', e?.message ?? e);
      res.status(500).json({ error: 'Failed to summarize realized savings' });
    }
  });

  // POST /api/savings/measurements/run — measure everything due now, or one
  // specific measurement. The scheduler does this automatically; this exists so
  // a result can be pulled forward without waiting for the next tick.
  app.post('/api/savings/measurements/run', async (req, res) => {
    try {
      const id = Number(req.body?.measurementId);

      if (Number.isInteger(id)) {
        const outcome = await runMeasurement(id);
        if (!outcome) {
          return res.status(404).json({ error: 'Measurement not found, or not pending' });
        }
        return res.json({ outcomes: [outcome] });
      }

      const outcomes = await runDueMeasurements();
      res.json({ outcomes, count: outcomes.length });
    } catch (e: any) {
      console.error('[Savings] Failed to run measurements:', e?.message ?? e);
      res.status(500).json({ error: 'Failed to run measurements' });
    }
  });
}
