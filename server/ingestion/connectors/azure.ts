/**
 * Azure Cost Management connector.
 *
 * Issues the Cost Management query directly rather than reusing
 * fetchAzureCostData, because that helper is wired for the dashboard: it caches
 * responses for two minutes and returns only PreTaxCost at ActualCost.
 *
 * This connector runs the query twice — once as ActualCost, once as
 * AmortizedCost — and merges them. Azure exposes amortization only through the
 * query `type`, so there is no way to obtain both from a single call. Two calls
 * is the price of being able to say what a reservation actually costs per day
 * instead of showing the whole upfront payment on the day it was charged.
 */
import { getAccessToken } from "../../azure-client";
import { getActiveCloudAccounts } from "../../cloud-config-manager";
import { categorizeService } from "../service-category";
import type { CostConnector, ConnectorResult, DateRange, NormalizedCostRecord } from "../types";

const API_VERSION = '2023-03-01';

/** Azure returns usage dates as the number 20260601. */
function parseAzureDate(value: unknown): string | null {
  const s = String(value ?? '');
  if (!/^\d{8}$/.test(s)) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

interface AzureRow {
  cost: number;
  date: string;
  subscriptionName: string;
  resourceGroup: string;
  serviceName: string;
  currency: string;
}

/** Column order varies by scope, so rows are read by column name, not index. */
function readRows(payload: any): AzureRow[] {
  const columns: Array<{ name: string }> = payload?.properties?.columns ?? [];
  const rows: any[][] = payload?.properties?.rows ?? [];
  const idx = (name: string) => columns.findIndex(c => c.name?.toLowerCase() === name.toLowerCase());

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

function keyOf(r: AzureRow): string {
  return [r.date, r.subscriptionName, r.resourceGroup, r.serviceName].join('|');
}

export class AzureCostConnector implements CostConnector {
  readonly provider = 'azure' as const;

  async isConfigured(): Promise<boolean> {
    const accounts = await getActiveCloudAccounts('azure');
    return accounts.some(a => a.credentials?.subscriptionId || a.credentials?.billingAccountId);
  }

  async fetchCosts(range: DateRange): Promise<ConnectorResult> {
    const accounts = await getActiveCloudAccounts('azure');
    const records: NormalizedCostRecord[] = [];
    const warnings: string[] = [];
    let apiCalls = 0;

    for (const account of accounts) {
      const credentials = account.credentials ?? {};
      const subscriptionId = credentials.subscriptionId || account.accountId;
      const billingAccountId = credentials.billingAccountId;

      if (!subscriptionId && !billingAccountId) {
        warnings.push(`Azure account "${account.accountName}" has no subscription or billing account id`);
        continue;
      }

      // Billing-account scope avoids requiring Cost Management Reader on each
      // subscription, so prefer it when configured.
      const url = billingAccountId
        ? `https://management.azure.com/providers/Microsoft.Billing/billingAccounts/${billingAccountId}/providers/Microsoft.CostManagement/query?api-version=${API_VERSION}`
        : `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.CostManagement/query?api-version=${API_VERSION}`;

      try {
        const token = await getAccessToken();

        const [actual, amortized] = await Promise.all([
          this.query(url, token, range, 'ActualCost').then(r => { apiCalls++; return r; }),
          this.query(url, token, range, 'AmortizedCost')
            .then(r => { apiCalls++; return r; })
            // Amortized is a nice-to-have: some scopes and agreement types do not
            // support it. Losing it must not lose the actual-cost data.
            .catch(err => {
              warnings.push(`Azure account "${account.accountName}": amortized cost unavailable (${err?.message ?? err})`);
              return [] as AzureRow[];
            }),
        ]);

        const amortizedByKey = new Map(amortized.map(r => [keyOf(r), r.cost]));

        for (const row of actual) {
          if (row.cost === 0) continue;

          const effective = amortizedByKey.get(keyOf(row));

          records.push({
            provider: 'azure',
            billingAccountId: billingAccountId ?? null,
            billingAccountName: account.accountName,
            subAccountId: row.subscriptionName || subscriptionId || account.accountId,
            subAccountName: row.subscriptionName || null,
            chargePeriodStart: row.date,
            chargePeriodEnd: nextDay(row.date),
            billingPeriodStart: `${row.date.slice(0, 7)}-01`,
            serviceName: row.serviceName,
            serviceCategory: categorizeService(row.serviceName),
            chargeCategory: row.cost < 0 ? 'Credit' : 'Usage',
            // Azure has no region in this grouping; resource group is the closest
            // allocation dimension and belongs in tags, not regionId.
            regionId: null,
            billedCost: row.cost,
            effectiveCost: effective ?? null,
            billingCurrency: row.currency,
            tags: row.resourceGroup ? { resourceGroup: row.resourceGroup } : null,
          });
        }
      } catch (err: any) {
        warnings.push(`Azure account "${account.accountName}": ${err?.message ?? err}`);
      }
    }

    return { records, apiCalls, warnings };
  }

  private async query(url: string, token: string, range: DateRange, type: 'ActualCost' | 'AmortizedCost'): Promise<AzureRow[]> {
    const body = {
      type,
      timeframe: 'Custom',
      timePeriod: { from: range.start, to: range.end },
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

    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Azure Cost Management ${type} query failed (${res.status}): ${text.slice(0, 300)}`);
    }

    return readRows(await res.json());
  }
}
