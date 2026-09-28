/**
 * AI unit economics API.
 *
 * Authorization is declared in server/middleware/route-policy.ts. Reading the
 * breakdown is cost:read like any other cost view; entering a business
 * denominator is budget:write, because it is a finance input that changes every
 * derived per-unit figure the organization reports.
 */
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db';
import { aiUnitMetrics } from '@shared/schema';
import { currentOrgId, currentUserId } from '../tenant-context';
import { recordAudit } from '../audit';
import { buildSummary } from './queries';
import { buildDashboard, type TokenFilters } from './token-queries';
import { buildCoverage } from './coverage';
import { ingestAiUsage, loadPrices, repriceWindow, availableAdapters } from './ingest';
import { refreshRates } from './rates/refresh';
import { aiModelPricing, aiProviders } from '@shared/schema';

function fail(res: Response, err: unknown, what: string) {
  if (err instanceof z.ZodError) {
    return res.status(400).json({ error: 'Invalid request', details: err.errors });
  }
  console.error(`[AiEconomics] ${what}:`, err instanceof Error ? err.stack ?? err.message : err);
  res.status(500).json({ error: `Failed to ${what}` });
}

/** Bounded so a pathological range cannot pull the whole fact store into Node. */
const MAX_DAYS = 365;
const DEFAULT_DAYS = 30;

export function registerAiEconomicsRoutes(app: Express) {

  app.get('/api/ai-economics/summary', async (req: Request, res: Response) => {
    try {
      const days = Math.min(Math.max(Number(req.query.days) || DEFAULT_DAYS, 1), MAX_DAYS);
      const end = new Date();
      const start = new Date(end.getTime() - days * 86_400_000);

      res.json(await buildSummary(start, end));
    } catch (err) {
      fail(res, err, 'build the AI economics summary');
    }
  });


  /* ---- Token economics: the metered view -------------------------------- */

  /** Comma-separated query params, ignoring blanks. */
  const list = (v: unknown): string[] | undefined => {
    if (typeof v !== 'string' || !v.trim()) return undefined;
    const out = v.split(',').map(s => s.trim()).filter(Boolean);
    return out.length ? out : undefined;
  };

  app.get('/api/ai-economics/tokens', async (req: Request, res: Response) => {
    try {
      const days = Math.min(Math.max(Number(req.query.days) || DEFAULT_DAYS, 1), MAX_DAYS);
      const end = new Date();
      const start = new Date(end.getTime() - days * 86_400_000);

      const filters: TokenFilters = {
        start,
        end,
        providers: list(req.query.providers),
        models: list(req.query.models),
        applications: list(req.query.applications),
        environments: list(req.query.environments),
      };

      res.json(await buildDashboard(filters));
    } catch (err) {
      fail(res, err, 'build the token economics view');
    }
  });


/** A YYYY-MM-DD date in the SERVER's local calendar.
 *
 * Deliberately not `toISOString().slice(0, 10)`. That converts to UTC first, so
 * local midnight on the 1st of the month becomes the last day of the PREVIOUS
 * month anywhere east of Greenwich — at UTC+5:30 the "month to date" window
 * silently started a day early. Formatting from the local components keeps the
 * boundary on the day the operator means.
 */
const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The reported period, taking the same startDate/endDate parameters as the
 * FinOps report so both pages can be driven by one date-range picker.
 *
 * Falls back to month-to-date, which is the report's default, rather than to a
 * rolling 30 days — the two windows disagreeing by a thousand dollars is what
 * prompted this.
 */
function coveragePeriod(req: Request): { start: string; end: string } {
  const raw = (v: unknown) => (typeof v === 'string' && DATE_ONLY.test(v) ? v : null);
  const qs = raw(req.query.startDate);
  const qe = raw(req.query.endDate);

  const now = new Date();
  const startStr = qs ?? ymd(new Date(now.getFullYear(), now.getMonth(), 1));
  const endStr = qe ?? ymd(now);

  // Kept as strings end to end. Every conversion to a Date and back through
  // toISOString is a chance to shift the boundary by a timezone offset, which
  // is the defect this whole helper exists to avoid.
  //
  // An inverted range returns nothing and looks like "no AI spend", which is
  // the one wrong conclusion this endpoint exists to prevent.
  if (endStr < startStr) return { start: endStr, end: startStr };
  return { start: startStr, end: endStr };
}

  /**
   * Every billed AI service, and whether token data exists for it.
   *
   * Without this the page shows only what it can meter, which implies that is
   * all the AI spend there is. On this tenant that would be $4 against $12,900.
   */
  app.get('/api/ai-economics/coverage', async (req: Request, res: Response) => {
    try {
      const { start, end } = coveragePeriod(req);
      res.json(await buildCoverage(start, end));
    } catch (err) {
      fail(res, err, 'build the AI coverage view');
    }
  });

  /** What each provider needs before its usage can be collected. */
  app.get('/api/ai-economics/providers', async (_req: Request, res: Response) => {
    try {
      const rows = await db.select().from(aiProviders).orderBy(aiProviders.displayName);

      // `implemented` is stated separately from `isActive`: a provider declared
      // but with no adapter written yet must not look configurable.
      //
      // Derived from the adapter registry rather than from a list kept here.
      // The hardcoded version said Azure OpenAI was unimplemented for a while
      // after its adapter shipped, which is the failure mode of every manually
      // maintained mirror of something the code already knows.
      const implemented = new Set(availableAdapters().map(a => a.providerKey));

      res.json({
        providers: rows.map(p => ({ ...p, implemented: implemented.has(p.key) })),
      });
    } catch (err) {
      fail(res, err, 'list providers');
    }
  });

  app.post('/api/ai-economics/ingest', async (req: Request, res: Response) => {
    try {
      // 63 days is CloudWatch's retention for 1-hour-period data; asking for
      // more returns nothing for the excess rather than erroring, which would
      // look like missing usage.
      const hours = Math.min(Math.max(Number(req.body?.lookbackHours) || 24 * 14, 1), 24 * 63);
      res.json(await ingestAiUsage({ lookbackHours: hours }));
    } catch (err) {
      fail(res, err, 'ingest AI usage');
    }
  });

  /* ---- Model pricing ----------------------------------------------------- */

  /**
   * Fetches published rates so nobody has to type one in.
   *
   * LiteLLM first (it carries the current models, keyed by the exact id the
   * runtime reports), the vendor price list as a fallback. Re-prices the
   * window afterwards so the effect is visible immediately rather than on the
   * next scheduled sweep.
   */
  app.post('/api/ai-economics/pricing/refresh', async (req: Request, res: Response) => {
    try {
      const provider = String(req.body?.provider ?? 'bedrock');
      const outcome = await refreshRates(provider);

      const days = Math.min(Math.max(Number(req.body?.days) || 90, 1), MAX_DAYS);
      const end = new Date();
      const start = new Date(end.getTime() - days * 86_400_000);
      const repriced = await repriceWindow(start, end);

      res.json({ ...outcome, repriced });
    } catch (err) {
      fail(res, err, 'refresh model rates');
    }
  });


  app.get('/api/ai-economics/pricing', async (_req: Request, res: Response) => {
    try {
      res.json({ pricing: await loadPrices() });
    } catch (err) {
      fail(res, err, 'list model pricing');
    }
  });

  app.put('/api/ai-economics/pricing', async (req: Request, res: Response) => {
    try {
      const body = z.object({
        providerKey: z.string().min(2).max(40),
        modelId: z.string().min(1).max(200),
        inputPerMillion: z.number().nonnegative().finite(),
        outputPerMillion: z.number().nonnegative().finite(),
        cacheReadPerMillion: z.number().nonnegative().finite().nullish(),
        cacheWritePerMillion: z.number().nonnegative().finite().nullish(),
        perCallCost: z.number().nonnegative().finite().nullish(),
        currency: z.string().length(3).default('USD'),
        effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        effectiveTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
        source: z.enum(['customer', 'contract']).default('customer'),
        notes: z.string().max(1000).optional(),
      }).parse(req.body ?? {});

      // Always written as a TENANT row, never into the shared catalog. A price
      // entered by one customer must never change another customer's figures.
      const [created] = await db.insert(aiModelPricing).values({
        organizationId: currentOrgId(),
        providerKey: body.providerKey,
        modelId: body.modelId,
        inputPerMillion: String(body.inputPerMillion),
        outputPerMillion: String(body.outputPerMillion),
        cacheReadPerMillion: body.cacheReadPerMillion == null ? null : String(body.cacheReadPerMillion),
        cacheWritePerMillion: body.cacheWritePerMillion == null ? null : String(body.cacheWritePerMillion),
        perCallCost: body.perCallCost == null ? null : String(body.perCallCost),
        currency: body.currency.toUpperCase(),
        effectiveFrom: body.effectiveFrom,
        effectiveTo: body.effectiveTo ?? null,
        source: body.source,
        notes: body.notes ?? null,
        createdBy: currentUserId() ?? null,
      }).returning();

      void recordAudit({
        action: 'ai_economics.pricing.update',
        resourceType: 'ai_model_pricing',
        resourceId: String(created.id),
        metadata: {
          model: `${body.providerKey}/${body.modelId}`,
          inputPerMillion: body.inputPerMillion,
          outputPerMillion: body.outputPerMillion,
          effectiveFrom: body.effectiveFrom,
          source: body.source,
        },
      });

      res.status(201).json({ pricing: created });
    } catch (err) {
      fail(res, err, 'save model pricing');
    }
  });

  /* ---- Business denominators -------------------------------------------- */

  app.get('/api/ai-economics/metrics', async (_req: Request, res: Response) => {
    try {
      const rows = await db
        .select()
        .from(aiUnitMetrics)
        .where(eq(aiUnitMetrics.organizationId, currentOrgId()))
        .orderBy(desc(aiUnitMetrics.periodStart))
        .limit(60);

      res.json({ metrics: rows });
    } catch (err) {
      fail(res, err, 'list unit metrics');
    }
  });

  app.put('/api/ai-economics/metrics', async (req: Request, res: Response) => {
    try {
      const body = z.object({
        name: z.string().min(1).max(120),
        unitLabel: z.string().min(1).max(60).default('unit'),
        // Accepted as a full date or a YYYY-MM month; normalised to the first
        // of the month below, because a business metric describes a period and
        // a mid-month date invites two rows for one month.
        periodStart: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/),
        value: z.number().positive().finite(),
        notes: z.string().max(2000).optional(),
      }).parse(req.body ?? {});

      const periodStart = `${body.periodStart.slice(0, 7)}-01`;
      const orgId = currentOrgId();

      await db
        .insert(aiUnitMetrics)
        .values({
          organizationId: orgId,
          name: body.name.trim(),
          unitLabel: body.unitLabel.trim(),
          periodStart,
          value: String(body.value),
          notes: body.notes ?? null,
          createdBy: currentUserId() ?? null,
        })
        .onConflictDoUpdate({
          // Re-submitting a month corrects it rather than adding a second,
          // contradictory figure for the same period.
          target: [aiUnitMetrics.organizationId, aiUnitMetrics.name, aiUnitMetrics.periodStart],
          set: {
            unitLabel: body.unitLabel.trim(),
            value: String(body.value),
            notes: body.notes ?? null,
            updatedAt: new Date(),
          },
        });

      void recordAudit({
        action: 'ai_economics.metric.update',
        resourceType: 'ai_unit_metric',
        metadata: { name: body.name, periodStart, value: body.value, unitLabel: body.unitLabel },
      });

      res.json({ success: true, periodStart });
    } catch (err) {
      fail(res, err, 'save the unit metric');
    }
  });

  app.delete('/api/ai-economics/metrics/:id', async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid metric id' });

      const [removed] = await db
        .delete(aiUnitMetrics)
        .where(and(eq(aiUnitMetrics.organizationId, currentOrgId()), eq(aiUnitMetrics.id, id)))
        .returning();

      if (!removed) return res.status(404).json({ error: 'No such metric' });

      void recordAudit({
        action: 'ai_economics.metric.delete',
        resourceType: 'ai_unit_metric',
        resourceId: String(id),
        metadata: { name: removed.name, periodStart: String(removed.periodStart) },
      });

      res.json({ success: true });
    } catch (err) {
      fail(res, err, 'delete the unit metric');
    }
  });
}
