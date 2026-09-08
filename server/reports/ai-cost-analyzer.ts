/**
 * AI/ML spend, computed from the same records as the rest of the report.
 *
 * This used to make its own live Cost Explorer call and swallow any failure
 * into a zero-shaped result:
 *
 *     catch { return { totalAISpend: 0, aiServices: [], topAIService: 'None' } }
 *
 * which the UI renders as "No AI/ML services usage detected" — indistinguishable
 * from a genuine absence. On 2026-09-06 that call failed transiently, the zeros
 * were persisted to the report cache, and stale-while-revalidate served that
 * cached report for the rest of the day. The previous day's cache for the same
 * account held $2,205 of Bedrock spend across 11 services, so nothing about the
 * data had changed — only the reliability of one extra API call.
 *
 * Every other section of the report already reads the fact store. This one is
 * now a pure function over the records the engine has already loaded, which
 * removes the failure mode rather than retrying it, guarantees the AI
 * percentage agrees with the report's own total, and means Azure and GCP work
 * for free — both were previously stubs that returned zeros unconditionally.
 */

export interface AIServiceCost {
  service: string;
  cost: number;
  percentage: number;
}

export interface AISpendAnalysis {
  totalAISpend: number;
  aiServices: AIServiceCost[];
  aiPercentageOfTotal: number;
  topAIService: string;
  monthOverMonthChange: number;
}

export interface CostRecord {
  date: string;
  service: string;
  cost: number;
}

/**
 * Service-name patterns that identify AI/ML spend.
 *
 * Patterns, not an exact-name list. The previous exact list was written against
 * 2024-era product names and had already rotted: it did not contain "Foundry
 * Models" (Azure AI Foundry, the renamed Azure OpenAI Service), "Gemini API",
 * or "Claude Sonnet 4" (Claude on Vertex) — all of which are present in this
 * account's billing data. It matched AWS Bedrock only by accident, because
 * "Claude Opus 4.8 (Amazon Bedrock Edition)" happens to contain the substring
 * "Amazon Bedrock".
 *
 * Providers rename and add AI services continuously, so this list will need
 * revisiting; matching on the durable part of the name (bedrock, vertex,
 * gemini, foundry, claude) rots more slowly than matching full product names.
 */
const AI_PATTERNS: Record<'aws' | 'azure' | 'gcp', RegExp[]> = {
  aws: [
    /bedrock/i,             // also every "<model> (Amazon Bedrock Edition)" line item
    /sagemaker/i,
    /comprehend/i,
    /rekognition/i,
    /textract/i,
    /kendra/i,
    /transcribe/i,
    /\bpolly\b/i,
    /amazon translate/i,
    /amazon lex/i,
    /personalize/i,
    /amazon forecast/i,
    /fraud detector/i,
    /codewhisperer/i,
    /deeplens|deepracer|deepcomposer/i,
    /augmented ai/i,
    /devops guru/i,
    /lookout for/i,
    /monitron/i,
    /healthlake/i,
    /amazon q\b/i,
    /\bclaude\b/i,
  ],
  azure: [
    /openai/i,
    /cognitive/i,
    /machine learning/i,
    /bot service/i,
    /form recognizer/i,
    /document intelligence/i,
    /computer vision/i,
    /face api/i,
    /speech/i,
    /language understanding/i,
    /translator/i,
    /content moderator/i,
    /personalizer/i,
    /anomaly detector/i,
    /metrics advisor/i,
    /video indexer/i,
    /applied ai/i,
    /\bfoundry\b/i,         // "Foundry Models" — Azure AI Foundry
    /ai services/i,
    /ai search/i,
    /ai studio/i,
    /\bclaude\b/i,
    /\bgpt\b/i,
  ],
  gcp: [
    /vertex ai/i,
    /gemini/i,
    /ai platform/i,
    /automl/i,
    /vision ai/i,
    /video ai/i,
    /natural language ai/i,
    /translation ai/i,
    /speech-to-text|text-to-speech/i,
    /dialogflow/i,
    /document ai/i,
    /recommendations ai/i,
    /contact center ai/i,
    /talent solution/i,
    /cloud tpu/i,
    /\bclaude\b/i,          // Claude on Vertex, billed as e.g. "Claude Sonnet 4"
    /\bimagen\b/i,
  ],
};

export function isAIService(provider: 'aws' | 'azure' | 'gcp', serviceName: string): boolean {
  if (!serviceName) return false;
  return AI_PATTERNS[provider].some((pattern) => pattern.test(serviceName));
}

/** Strip the vendor prefix for display; model line items are left as-is. */
function cleanServiceName(serviceName: string): string {
  return serviceName
    .replace(/^Amazon\s+/i, '')
    .replace(/^AWS\s+/i, '')
    .replace(/^Azure\s+/i, '')
    .trim();
}

function sumByService(records: CostRecord[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of records) {
    if (!Number.isFinite(r.cost)) continue;
    out.set(r.service, (out.get(r.service) ?? 0) + r.cost);
  }
  return out;
}

/**
 * @param currentPeriod  cost records for the reported period
 * @param previousPeriod cost records for the preceding month, for the MoM delta
 */
export function analyzeAICosts(
  provider: 'aws' | 'azure' | 'gcp',
  currentPeriod: CostRecord[],
  previousPeriod: CostRecord[] = [],
): AISpendAnalysis {
  const byService = sumByService(currentPeriod);

  let totalCost = 0;
  let totalAISpend = 0;
  const aiByService: Array<{ service: string; cost: number }> = [];

  for (const [service, cost] of byService) {
    totalCost += cost;
    if (isAIService(provider, service)) {
      totalAISpend += cost;
      aiByService.push({ service, cost });
    }
  }

  const aiServices: AIServiceCost[] = aiByService
    // Zero-cost AI line items are noise on a spend report — a service that cost
    // nothing is not "AI spend". The old version listed them (e.g. "Lex: $0").
    .filter((s) => s.cost !== 0)
    .map((s) => ({
      service: cleanServiceName(s.service),
      cost: s.cost,
      percentage: totalAISpend > 0 ? (s.cost / totalAISpend) * 100 : 0,
    }))
    .sort((a, b) => b.cost - a.cost);

  // Previously hardcoded to 0 with a TODO. The engine already has the previous
  // month's records, so there is no reason not to compute it.
  //
  // Caveat worth knowing when reading the number: a partial current month is
  // being compared against a complete previous month, so mid-month it reads
  // negative. That is the same convention the top-cost-drivers section uses.
  let previousAISpend = 0;
  for (const [service, cost] of sumByService(previousPeriod)) {
    if (isAIService(provider, service)) previousAISpend += cost;
  }
  const monthOverMonthChange =
    previousAISpend > 0 ? ((totalAISpend - previousAISpend) / previousAISpend) * 100 : 0;

  const analysis: AISpendAnalysis = {
    totalAISpend,
    aiServices,
    aiPercentageOfTotal: totalCost > 0 ? (totalAISpend / totalCost) * 100 : 0,
    topAIService: aiServices.length > 0 ? aiServices[0].service : 'None',
    monthOverMonthChange,
  };

  console.log(
    `[AI Cost Analyzer] ${provider}: $${totalAISpend.toFixed(2)} across ${aiServices.length} service(s)` +
    ` (${analysis.aiPercentageOfTotal.toFixed(1)}% of $${totalCost.toFixed(2)})`,
  );

  return analysis;
}
