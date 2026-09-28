/**
 * Reconciling billed AI spend against metered AI usage.
 *
 * The page previously showed only what could be metered, which quietly implied
 * that was all the AI spend there was. On this tenant that would have shown
 * $4.37 against a real $12,972 — the reader has no way to know the other 99.97%
 * exists, let alone why it is missing.
 *
 * This lists every billed AI service and states, for each, whether token-level
 * data exists and why not. "Covered" here means ACCOUNTED FOR, not measured:
 * a service we cannot meter is covered when the reader can see it, see its
 * cost, and see the reason.
 *
 * ── The distinction that drove this ─────────────────────────────────────────
 *
 * AWS bills Bedrock through two entirely separate products:
 *
 *   "Amazon Bedrock"                      the inference API. InvokeModel calls
 *                                         emit CloudWatch metrics. Meterable.
 *   "Claude X (Amazon Bedrock Edition)"   AWS Marketplace subscriptions. No
 *                                         InvokeModel calls in the account, so
 *                                         no metrics exist to read.
 *
 * On this tenant that is $28 against $12,944. Matching the Marketplace service
 * to a metered model by name — they normalise to the same string — would be
 * wrong: it would claim spend was metered when nothing metered it. The two are
 * therefore classified by billing path, never by model name.
 */
import { sql } from 'drizzle-orm';
import { db } from '../db';
import { currentOrgId } from '../tenant-context';
import { isAIService } from '../reports/ai-cost-analyzer';

export type CoverageStatus =
  | 'metered'        // token-level data exists for this spend
  | 'marketplace'    // vendor subscription; no invocation telemetry exists
  | 'platform'       // training, hosting, endpoints — not per-token at all
  | 'no_telemetry';  // an API we could meter, but nothing has been collected

export interface CoverageRow {
  provider: string;
  serviceName: string;
  cost: number;
  status: CoverageStatus;
  /** Plain-language explanation shown next to the row. */
  reason: string;
  /** What the customer can do about it, where anything can be. */
  remedy: string | null;
  /** Populated only for metered rows. */
  inputTokens: number | null;
  outputTokens: number | null;
  inferenceCalls: number | null;
  calculatedCost: number | null;
}

export interface CoverageSummary {
  /** Inclusive YYYY-MM-DD bounds, echoed back so the UI states what it charged. */
  windowStart: string;
  windowEnd: string;
  totalAiCost: number;
  meteredCost: number;
  unmeteredCost: number;
  /** Share of AI spend with token-level data, 0-100. */
  coveragePercent: number;
  rows: CoverageRow[];
}

/**
 * AWS Marketplace sells vendor models as their own service, named
 * "<Model> (Amazon Bedrock Edition)". They are consumed through the vendor's
 * own channel rather than InvokeModel, so no CloudWatch metric is ever emitted
 * into the customer's account.
 */
const MARKETPLACE = /\(Amazon Bedrock Edition\)|\(Amazon SageMaker Edition\)/i;

/** Training, hosting and endpoint charges. Real AI spend, never per-token. */
const PLATFORM = /sagemaker|comprehend|rekognition|textract|polly|transcribe|translate|lex|kendra|personalize|dataplex|document ?ai/i;

/** Services that DO emit per-invocation telemetry. */
const METERABLE = /^amazon bedrock$|^vertex ai$|^gemini api$|azure openai/i;

export function classify(serviceName: string, hasMetrics: boolean): {
  status: CoverageStatus; reason: string; remedy: string | null;
} {
  if (MARKETPLACE.test(serviceName)) {
    return {
      status: 'marketplace',
      reason:
        'Billed as an AWS Marketplace subscription, not through the Bedrock inference API. ' +
        'No InvokeModel calls happen in your account, so CloudWatch has no tokens or call counts to report.',
      remedy:
        'Token-level data for this spend lives with the vendor. Connect an Anthropic admin key to read ' +
        'it from their usage report.',
    };
  }

  if (PLATFORM.test(serviceName)) {
    return {
      status: 'platform',
      reason: 'Training, hosting or endpoint time rather than model inference. It has no token dimension at all.',
      remedy: null,
    };
  }

  if (hasMetrics) {
    return {
      status: 'metered',
      reason: 'Token counts and call counts collected from provider metrics.',
      remedy: null,
    };
  }

  if (METERABLE.test(serviceName)) {
    return {
      status: 'no_telemetry',
      reason:
        'This service can report tokens, but none have been collected for the selected window — usually ' +
        'a region that has not been connected, or a window with no usage.',
      remedy: 'Press Collect usage with a wider date range, and check the region.',
    };
  }

  return {
    status: 'no_telemetry',
    reason: 'No token telemetry is available for this service.',
    remedy: null,
  };
}

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
};

/**
 * @param startStr inclusive start of the reported period, YYYY-MM-DD
 * @param endStr   inclusive end, YYYY-MM-DD
 *
 * Takes an explicit period rather than a rolling day count so it can be driven
 * by the same date-range context the FinOps report uses. Two AI totals on two
 * pages that silently covered different windows was the first thing anyone
 * noticed about this feature, and the answer is to share the window, not to
 * explain the discrepancy.
 */
export async function buildCoverage(startStr: string, endStr: string): Promise<CoverageSummary> {
  const orgId = currentOrgId();

  // Days are bucketed with to_char, NOT by comparing raw timestamps, because
  // that is exactly what the FinOps report does (ingestion/cost-records.ts) and
  // the two must agree. to_char renders in the DATABASE session timezone; a
  // UTC timestamp comparison does not. With the session on IST that pulled the
  // boundary 5.5 hours apart and made Coverage read ~$391 lower than the report
  // over the same nominal window — every service short by a few percent, which
  // looks like a pricing bug rather than a calendar one.
  //
  // The timestamp bounds below are a widened index pre-filter only: a day of
  // slack either side so no session timezone can exclude a row the to_char
  // predicate would have kept.
  const pad = 86_400_000;
  const since = new Date(new Date(`${startStr}T00:00:00Z`).getTime() - pad);
  const until = new Date(new Date(`${endStr}T00:00:00Z`).getTime() + pad);

  // Every service on the bill. WHICH of them count as AI is decided below by
  // isAIService — the same predicate the FinOps report uses — rather than by a
  // second list of patterns maintained here. Two definitions of "AI service"
  // guarantee the two pages eventually disagree, and a reader looking at two
  // different totals has no way to tell which one is wrong.
  const billed = await db.execute(sql`
    SELECT provider,
           service_name,
           MIN(service_category) AS service_category,
           SUM(COALESCE(effective_cost, billed_cost)) AS cost
      FROM cost_facts
     WHERE organization_id = ${orgId}
       AND charge_period_start >= ${since}
       AND charge_period_start <= ${until}
       AND to_char(charge_period_start, 'YYYY-MM-DD') >= ${startStr}
       AND to_char(charge_period_start, 'YYYY-MM-DD') <= ${endStr}
       AND charge_category <> 'Tax'
     GROUP BY provider, service_name
     HAVING SUM(COALESCE(effective_cost, billed_cost)) <> 0
     ORDER BY cost DESC
  `);

  // Everything metered in the same window, as one bucket. It is attributed to
  // the inference API service rather than split across model names, because a
  // metered model maps to the API line, not to a Marketplace subscription that
  // happens to share its name.
  const metered = await db.execute(sql`
    SELECT COALESCE(SUM(u.input_tokens), 0)::bigint   AS input_tokens,
           COALESCE(SUM(u.output_tokens), 0)::bigint  AS output_tokens,
           COALESCE(SUM(u.inference_calls), 0)::bigint AS calls,
           COALESCE(SUM(s.total_cost), 0)             AS calculated
      FROM ai_usage_records u
      LEFT JOIN ai_spend_records s ON s.usage_record_id = u.id
     WHERE u.organization_id = ${orgId}
       AND u.period_start >= ${since}
       AND u.period_start <= ${until}
       AND to_char(u.period_start, 'YYYY-MM-DD') >= ${startStr}
       AND to_char(u.period_start, 'YYYY-MM-DD') <= ${endStr}
  `);

  const m = (metered.rows as any[])[0] ?? {};
  const hasAnyMetrics = num(m.input_tokens) + num(m.output_tokens) > 0;

  const rows: CoverageRow[] = [];
  let meteredCost = 0;
  let totalAiCost = 0;
  let attachedMetrics = false;

  for (const raw of billed.rows as any[]) {
    const serviceName = String(raw.service_name);
    const provider = String(raw.provider).toLowerCase();
    const cost = num(raw.cost);

    // The provider's own category is honoured as well as the name patterns, so
    // a service the pattern list has not caught up with still appears rather
    // than vanishing from a view whose entire purpose is completeness.
    const isAi = isAIService(provider as 'aws' | 'azure' | 'gcp', serviceName)
      || String(raw.service_category ?? '') === 'AI and Machine Learning';
    if (!isAi) continue;

    totalAiCost += cost;

    // Metrics attach to the FIRST meterable service encountered, which is the
    // highest-cost one because the query is ordered by cost. Splitting them
    // across several would require per-service attribution the metrics do not
    // carry.
    const meterable = METERABLE.test(serviceName);
    const attach = meterable && hasAnyMetrics && !attachedMetrics;
    if (attach) attachedMetrics = true;

    const { status, reason, remedy } = classify(serviceName, attach);
    if (status === 'metered') meteredCost += cost;

    rows.push({
      provider,
      serviceName,
      cost,
      status,
      reason,
      remedy,
      inputTokens: attach ? num(m.input_tokens) : null,
      outputTokens: attach ? num(m.output_tokens) : null,
      inferenceCalls: attach ? num(m.calls) : null,
      calculatedCost: attach ? num(m.calculated) : null,
    });
  }

  return {
    windowStart: startStr,
    windowEnd: endStr,
    totalAiCost,
    meteredCost,
    unmeteredCost: totalAiCost - meteredCost,
    coveragePercent: totalAiCost > 0 ? (meteredCost / totalAiCost) * 100 : 0,
    rows,
  };
}
