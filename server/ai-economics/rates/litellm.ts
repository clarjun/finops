/**
 * Model rates from LiteLLM's published pricing database.
 *
 * Adopted after studying how ccusage prices Claude Code usage: it reads
 * LiteLLM's `model_prices_and_context_window.json`, a community-maintained
 * catalogue of ~4,300 models covering every major provider. That turns out to
 * solve the exact problem the AWS Price List could not.
 *
 * ── Why this beats the provider APIs ────────────────────────────────────────
 *
 * The AWS Price List publishes Claude 2.0, 2.1, Instant, 3 Haiku and 3 Sonnet
 * and stops. A scan of 80 pages across every region returned zero rows for
 * Claude 4.x — the models this tenant actually runs. LiteLLM has all of them.
 *
 * Better still, LiteLLM is keyed by the EXACT model id the runtime reports, so
 * there is no fuzzy matching to get wrong:
 *
 *     anthropic.claude-sonnet-4-6                 $3.00 / $15.00 per 1M
 *     global.anthropic.claude-sonnet-4-6          $3.00 / $15.00
 *     us.anthropic.claude-sonnet-4-6              $3.30 / $16.50
 *     anthropic.claude-haiku-4-5-20251001-v1:0    $1.00 /  $5.00
 *
 * ── The thing that finding corrected ────────────────────────────────────────
 *
 * Look at the third line. Cross-region inference profiles cost 10% MORE than
 * the base model. An earlier version of this code normalised `us.` and
 * `global.` away to collapse "the same model" into one row — which would have
 * priced every cross-region call 10% too low, invisibly. The routing prefix is
 * not cosmetic; it is part of the price. Model ids are now kept verbatim.
 *
 * ── Trust ───────────────────────────────────────────────────────────────────
 *
 * This is a third-party catalogue, not a vendor invoice. Most entries carry a
 * `source` URL pointing at the vendor's own pricing page, which is recorded
 * with every rate so any figure can be traced back. A tenant rate always
 * overrides it — see resolvePrice in ../pricing.ts.
 */

const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

/** The fields this module uses. LiteLLM entries carry many more. */
interface LiteLlmEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  litellm_provider?: string;
  mode?: string;
  /** Vendor pricing page, present on most entries. Recorded as provenance. */
  source?: string;
}

export interface LiteLlmRate {
  modelKey: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number | null;
  cacheWritePerMillion: number | null;
  litellmProvider: string;
  mode: string;
  sourceUrl: string;
}

const PER_MILLION = 1_000_000;

/**
 * In-memory cache. The document is ~2.7MB and changes at most daily, so
 * re-fetching it per model lookup would be absurd; an hour is comfortably
 * fresher than any pricing change matters.
 */
const CACHE_TTL_MS = 60 * 60 * 1000;
let cache: { at: number; data: Record<string, LiteLlmEntry> } | null = null;

export async function loadLiteLlmCatalog(force = false): Promise<Record<string, LiteLlmEntry>> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;

  const res = await fetch(LITELLM_URL, {
    // Without a timeout a hung connection stalls the refresh indefinitely.
    signal: AbortSignal.timeout(60_000),
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) {
    // Serve stale rather than failing: an hour-old price is far better than no
    // price, and the alternative is every model reverting to unpriced because
    // GitHub had a bad minute.
    if (cache) {
      console.warn(`[LiteLLM] Fetch failed (${res.status}); serving cached catalog.`);
      return cache.data;
    }
    throw new Error(`Could not fetch the LiteLLM pricing catalog (HTTP ${res.status}).`);
  }

  const data = (await res.json()) as Record<string, LiteLlmEntry>;
  cache = { at: Date.now(), data };
  return data;
}

/** LiteLLM's provider vocabulary mapped to ours. */
const PROVIDER_MAP: Record<string, string> = {
  bedrock: 'bedrock',
  bedrock_converse: 'bedrock',
  anthropic: 'anthropic',
  openai: 'openai',
  azure: 'azure_openai',
  azure_ai: 'azure_openai',
  azure_text: 'azure_openai',
  vertex_ai: 'vertex',
  'vertex_ai-language-models': 'vertex',
  'vertex_ai-anthropic_models': 'vertex',
  gemini: 'vertex',
};

function toRate(key: string, entry: LiteLlmEntry): LiteLlmRate | null {
  const input = entry.input_cost_per_token;
  const output = entry.output_cost_per_token;

  // Both are required. An entry with only an input price would produce a cost
  // that is confidently too low, because output is typically several times the
  // input rate. Embeddings legitimately have output 0, which is not the same
  // as absent — hence the explicit undefined check.
  if (typeof input !== 'number' || typeof output !== 'number') return null;

  return {
    modelKey: key,
    inputPerMillion: input * PER_MILLION,
    outputPerMillion: output * PER_MILLION,
    cacheReadPerMillion:
      typeof entry.cache_read_input_token_cost === 'number'
        ? entry.cache_read_input_token_cost * PER_MILLION
        : null,
    cacheWritePerMillion:
      typeof entry.cache_creation_input_token_cost === 'number'
        ? entry.cache_creation_input_token_cost * PER_MILLION
        : null,
    litellmProvider: entry.litellm_provider ?? 'unknown',
    mode: entry.mode ?? 'chat',
    sourceUrl: entry.source ?? 'https://github.com/BerriAI/litellm',
  };
}

/**
 * Candidate keys to try, most precise first.
 *
 * The exact id is tried before anything else, because LiteLLM prices routing
 * profiles separately and the prefix carries a real price difference. Only
 * after that do we fall back to the base id — and that fallback is reported as
 * a lower-confidence match, not silently.
 */
/**
 * LiteLLM namespaces most providers' models behind a prefix — `bedrock/…`,
 * `azure/…`, `vertex_ai/…` — while the runtime reports the bare id. Trying the
 * right prefix is what makes a lookup exact rather than a near-miss.
 */
const KEY_PREFIX: Record<string, string[]> = {
  bedrock: ['bedrock'],
  azure_openai: ['azure', 'azure_ai'],
  vertex: ['vertex_ai', 'gemini'],
  anthropic: ['anthropic'],
  openai: [],
};

function candidateKeys(modelId: string, providerKey?: string): Array<{ key: string; exact: boolean }> {
  const keys: Array<{ key: string; exact: boolean }> = [{ key: modelId, exact: true }];

  // The provider's own namespace first; `bedrock/` is always tried because
  // Bedrock ids reach LiteLLM both bare and prefixed.
  for (const prefix of KEY_PREFIX[providerKey ?? ''] ?? ['bedrock']) {
    keys.push({ key: `${prefix}/${modelId}`, exact: true });
  }
  if (!keys.some((k) => k.key === `bedrock/${modelId}`)) {
    keys.push({ key: `bedrock/${modelId}`, exact: true });
  }

  // Fall back to the base model without its routing prefix. This is a real
  // approximation — cross-region profiles cost ~10% more — so it is flagged.
  const withoutRouting = modelId.replace(/^(global|us|eu|apac|au|jp|us-gov)\./i, '');
  if (withoutRouting !== modelId) {
    keys.push({ key: withoutRouting, exact: false });
    keys.push({ key: `bedrock/${withoutRouting}`, exact: false });
  }

  // Some catalogues carry the vendor-less form.
  const withoutVendor = withoutRouting.replace(/^[a-z0-9-]+\./i, '');
  if (withoutVendor && withoutVendor !== withoutRouting) {
    keys.push({ key: withoutVendor, exact: false });
  }

  return keys;
}

export interface RateLookup {
  rate: LiteLlmRate;
  /** True when the exact model id was found; false when a base model was used. */
  exact: boolean;
  matchedKey: string;
}

/**
 * Finds the rate for a model id.
 *
 * `expectedProvider` guards against a same-named model on another provider —
 * Claude on Bedrock and Claude direct from Anthropic are different contracts at
 * different rates, and silently mixing them would be a quiet error.
 */
export function lookupRate(
  catalog: Record<string, LiteLlmEntry>,
  modelId: string,
  expectedProvider?: string,
): RateLookup | null {
  for (const { key, exact } of candidateKeys(modelId, expectedProvider)) {
    const entry = catalog[key];
    if (!entry) continue;

    const rate = toRate(key, entry);
    if (!rate) continue;

    if (expectedProvider) {
      const mapped = PROVIDER_MAP[rate.litellmProvider];
      // An unmapped provider is not proof of a mismatch — LiteLLM adds
      // providers faster than this map does — so only a KNOWN mismatch rejects.
      if (mapped && mapped !== expectedProvider) continue;
    }

    return { rate, exact, matchedKey: key };
  }

  return null;
}

/** Catalogue coverage for a set of models, for the UI to report honestly. */
export interface CoverageReport {
  total: number;
  exact: number;
  approximate: number;
  missing: string[];
}

export async function reportCoverage(modelIds: string[], provider?: string): Promise<CoverageReport> {
  const catalog = await loadLiteLlmCatalog();
  const report: CoverageReport = { total: modelIds.length, exact: 0, approximate: 0, missing: [] };

  for (const modelId of modelIds) {
    const hit = lookupRate(catalog, modelId, provider);
    if (!hit) report.missing.push(modelId);
    else if (hit.exact) report.exact++;
    else report.approximate++;
  }

  return report;
}
