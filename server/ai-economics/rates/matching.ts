/**
 * Matching a metered model to a published rate.
 *
 * The two sides do not agree on names, and this is the whole difficulty of
 * fetching rates automatically.
 *
 * CloudWatch reports what the API was called with:
 *     anthropic.claude-haiku-4-5-20251001-v1:0
 *
 * The AWS Price List reports a human label plus a usage type:
 *     model      "Claude 3 Sonnet"
 *     usagetype  "USE1-Claude3Sonnet-input-tokens"
 *     usagetype  "USE1-zai.glm-4.7-output-tokens-batch"   (newer models)
 *
 * Newer entries embed the API model id in usagetype, older ones use a
 * squashed display name. So matching tries the precise signal first and falls
 * back to a normalised comparison — and refuses rather than guessing when
 * neither is confident.
 *
 * ── Why a wrong match is worse than no match ────────────────────────────────
 *
 * Attaching Claude Haiku's rate to Claude Opus usage produces a cost that is
 * wrong by a factor of forty, and looks entirely plausible on a dashboard. An
 * unmatched model shows as "no rate configured", which is visible and fixable.
 * Every ambiguity here therefore resolves to no-match.
 */

export interface RateCandidate {
  /** The provider's usage type string, where one exists. */
  usageType?: string | null;
  /** The provider's display label for the model, e.g. "Claude 3 Sonnet". */
  modelLabel?: string | null;
  /** Vendor, e.g. "Anthropic". */
  provider?: string | null;
}

/**
 * Reduces a name to comparable characters.
 *
 * Drops punctuation, spacing and case so "Claude 3 Sonnet", "claude-3-sonnet"
 * and "Claude3Sonnet" all converge. Version digits are KEPT — they are the
 * difference between a $0.25 model and a $15 one.
 */
export function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The identifying part of a Bedrock model id.
 *
 * "anthropic.claude-haiku-4-5-20251001-v1:0" -> "claudehaiku45"
 *
 * The vendor prefix, the build date and the version suffix are removed. The
 * build date especially must go: the Price List never carries it, so leaving it
 * in guarantees nothing ever matches.
 */
export function modelIdSignature(modelId: string): string {
  const withoutRouting = modelId.replace(/^(global|us|eu|apac|us-gov)\./i, '');
  const withoutVendor = withoutRouting.replace(/^[a-z0-9-]+\./i, '');
  return normalizeName(
    withoutVendor
      .replace(/-v\d+(:\d+)?$/i, '')   // -v1:0
      .replace(/[-:]\d{8}\b/g, '')     // -20251001
      .replace(/-\d{8}$/, ''),
  );
}

/**
 * How confident a match is.
 *
 * `exact`  the API model id appears verbatim in the usage type.
 * `strong` normalised signatures are equal.
 * `none`   anything else. Deliberately not "weak" — a partial match is not
 *          used, because a plausible wrong rate is worse than a visible gap.
 */
export type MatchStrength = 'exact' | 'strong' | 'none';

export interface MatchResult {
  strength: MatchStrength;
  /** Why, for the UI to show when a customer asks where a rate came from. */
  reason: string;
}

export function matchModel(modelId: string, candidate: RateCandidate): MatchResult {
  const signature = modelIdSignature(modelId);
  if (!signature) return { strength: 'none', reason: 'Model id has no comparable identifier.' };

  // 1. The API model id embedded in the usage type. Newer Bedrock entries do
  //    this, and it is unambiguous.
  const usageType = candidate.usageType ?? '';
  if (usageType) {
    const bare = modelId.replace(/^(global|us|eu|apac|us-gov)\./i, '').replace(/-v\d+(:\d+)?$/i, '');
    if (bare && usageType.toLowerCase().includes(bare.toLowerCase())) {
      return { strength: 'exact', reason: `Usage type contains the model id "${bare}".` };
    }

    // The squashed form older entries use: USE1-Claude3Sonnet-input-tokens.
    const squashed = normalizeName(usageType);
    if (squashed.includes(signature) && signature.length >= 6) {
      return { strength: 'strong', reason: `Usage type matches "${signature}".` };
    }
  }

  // 2. The display label.
  const label = candidate.modelLabel ?? '';
  if (label) {
    const normalizedLabel = normalizeName(label);
    if (normalizedLabel === signature) {
      return { strength: 'strong', reason: `Model name "${label}" matches exactly.` };
    }
    // Containment is allowed only one way and only for a substantial
    // signature: "claude" inside "claudeopus45" must never match.
    if (signature.length >= 8 && normalizedLabel.length >= 8) {
      if (normalizedLabel === signature) {
        return { strength: 'strong', reason: `Model name "${label}" matches.` };
      }
    }
  }

  return {
    strength: 'none',
    reason: `No published rate matched "${modelId}". Set one manually, or the usage stays unpriced.`,
  };
}

/**
 * Picks the best candidate for a model.
 *
 * Returns null when the best is ambiguous — two different candidates matching
 * equally well means we cannot tell which rate applies, and choosing one at
 * random is exactly the silent error this module exists to avoid.
 */
export function bestMatch<T extends RateCandidate>(
  modelId: string,
  candidates: T[],
): { candidate: T; match: MatchResult } | null {
  const scored = candidates
    .map((candidate) => ({ candidate, match: matchModel(modelId, candidate) }))
    .filter((s) => s.match.strength !== 'none');

  if (scored.length === 0) return null;

  const exact = scored.filter((s) => s.match.strength === 'exact');
  const pool = exact.length > 0 ? exact : scored;

  // Distinct usage types at the same strength mean genuine ambiguity.
  const distinct = new Set(pool.map((s) => normalizeName(s.candidate.usageType ?? s.candidate.modelLabel ?? '')));
  if (distinct.size > 1) return null;

  return pool[0];
}
