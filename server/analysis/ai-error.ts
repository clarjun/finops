/**
 * Classify a failure from the AI provider.
 *
 * Every AI call used to end in the same handler: log the error, return 500,
 * "Please try again." That advice is wrong for most of the ways these calls
 * fail, and it is worst exactly when it matters most.
 *
 * Production spent a week answering every AI question with "Failed to process
 * your query. Please try again." The real cause was a single line the user
 * never saw:
 *
 *     401 You do not have access to the project tied to the API key.
 *
 * No amount of retrying fixes a revoked key. The message sent users to retry,
 * made the product look flaky, and hid a one-line configuration fix from the
 * only people who could apply it.
 *
 * So failures are separated by who can act on them:
 *
 *   config    an operator must change something. Never retryable.
 *   quota     billing or rate limits. Retryable, but not immediately.
 *   upstream  the provider is having trouble. Retryable.
 *   unknown   anything unrecognised. Retryable, because assuming a permanent
 *             failure on an unfamiliar error would hide a transient one.
 *
 * Messages are written for the person reading them in the UI and deliberately
 * carry no key material, model names or internal paths — this text reaches an
 * unauthenticated error surface.
 */

export type AiFailureKind = 'config' | 'quota' | 'upstream' | 'unknown';

export interface AiFailure {
  kind: AiFailureKind;
  /** HTTP status for our own response. */
  status: number;
  /** Shown to the user. No internal detail. */
  message: string;
  /** Whether repeating the same request could plausibly succeed. */
  retryable: boolean;
}

/** Status the provider returned, where the SDK exposed one. */
function statusOf(err: unknown): number | undefined {
  const s = (err as { status?: unknown; statusCode?: unknown })?.status
    ?? (err as { statusCode?: unknown })?.statusCode;
  return typeof s === 'number' ? s : undefined;
}

function textOf(err: unknown): string {
  const e = err as { message?: unknown; code?: unknown; type?: unknown; error?: { message?: unknown; code?: unknown } };
  return [e?.message, e?.code, e?.type, e?.error?.message, e?.error?.code]
    .filter((v) => typeof v === 'string')
    .join(' ')
    .toLowerCase()
    // Underscores become spaces so one spelling matches every variant the
    // provider and our own code use: OPENAI_API_KEY, "api key", invalid_project
    // and "invalid project" all normalise to the same thing. Matching the
    // spaced form alone missed the missing-key case entirely.
    .replace(/[_-]+/g, ' ');
}

export function classifyAiError(err: unknown): AiFailure {
  const status = statusOf(err);
  const text = textOf(err);

  // Configuration. 401 and 403 from the provider are never the user's doing and
  // never fix themselves: a missing, revoked, or wrong-project key.
  //
  // `invalid_project` is called out because it is the confusing one — the key
  // is well-formed and was valid once, so it looks like an outage rather than a
  // credential that needs replacing.
  const configText =
    text.includes('api key') ||
    text.includes('invalid project') ||
    text.includes('do not have access to the project') ||
    text.includes('incorrect api key') ||
    text.includes('authentication');

  if (status === 401 || status === 403 || (status === undefined && configText)) {
    return {
      kind: 'config',
      status: 503,
      message:
        'AI analysis is unavailable because this deployment\'s AI provider key was rejected. ' +
        'Retrying will not help — an administrator needs to update the key.',
      retryable: false,
    };
  }

  // Quota and rate limits. Retryable, but "try again" alone is misleading when
  // the account is simply out of credit, so both cases are named.
  if (status === 429 || text.includes('quota') || text.includes('rate limit') || text.includes('insufficient quota')) {
    const billing = text.includes('quota') || text.includes('billing') || text.includes('credit');
    return {
      kind: 'quota',
      status: 429,
      message: billing
        ? 'The AI provider reports this account is out of quota. An administrator needs to check its billing.'
        : 'The AI provider is rate-limiting requests. Wait a moment and ask again.',
      retryable: true,
    };
  }

  if ((status !== undefined && status >= 500) || text.includes('timeout') || text.includes('econnreset') || text.includes('socket hang up')) {
    return {
      kind: 'upstream',
      status: 503,
      message: 'The AI provider is temporarily unavailable. Try again in a moment.',
      retryable: true,
    };
  }

  return {
    kind: 'unknown',
    status: 500,
    message: 'Something went wrong while analyzing your query. Try again shortly.',
    retryable: true,
  };
}
