/**
 * A shared, per-provider request budget.
 *
 * Three independent things call the billing APIs — the ingestion scheduler
 * (6-hourly), the budget alert checker (hourly) and the dashboard refresh
 * (on demand) — and until now none of them knew the others existed. Against
 * Azure Cost Management, whose quota at billing-account scope is small, that
 * meant they routinely throttled each other and the resulting 429s looked like
 * a broken integration.
 *
 * Two controls, because throttling has two causes:
 *
 *   concurrency   too many requests at the same instant. The Azure connector
 *                 used Promise.all for its two passes and reliably 429'd itself.
 *   spacing       too many requests over a short window, which is what a
 *                 per-entity quota actually measures.
 *
 * Process-wide rather than per-caller, deliberately: a budget each consumer
 * holds privately does not prevent them colliding, which is the entire problem.
 *
 * Not distributed. With several replicas each has its own budget, so the
 * effective rate is multiplied by replica count. That is a real limitation and
 * is called out rather than hidden — the fix would be a Postgres or Redis token
 * bucket, and it is not worth that until multi-replica throttling is observed.
 */

export interface ProviderBudget {
  /** Requests allowed in flight at once. */
  maxConcurrent: number;
  /** Minimum gap between request starts. */
  minIntervalMs: number;
}

/**
 * Defaults tuned to each provider's actual behaviour, not to a uniform guess.
 *
 *   azure   the tightest by far. Cost Management at billing-account scope
 *           returned Retry-After values of 37-52s in testing, so one request at
 *           a time with a real gap between them.
 *   aws     Cost Explorer bills per request rather than throttling hard, so the
 *           limit here protects the invoice as much as the rate.
 *   gcp     BigQuery has generous quotas and charges per byte scanned, so
 *           concurrency is cheap; the interval guards against a runaway loop.
 */
const DEFAULTS: Record<string, ProviderBudget> = {
  azure: { maxConcurrent: 1, minIntervalMs: 1_500 },
  aws: { maxConcurrent: 2, minIntervalMs: 250 },
  gcp: { maxConcurrent: 3, minIntervalMs: 100 },
};

const FALLBACK: ProviderBudget = { maxConcurrent: 1, minIntervalMs: 1_000 };

function budgetFor(provider: string): ProviderBudget {
  const envConcurrent = Number(process.env[`CLOUD_BUDGET_${provider.toUpperCase()}_CONCURRENT`]);
  const envInterval = Number(process.env[`CLOUD_BUDGET_${provider.toUpperCase()}_INTERVAL_MS`]);
  const base = DEFAULTS[provider] ?? FALLBACK;
  return {
    maxConcurrent: Number.isFinite(envConcurrent) && envConcurrent > 0 ? envConcurrent : base.maxConcurrent,
    minIntervalMs: Number.isFinite(envInterval) && envInterval >= 0 ? envInterval : base.minIntervalMs,
  };
}

interface Lane {
  inFlight: number;
  lastStartMs: number;
  /** FIFO, so a request that has waited longest goes next. */
  queue: Array<() => void>;
}

const lanes = new Map<string, Lane>();

function lane(provider: string): Lane {
  let l = lanes.get(provider);
  if (!l) {
    l = { inFlight: 0, lastStartMs: 0, queue: [] };
    lanes.set(provider, l);
  }
  return l;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Runs `fn` within the provider's budget.
 *
 * Queues rather than rejects when the budget is full: a caller that has decided
 * to fetch cost data wants it fetched, and failing fast here would only move the
 * problem to the caller, which has less information about the provider's limits
 * than this module does.
 *
 * Releases in a `finally`, so a thrown request cannot leak a slot and
 * permanently shrink the budget — the failure mode that turns a transient error
 * into a permanently stalled provider.
 */
export async function withBudget<T>(provider: string, fn: () => Promise<T>): Promise<T> {
  const { maxConcurrent, minIntervalMs } = budgetFor(provider);
  const l = lane(provider);

  if (l.inFlight >= maxConcurrent) {
    await new Promise<void>((resolve) => l.queue.push(resolve));
  }

  l.inFlight++;

  try {
    const since = Date.now() - l.lastStartMs;
    if (since < minIntervalMs) {
      await sleep(minIntervalMs - since);
    }
    l.lastStartMs = Date.now();
    return await fn();
  } finally {
    l.inFlight--;
    const next = l.queue.shift();
    if (next) next();
  }
}

/** Diagnostics. Exposes counts only. */
export function budgetStats(): Record<string, { inFlight: number; queued: number; budget: ProviderBudget }> {
  const out: Record<string, { inFlight: number; queued: number; budget: ProviderBudget }> = {};
  for (const [provider, l] of lanes) {
    out[provider] = { inFlight: l.inFlight, queued: l.queue.length, budget: budgetFor(provider) };
  }
  return out;
}

/** Test seam. */
export function resetBudgets(): void {
  lanes.clear();
}
