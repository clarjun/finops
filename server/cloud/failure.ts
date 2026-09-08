/**
 * What a cloud billing-API failure means, and whether to try again.
 *
 * One classifier for every provider, because the decision is the same decision
 * regardless of who returned the error: wait, stop and tell someone, or stop and
 * fix the code. Three connectors previously answered it three different ways —
 * AWS leaned on the SDK's retry, Azure had a hand-written loop added twice, and
 * GCP had nothing at all — which is why the same class of outage kept recurring
 * on whichever provider happened to lack the protection.
 *
 * A rule table, not a heuristic. Deciding whether to re-issue a billed request
 * against a customer's account has to be inspectable and identical on Tuesday to
 * what it was on Monday. Modelled on infra-agent/failure.ts, which does the same
 * job for Terraform and has proved sound.
 *
 * Anything unrecognised is `unknown`, which never retries. Not knowing what went
 * wrong is the worst possible reason to do it again.
 */

export type FailureKind =
  /** Provider explicitly asked us to slow down. Retry, honouring its timing. */
  | 'throttled'
  /** Likely to succeed on its own: timeouts, transient 5xx, connection resets. */
  | 'transient'
  /** Real, fixable outside this system: expired secret, missing permission, quota. */
  | 'blocked'
  /** The request is wrong. Retrying cannot help. */
  | 'permanent'
  /** Unrecognised. Never retried. */
  | 'unknown';

export interface Classification {
  kind: FailureKind;
  /** The matched pattern, so a human can see why it was classified this way. */
  reason: string;
  retryable: boolean;
}

interface Rule {
  kind: Exclude<FailureKind, 'unknown'>;
  reason: string;
  match: RegExp;
}

/**
 * Order matters.
 *
 * Throttling is checked first because its text overlaps with quota exhaustion —
 * AWS's `RequestLimitExceeded` contains "LimitExceeded", which also reads as a
 * spent quota. Classified the other way round, every throttle would look like an
 * exhausted quota and ingestion would stop instead of waiting and succeeding.
 * That is exactly the mistake that produced three Azure outages.
 */
const RULES: Rule[] = [
  /* ---- throttled: the provider named the problem ------------------------ */
  { kind: 'throttled', reason: 'the provider is rate-limiting this query',
    match: /\b429\b|TooManyRequests|Rate ?exceeded|RequestLimitExceeded|throttl|SlowDown|rateLimitExceeded|quotaExceeded.*rate|userRateLimitExceeded/i },

  /* ---- transient: will probably work shortly ---------------------------- */
  { kind: 'transient', reason: 'the request timed out',
    match: /\btimeout\b|timed out|ETIMEDOUT|context deadline exceeded|ESOCKETTIMEDOUT/i },
  { kind: 'transient', reason: 'the provider reported a temporary internal error',
    match: /\b50[0234]\b|ServiceUnavailable|InternalError|InternalFailure|InternalServerError|backendError|try again later/i },
  { kind: 'transient', reason: 'the network dropped the connection',
    match: /ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|network error|fetch failed|ENOTFOUND|EAI_AGAIN|TLS handshake/i },

  /* ---- blocked: real, but fixed outside this system --------------------- */
  { kind: 'blocked', reason: 'the stored credential was rejected or has expired',
    match: /AADSTS7000215|invalid_client|InvalidClientTokenId|SignatureDoesNotMatch|ExpiredToken|TokenRefreshRequired|invalid_grant|credential.*expired|AADSTS700(16|24)/i },
  { kind: 'blocked', reason: 'the credential lacks a permission this query needs',
    match: /AccessDenied|UnauthorizedOperation|not authorized to perform|Forbidden|\b403\b|PERMISSION_DENIED|does not have.*permission|AuthorizationFailed/i },
  { kind: 'blocked', reason: 'an account quota or service limit was reached',
    match: /quota.*exceeded|LimitExceeded|exceeded the maximum|OverQuota|resourcesExceeded/i },
  { kind: 'blocked', reason: 'cost data is not enabled for this account',
    match: /not registered|not enabled|no billing account|BillingNotEnabled|export.*not configured|dataset.*not found|Table.*not found|NotFound.*billing/i },

  /* ---- permanent: the request itself is wrong --------------------------- */
  { kind: 'permanent', reason: 'the query was malformed or used an invalid parameter',
    match: /\b400\b|ValidationError|ValidationException|InvalidParameter|BadRequest|invalidQuery|Syntax error|malformed|Unsupported.*granularity|InvalidInput/i },
  { kind: 'permanent', reason: 'the requested scope or dimension is not supported here',
    match: /Unsupported|does not support|NotAvailableIn|InvalidDimension|unsupported.*scope/i },
];

/** Attempts allowed for a retryable failure, including the first. */
export const MAX_ATTEMPTS = 6;

/**
 * Classifies a failure from whatever text the caller has.
 *
 * Takes free text plus an optional HTTP status because the three providers
 * surface errors differently — an SDK exception name, a REST body, a BigQuery
 * error object. One classifier over the combined string is more honest than
 * three that could disagree about the same underlying condition.
 */
export function classifyFailure(input: {
  message?: string;
  name?: string;
  status?: number;
}): Classification {
  const haystack = [
    input.name ?? '',
    input.status != null ? String(input.status) : '',
    (input.message ?? '').slice(0, 4000),
  ].join(' ');

  for (const rule of RULES) {
    if (rule.match.test(haystack)) {
      return {
        kind: rule.kind,
        reason: rule.reason,
        retryable: rule.kind === 'throttled' || rule.kind === 'transient',
      };
    }
  }

  return {
    kind: 'unknown',
    reason: 'the error was not recognised, so it is left for a human',
    retryable: false,
  };
}

/**
 * Whether another attempt is warranted. `attemptsSoFar` counts attempts already
 * made, so the first failure arrives here as 1.
 *
 * The ceiling is a parameter rather than the constant, because a background
 * ingestion can afford more attempts than an interactive request. MAX_ATTEMPTS
 * remains the default for callers that do not care.
 */
export function shouldRetry(
  c: Classification,
  attemptsSoFar: number,
  maxAttempts: number = MAX_ATTEMPTS,
): boolean {
  return c.retryable && attemptsSoFar < maxAttempts;
}

/**
 * How long to wait before the next attempt.
 *
 * `retryAfterMs` — what the provider explicitly asked for — always wins. It is
 * better information than any schedule we could invent, and ignoring it is what
 * made the Azure retry loop give up while holding the answer.
 *
 * Otherwise exponential with jitter. Jitter matters because several consumers
 * (ingester, alert checker, dashboard) can be throttled simultaneously; without
 * it they retry in lockstep and throttle each other again.
 */
export function backoffMs(attemptsSoFar: number, retryAfterMs?: number | null): number {
  if (retryAfterMs != null && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, 120_000);
  }
  // Base is configurable so tests can use milliseconds instead of seconds.
  // Real-timer sleeps of 5-60s in a unit test are both slow and flaky: under
  // full-suite parallelism they compete for CPU and overrun their timeouts,
  // which is exactly what made one of these tests fail intermittently.
  const baseUnit = Number(process.env.CLOUD_BACKOFF_BASE_MS) || 5_000;
  const ceiling = Math.max(baseUnit * 12, baseUnit);
  const base = Math.min(baseUnit * 2 ** (attemptsSoFar - 1), ceiling);
  // Full jitter over the top 40%, so retries spread out rather than colliding.
  return Math.round(base * (0.6 + Math.random() * 0.4));
}

/**
 * Seconds a provider asked us to wait, from response headers.
 *
 * Checks the standard header and the provider-specific ones. Azure Cost
 * Management uses several `x-ms-ratelimit-*-retry-after` variants and does not
 * always send plain `Retry-After`, which is why this looks at more than one.
 */
const RETRY_AFTER_HEADERS = [
  'retry-after',
  'x-ms-ratelimit-microsoft.costmanagement-entity-retry-after',
  'x-ms-ratelimit-microsoft.costmanagement-tenant-retry-after',
  'x-ms-ratelimit-microsoft.costmanagement-client-retry-after',
  'x-ratelimit-reset-after',
];

export function retryAfterFromHeaders(headers: Headers | undefined): number | null {
  if (!headers) return null;
  for (const name of RETRY_AFTER_HEADERS) {
    const raw = headers.get(name);
    if (!raw) continue;
    const seconds = Number(raw.trim());
    // Only a plain seconds count. Retry-After also permits an HTTP date, but
    // parsing that wrong yields a wait of hours or of zero — both worse than
    // falling back to the backoff schedule.
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 120) * 1000;
  }
  return null;
}
