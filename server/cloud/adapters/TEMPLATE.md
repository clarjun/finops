# Adding a cloud provider

Write one adapter. You implement **two methods** and declare **three facts**.
You do not write a pagination loop, retry logic, throttle handling, or error
classification — the runtime owns those, identically for every provider.

## The whole contract

```ts
export interface CloudCostAdapter<TRaw> {
  readonly provider: CloudProvider;
  readonly passes: readonly string[];   // usually ['default']
  readonly maxPages: number;            // hard cap; exceeding it FAILS, never truncates

  listAccounts(): Promise<AdapterAccount[]>;
  fetchPage(ctx: FetchContext, cursor: string | null): Promise<PageResult<TRaw>>;
  mapRows(rowsByPass: Map<string, TRaw[]>, ctx): NormalizedCostRecord[];
}
```

## Skeleton

```ts
import type { CloudCostAdapter, FetchContext, PageResult } from '../fetch-runtime';
import type { NormalizedCostRecord } from '../../ingestion/types';
import { getActiveCloudAccounts } from '../../cloud-config-manager';
import { categorizeService } from '../../ingestion/service-category';

interface AcmeRow { /* whatever the provider returns */ }

export const acmeCostAdapter: CloudCostAdapter<AcmeRow> = {
  provider: 'acme',
  passes: ['default'],
  maxPages: 50,

  async listAccounts() {
    const accounts = await getActiveCloudAccounts('acme');
    return accounts.map((a) => ({
      id: a.id,
      accountId: a.accountId,
      accountName: a.accountName,
      credentials: a.credentials ?? {},
      authType: a.authType,
    }));
  },

  async fetchPage(ctx: FetchContext, cursor: string | null): Promise<PageResult<AcmeRow>> {
    // Throw on failure — do NOT catch, retry, or sleep. Attach `status` and
    // `headers` where you have them so the runtime can classify the error and
    // read the provider's Retry-After.
    const res = await fetch(url, { /* ... */ });
    if (!res.ok) {
      throw Object.assign(new Error(await res.text()), {
        status: res.status,
        headers: res.headers,
      });
    }

    const payload = await res.json();
    return {
      rows: payload.items,
      nextCursor: payload.nextToken ?? null,   // null = last page
      headers: res.headers,
    };
  },

  mapRows(rowsByPass, ctx): NormalizedCostRecord[] {
    const rows = rowsByPass.get('default') ?? [];
    return rows
      // Keep negatives — they are credits and refunds. Dropping them
      // overstates the bill, a mistake made on all three existing providers.
      .filter((r) => r.cost !== 0)
      .map((r) => ({
        provider: 'acme',
        subAccountId: r.accountId ?? ctx.account.accountId,
        chargePeriodStart: r.date,          // YYYY-MM-DD
        chargePeriodEnd: nextDay(r.date),   // exclusive
        serviceName: r.service,
        serviceCategory: categorizeService(r.service),
        chargeCategory: r.cost < 0 ? 'Credit' : 'Usage',
        billedCost: r.cost,                 // what the invoice says
        effectiveCost: r.netCost ?? null,   // after credits; null if unknown
        billingCurrency: r.currency ?? 'USD',
      }));
  },
};
```

Then a three-line connector, and register it:

```ts
export class AcmeCostConnector implements CostConnector {
  readonly provider = 'acme' as const;
  async isConfigured() { return (await getActiveCloudAccounts('acme')).length > 0; }
  async fetchCosts(range: DateRange) {
    const r = await runAdapter(acmeCostAdapter, range);
    return { records: r.records, apiCalls: r.apiCalls, warnings: r.warnings };
  }
}
```

## Rules that matter

**Declare your date semantics, don't assume.** `DateRange.end` is **inclusive**.
If the provider's end bound is exclusive, convert it in `fetchPage`. AWS does
(`exclusiveEnd()`); Azure passes it through; GCP uses `<=`. Getting this wrong
produced a cross-cloud total that combined 22 Azure days with 21 AWS days.

**Never catch and retry.** Throw. The runtime classifies (`throttled` /
`transient` / `blocked` / `permanent`), honours `Retry-After`, backs off with
jitter, and enforces the per-provider budget. A private retry loop reintroduces
the divergence this design removes.

**Attach `status` and `headers` to thrown errors.** That's how the classifier
distinguishes an expired credential (don't retry) from throttling (do), and how
it reads the provider's own backoff timing.

**Return `nextCursor: null` explicitly** when there are no more pages. Saying so
is clearer than omitting it, and a cursor that never clears hits `maxPages` and
**fails loudly** rather than silently returning a short total.

**Keep negative amounts.** They're credits, refunds and adjustments. A
`cost > 0` filter was copy-pasted into all three original connectors and
overstated every bill.

**Use `passes` only when the provider genuinely needs more than one query.**
Azure does, because amortization is selected by query `type`. The runtime runs
them **sequentially** — the first pass carries billed cost, so if it fails the
account is skipped rather than spending more quota; a later pass failing only
degrades detail.

## What you get for free

pagination · retry · `Retry-After` · jitter · per-provider concurrency and
spacing budget · error classification · per-attempt API accounting ·
partial-failure isolation (one bad account never loses the others) · consistent
warnings

## Testing

`server/cloud/fetch-runtime.test.ts` tests the runtime with a fake adapter — 22
tests, each pinned to a bug that actually shipped. Your adapter needs tests only
for its **own** mapping: date parsing, currency, credit handling, and the
provider's row shape.
