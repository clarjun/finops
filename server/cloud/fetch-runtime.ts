/**
 * The provider-agnostic cost-fetch runtime.
 *
 *   adapter declares WHAT to fetch  →  runtime owns HOW
 *
 * The existing CostConnector contract already abstracted the *shape* of the
 * data — every connector returns FOCUS-shaped NormalizedCostRecords and nothing
 * downstream branches on provider. What it did not abstract were the operational
 * concerns, and each connector reinvented them:
 *
 *   pagination    AWS used NextPageToken; Azure's nextLink was missing entirely
 *                 and lost 29% of a month's spend, independently, in two files
 *   retry         AWS relied on the SDK; Azure had a hand-written loop added
 *                 twice; GCP had none
 *   throttling    no shared budget, so the ingester, alert checker and refresh
 *                 button throttled each other
 *   errors        three different vocabularies for the same conditions
 *   date bounds   AWS/GCP exclusive, Azure inclusive — so a cross-cloud total
 *                 combined 22 Azure days with 21 AWS days
 *
 * Every one of those was a real, shipped bug. They recurred because each was
 * fixed in one connector at a time. This module makes them properties of the
 * runtime, so a fix lands once and a new provider inherits it.
 *
 * An adapter now implements two things — fetch one page, and map raw rows — and
 * declares its semantics. It writes no loop, no retry, and no error handling.
 */
import type { CloudProvider } from '@shared/schema';
import type { NormalizedCostRecord, DateRange } from '../ingestion/types';
import { withBudget } from './rate-budget';
import {
  classifyFailure, shouldRetry, backoffMs, retryAfterFromHeaders,
  MAX_ATTEMPTS, type Classification,
} from './failure';

/** One page of provider-native rows, plus how to ask for the next. */
export interface PageResult<TRaw> {
  rows: TRaw[];
  /** Null or undefined means this was the last page. */
  nextCursor?: string | null;
  /** Response headers, when the provider is REST — used to read Retry-After. */
  headers?: Headers;
}

/** The account being fetched. Adapters resolve their own credentials. */
export interface AdapterAccount {
  /** cloud_accounts.id */
  id: number;
  accountId: string;
  accountName: string;
  credentials: Record<string, any>;
  authType: string;
}

export interface FetchContext {
  account: AdapterAccount;
  range: DateRange;
  /** Which pass, for providers needing more than one query per range. */
  pass: string;
}

export interface CloudCostAdapter<TRaw> {
  readonly provider: CloudProvider;

  /**
   * Queries needed per range.
   *
   * Most providers need one. Azure needs two — ActualCost and AmortizedCost —
   * because amortization is selected by the query `type` and cannot be obtained
   * in a single call. The runtime runs them SEQUENTIALLY; running them
   * concurrently is what made the Azure connector throttle itself.
   */
  readonly passes: readonly string[];

  /**
   * Hard ceiling on pages per pass. Prevents a cursor that never clears from
   * spinning forever, and makes truncation an explicit error instead of a
   * silently short total.
   */
  readonly maxPages: number;

  /** Accounts to iterate for the calling tenant. */
  listAccounts(): Promise<AdapterAccount[]>;

  /** One page. The runtime owns the loop, the retry and the budget. */
  fetchPage(ctx: FetchContext, cursor: string | null): Promise<PageResult<TRaw>>;

  /**
   * Provider rows → normalized records.
   *
   * Receives every pass's rows keyed by pass name, so an adapter that needs to
   * join them (Azure merging amortized onto actual) can, without the runtime
   * knowing anything about the relationship.
   */
  mapRows(rowsByPass: Map<string, TRaw[]>, ctx: Omit<FetchContext, 'pass'>): NormalizedCostRecord[];
}

export interface AdapterRunResult {
  provider: CloudProvider;
  records: NormalizedCostRecord[];
  apiCalls: number;
  /** One per account or pass that failed. The run continues around them. */
  warnings: string[];
  /** Set when at least one account produced no data because of a failure. */
  partial: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * How long a run may spend waiting out throttling, in total.
 *
 * An attempt count alone is not enough, and getting this wrong is a mistake I
 * made in the first version of this file: six attempts sounds generous, but when
 * Azure asks for 20-25 seconds each time that is only ~100 seconds — *less*
 * patient than the 6-minute budget the hand-written Azure loop already had. The
 * adapter then failed where the code it replaced had succeeded.
 *
 * So the budget is wall-clock and differs by caller, because the callers differ:
 * a background ingestion has nothing better to do than wait, while an
 * interactive request must not hang for minutes.
 */
export const BUDGET_BACKGROUND_MS =
  Number(process.env.CLOUD_FETCH_BUDGET_BACKGROUND_MS) || 8 * 60_000;
export const BUDGET_INTERACTIVE_MS =
  Number(process.env.CLOUD_FETCH_BUDGET_INTERACTIVE_MS) || 60_000;

export interface RunOptions {
  /** Total wall-clock time the run may spend waiting on retries. */
  budgetMs?: number;
  /** Overrides the classifier's default attempt ceiling. */
  maxAttempts?: number;
}

/** Anything with a status/headers, so REST and SDK errors classify alike. */
function errorFacts(err: unknown): { message: string; name?: string; status?: number; headers?: Headers } {
  const e = err as any;
  return {
    message: e?.message ?? String(err),
    name: e?.name,
    status: e?.status ?? e?.$metadata?.httpStatusCode ?? e?.statusCode,
    headers: e?.headers instanceof Headers ? e.headers : undefined,
  };
}

/**
 * Thrown when a page fetch fails in a way worth surfacing with its
 * classification attached, so the caller can report *why* rather than just
 * that something went wrong.
 */
export class CloudFetchError extends Error {
  constructor(message: string, readonly classification: Classification) {
    super(message);
    this.name = 'CloudFetchError';
  }
}

/**
 * Fetches one page, with the provider's budget and the shared retry policy.
 *
 * Retry lives here rather than in each adapter so every provider gets identical
 * behaviour: throttling waits as long as the provider asked, transient errors
 * back off with jitter, and anything blocked or permanent fails immediately
 * instead of burning attempts on something that cannot improve.
 */
async function fetchPageWithRetry<TRaw>(
  adapter: CloudCostAdapter<TRaw>,
  ctx: FetchContext,
  cursor: string | null,
  limits: { maxAttempts: number; deadlineMs: number },
  countCall: () => void,
): Promise<PageResult<TRaw>> {
  let attempts = 0;
  let last: Classification | null = null;

  while (attempts < limits.maxAttempts) {
    attempts++;
    // Counted per ATTEMPT, not per success. Providers bill for requests that
    // fail — AWS Cost Explorer charges per request regardless of outcome — so
    // counting only successes told the operator ingestion was cheaper than it
    // was. A run that retried eight times and succeeded once reported "1".
    countCall();
    try {
      return await withBudget(adapter.provider, () => adapter.fetchPage(ctx, cursor));
    } catch (err) {
      const facts = errorFacts(err);
      const c = classifyFailure(facts);
      last = c;

      if (!shouldRetry(c, attempts, limits.maxAttempts)) {
        throw new CloudFetchError(
          `${adapter.provider} ${ctx.pass}: ${c.reason} (${facts.name ?? facts.status ?? 'error'})`,
          c,
        );
      }

      const wait = backoffMs(attempts, retryAfterFromHeaders(facts.headers));
      const remaining = limits.deadlineMs - Date.now();

      if (wait > remaining) {
        throw new CloudFetchError(
          `${adapter.provider} ${ctx.pass}: ${c.reason}, and the ${Math.round(wait / 1000)}s wait it ` +
          `needs exceeds the ${Math.round(Math.max(remaining, 0) / 1000)}s of budget left.`,
          c,
        );
      }

      console.log(
        `[Cloud/${adapter.provider}] ${c.kind} on ${ctx.pass} attempt ${attempts}/${limits.maxAttempts}: ` +
        `${c.reason}. Retrying in ${Math.round(wait / 1000)}s ` +
        `(${Math.round(remaining / 1000)}s budget left).`,
      );
      await sleep(wait);
    }
  }

  throw new CloudFetchError(
    `${adapter.provider} ${ctx.pass}: gave up after ${limits.maxAttempts} attempts — ${last?.reason ?? 'unknown'}`,
    last ?? { kind: 'unknown', reason: 'exhausted attempts', retryable: false },
  );
}

/** Paginates one pass to completion, or fails loudly rather than truncating. */
async function fetchPass<TRaw>(
  adapter: CloudCostAdapter<TRaw>,
  ctx: FetchContext,
  countCall: () => void,
  limits: { maxAttempts: number; deadlineMs: number },
): Promise<TRaw[]> {
  const rows: TRaw[] = [];
  let cursor: string | null = null;
  let pages = 0;

  do {
    // Annotated explicitly: `cursor` is assigned from `page`, so inference would
    // otherwise be circular.
    const page: PageResult<TRaw> = await fetchPageWithRetry(adapter, ctx, cursor, limits, countCall);
    pages++;
    rows.push(...page.rows);
    cursor = page.nextCursor ?? null;

    if (cursor && pages >= adapter.maxPages) {
      // Explicit failure, never a short answer. A truncated total presented as
      // complete is the Azure bug that hid 29% of a month's spend.
      throw new CloudFetchError(
        `${adapter.provider} ${ctx.pass}: more than ${adapter.maxPages} pages for ` +
        `${ctx.range.start}..${ctx.range.end}. Narrow the range; reporting a truncated ` +
        `total would understate the bill.`,
        { kind: 'permanent', reason: 'page limit exceeded', retryable: false },
      );
    }
  } while (cursor);

  if (pages > 1) {
    console.log(`[Cloud/${adapter.provider}] ${ctx.pass}: ${rows.length} rows across ${pages} pages.`);
  }
  return rows;
}

/**
 * Runs an adapter across every account for the calling tenant.
 *
 * One account failing never loses the others' data — it becomes a warning and
 * the run is marked partial, so a gap is visible rather than looking like zero
 * spend. Reporting $0 for a provider that simply could not be reached is the
 * failure mode this whole exercise exists to eliminate.
 */
export async function runAdapter<TRaw>(
  adapter: CloudCostAdapter<TRaw>,
  range: DateRange,
  options: RunOptions = {},
): Promise<AdapterRunResult> {
  // Background by default: the overwhelming majority of callers are the
  // ingestion scheduler, and defaulting to the tight interactive budget is how
  // a background job silently becomes less patient than the code it replaced.
  const limits = {
    maxAttempts: options.maxAttempts ?? MAX_ATTEMPTS,
    deadlineMs: Date.now() + (options.budgetMs ?? BUDGET_BACKGROUND_MS),
  };
  const records: NormalizedCostRecord[] = [];
  const warnings: string[] = [];
  let apiCalls = 0;
  let partial = false;

  const accounts = await adapter.listAccounts();

  for (const account of accounts) {
    const rowsByPass = new Map<string, TRaw[]>();
    let primaryFailed = false;

    // Sequential across passes. Concurrency here is what made Azure throttle
    // itself: two queries against one per-entity quota, each burning its own
    // retry budget racing the other.
    for (const [index, pass] of adapter.passes.entries()) {
      const ctx: FetchContext = { account, range, pass };
      try {
        rowsByPass.set(pass, await fetchPass(adapter, ctx, () => { apiCalls++; }, limits));
      } catch (err) {
        const message = (err as Error).message;
        warnings.push(`${adapter.provider} account "${account.accountName}": ${message}`);

        // The first pass is the one that carries billed cost. Losing a later
        // pass degrades detail (Azure's amortized figures); losing the first
        // means this account contributed nothing.
        if (index === 0) { primaryFailed = true; break; }
        rowsByPass.set(pass, []);
      }
    }

    if (primaryFailed) { partial = true; continue; }

    try {
      records.push(...adapter.mapRows(rowsByPass, { account, range }));
    } catch (err) {
      // A mapping bug must not be reported as a provider failure — the
      // distinction matters when deciding whether to retry or to fix code.
      partial = true;
      warnings.push(
        `${adapter.provider} account "${account.accountName}": could not map rows — ${(err as Error).message}`,
      );
    }
  }

  return { provider: adapter.provider, records, apiCalls, warnings, partial };
}
