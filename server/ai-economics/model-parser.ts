/**
 * Reading model-level AI usage out of ordinary cloud billing rows.
 *
 * The product already classified AI spend into a service category, which
 * answers "how much do we spend on AI" and nothing else. The question a FinOps
 * team actually has is "on WHICH model, and what does a million tokens cost us"
 * — and the billing data can answer it, but only if you read the right field
 * per provider, because the two clouds put the information in different places.
 *
 * ── What the data actually looks like ───────────────────────────────────────
 *
 * Verified against real rows in this tenant's fact store, not assumed:
 *
 *   AWS Bedrock  service_name IS the model:
 *                  "Claude Opus 4.8 (Amazon Bedrock Edition)"
 *                charge_description is NULL, pricing_unit is "N/A", and
 *                pricing_quantity is a fractional number in an undocumented
 *                unit (198.075 for $1,102). It is NOT a token count.
 *
 *   GCP Vertex   charge_description carries everything:
 *                  "Generate content output token count gemini 2.5 flash ..."
 *                and where it says "token count", pricing_quantity IS a real
 *                token count. Verified: 461,280 output tokens at $1.153197 is
 *                exactly $2.50/1M, Gemini 2.5 Flash's list output price.
 *
 * ── The rule that matters ───────────────────────────────────────────────────
 *
 * Token metrics are reported ONLY where the provider actually gives a token
 * count. For Bedrock this module reports spend per model and says plainly that
 * per-token economics are unavailable, rather than dividing cost by a quantity
 * whose unit nobody can name. A cost-per-million-tokens figure derived from the
 * wrong denominator is worse than no figure: it is precise, plausible, and
 * wrong, and someone will put it in a board deck.
 */

export type AiVendor = 'anthropic' | 'google' | 'openai' | 'amazon' | 'meta' | 'mistral' | 'cohere' | 'other';
export type TokenDirection = 'input' | 'output' | 'cache' | 'unknown';
export type Modality = 'text' | 'audio' | 'image' | 'video' | 'unknown';

export interface AiUsageRow {
  provider: string;
  serviceName: string;
  chargeDescription?: string | null;
  pricingUnit?: string | null;
  pricingQuantity?: number | null;
}

export interface AiUsage {
  vendor: AiVendor;
  /** Display name, e.g. "Claude Opus 4.8" or "Gemini 2.5 Flash". */
  model: string;
  /** Coarser grouping for trends, e.g. "Claude Opus", "Gemini Flash". */
  family: string;
  direction: TokenDirection;
  modality: Modality;
  /**
   * Tokens, when the provider gave a real count. Null means the provider did
   * not tell us — which is NOT the same as zero and must never be summed as if
   * it were.
   */
  tokens: number | null;
  /** True when this row is a model inference charge rather than platform cost. */
  isInference: boolean;
}

// ── Model recognition ─────────────────────────────────────────────────────────

interface ModelPattern {
  match: RegExp;
  vendor: AiVendor;
  /** Builds the display name from the match, so "4.8" is not hard-coded. */
  name: (m: RegExpMatchArray) => string;
  family: (m: RegExpMatchArray) => string;
}

/**
 * Ordered: the first match wins, so more specific patterns come first.
 * Version numbers are captured rather than enumerated — a list of known
 * versions goes stale the week a new model ships, and then the newest and most
 * expensive model is the one that shows as "unknown".
 */
const MODEL_PATTERNS: ModelPattern[] = [
  {
    // "Claude Opus 4.8 (Amazon Bedrock Edition)", "Claude 3.7 Sonnet", "claude-sonnet-4"
    match: /claude[\s-]*(?:(opus|sonnet|haiku)[\s-]*([\d.]+)|([\d.]+)[\s-]*(opus|sonnet|haiku))/i,
    vendor: 'anthropic',
    name: (m) => {
      const tier = titleCase(m[1] ?? m[4] ?? '');
      const version = m[2] ?? m[3] ?? '';
      return `Claude ${tier} ${version}`.trim();
    },
    family: (m) => `Claude ${titleCase(m[1] ?? m[4] ?? '')}`.trim(),
  },
  {
    match: /claude/i,
    vendor: 'anthropic',
    name: () => 'Claude (unspecified)',
    family: () => 'Claude',
  },
  {
    // "gemini 2.5 flash lite", "Gemini 3.5 Flash Global", "Gemini 2.5 Pro Thinking"
    match: /gemini[\s-]*([\d.]+)[\s-]*(pro|flash(?:[\s-]*lite)?|ultra|nano)/i,
    vendor: 'google',
    name: (m) => `Gemini ${m[1]} ${titleCase(m[2].replace(/[\s-]+/g, ' '))}`,
    family: (m) => `Gemini ${titleCase(m[2].replace(/[\s-]+/g, ' '))}`,
  },
  {
    match: /gemini/i,
    vendor: 'google',
    name: () => 'Gemini (unspecified)',
    family: () => 'Gemini',
  },
  {
    match: /\b(gpt-?[\d.]+\w*|o[134](?:-mini)?)\b/i,
    vendor: 'openai',
    name: (m) => m[1].toUpperCase(),
    family: (m) => (/^o/i.test(m[1]) ? 'OpenAI o-series' : 'GPT'),
  },
  {
    match: /\b(titan|nova)[\s-]*(lite|pro|premier|micro|canvas|reel)?/i,
    vendor: 'amazon',
    name: (m) => `Amazon ${titleCase(m[1])}${m[2] ? ' ' + titleCase(m[2]) : ''}`,
    family: (m) => `Amazon ${titleCase(m[1])}`,
  },
  {
    match: /\bllama[\s-]*([\d.]+)?/i,
    vendor: 'meta',
    name: (m) => `Llama${m[1] ? ' ' + m[1] : ''}`,
    family: () => 'Llama',
  },
  {
    match: /\bmistral|mixtral\b/i,
    vendor: 'mistral',
    name: (m) => titleCase(m[0]),
    family: () => 'Mistral',
  },
  {
    match: /\bcommand[\s-]*(r\+?|light)?\b/i,
    vendor: 'cohere',
    name: (m) => `Command${m[1] ? ' ' + m[1].toUpperCase() : ''}`,
    family: () => 'Cohere Command',
  },
];

/**
 * Services that are AI platform or tooling spend rather than model inference.
 *
 * Kept separate because mixing them into a cost-per-token denominator is how a
 * SageMaker training cluster ends up inflating the reported price of a Claude
 * call.
 */
const PLATFORM_SERVICES = /sagemaker|comprehend|rekognition|textract|polly|transcribe|translate|lex|kendra|personalize|forecast|dataplex|document ?ai|speech|vision ai|automl|notebooks/i;

function titleCase(v: string): string {
  return v.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

// ── Direction, modality, tokens ───────────────────────────────────────────────

function readDirection(text: string): TokenDirection {
  // Caching is checked first: "Input Text Caching" is a cache write, not an
  // ordinary input charge, and they are priced very differently.
  if (/cach/i.test(text)) return 'cache';
  if (/\boutput\b|\bcompletion\b|\bresponse\b/i.test(text)) return 'output';
  if (/\binput\b|\bprompt\b/i.test(text)) return 'input';
  return 'unknown';
}

function readModality(text: string): Modality {
  if (/\baudio\b|\bspeech\b|\bvoice\b/i.test(text)) return 'audio';
  if (/\bimage\b|\bvision\b/i.test(text)) return 'image';
  if (/\bvideo\b/i.test(text)) return 'video';
  if (/\btext\b/i.test(text)) return 'text';
  return 'unknown';
}

/**
 * Whether pricing_quantity on this row is a token count.
 *
 * The one reliable signal found in the data is the provider saying so in the
 * charge description. GCP writes "token count" explicitly, and those rows
 * reconcile exactly against published per-million prices. Nothing else does, so
 * nothing else is trusted.
 *
 * Note that GCP labels pricing_unit "requests" on these rows even though the
 * quantity is tokens — which is exactly why the unit field cannot be the test.
 */
function quantityIsTokens(description: string): boolean {
  return /token count|tokens?\b/i.test(description);
}

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Identifies the model behind a billing row, or null when it is not AI spend.
 *
 * Reads service_name AND charge_description together, because AWS puts the
 * model in the first and GCP puts it in the second.
 */
export function parseAiUsage(row: AiUsageRow): AiUsage | null {
  const service = row.serviceName ?? '';
  const description = row.chargeDescription ?? '';
  const haystack = `${service} ${description}`.trim();
  if (!haystack) return null;

  const isPlatform = PLATFORM_SERVICES.test(service);

  const pattern = MODEL_PATTERNS.find((p) => p.match.test(haystack));

  if (!pattern) {
    // Recognisable AI platform spend with no identifiable model — SageMaker,
    // Comprehend. Worth reporting as AI spend; not worth pretending it has a
    // model or a token price.
    if (isPlatform) {
      return {
        vendor: providerVendor(row.provider),
        model: service || 'Unknown AI service',
        family: service || 'AI platform',
        direction: 'unknown',
        modality: 'unknown',
        tokens: null,
        isInference: false,
      };
    }
    return null;
  }

  const m = haystack.match(pattern.match)!;
  const tokens = quantityIsTokens(description) && typeof row.pricingQuantity === 'number'
    ? row.pricingQuantity
    : null;

  return {
    vendor: pattern.vendor,
    model: pattern.name(m),
    family: pattern.family(m),
    direction: readDirection(haystack),
    modality: readModality(haystack),
    tokens,
    isInference: !isPlatform,
  };
}

function providerVendor(provider: string): AiVendor {
  switch (provider?.toLowerCase()) {
    case 'aws': return 'amazon';
    case 'gcp': return 'google';
    default: return 'other';
  }
}

/**
 * Why a provider's rows carry no token counts.
 *
 * Shown in the UI next to the affected spend. "Token metrics unavailable" with
 * no reason reads like a bug in the product; with the reason it reads as a
 * thing the customer can go and fix.
 */
export function tokenAvailabilityNote(provider: string): string {
  switch (provider?.toLowerCase()) {
    case 'aws':
      return 'AWS Cost Explorer reports Bedrock spend per model but does not expose token counts. ' +
             'Enable a Cost and Usage Report with resource IDs, or read Bedrock invocation-log metrics, ' +
             'to get per-token economics on AWS.';
    case 'azure':
      return 'Azure Cost Management does not break Azure OpenAI charges down to token counts. ' +
             'Azure OpenAI request metrics carry them.';
    default:
      return 'This provider does not report token counts on its billing records.';
  }
}
