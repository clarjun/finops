/**
 * Populating the rate catalog from the vendors' own published prices.
 *
 * The point is that nobody should be typing rates in from memory. Where a
 * vendor publishes prices programmatically, we read them.
 *
 * ── What is actually available, verified live ───────────────────────────────
 *
 *   AWS Bedrock   YES — Price List API, ~675 token rates. But NOT every model:
 *                 a scan of 80 pages across all regions returned zero rows for
 *                 Claude 4.x. AWS publishes the older Claude 2/3 generation and
 *                 omits the newer ones entirely.
 *   Azure OpenAI  YES — Retail Prices API, no auth, ~606 token meters.
 *   Vertex AI     Cloud Billing Catalog API, needs an API key (not wired yet).
 *   OpenAI        NO public pricing API. Published on a web page only.
 *   Anthropic     NO public pricing API. Published on a docs page only.
 *
 * So this fills in what it can and leaves the rest visibly unpriced rather than
 * guessing. A model whose rate was invented is indistinguishable on a dashboard
 * from one whose rate is correct, which is the whole reason the `source` column
 * records where every rate came from.
 *
 * ── Effective dating ────────────────────────────────────────────────────────
 *
 * A refresh never overwrites a rate. It closes the previous row the day before
 * the new one starts and inserts the new one. Historical figures therefore stay
 * as they were reported, which is the entire purpose of effective dates.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import { aiModelPricing, aiUsageRecords } from '@shared/schema';
import { currentOrgId, currentUserId } from '../../tenant-context';
import { recordAudit } from '../../audit';
import { fetchBedrockRates, type PublishedRate } from './bedrock-rates';
import { bestMatch } from './matching';
import { loadLiteLlmCatalog, lookupRate } from './litellm';

export interface RefreshOutcome {
  providerKey: string;
  ratesFetched: number;
  modelsMatched: number;
  modelsUnmatched: string[];
  pricesWritten: number;
  apiCalls: number;
  warning?: string;
  error?: string;
}

/**
 * The earliest usage recorded for a model.
 *
 * Used to backdate the FIRST catalog rate. Without it the first refresh writes
 * every rate effective today, and all historical usage stays unpriced forever —
 * a customer collects a month of tokens, fetches rates, and still sees $0.
 *
 * The assumption being made, and it is a real one: that today's published rate
 * also applied over the window already collected. That is usually true and is
 * recorded in the rate's notes so it can be corrected. It only ever applies to
 * the first rate for a model — once a rate exists, a change is dated from the
 * day it is observed, and history stops moving.
 */
async function earliestUsage(providerKey: string, modelId: string): Promise<string | null> {
  const [row] = await db
    .select({ earliest: sql<string | null>`to_char(MIN(${aiUsageRecords.periodStart}), 'YYYY-MM-DD')` })
    .from(aiUsageRecords)
    .where(and(
      eq(aiUsageRecords.organizationId, currentOrgId()),
      eq(aiUsageRecords.providerKey, providerKey),
      eq(aiUsageRecords.modelId, modelId),
    ));

  return row?.earliest ?? null;
}

/** Model ids this tenant actually uses. Nothing else is worth pricing. */
async function usedModels(providerKey: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ modelId: aiUsageRecords.modelId })
    .from(aiUsageRecords)
    .where(and(
      eq(aiUsageRecords.organizationId, currentOrgId()),
      eq(aiUsageRecords.providerKey, providerKey),
    ));

  return rows.map((r) => r.modelId);
}

/**
 * Writes a rate, closing whatever it supersedes.
 *
 * Skips the write when the current open rate is already identical — a daily
 * refresh should not produce 365 rows a year saying the same thing, and an
 * unchanged price is not a price change.
 */
async function upsertRate(
  providerKey: string,
  modelId: string,
  inputPerMillion: number,
  outputPerMillion: number,
  cacheRead: number | null,
  cacheWrite: number | null,
  sourceUrl: string,
  effectiveFrom: string,
): Promise<boolean> {
  const orgId = currentOrgId();

  const [open] = await db
    .select()
    .from(aiModelPricing)
    .where(and(
      eq(aiModelPricing.organizationId, orgId),
      eq(aiModelPricing.providerKey, providerKey),
      eq(aiModelPricing.modelId, modelId),
      eq(aiModelPricing.source, 'catalog'),
      isNull(aiModelPricing.effectiveTo),
    ))
    .limit(1);

  // First rate for this model: backdate it to cover the usage already
  // collected, otherwise the customer's whole history stays at $0.
  let startsFrom = effectiveFrom;
  let backdated = false;
  if (!open) {
    const earliest = await earliestUsage(providerKey, modelId);
    if (earliest && earliest < effectiveFrom) {
      startsFrom = earliest;
      backdated = true;
    }
  }

  if (open) {
    const unchanged =
      Number(open.inputPerMillion) === inputPerMillion &&
      Number(open.outputPerMillion) === outputPerMillion;
    if (unchanged) return false;

    // Close the day before the new rate starts, so there is no overlap and no
    // gap. An overlap would make resolvePrice pick arbitrarily; a gap would
    // leave a day unpriced.
    await db
      .update(aiModelPricing)
      .set({
        effectiveTo: sql`(${startsFrom}::date - INTERVAL '1 day')::date`,
        updatedAt: new Date(),
      })
      .where(eq(aiModelPricing.id, open.id));
  }

  await db.insert(aiModelPricing).values({
    organizationId: orgId,
    providerKey,
    modelId,
    inputPerMillion: String(inputPerMillion),
    outputPerMillion: String(outputPerMillion),
    cacheReadPerMillion: cacheRead === null ? null : String(cacheRead),
    cacheWritePerMillion: cacheWrite === null ? null : String(cacheWrite),
    currency: 'USD',
    effectiveFrom: startsFrom,
    effectiveTo: null,
    source: 'catalog',
    sourceUrl,
    notes: backdated
      ? `Fetched from the published price list on ${effectiveFrom} and backdated to ${startsFrom} to cover usage already collected. ` +
        'If the rate changed during that period, add an earlier rate to correct it.'
      : 'Fetched from the published price list.',
    createdBy: currentUserId() ?? null,
  });

  return true;
}

const rateFor = (rates: PublishedRate[], modelId: string, direction: PublishedRate['direction']) =>
  bestMatch(modelId, rates.filter((r) => r.direction === direction));

/**
 * Refreshes rates for every model this tenant actually uses.
 *
 * LiteLLM is the primary source and the AWS Price List is the fallback, which
 * is the opposite of what one might expect from a vendor-first instinct. The
 * reason is empirical: the Price List publishes Claude 2.0 through 3 Sonnet and
 * omits Claude 4.x entirely — a scan of 80 pages across all regions found zero
 * rows — while LiteLLM carries all of them, keyed by the exact id the runtime
 * reports. Preferring the vendor API would leave the models actually in use
 * unpriced.
 */
export async function refreshRates(providerKey = 'bedrock', regionCode = 'us-east-1'): Promise<RefreshOutcome> {
  const base: RefreshOutcome = {
    providerKey,
    ratesFetched: 0,
    modelsMatched: 0,
    modelsUnmatched: [],
    pricesWritten: 0,
    apiCalls: 0,
  };

  try {
    const models = await usedModels(providerKey);
    if (models.length === 0) {
      return { ...base, warning: 'No usage has been collected yet, so there is nothing to price.' };
    }

    const catalog = await loadLiteLlmCatalog();

    // Only fetched when LiteLLM misses something, so the common path costs no
    // AWS API calls at all.
    let awsRates: PublishedRate[] | null = null;
    let awsApiCalls = 0;

    const today = new Date().toISOString().slice(0, 10);
    const unmatched: string[] = [];
    const approximate: string[] = [];
    let matched = 0;
    let written = 0;

    for (const modelId of models) {
      const hit = lookupRate(catalog, modelId, providerKey);

      if (hit) {
        if (!hit.exact) approximate.push(`${modelId} (priced as ${hit.matchedKey})`);
        matched++;

        const didWrite = await upsertRate(
          providerKey,
          modelId,
          hit.rate.inputPerMillion,
          hit.rate.outputPerMillion,
          hit.rate.cacheReadPerMillion,
          hit.rate.cacheWritePerMillion,
          hit.rate.sourceUrl,
          today,
        );
        if (didWrite) written++;
        continue;
      }

      // Fall back to the vendor's own price list.
      if (providerKey === 'bedrock') {
        if (awsRates === null) {
          const fetched = await fetchBedrockRates(regionCode);
          awsRates = fetched.rates;
          awsApiCalls = fetched.apiCalls;
        }

        const input = bestMatch(modelId, awsRates.filter((r) => r.direction === 'input'));
        const output = bestMatch(modelId, awsRates.filter((r) => r.direction === 'output'));

        // Both directions or nothing: a model priced on input alone reports a
        // cost that is confidently and substantially too low.
        if (input && output) {
          matched++;
          const didWrite = await upsertRate(
            providerKey,
            modelId,
            input.candidate.pricePerMillion,
            output.candidate.pricePerMillion,
            bestMatch(modelId, awsRates.filter((r) => r.direction === 'cache_read'))?.candidate.pricePerMillion ?? null,
            bestMatch(modelId, awsRates.filter((r) => r.direction === 'cache_write'))?.candidate.pricePerMillion ?? null,
            input.candidate.sourceUrl,
            today,
          );
          if (didWrite) written++;
          continue;
        }
      }

      unmatched.push(modelId);
    }

    void recordAudit({
      action: 'ai_economics.rates.refresh',
      resourceType: 'ai_model_pricing',
      metadata: {
        provider: providerKey, source: 'litellm+price-list',
        catalogSize: Object.keys(catalog).length,
        modelsMatched: matched, approximate, modelsUnmatched: unmatched, pricesWritten: written,
      },
    });

    const notes: string[] = [];
    if (approximate.length > 0) {
      // A cross-region profile priced from its base model is roughly 10% low.
      // That is useful, and it is not exact, and the difference must be said.
      notes.push(
        `${approximate.length} model(s) were priced from a base model rather than their exact id, ` +
        `which understates cross-region inference by about 10%: ${approximate.join('; ')}.`,
      );
    }
    if (unmatched.length > 0) {
      notes.push(`${unmatched.length} model(s) have no published rate anywhere and must be set manually: ${unmatched.join(', ')}.`);
    }

    return {
      ...base,
      ratesFetched: Object.keys(catalog).length,
      modelsMatched: matched,
      modelsUnmatched: unmatched,
      pricesWritten: written,
      apiCalls: awsApiCalls,
      warning: notes.length > 0 ? notes.join(' ') : undefined,
    };
  } catch (err: any) {
    console.error('[AiRates] refresh failed:', err?.message ?? err);
    return { ...base, error: err?.message ?? String(err) };
  }
}

/** Retained for the AWS-only path and its tests. */
export const refreshBedrockRates = (regionCode = 'us-east-1') => refreshRates('bedrock', regionCode);

/**
 * Refreshes every provider whose prices can be fetched.
 *
 * Run in sequence, not in parallel: they share one LiteLLM catalogue fetch, and
 * firing them together would download the 2.7MB document once per provider.
 */
export async function refreshAllRates(): Promise<RefreshOutcome[]> {
  const out: RefreshOutcome[] = [];
  for (const provider of ['bedrock', 'azure_openai']) {
    out.push(await refreshRates(provider));
  }
  return out;
}
