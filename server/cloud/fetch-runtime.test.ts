/**
 * The runtime's job is to make every provider behave identically under failure.
 *
 * Each test below corresponds to a bug that actually shipped, on one provider
 * or another, because the behaviour lived in the connector instead of here.
 * A fake adapter stands in for a cloud, so the policy is tested rather than the
 * provider.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  runAdapter, CloudFetchError, BUDGET_BACKGROUND_MS, BUDGET_INTERACTIVE_MS,
  type CloudCostAdapter, type PageResult,
} from './fetch-runtime';
import { resetBudgets } from './rate-budget';
import { classifyFailure, backoffMs, retryAfterFromHeaders } from './failure';

interface Row { cost: number; day: string }

/** A configurable stand-in for a cloud provider. */
function fakeAdapter(opts: {
  pages?: Row[][];
  passes?: string[];
  maxPages?: number;
  failWith?: (call: number, pass: string) => unknown | null;
  accounts?: number;
}): CloudCostAdapter<Row> & { calls: number; callLog: string[] } {
  const pages = opts.pages ?? [[{ cost: 1, day: '2026-09-01' }]];
  const state = {
    calls: 0,
    callLog: [] as string[],
    provider: 'aws' as const,
    passes: (opts.passes ?? ['default']) as readonly string[],
    maxPages: opts.maxPages ?? 50,

    async listAccounts() {
      return Array.from({ length: opts.accounts ?? 1 }, (_, i) => ({
        id: i + 1,
        accountId: `1111111111${i}1`,
        accountName: `acct-${i + 1}`,
        credentials: {},
        authType: 'access_keys',
      }));
    },

    async fetchPage(ctx: any, cursor: string | null): Promise<PageResult<Row>> {
      state.calls++;
      state.callLog.push(`${ctx.pass}:${cursor ?? 'first'}`);

      const boom = opts.failWith?.(state.calls, ctx.pass);
      if (boom) throw boom;

      const index = cursor ? Number(cursor) : 0;
      return {
        rows: pages[index] ?? [],
        nextCursor: index + 1 < pages.length ? String(index + 1) : null,
      };
    },

    mapRows(rowsByPass: Map<string, Row[]>, ctx: any) {
      const all = [...rowsByPass.values()].flat();
      return all.map((r) => ({
        provider: 'aws' as const,
        subAccountId: ctx.account.accountId,
        chargePeriodStart: r.day,
        chargePeriodEnd: r.day,
        serviceName: 'Test',
        billedCost: r.cost,
      }));
    },
  };
  return state as never;
}

beforeEach(() => {
  resetBudgets();
  vi.restoreAllMocks();
});

describe('pagination — the Azure bug that hid 29% of a month', () => {
  it('follows the cursor to the end', async () => {
    const adapter = fakeAdapter({
      pages: [
        [{ cost: 10, day: '2026-09-01' }],
        [{ cost: 20, day: '2026-09-02' }],
        [{ cost: 30, day: '2026-09-03' }],
      ],
    });

    const result = await runAdapter(adapter, { start: '2026-09-01', end: '2026-09-03' });

    // All three pages, not just the first. Reading one page is exactly what lost
    // $4,842 of Azure spend.
    expect(result.records).toHaveLength(3);
    expect(result.records.reduce((s, r) => s + r.billedCost, 0)).toBe(60);
    expect(result.apiCalls).toBe(3);
  });

  it('FAILS rather than truncating when the page cap is hit', async () => {
    // A short total presented as complete is worse than an error, because
    // nobody investigates a plausible number.
    const adapter = fakeAdapter({
      pages: [[{ cost: 1, day: 'd' }], [{ cost: 1, day: 'd' }], [{ cost: 1, day: 'd' }]],
      maxPages: 2,
    });

    const result = await runAdapter(adapter, { start: 'a', end: 'b' });

    expect(result.partial).toBe(true);
    expect(result.records).toHaveLength(0);
    expect(result.warnings[0]).toMatch(/more than 2 pages/);
  });
});

describe('retry policy', () => {
  it('retries a throttling error and then succeeds', async () => {
    const adapter = fakeAdapter({
      failWith: (call) => (call === 1 ? Object.assign(new Error('429 Too many requests'), { status: 429 }) : null),
    });

    const result = await runAdapter(adapter, { start: 'a', end: 'b' });

    expect(result.records).toHaveLength(1);
    expect(adapter.calls).toBe(2);
  }, 30_000);

  it('retries a transient network error', async () => {
    const adapter = fakeAdapter({
      failWith: (call) => (call === 1 ? Object.assign(new Error('read ECONNRESET'), { name: 'Error' }) : null),
    });

    const result = await runAdapter(adapter, { start: 'a', end: 'b' });
    expect(result.records).toHaveLength(1);
  }, 30_000);

  it('does NOT retry an expired credential', async () => {
    // Blocked, not transient. Retrying an expired secret six times just delays a
    // clear message — the Azure AADSTS7000215 case.
    const adapter = fakeAdapter({
      failWith: () => Object.assign(new Error('AADSTS7000215: Invalid client secret provided'), { status: 401 }),
    });

    const result = await runAdapter(adapter, { start: 'a', end: 'b' });

    expect(adapter.calls).toBe(1);
    expect(result.warnings[0]).toMatch(/credential.*rejected|expired/i);
  });

  it('does NOT retry a malformed query', async () => {
    const adapter = fakeAdapter({
      failWith: () => Object.assign(new Error('ValidationException: bad granularity'), { status: 400 }),
    });

    const result = await runAdapter(adapter, { start: 'a', end: 'b' });
    expect(adapter.calls).toBe(1);
  });
});

describe('time budget — the regression I introduced', () => {
  it('defaults to the BACKGROUND budget, not the interactive one', async () => {
    // The mistake worth pinning: six attempts sounds generous, but at Azure's
    // 20-25s Retry-After that is ~100s — LESS patient than the 6-minute budget
    // the hand-written Azure loop already had. The adapter then failed where the
    // code it replaced succeeded.
    expect(BUDGET_BACKGROUND_MS).toBeGreaterThanOrEqual(6 * 60_000);
    expect(BUDGET_INTERACTIVE_MS).toBeLessThan(BUDGET_BACKGROUND_MS);
  });

  it('stops when the next wait would exceed the remaining budget', async () => {
    const adapter = fakeAdapter({
      failWith: () => Object.assign(new Error('429 Too many requests'), { status: 429 }),
    });

    // A budget too small for even one backoff: it must refuse rather than
    // sleeping past its own deadline.
    const result = await runAdapter(adapter, { start: 'a', end: 'b' }, { budgetMs: 1 });

    expect(adapter.calls).toBe(1);
    expect(result.warnings[0]).toMatch(/exceeds the .* of budget left/);
  });

  it('an explicit maxAttempts caps retries', async () => {
    const adapter = fakeAdapter({
      failWith: () => Object.assign(new Error('429'), { status: 429 }),
    });

    await runAdapter(adapter, { start: 'a', end: 'b' }, { maxAttempts: 2, budgetMs: 60_000 });
    expect(adapter.calls).toBe(2);
  }, 30_000);
});

describe('API call accounting', () => {
  it('counts every ATTEMPT, including ones that failed', async () => {
    // Providers bill for failed requests too. Counting only successes reported
    // "1 api call" for a run that actually made nine, which understates the
    // cost of ingestion in ingestion_runs.api_calls.
    const adapter = fakeAdapter({
      failWith: (call) => (call <= 2 ? Object.assign(new Error('429'), { status: 429 }) : null),
    });

    const result = await runAdapter(adapter, { start: 'a', end: 'b' }, { budgetMs: 60_000 });

    expect(adapter.calls).toBe(3);        // 2 failures + 1 success
    expect(result.apiCalls).toBe(3);      // and all three are reported
  }, 30_000);
});

describe('multi-pass — the Azure self-throttling bug', () => {
  it('runs passes sequentially, not concurrently', async () => {
    const adapter = fakeAdapter({ passes: ['ActualCost', 'AmortizedCost'] });

    await runAdapter(adapter, { start: 'a', end: 'b' });

    // Order proves sequencing. Promise.all here doubled the instantaneous rate
    // against a per-entity quota and reliably 429'd.
    expect(adapter.callLog).toEqual(['ActualCost:first', 'AmortizedCost:first']);
  });

  it('keeps the primary pass when a later pass fails', async () => {
    const adapter = fakeAdapter({
      passes: ['ActualCost', 'AmortizedCost'],
      failWith: (_c, pass) =>
        pass === 'AmortizedCost' ? Object.assign(new Error('400 unsupported'), { status: 400 }) : null,
    });

    const result = await runAdapter(adapter, { start: 'a', end: 'b' });

    // Amortized is a detail enhancement; losing it must not lose billed cost.
    expect(result.records).toHaveLength(1);
    expect(result.warnings.some((w) => /AmortizedCost/.test(w))).toBe(true);
  });

  it('drops the account when the PRIMARY pass fails', async () => {
    const adapter = fakeAdapter({
      passes: ['ActualCost', 'AmortizedCost'],
      failWith: (_c, pass) =>
        pass === 'ActualCost' ? Object.assign(new Error('401 invalid_client'), { status: 401 }) : null,
    });

    const result = await runAdapter(adapter, { start: 'a', end: 'b' });

    expect(result.records).toHaveLength(0);
    expect(result.partial).toBe(true);
    // And it does not go on to waste quota on the second pass.
    expect(adapter.callLog).toEqual(['ActualCost:first']);
  });
});

describe('partial failure across accounts', () => {
  it('one bad account does not lose the others', async () => {
    let seen = 0;
    const adapter = fakeAdapter({
      accounts: 3,
      failWith: () => {
        seen++;
        // Fail only the second account's single call.
        return seen === 2 ? Object.assign(new Error('403 Forbidden'), { status: 403 }) : null;
      },
    });

    const result = await runAdapter(adapter, { start: 'a', end: 'b' });

    // Two of three accounts still contributed. Reporting zero for all three
    // because one lacked a permission is the shape of every "data not coming"
    // report in this project's history.
    expect(result.records).toHaveLength(2);
    expect(result.partial).toBe(true);
    expect(result.warnings).toHaveLength(1);
  });
});

describe('failure classification', () => {
  it('reads throttling before quota exhaustion', () => {
    // RequestLimitExceeded contains "LimitExceeded". Classified as a quota, a
    // throttle would stop ingestion instead of waiting two seconds.
    expect(classifyFailure({ message: 'RequestLimitExceeded' }).kind).toBe('throttled');
    expect(classifyFailure({ message: 'quota exceeded for this project' }).kind).toBe('blocked');
  });

  it('recognises each provider\'s dialect for the same condition', () => {
    const expired = [
      'AADSTS7000215: Invalid client secret provided',   // Azure
      'ExpiredToken: The security token has expired',    // AWS
      'invalid_grant: Invalid JWT Signature',            // GCP
    ];
    for (const m of expired) {
      expect(classifyFailure({ message: m }).kind, m).toBe('blocked');
    }
  });

  it('never retries something it does not recognise', () => {
    const c = classifyFailure({ message: 'something entirely novel happened' });
    expect(c.kind).toBe('unknown');
    expect(c.retryable).toBe(false);
  });
});

describe('backoff', () => {
  it('honours an explicit Retry-After over its own schedule', () => {
    // The Azure failure: it asked for 52s, our schedule said 30s, and giving up
    // on its answer discarded the only certainty available.
    expect(backoffMs(1, 52_000)).toBe(52_000);
  });

  it('caps a pathological Retry-After', () => {
    expect(backoffMs(1, 999_000)).toBe(120_000);
  });

  it('applies jitter so concurrent consumers do not retry in lockstep', () => {
    const waits = new Set(Array.from({ length: 30 }, () => backoffMs(2)));
    expect(waits.size).toBeGreaterThan(1);
  });

  it('reads Azure\'s non-standard retry headers', () => {
    const h = new Headers({ 'x-ms-ratelimit-microsoft.costmanagement-entity-retry-after': '37' });
    expect(retryAfterFromHeaders(h)).toBe(37_000);
  });

  it('ignores an HTTP-date Retry-After rather than misparsing it', () => {
    const h = new Headers({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' });
    expect(retryAfterFromHeaders(h)).toBeNull();
  });
});
