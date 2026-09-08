/**
 * Azure Cost Management adapter.
 *
 * Compare with the connector this replaces: that file carried its own
 * pagination loop, its own throttle-retry with a hand-tuned budget, its own
 * error strings, and a `Promise.all` that made it throttle itself. All of that
 * now lives in the runtime, identically for every provider.
 *
 * What is left here is only what is genuinely Azure-specific:
 *
 *   - two passes, because amortization is selected by the query `type` and
 *     cannot be obtained in one call
 *   - `nextLink` as the pagination cursor
 *   - `timePeriod.to` is INCLUSIVE, unlike AWS and GCP
 *   - rows are addressed by column NAME, because column order varies by scope
 */
import type { CloudCostAdapter, FetchContext, PageResult, AdapterAccount } from '../fetch-runtime';
import type { NormalizedCostRecord } from '../../ingestion/types';
import { getAccessToken } from '../../azure-client';
import { getActiveCloudAccounts } from '../../cloud-config-manager';
import { categorizeService } from '../../ingestion/service-category';

const API_VERSION = '2023-03-01';

export interface AzureRow {
  cost: number;
  date: string;
  subscriptionName: string;
  resourceGroup: string;
  serviceName: string;
  currency: string;
}

/** Azure returns usage dates as the number 20260601. */
function parseAzureDate(value: unknown): string | null {
  const s = String(value ?? '');
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
}

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Column order varies by scope, so rows are read by name, never by index. */
function readRows(payload: any): AzureRow[] {
  const columns: Array<{ name: string }> = payload?.properties?.columns ?? [];
  const rows: any[][] = payload?.properties?.rows ?? [];
  const idx = (name: string) => columns.findIndex((c) => c.name?.toLowerCase() === name.toLowerCase());

  const iCost = idx('PreTaxCost') !== -1 ? idx('PreTaxCost') : idx('Cost');
  const iDate = idx('UsageDate');
  const iSub = idx('SubscriptionName');
  const iRg = idx('ResourceGroup');
  const iSvc = idx('ServiceName');
  const iCur = idx('Currency');

  const out: AzureRow[] = [];
  for (const row of rows) {
    const date = parseAzureDate(iDate !== -1 ? row[iDate] : null);
    if (!date) continue;
    out.push({
      cost: Number(iCost !== -1 ? row[iCost] : 0) || 0,
      date,
      subscriptionName: String(iSub !== -1 ? row[iSub] ?? '' : ''),
      resourceGroup: String(iRg !== -1 ? row[iRg] ?? '' : ''),
      serviceName: String(iSvc !== -1 ? row[iSvc] ?? 'Unknown' : 'Unknown'),
      currency: String(iCur !== -1 ? row[iCur] ?? 'USD' : 'USD'),
    });
  }
  return out;
}

const keyOf = (r: AzureRow) =>
  [r.date, r.subscriptionName, r.resourceGroup, r.serviceName].join('|');

function scopeUrl(account: AdapterAccount): string {
  const c = account.credentials ?? {};
  const billingAccountId = c.billingAccountId;
  const subscriptionId = c.subscriptionId || account.accountId;

  // Billing-account scope avoids requiring Cost Management Reader on every
  // subscription, so prefer it when configured.
  return billingAccountId
    ? `https://management.azure.com/providers/Microsoft.Billing/billingAccounts/${billingAccountId}/providers/Microsoft.CostManagement/query?api-version=${API_VERSION}`
    : `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.CostManagement/query?api-version=${API_VERSION}`;
}

/** An HTTP failure the runtime's classifier can read, headers included. */
class AzureHttpError extends Error {
  constructor(readonly status: number, body: string, readonly headers: Headers) {
    super(`Azure Cost Management returned ${status}: ${body.slice(0, 200)}`);
    this.name = 'AzureHttpError';
  }
}

export const azureCostAdapter: CloudCostAdapter<AzureRow> = {
  provider: 'azure',

  // ActualCost first: it carries billed cost. If it fails the account has
  // contributed nothing, and the runtime skips the second pass rather than
  // spending more of a quota that is evidently exhausted.
  passes: ['ActualCost', 'AmortizedCost'],

  // 5000 rows per page; a three-week window on a real account produced 7252.
  maxPages: 50,

  async listAccounts() {
    const accounts = await getActiveCloudAccounts('azure');
    return accounts
      .filter((a) => a.credentials?.subscriptionId || a.credentials?.billingAccountId || a.accountId)
      .map((a) => ({
        id: a.id,
        accountId: a.accountId,
        accountName: a.accountName,
        credentials: a.credentials ?? {},
        authType: a.authType,
      }));
  },

  async fetchPage(ctx: FetchContext, cursor: string | null): Promise<PageResult<AzureRow>> {
    const token = await getAccessToken();

    const body = {
      type: ctx.pass,
      timeframe: 'Custom',
      // INCLUSIVE, unlike AWS and GCP. The runtime passes the range through
      // unchanged; each adapter is responsible for its own provider's semantics,
      // which is what stops a cross-cloud total mixing 22 days with 21.
      timePeriod: { from: ctx.range.start, to: ctx.range.end },
      dataset: {
        granularity: 'Daily',
        aggregation: { totalCost: { name: 'PreTaxCost', function: 'Sum' } },
        grouping: [
          { type: 'Dimension', name: 'SubscriptionName' },
          { type: 'Dimension', name: 'ResourceGroup' },
          { type: 'Dimension', name: 'ServiceName' },
        ],
      },
    };

    // A cursor here is a full nextLink URL, not a token.
    const url = cursor ?? scopeUrl(ctx.account);

    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      // Thrown with status and headers attached so the runtime can classify it
      // and read Azure's Retry-After. No retry logic here.
      throw new AzureHttpError(res.status, await res.text().catch(() => ''), res.headers);
    }

    const payload = await res.json();
    return {
      rows: readRows(payload),
      nextCursor: payload?.properties?.nextLink ?? null,
      headers: res.headers,
    };
  },

  mapRows(rowsByPass, ctx): NormalizedCostRecord[] {
    const actual = rowsByPass.get('ActualCost') ?? [];
    const amortized = rowsByPass.get('AmortizedCost') ?? [];
    const amortizedByKey = new Map(amortized.map((r) => [keyOf(r), r.cost]));

    const credentials = ctx.account.credentials ?? {};
    const billingAccountId = credentials.billingAccountId ?? null;
    const subscriptionId = credentials.subscriptionId || ctx.account.accountId;

    const out: NormalizedCostRecord[] = [];
    for (const row of actual) {
      // Non-zero, not positive: a negative PreTaxCost is a credit or refund and
      // dropping it overstates the bill.
      if (row.cost === 0) continue;

      out.push({
        provider: 'azure',
        billingAccountId,
        billingAccountName: ctx.account.accountName,
        subAccountId: row.subscriptionName || subscriptionId,
        subAccountName: row.subscriptionName || null,
        chargePeriodStart: row.date,
        chargePeriodEnd: nextDay(row.date),
        billingPeriodStart: `${row.date.slice(0, 7)}-01`,
        serviceName: row.serviceName,
        serviceCategory: categorizeService(row.serviceName),
        chargeCategory: row.cost < 0 ? 'Credit' : 'Usage',
        // Azure exposes no region in this grouping; resource group is the
        // closest allocation dimension and belongs in tags, not regionId.
        regionId: null,
        billedCost: row.cost,
        effectiveCost: amortizedByKey.get(keyOf(row)) ?? null,
        billingCurrency: row.currency,
        tags: row.resourceGroup ? { resourceGroup: row.resourceGroup } : null,
      });
    }
    return out;
  },
};
