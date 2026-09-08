/**
 * Shared retry and rate budget for any single provider API call.
 *
 * The cost adapters get this from the fetch runtime, which also owns pagination
 * and multi-pass sequencing. But plenty of provider calls are not paginated
 * lists of cost rows and should not be forced into that contract:
 *
 *   - usage-type and meter-category drill-downs (analysis/*-cost-explorer)
 *   - resource inventory, which returns ~20 heterogeneous resource types with
 *     no common schema to normalize to
 *   - metrics queries
 *
 * Those share the *operational* problem, not the shape. Before this existed,
 * every one of them had its own answer, and mostly the answer was "none":
 * `analysis/aws-cost-explorer.ts` and `analysis/azure-cost-explorer.ts` each had
 * zero pagination and zero retry, so the same throttling that produced three
 * visible Azure outages was sitting unhandled in the analysis layer too.
 *
 * This deliberately does NOT impose a schema. It wraps one call with the same
 * classification, backoff and per-provider budget the adapters use, so a fix to
 * the retry policy reaches every provider call in the application rather than
 * only the ones that happen to fetch cost rows.
 */
import type { CloudProvider } from '@shared/schema';
import { withBudget } from './rate-budget';
import {
  classifyFailure, shouldRetry, backoffMs, retryAfterFromHeaders,
  MAX_ATTEMPTS, type Classification,
} from './failure';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Extracts what the classifier needs from an SDK exception or a REST error. */
function errorFacts(err: unknown): { message: string; name?: string; status?: number; headers?: Headers } {
  const e = err as any;
  return {
    message: e?.message ?? String(err),
    name: e?.name,
    status: e?.status ?? e?.$metadata?.httpStatusCode ?? e?.statusCode,
    headers: e?.headers instanceof Headers ? e.headers : undefined,
  };
}

export class ProviderQueryError extends Error {
  constructor(message: string, readonly classification: Classification) {
    super(message);
    this.name = 'ProviderQueryError';
  }
}

export interface QueryOptions {
  /** Total wall-clock time available for retries. */
  budgetMs?: number;
  maxAttempts?: number;
}

/**
 * Default budget for a drill-down or inventory call.
 *
 * Shorter than ingestion's eight minutes: these run behind a user action, so
 * waiting minutes is worse than saying "temporarily unavailable". Longer than
 * nothing, which is what they had.
 */
export const QUERY_BUDGET_MS = Number(process.env.CLOUD_QUERY_BUDGET_MS) || 60_000;

/**
 * Runs one provider call with the shared budget and retry policy.
 *
 * `label` appears in log lines, so a throttled inventory sweep is
 * distinguishable from a throttled cost query when reading production logs.
 *
 * Throws `ProviderQueryError` with the classification attached rather than
 * returning a fallback: the caller decides whether an empty result is
 * acceptable for its screen, and a silent `[]` is how "provider unreachable"
 * became "you spent nothing" in the first place.
 */
export async function runProviderQuery<T>(
  provider: CloudProvider,
  label: string,
  fn: () => Promise<T>,
  options: QueryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  const deadline = Date.now() + (options.budgetMs ?? QUERY_BUDGET_MS);

  let attempts = 0;
  let last: Classification | null = null;

  while (attempts < maxAttempts) {
    attempts++;
    try {
      return await withBudget(provider, fn);
    } catch (err) {
      const facts = errorFacts(err);
      const c = classifyFailure(facts);
      last = c;

      // Blocked and permanent failures are not retried. Six attempts at an
      // expired credential only delays a clear message.
      if (!shouldRetry(c, attempts, maxAttempts)) {
        throw new ProviderQueryError(`${provider} ${label}: ${c.reason}`, c);
      }

      const wait = backoffMs(attempts, retryAfterFromHeaders(facts.headers));
      const remaining = deadline - Date.now();

      if (wait > remaining) {
        throw new ProviderQueryError(
          `${provider} ${label}: ${c.reason}, and the ${Math.round(wait / 1000)}s wait it needs ` +
          `exceeds the ${Math.round(Math.max(remaining, 0) / 1000)}s of budget left.`,
          c,
        );
      }

      console.log(
        `[Cloud/${provider}] ${c.kind} on ${label} attempt ${attempts}/${maxAttempts}: ` +
        `${c.reason}. Retrying in ${Math.round(wait / 1000)}s.`,
      );
      await sleep(wait);
    }
  }

  throw new ProviderQueryError(
    `${provider} ${label}: gave up after ${maxAttempts} attempts — ${last?.reason ?? 'unknown'}`,
    last ?? { kind: 'unknown', reason: 'exhausted attempts', retryable: false },
  );
}

/**
 * Paginates a provider call that returns a cursor, with retry on every page.
 *
 * Separate from the adapter runtime because the item type is the caller's, not
 * a NormalizedCostRecord. Same hard page cap and same refusal to truncate: a
 * short list presented as complete is what hid 29% of a month's Azure spend and
 * is the failure this signature exists to make impossible.
 */
export async function runPaginatedQuery<TItem, TCursor = string>(
  provider: CloudProvider,
  label: string,
  page: (cursor: TCursor | undefined) => Promise<{ items: TItem[]; nextCursor?: TCursor }>,
  options: QueryOptions & { maxPages?: number } = {},
): Promise<TItem[]> {
  const maxPages = options.maxPages ?? 100;
  const items: TItem[] = [];
  let cursor: TCursor | undefined;
  let pages = 0;

  do {
    const captured = cursor;
    const result = await runProviderQuery(provider, `${label} p${pages + 1}`, () => page(captured), options);
    pages++;
    items.push(...result.items);
    cursor = result.nextCursor;

    if (cursor && pages >= maxPages) {
      throw new ProviderQueryError(
        `${provider} ${label}: more than ${maxPages} pages. Refusing to return a truncated result.`,
        { kind: 'permanent', reason: 'page limit exceeded', retryable: false },
      );
    }
  } while (cursor);

  if (pages > 1) {
    console.log(`[Cloud/${provider}] ${label}: ${items.length} items across ${pages} pages.`);
  }
  return items;
}
