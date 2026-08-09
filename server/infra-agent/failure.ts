/**
 * What a Terraform failure means, and whether to try again.
 *
 * Until now a failed deployment did one thing: stop. That is wrong in both
 * directions. A throttling response from EC2 is not a reason to abandon a
 * half-built environment, and an invalid instance type is not something that
 * gets better on the third attempt.
 *
 * The classification is a table of patterns rather than a question for a model.
 * Deciding whether to re-run an operation against someone's cloud account is a
 * safety decision, and a safety decision has to be inspectable, deterministic,
 * and the same on Tuesday as it was on Monday. A model belongs later in the
 * process — proposing a fix for a permanent error — not here.
 *
 * Anything unrecognised is `unknown`, which never retries. Not knowing what
 * went wrong is the worst possible reason to do it again.
 */

export type FailureKind =
  /** Will likely succeed on its own: throttling, timeouts, eventual consistency. */
  | 'transient'
  /** Real, but fixable outside this system: quota, permissions, capacity. */
  | 'blocked'
  /** The configuration is wrong. Retrying cannot help. */
  | 'permanent'
  /** Unrecognised. Treated as needing a human, and never retried. */
  | 'unknown';

export interface Classification {
  kind: FailureKind;
  /** The pattern that matched, so a human can see why it was classified. */
  reason: string;
  retryable: boolean;
}

interface Rule { kind: Exclude<FailureKind, 'unknown'>; reason: string; match: RegExp }

/**
 * Order matters, and transient comes first for a specific reason.
 *
 * `RequestLimitExceeded` is AWS's throttling error and contains the substring
 * "LimitExceeded", which is also how quota errors read. Checked the other way
 * round, every throttle would be classified as an exhausted quota and the
 * deployment would stop instead of waiting two seconds and succeeding.
 */
const RULES: Rule[] = [
  /* ---- transient ------------------------------------------------------- */
  { kind: 'transient', reason: 'request throttled by the provider',
    match: /throttl|RequestLimitExceeded|TooManyRequests|Rate ?exceeded|SlowDown|Client\.RequestLimitExceeded/i },
  { kind: 'transient', reason: 'the operation timed out',
    match: /\btimeout\b|timed out|context deadline exceeded/i },
  { kind: 'transient', reason: 'the provider reported a temporary internal error',
    match: /ServiceUnavailable|InternalError|InternalFailure|Service is unavailable|try again later/i },
  { kind: 'transient', reason: 'the network dropped the connection',
    match: /connection reset|connection refused|EOF\b|no such host|TLS handshake/i },
  // Cloud APIs are eventually consistent: a resource can exist and not yet be
  // visible to the call that needs it. Waiting is the documented fix.
  { kind: 'transient', reason: 'a dependency was not visible yet (eventual consistency)',
    match: /does not exist yet|not yet (available|ready|propagated)|still (creating|pending)|InvalidGroup\.NotFound|InvalidSubnetID\.NotFound|does not exist \(yet\)/i },

  /* ---- blocked: real, but fixed outside this system --------------------- */
  { kind: 'blocked', reason: 'an account quota or service limit was reached',
    match: /quota|LimitExceeded|MaxNumberOf|VcpuLimitExceeded|AddressLimitExceeded|exceeded the maximum/i },
  { kind: 'blocked', reason: 'the credentials are not permitted to do this',
    match: /AccessDenied|UnauthorizedOperation|not authorized to perform|InvalidClientTokenId|SignatureDoesNotMatch|is not authorized/i },
  { kind: 'blocked', reason: 'the credentials have expired',
    match: /ExpiredToken|TokenRefreshRequired|security token.*expired|credentials.*expired/i },
  { kind: 'blocked', reason: 'the provider has no capacity for this instance type right now',
    match: /InsufficientInstanceCapacity|Insufficient capacity|capacity is not available/i },

  /* ---- permanent: the configuration is wrong ---------------------------- */
  { kind: 'permanent', reason: 'a parameter the configuration set is not valid',
    match: /InvalidParameter|ValidationError|ValidationException|MalformedPolicyDocument|InvalidInput|is not a valid/i },
  { kind: 'permanent', reason: 'the resource already exists',
    match: /AlreadyExists|EntityAlreadyExists|BucketAlreadyOwnedByYou|DuplicateName|already in use/i },
  { kind: 'permanent', reason: 'the provider does not support this here',
    match: /Unsupported|does not support|NotAvailableInRegion|InvalidAMIID|no matching .* found|Unsupported operation/i },
  { kind: 'permanent', reason: 'the configuration itself is invalid',
    match: /Invalid (function|index|reference|template)|Unsupported argument|Missing required argument|Reference to undeclared/i },
  // The topology does not satisfy a provider requirement — a subnet group that
  // does not span two zones, a resource in the wrong scope. remedies.ts can
  // explain these and often name the answer that would fix them, so leaving
  // them `unknown` would have the two modules disagreeing about an error they
  // both recognise, and would pause a run whose plan has to change regardless.
  { kind: 'permanent', reason: 'the topology does not meet a provider requirement',
    match: /DoesNotCoverEnoughAZs|does not cover at least two|requires at least two subnets|InvalidSubnet\.Conflict|must be in (a different|at least)/i },
];

/** Attempts allowed for a transient failure, including the first. */
export const MAX_ATTEMPTS = 3;

/**
 * Classifies a failure from whatever text the tool produced.
 *
 * Takes plain text because `apply` gives only stderr, while `plan` gives
 * structured diagnostics — both end up as prose, and one classifier over the
 * combined string is more honest than two that could disagree.
 */
export function classifyFailure(text: string): Classification {
  const haystack = (text ?? '').slice(0, 8000);

  for (const rule of RULES) {
    if (rule.match.test(haystack)) {
      return { kind: rule.kind, reason: rule.reason, retryable: rule.kind === 'transient' };
    }
  }

  return {
    kind: 'unknown',
    reason: 'the error was not recognised, so it is left for a human',
    retryable: false,
  };
}

/**
 * Whether another attempt is warranted.
 *
 * `attemptsSoFar` counts attempts already made, so the first failure arrives
 * here as 1.
 */
export function shouldRetry(classification: Classification, attemptsSoFar: number): boolean {
  return classification.retryable && attemptsSoFar < MAX_ATTEMPTS;
}

/**
 * How long to wait before the next attempt.
 *
 * Backed off rather than immediate: retrying a throttle straight away is how a
 * client turns provider throttling into provider blocking. The values stay well
 * inside the run lease, so a waiting attempt never lets another worker take the
 * run over mid-retry.
 */
export function retryDelayMs(attemptsSoFar: number): number {
  const schedule = [2_000, 8_000, 20_000];
  return schedule[Math.min(attemptsSoFar, schedule.length) - 1] ?? 20_000;
}

/**
 * How a failed run should end when it is not being retried.
 *
 * `blocked` and `unknown` become `paused`, not `failed`: the resources that were
 * created still exist, the cause may be fixable outside this system, and a
 * paused run can be resumed once it is. Calling that "failed" would suggest
 * there is nothing left to do, and would throw away a half-built environment
 * that is one quota increase away from finishing.
 *
 * `permanent` really is failed. The configuration has to change, and that means
 * a new plan.
 */
export function terminalStatusFor(kind: FailureKind): 'failed' | 'paused' {
  return kind === 'permanent' ? 'failed' : 'paused';
}
