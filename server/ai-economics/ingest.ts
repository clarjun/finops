/**
 * Ingesting AI usage and pricing it.
 *
 * Two steps, deliberately separate and separately re-runnable:
 *
 *   1. usage   — what the provider metered. Facts. Never recomputed.
 *   2. spend   — what we calculate those facts cost. Derived, and re-priceable
 *                without re-fetching anything.
 *
 * The split matters because the two go wrong for different reasons. A usage
 * fetch fails because a credential expired; a price is wrong because a rate was
 * missing or entered incorrectly. Keeping them apart means correcting a price
 * is a local operation over stored rows rather than a re-fetch of a month of
 * CloudWatch data.
 *
 * Re-ingestion overwrites rather than accumulating. Every source restates:
 * CloudWatch backfills late data points, and the vendor usage APIs settle over
 * hours. An adapter re-reading yesterday must correct yesterday, not double it.
 */
import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  aiModelPricing,
  aiSpendRecords,
  aiUsageRecords,
  type AiModelPricing,
} from '@shared/schema';
import { currentOrgId } from '../tenant-context';
import { recordAudit } from '../audit';
import { priceUsage, resolvePrice, type ModelPrice } from './pricing';
import type { UsageAdapter, UsageBucket } from './adapters/types';
import { BedrockUsageAdapter } from './adapters/bedrock';
import { AzureOpenAiUsageAdapter } from './adapters/azure-openai';

export interface IngestResult {
  providerKey: string;
  configured: boolean;
  buckets: number;
  apiCalls: number;
  tokensIngested: number;
  callsIngested: number;
  warning?: string;
  error?: string;
}

/**
 * The adapters available.
 *
 * Only Bedrock is implemented. The others are declared in the provider table
 * with their setup hints so the UI can show a customer what exists and what is
 * coming, rather than silently omitting four of the five providers they asked
 * about.
 */
export function availableAdapters(): UsageAdapter[] {
  return [new BedrockUsageAdapter(), new AzureOpenAiUsageAdapter()];
}

/**
 * Writes metered usage. Idempotent on the identity index.
 *
 * Raw SQL rather than Drizzle's onConflictDoUpdate because the uniqueness that
 * matters here is over EXPRESSIONS — COALESCE(account_id, '') and friends — so
 * that two rows differing only by a NULL attribution are still one row. Drizzle
 * can only name plain columns as a conflict target. The alternative was making
 * those columns NOT NULL DEFAULT '', which would have destroyed the distinction
 * between "unattributed" and "attributed to the empty string", and that
 * distinction is what lets the UI say "unattributed" honestly.
 */
async function persistUsage(providerKey: string, buckets: UsageBucket[]): Promise<number> {
  if (buckets.length === 0) return 0;

  const orgId = currentOrgId();
  let written = 0;

  // Chunked: a 90-day hourly window across twenty models is tens of thousands
  // of rows, and one statement that large exceeds the protocol's parameter
  // limit. Idempotency makes a partial write harmless.
  const CHUNK = 500;
  for (let i = 0; i < buckets.length; i += CHUNK) {
    const chunk = buckets.slice(i, i + CHUNK);

    const values = chunk.map((b) => sql`(
      ${orgId}, ${providerKey}, ${b.modelId},
      ${b.periodStart}, ${b.periodEnd},
      ${Math.round(b.inputTokens)}, ${Math.round(b.outputTokens)},
      ${Math.round(b.cacheReadTokens ?? 0)}, ${Math.round(b.cacheWriteTokens ?? 0)},
      ${Math.round(b.inferenceCalls)},
      ${b.accountId ?? null}, ${b.region ?? null},
      ${b.application ?? null}, ${b.environment ?? null},
      ${providerKey}, ${b.sourceRef ?? null}, NOW()
    )`);

    const result = await db.execute(sql`
      INSERT INTO ai_usage_records (
        organization_id, provider_key, model_id,
        period_start, period_end,
        input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens,
        inference_calls,
        account_id, region, application, environment,
        source, source_ref, ingested_at
      )
      VALUES ${sql.join(values, sql`, `)}
      ON CONFLICT (
        organization_id, provider_key, model_id, period_start,
        COALESCE(account_id, ''), COALESCE(application, ''), COALESCE(environment, '')
      )
      DO UPDATE SET
        -- Replace, never add. A restated period is a correction of the previous
        -- value, not additional usage on top of it.
        input_tokens       = EXCLUDED.input_tokens,
        output_tokens      = EXCLUDED.output_tokens,
        cache_read_tokens  = EXCLUDED.cache_read_tokens,
        cache_write_tokens = EXCLUDED.cache_write_tokens,
        inference_calls    = EXCLUDED.inference_calls,
        period_end         = EXCLUDED.period_end,
        ingested_at        = NOW()
      RETURNING id
    `);

    written += (result.rows as unknown[]).length;
  }

  return written;
}

/** Every price visible to this tenant: the catalog plus their own overrides. */
export async function loadPrices(): Promise<ModelPrice[]> {
  const orgId = currentOrgId();

  const rows = await db
    .select()
    .from(aiModelPricing)
    .where(sql`${aiModelPricing.organizationId} IS NULL OR ${aiModelPricing.organizationId} = ${orgId}`);

  return rows.map(toModelPrice);
}

function toModelPrice(row: AiModelPricing): ModelPrice {
  return {
    id: row.id,
    providerKey: row.providerKey,
    modelId: row.modelId,
    inputPerMillion: Number(row.inputPerMillion),
    outputPerMillion: Number(row.outputPerMillion),
    cacheReadPerMillion: row.cacheReadPerMillion === null ? null : Number(row.cacheReadPerMillion),
    cacheWritePerMillion: row.cacheWritePerMillion === null ? null : Number(row.cacheWritePerMillion),
    perCallCost: row.perCallCost === null ? null : Number(row.perCallCost),
    currency: row.currency,
    effectiveFrom: String(row.effectiveFrom),
    effectiveTo: row.effectiveTo === null ? null : String(row.effectiveTo),
    source: row.source,
    organizationId: row.organizationId,
  };
}

export interface RepriceResult {
  priced: number;
  unpriced: number;
  totalCost: number;
}

/**
 * Prices stored usage.
 *
 * Runs over a window rather than over the rows a fetch just wrote, so it can be
 * re-run after a price correction without touching any provider. That is the
 * whole reason usage and spend are separate tables.
 */
export async function repriceWindow(start: Date, end: Date): Promise<RepriceResult> {
  const orgId = currentOrgId();
  const prices = await loadPrices();

  const usage = await db
    .select()
    .from(aiUsageRecords)
    .where(and(
      eq(aiUsageRecords.organizationId, orgId),
      gte(aiUsageRecords.periodStart, start),
      lte(aiUsageRecords.periodStart, end),
    ));

  if (usage.length === 0) return { priced: 0, unpriced: 0, totalCost: 0 };

  let priced = 0;
  let unpriced = 0;
  let totalCost = 0;

  const CHUNK = 500;
  for (let i = 0; i < usage.length; i += CHUNK) {
    const rows = usage.slice(i, i + CHUNK).map((u) => {
      const price = resolvePrice(prices, u.providerKey, u.modelId, u.periodStart);
      const result = priceUsage(
        {
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheReadTokens: u.cacheReadTokens,
          cacheWriteTokens: u.cacheWriteTokens,
          inferenceCalls: u.inferenceCalls,
        },
        price,
      );

      if (result.pricingId === null) unpriced++;
      else priced++;
      totalCost += result.totalCost;

      return {
        organizationId: orgId,
        usageRecordId: u.id,
        providerKey: u.providerKey,
        modelId: u.modelId,
        periodStart: u.periodStart,
        inputCost: String(result.inputCost),
        outputCost: String(result.outputCost),
        cacheCost: String(result.cacheCost),
        callCost: String(result.callCost),
        totalCost: String(result.totalCost),
        currency: result.currency,
        pricingId: result.pricingId,
        pricingSource: result.pricingSource,
        unpricedReason: result.unpricedReason,
        computedAt: new Date(),
      };
    });

    await db
      .insert(aiSpendRecords)
      .values(rows)
      .onConflictDoUpdate({
        target: [aiSpendRecords.usageRecordId],
        set: {
          inputCost: sql`excluded.input_cost`,
          outputCost: sql`excluded.output_cost`,
          cacheCost: sql`excluded.cache_cost`,
          callCost: sql`excluded.call_cost`,
          totalCost: sql`excluded.total_cost`,
          currency: sql`excluded.currency`,
          pricingId: sql`excluded.pricing_id`,
          pricingSource: sql`excluded.pricing_source`,
          unpricedReason: sql`excluded.unpriced_reason`,
          computedAt: new Date(),
        },
      });
  }

  return { priced, unpriced, totalCost };
}

export interface IngestOptions {
  /** How far back to fetch. Providers restate, so this overlaps deliberately. */
  lookbackHours?: number;
  now?: Date;
}

/**
 * Default lookback.
 *
 * Was 48 hours, chosen to overlap CloudWatch's late data points. That is right
 * for a busy tenant and wrong for everyone else: a team calling Bedrock a few
 * times a week collects nothing, sees an empty dashboard, and concludes the
 * feature is broken. Fourteen days costs one extra API call and always finds
 * the usage that exists.
 *
 * CloudWatch serves 1-hour-period data for 63 days, which is the ceiling the
 * route enforces.
 */
const DEFAULT_LOOKBACK_HOURS = 24 * 14;

/**
 * Fetches usage from every configured adapter, stores it, and prices it.
 *
 * One provider failing never stops the others: a customer using four providers
 * should not lose all four because one credential expired.
 */
export async function ingestAiUsage(options: IngestOptions = {}): Promise<{
  providers: IngestResult[];
  repriced: RepriceResult;
}> {
  const now = options.now ?? new Date();
  const start = new Date(now.getTime() - (options.lookbackHours ?? DEFAULT_LOOKBACK_HOURS) * 3_600_000);

  const results: IngestResult[] = [];

  for (const adapter of availableAdapters()) {
    const base: IngestResult = {
      providerKey: adapter.providerKey,
      configured: false,
      buckets: 0,
      apiCalls: 0,
      tokensIngested: 0,
      callsIngested: 0,
    };

    try {
      if (!(await adapter.isConfigured())) {
        results.push({ ...base, warning: adapter.setupHint });
        continue;
      }

      const fetched = await adapter.fetchUsage({ start, end: now });
      await persistUsage(adapter.providerKey, fetched.buckets);

      results.push({
        ...base,
        configured: true,
        buckets: fetched.buckets.length,
        apiCalls: fetched.apiCalls,
        tokensIngested: fetched.buckets.reduce((s, b) => s + b.inputTokens + b.outputTokens, 0),
        callsIngested: fetched.buckets.reduce((s, b) => s + b.inferenceCalls, 0),
        warning: fetched.warning,
      });
    } catch (err: any) {
      console.error(`[AiUsage] ${adapter.providerKey} ingest failed:`, err?.message ?? err);
      results.push({ ...base, configured: true, error: err?.message ?? String(err) });
    }
  }

  const repriced = await repriceWindow(start, now);

  void recordAudit({
    action: 'ai_economics.ingest',
    outcome: results.some((r) => r.error) ? 'failure' : 'success',
    resourceType: 'ai_usage',
    metadata: {
      windowStart: start.toISOString(),
      providers: results.map((r) => ({
        provider: r.providerKey,
        configured: r.configured,
        buckets: r.buckets,
        apiCalls: r.apiCalls,
        error: r.error ?? null,
      })),
      priced: repriced.priced,
      unpriced: repriced.unpriced,
    },
  });

  return { providers: results, repriced };
}
