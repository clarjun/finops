/**
 * Aggregating AI spend by model.
 *
 * The filtering happens in Postgres and the grouping happens in Node, which is
 * the opposite of the rule followed elsewhere in this codebase — so it needs a
 * reason. The reason is that the grouping key does not exist in the data: the
 * model is *parsed* out of a service name or a charge description by
 * ./model-parser.ts, and there is no SQL expression that produces "Claude Opus
 * 4.8" from "Claude Opus 4.8 (Amazon Bedrock Edition)" without reimplementing
 * every pattern in that file as a CASE statement that would immediately drift.
 *
 * The volume makes this safe. AI rows are a small, bounded subset — hundreds to
 * low thousands per month, against millions of infrastructure rows — and the
 * SQL filter runs first, so Node only ever sees the candidates.
 */
import { and, eq, gte, lte, or, sql, ilike } from 'drizzle-orm';
import { db } from '../db';
import { costFacts, aiUnitMetrics } from '@shared/schema';
import { currentOrgId } from '../tenant-context';
import { parseAiUsage, tokenAvailabilityNote, type AiUsage } from './model-parser';

/**
 * Service names that indicate AI spend.
 *
 * Deliberately broader than the service_category classification: a model
 * shipped last week reaches the fact store before anyone adds it to the
 * category matcher, and the whole point of this view is to see the newest and
 * most expensive models.
 */
const AI_NAME_PATTERNS = [
  '%bedrock%', '%claude%', '%sagemaker%', '%openai%', '%vertex%', '%gemini%',
  '%anthropic%', '%llama%', '%mistral%', '%titan%', '%nova%', '%comprehend%',
  '%rekognition%', '%textract%', '%polly%', '%transcribe%', '%kiro%',
];

export interface AiSpendRow extends AiUsage {
  provider: string;
  accountId: string;
  serviceName: string;
  cost: number;
  day: string;
}

export interface ModelSpend {
  model: string;
  family: string;
  vendor: string;
  provider: string;
  cost: number;
  /** Null when the provider reports no token counts — never zero. */
  inputTokens: number | null;
  outputTokens: number | null;
  cacheTokens: number | null;
  totalTokens: number | null;
  /**
   * Null unless tokens are known. Computed from ONLY the cost of the rows that
   * also reported tokens — see tokenCoverage.
   */
  costPerMillionTokens: number | null;
  /** Cost of the output half, per million output tokens. */
  outputCostPerMillion: number | null;
  /**
   * Share of this model's spend the per-token figures are derived from, 0-1.
   *
   * Below 1 the rate is real but partial: some of this model's charges carry no
   * token count, so they are excluded from BOTH sides of the division rather
   * than inflating the numerator. The UI shows this, because "$6.02/1M based on
   * 40% of spend" and "$6.02/1M" are different claims.
   */
  tokenCoverage: number | null;
  share: number;
  isInference: boolean;
}

export interface AiEconomicsSummary {
  windowStart: string;
  windowEnd: string;
  totalCost: number;
  inferenceCost: number;
  platformCost: number;
  totalTokens: number | null;
  /** Spend whose provider gives no token counts, so it has no per-token figure. */
  costWithoutTokenData: number;
  /** One note per provider that cannot report tokens. */
  tokenGaps: Array<{ provider: string; cost: number; note: string }>;
  models: ModelSpend[];
  vendors: Array<{ vendor: string; cost: number; share: number }>;
  trend: Array<{ day: string; cost: number; tokens: number | null }>;
  unitEconomics: UnitEconomics | null;
}

export interface UnitEconomics {
  name: string;
  unitLabel: string;
  value: number;
  periodStart: string;
  costPerUnit: number;
  /** Previous period, so the trend that matters is visible without a chart. */
  previousCostPerUnit: number | null;
}

/** Loads and parses the AI rows in a window. */
export async function loadAiSpend(start: Date, end: Date): Promise<AiSpendRow[]> {
  const orgId = currentOrgId();

  const rows = await db
    .select({
      provider: costFacts.provider,
      accountId: costFacts.subAccountId,
      serviceName: costFacts.serviceName,
      chargeDescription: costFacts.chargeDescription,
      pricingUnit: costFacts.pricingUnit,
      pricingQuantity: costFacts.pricingQuantity,
      cost: sql<string>`COALESCE(${costFacts.effectiveCost}, ${costFacts.billedCost})`,
      day: sql<string>`to_char(${costFacts.chargePeriodStart}, 'YYYY-MM-DD')`,
    })
    .from(costFacts)
    .where(and(
      eq(costFacts.organizationId, orgId),
      gte(costFacts.chargePeriodStart, start),
      lte(costFacts.chargePeriodStart, end),
      // Tax is a real charge but is not attributable to a model, and including
      // it would inflate every per-token figure.
      sql`${costFacts.chargeCategory} <> 'Tax'`,
      or(
        eq(costFacts.serviceCategory, 'AI and Machine Learning'),
        ...AI_NAME_PATTERNS.map((p) => ilike(costFacts.serviceName, p)),
      ),
    ));

  const out: AiSpendRow[] = [];
  for (const r of rows) {
    const usage = parseAiUsage({
      provider: r.provider,
      serviceName: r.serviceName,
      chargeDescription: r.chargeDescription,
      pricingUnit: r.pricingUnit,
      pricingQuantity: r.pricingQuantity === null ? null : Number(r.pricingQuantity),
    });
    if (!usage) continue;

    out.push({
      ...usage,
      provider: r.provider,
      accountId: r.accountId,
      serviceName: r.serviceName,
      cost: Number(r.cost) || 0,
      day: r.day,
    });
  }

  return out;
}

/**
 * Sums a token direction, preserving "unknown".
 *
 * Returns null when NO row in the group reported tokens, rather than 0. The
 * difference matters: zero tokens for $14,000 of Bedrock spend would render as
 * an infinite cost per token, and treating unknown as zero is exactly the error
 * that produces confident nonsense.
 */
function sumTokens(rows: AiSpendRow[], direction: AiUsage['direction']): number | null {
  const known = rows.filter((r) => r.direction === direction && r.tokens !== null);
  if (known.length === 0) return null;
  return known.reduce((sum, r) => sum + (r.tokens ?? 0), 0);
}

export function summarizeModels(rows: AiSpendRow[]): ModelSpend[] {
  const byModel = new Map<string, AiSpendRow[]>();
  for (const r of rows) {
    const key = `${r.provider}|${r.model}`;
    byModel.set(key, [...(byModel.get(key) ?? []), r]);
  }

  const total = rows.reduce((s, r) => s + r.cost, 0);

  const models: ModelSpend[] = [];
  for (const group of byModel.values()) {
    const cost = group.reduce((s, r) => s + r.cost, 0);
    const inputTokens = sumTokens(group, 'input');
    const outputTokens = sumTokens(group, 'output');
    const cacheTokens = sumTokens(group, 'cache');

    const totalTokens = inputTokens === null && outputTokens === null
      ? null
      : (inputTokens ?? 0) + (outputTokens ?? 0);

    // Only the cost of rows that ALSO reported tokens. Dividing the model's
    // full cost by a partial token count produced $2,753/1M for Gemini 2.5 Pro
    // — a precise, plausible, completely wrong number, because some of that
    // model's rows carry cost with no token count attached.
    const tokenBackedCost = group
      .filter((r) => r.tokens !== null)
      .reduce((s, r) => s + r.cost, 0);

    const outputCost = group
      .filter((r) => r.direction === 'output' && r.tokens !== null)
      .reduce((s, r) => s + r.cost, 0);

    models.push({
      model: group[0].model,
      family: group[0].family,
      vendor: group[0].vendor,
      provider: group[0].provider,
      cost,
      inputTokens,
      outputTokens,
      cacheTokens,
      totalTokens,
      costPerMillionTokens: totalTokens && totalTokens > 0
        ? (tokenBackedCost / totalTokens) * 1_000_000
        : null,
      outputCostPerMillion: outputTokens && outputTokens > 0
        ? (outputCost / outputTokens) * 1_000_000
        : null,
      tokenCoverage: cost > 0 && totalTokens ? tokenBackedCost / cost : null,
      share: total > 0 ? (cost / total) * 100 : 0,
      isInference: group[0].isInference,
    });
  }

  return models.sort((a, b) => b.cost - a.cost);
}

/** The business denominator covering a window, and the period before it. */
export async function loadUnitEconomics(
  end: Date,
  aiCost: number,
  previousCost: number | null,
): Promise<UnitEconomics | null> {
  const orgId = currentOrgId();

  // The value whose period starts at or before the window end. A metric set for
  // March should still apply in April if April has not been entered yet — the
  // alternative is the figure silently disappearing at every month boundary.
  const rows = await db
    .select()
    .from(aiUnitMetrics)
    .where(and(
      eq(aiUnitMetrics.organizationId, orgId),
      lte(aiUnitMetrics.periodStart, end.toISOString().slice(0, 10)),
    ))
    .orderBy(sql`${aiUnitMetrics.periodStart} DESC`)
    .limit(2);

  const current = rows[0];
  if (!current) return null;

  const value = Number(current.value);
  if (!Number.isFinite(value) || value <= 0) return null;

  const prior = rows[1];
  const priorValue = prior ? Number(prior.value) : null;

  return {
    name: current.name,
    unitLabel: current.unitLabel,
    value,
    periodStart: String(current.periodStart),
    costPerUnit: aiCost / value,
    previousCostPerUnit:
      previousCost !== null && priorValue && priorValue > 0 ? previousCost / priorValue : null,
  };
}

export async function buildSummary(start: Date, end: Date): Promise<AiEconomicsSummary> {
  const rows = await loadAiSpend(start, end);

  const totalCost = rows.reduce((s, r) => s + r.cost, 0);
  const inferenceRows = rows.filter((r) => r.isInference);
  const inferenceCost = inferenceRows.reduce((s, r) => s + r.cost, 0);

  const models = summarizeModels(rows);

  // Spend the provider gave no token counts for. Reported as its own figure so
  // a reader knows how much of the total the per-token view actually covers.
  const withoutTokens = rows.filter((r) => r.tokens === null);
  const costWithoutTokenData = withoutTokens.reduce((s, r) => s + r.cost, 0);

  const byProvider = new Map<string, number>();
  for (const r of withoutTokens) {
    byProvider.set(r.provider, (byProvider.get(r.provider) ?? 0) + r.cost);
  }

  const knownTokens = rows.filter((r) => r.tokens !== null);
  const totalTokens = knownTokens.length === 0
    ? null
    : knownTokens.reduce((s, r) => s + (r.tokens ?? 0), 0);

  const vendorTotals = new Map<string, number>();
  for (const r of rows) vendorTotals.set(r.vendor, (vendorTotals.get(r.vendor) ?? 0) + r.cost);

  const dayTotals = new Map<string, { cost: number; tokens: number | null }>();
  for (const r of rows) {
    const entry = dayTotals.get(r.day) ?? { cost: 0, tokens: null };
    entry.cost += r.cost;
    if (r.tokens !== null) entry.tokens = (entry.tokens ?? 0) + r.tokens;
    dayTotals.set(r.day, entry);
  }

  // The equivalent window immediately before this one, for the cost-per-unit
  // comparison. Same length, so the two are comparable.
  const windowMs = end.getTime() - start.getTime();
  const priorRows = await loadAiSpend(new Date(start.getTime() - windowMs), start);
  const priorCost = priorRows.reduce((s, r) => s + r.cost, 0);

  return {
    windowStart: start.toISOString().slice(0, 10),
    windowEnd: end.toISOString().slice(0, 10),
    totalCost,
    inferenceCost,
    platformCost: totalCost - inferenceCost,
    totalTokens,
    costWithoutTokenData,
    tokenGaps: Array.from(byProvider.entries())
      .map(([provider, cost]) => ({ provider, cost, note: tokenAvailabilityNote(provider) }))
      .sort((a, b) => b.cost - a.cost),
    models,
    vendors: Array.from(vendorTotals.entries())
      .map(([vendor, cost]) => ({ vendor, cost, share: totalCost > 0 ? (cost / totalCost) * 100 : 0 }))
      .sort((a, b) => b.cost - a.cost),
    trend: Array.from(dayTotals.entries())
      .map(([day, v]) => ({ day, cost: v.cost, tokens: v.tokens }))
      .sort((a, b) => a.day.localeCompare(b.day)),
    unitEconomics: await loadUnitEconomics(end, totalCost, priorRows.length > 0 ? priorCost : null),
  };
}
