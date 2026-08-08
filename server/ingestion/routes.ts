/**
 * Cost fact store API.
 *
 * Served under /api/costs/* alongside the existing live-fetch endpoints rather
 * than replacing them in place, so the UI can be migrated page by page and the
 * two can be compared against each other while the store fills.
 */
import type { Express } from "express";
import { z } from "zod";
import type { CloudProvider } from "@shared/schema";
import { ingestAllProviders, defaultRange, getIngestionStatus } from "./ingest";
import {
  getTotalCost, getDailyTrend, getServiceBreakdown, getCategoryBreakdown,
  getProviderBreakdown, getSubAccountBreakdown, getCostByTag, getCoverage,
  type CostBasis,
} from "./queries";

const dayRe = /^\d{4}-\d{2}-\d{2}$/;

const filterSchema = z.object({
  start: z.string().regex(dayRe).optional(),
  end: z.string().regex(dayRe).optional(),
  providers: z.string().optional(),
  costBasis: z.enum(['billed', 'effective']).optional(),
  includeTax: z.enum(['true', 'false']).optional(),
});

/** Defaults to the current month to date. */
function parseFilters(query: unknown) {
  const q = filterSchema.parse(query);
  const now = new Date();

  const start = q.start
    ? new Date(`${q.start}T00:00:00Z`)
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = q.end ? new Date(`${q.end}T00:00:00Z`) : now;

  return {
    start,
    end,
    providers: q.providers
      ? (q.providers.split(',').filter(p => ['aws', 'azure', 'gcp'].includes(p)) as CloudProvider[])
      : undefined,
    costBasis: (q.costBasis ?? 'effective') as CostBasis,
    includeTax: q.includeTax === 'true',
  };
}

function fail(res: any, err: any, what: string) {
  console.error(`[CostFacts] ${what}:`, err?.message ?? err);
  const status = err instanceof z.ZodError ? 400 : 500;
  res.status(status).json({
    error: err instanceof z.ZodError ? 'Invalid query parameters' : `Failed to ${what}`,
    details: err instanceof z.ZodError ? err.errors : undefined,
  });
}

export function registerCostFactRoutes(app: Express) {

  // GET /api/costs/summary — everything a dashboard needs in one round trip.
  app.get('/api/costs/summary', async (req, res) => {
    try {
      const f = parseFilters(req.query);

      const [total, daily, services, providers, coverage] = await Promise.all([
        getTotalCost(f),
        getDailyTrend(f),
        getServiceBreakdown(f, 20),
        getProviderBreakdown(f),
        getCoverage(),
      ]);

      const days = Math.max(1, daily.length);

      res.json({
        // Echoed back so a consumer can never misread which number this is.
        costBasis: f.costBasis,
        period: { start: f.start.toISOString().slice(0, 10), end: f.end.toISOString().slice(0, 10) },
        totalCost: total,
        avgDailyCost: total / days,
        dailyTrend: daily,
        serviceBreakdown: services,
        providerBreakdown: providers,
        coverage,
      });
    } catch (err) {
      fail(res, err, 'load cost summary');
    }
  });

  app.get('/api/costs/trend', async (req, res) => {
    try {
      const f = parseFilters(req.query);
      res.json({ costBasis: f.costBasis, trend: await getDailyTrend(f) });
    } catch (err) { fail(res, err, 'load cost trend'); }
  });

  app.get('/api/costs/by-service', async (req, res) => {
    try {
      const f = parseFilters(req.query);
      res.json({ costBasis: f.costBasis, services: await getServiceBreakdown(f, 100) });
    } catch (err) { fail(res, err, 'load service breakdown'); }
  });

  // Cross-cloud comparison on a normalized axis.
  app.get('/api/costs/by-category', async (req, res) => {
    try {
      const f = parseFilters(req.query);
      res.json({ costBasis: f.costBasis, categories: await getCategoryBreakdown(f) });
    } catch (err) { fail(res, err, 'load category breakdown'); }
  });

  app.get('/api/costs/by-account', async (req, res) => {
    try {
      const f = parseFilters(req.query);
      res.json({ costBasis: f.costBasis, accounts: await getSubAccountBreakdown(f) });
    } catch (err) { fail(res, err, 'load account breakdown'); }
  });

  // GET /api/costs/by-tag?tagKey=cost-center — allocation, including the
  // untagged bucket that nobody can be charged for.
  app.get('/api/costs/by-tag', async (req, res) => {
    try {
      const tagKey = String(req.query.tagKey ?? '').trim();
      if (!tagKey) return res.status(400).json({ error: 'tagKey is required' });

      const f = parseFilters(req.query);
      const rows = await getCostByTag(f, tagKey);
      const total = rows.reduce((s, r) => s + r.cost, 0);
      const unallocated = rows.filter(r => !r.allocated).reduce((s, r) => s + r.cost, 0);

      res.json({
        costBasis: f.costBasis,
        tagKey,
        values: rows,
        totalCost: total,
        unallocatedCost: unallocated,
        allocationCoveragePercent: total > 0 ? ((total - unallocated) / total) * 100 : 0,
      });
    } catch (err) { fail(res, err, 'load tag allocation'); }
  });

  // GET /api/costs/ingestion-status — freshness and recent runs.
  app.get('/api/costs/ingestion-status', async (_req, res) => {
    try {
      const [runs, coverage] = await Promise.all([getIngestionStatus(), getCoverage()]);
      res.json({ coverage, recentRuns: runs });
    } catch (err) { fail(res, err, 'load ingestion status'); }
  });

  // POST /api/costs/ingest — run ingestion now. Also the backfill entry point:
  // pass an explicit start/end to load history.
  app.post('/api/costs/ingest', async (req, res) => {
    try {
      const body = z.object({
        start: z.string().regex(dayRe).optional(),
        end: z.string().regex(dayRe).optional(),
        providers: z.array(z.enum(['aws', 'azure', 'gcp'])).optional(),
      }).parse(req.body ?? {});

      const range = body.start && body.end
        ? { start: body.start, end: body.end }
        : defaultRange();

      if (new Date(range.start) > new Date(range.end)) {
        return res.status(400).json({ error: 'start must be on or before end' });
      }

      const results = await ingestAllProviders({
        range,
        providers: body.providers as CloudProvider[] | undefined,
        trigger: body.start ? 'backfill' : 'manual',
      });

      res.json({
        range,
        results,
        totalRecords: results.reduce((s, r) => s + r.recordsIngested, 0),
        totalApiCalls: results.reduce((s, r) => s + r.apiCalls, 0),
      });
    } catch (err) { fail(res, err, 'run ingestion'); }
  });
}
