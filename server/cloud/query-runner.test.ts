/**
 * The shared retry/budget wrapper for non-cost provider calls.
 *
 * These paths — usage-type drill-downs, meter-category drill-downs, resource
 * inventory — had NO retry and NO pagination before this existed. Cost
 * Management throttling therefore reached the analysis engine as an empty array,
 * which reads as "this service has no meter categories" rather than "the call
 * failed". Each test below pins one of those behaviours.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { runProviderQuery, runPaginatedQuery, ProviderQueryError } from './query-runner';
import { resetBudgets } from './rate-budget';

beforeEach(() => resetBudgets());

describe('runProviderQuery', () => {
  it('returns the value when the call succeeds', async () => {
    expect(await runProviderQuery('aws', 'probe', async () => 'ok')).toBe('ok');
  });

  it('retries throttling and then succeeds', async () => {
    let calls = 0;
    const value = await runProviderQuery('aws', 'probe', async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('429 Too many requests'), { status: 429 });
      return 'recovered';
    }, { budgetMs: 30_000 });

    expect(value).toBe('recovered');
    expect(calls).toBe(2);
  }, 30_000);

  it('does NOT retry an expired credential', async () => {
    let calls = 0;
    await expect(
      runProviderQuery('azure', 'probe', async () => {
        calls++;
        throw Object.assign(new Error('AADSTS7000215: Invalid client secret provided'), { status: 401 });
      }),
    ).rejects.toThrow(ProviderQueryError);

    // One attempt. Six retries on an expired secret only delays a clear message.
    expect(calls).toBe(1);
  });

  it('THROWS rather than returning a silent empty result', async () => {
    // The whole point. A caller may choose to swallow it, but the runner must
    // not decide that "unreachable" means "no data".
    await expect(
      runProviderQuery('aws', 'probe', async () => {
        throw Object.assign(new Error('403 Forbidden'), { status: 403 });
      }),
    ).rejects.toThrow(/permission/i);
  });

  it('attaches the classification so callers can distinguish causes', async () => {
    try {
      await runProviderQuery('gcp', 'probe', async () => {
        throw Object.assign(new Error('ValidationException: bad query'), { status: 400 });
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderQueryError);
      expect((err as ProviderQueryError).classification.kind).toBe('permanent');
    }
  });

  it('stops when the next wait exceeds the remaining budget', async () => {
    let calls = 0;
    await expect(
      runProviderQuery('azure', 'probe', async () => {
        calls++;
        throw Object.assign(new Error('429'), { status: 429 });
      }, { budgetMs: 1 }),
    ).rejects.toThrow(/exceeds the .* of budget left/);

    expect(calls).toBe(1);
  });
});

describe('runPaginatedQuery', () => {
  it('follows the cursor to the end', async () => {
    const pages = [['a', 'b'], ['c'], ['d', 'e']];
    const items = await runPaginatedQuery<string>('aws', 'probe', async (cursor) => {
      const i = cursor ? Number(cursor) : 0;
      return { items: pages[i], nextCursor: i + 1 < pages.length ? String(i + 1) : undefined };
    });

    // All three pages. Reading only the first is the bug that hid 29% of a
    // month's Azure spend, and the same omission was present in both analysis
    // drill-downs.
    expect(items).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('REFUSES to return a truncated result at the page cap', async () => {
    await expect(
      runPaginatedQuery<string>('aws', 'probe', async (cursor) => {
        const i = cursor ? Number(cursor) : 0;
        return { items: [`item${i}`], nextCursor: String(i + 1) };   // never ends
      }, { maxPages: 3 }),
    ).rejects.toThrow(/more than 3 pages/);
  });

  it('retries an individual page without restarting the whole sweep', async () => {
    let attempts = 0;
    const items = await runPaginatedQuery<string>('aws', 'probe', async (cursor) => {
      const i = cursor ? Number(cursor) : 0;
      if (i === 1) {
        attempts++;
        if (attempts === 1) throw Object.assign(new Error('429'), { status: 429 });
      }
      return { items: [`p${i}`], nextCursor: i < 2 ? String(i + 1) : undefined };
    }, { budgetMs: 30_000 });

    // Page 0 is not re-fetched when page 1 throttles.
    expect(items).toEqual(['p0', 'p1', 'p2']);
  }, 30_000);

  it('passes the cursor captured for that page, not a mutated one', async () => {
    // Guards a closure bug: capturing the loop variable by reference would send
    // the wrong cursor on a retry and silently skip or repeat a page.
    const seen: (string | undefined)[] = [];
    await runPaginatedQuery<string>('aws', 'probe', async (cursor) => {
      seen.push(cursor);
      const i = cursor ? Number(cursor) : 0;
      return { items: [], nextCursor: i < 2 ? String(i + 1) : undefined };
    });

    expect(seen).toEqual([undefined, '1', '2']);
  });
});
