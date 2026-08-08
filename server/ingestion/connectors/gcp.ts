/**
 * GCP BigQuery billing-export connector.
 *
 * Runs its own query rather than reusing fetchGCPCostData, because that query
 * has two defects that make it unusable as a source of record:
 *
 *   1. `WHERE cost > 0` discards every credit, refund and adjustment row.
 *      Sustained-use discounts and committed-use discounts arrive in GCP billing
 *      export as negative rows, so filtering them out overstates spend — often
 *      by 20-30% for a committed-use customer.
 *
 *   2. It ignores the `credits` repeated field entirely, so there is no way to
 *      compute effective cost. GCP puts discounts there, not in `cost`.
 *
 * Effective cost here is cost + SUM(credits.amount). Credit amounts are negative
 * in the export, so that addition is a subtraction.
 */
import { BigQuery } from "@google-cloud/bigquery";
import { getActiveCloudAccounts } from "../../cloud-config-manager";
import { categorizeService } from "../service-category";
import type { CostConnector, ConnectorResult, DateRange, NormalizedCostRecord } from "../types";

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function parseServiceAccountKey(credentials: any): any | null {
  const raw = credentials?.serviceAccountKey ?? credentials;
  if (!raw) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw;
}

function labelsToTags(json: string | null | undefined): Record<string, string> | null {
  if (!json) return null;
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const tags: Record<string, string> = {};
    for (const l of arr) {
      if (l?.key) tags[l.key] = l.value ?? '';
    }
    return Object.keys(tags).length > 0 ? tags : null;
  } catch {
    return null;
  }
}

export class GcpCostConnector implements CostConnector {
  readonly provider = 'gcp' as const;

  async isConfigured(): Promise<boolean> {
    const accounts = await getActiveCloudAccounts('gcp');
    return accounts.some(a => a.credentials?.billingTable);
  }

  async fetchCosts(range: DateRange): Promise<ConnectorResult> {
    const accounts = await getActiveCloudAccounts('gcp');
    const records: NormalizedCostRecord[] = [];
    const warnings: string[] = [];
    let apiCalls = 0;

    for (const account of accounts) {
      const credentials = account.credentials ?? {};
      const key = parseServiceAccountKey(credentials);
      const projectId = credentials.projectId || key?.project_id;
      const dataset = credentials.billingDataset || 'cloud_billing_data';
      const table = credentials.billingTable;

      if (!key || !projectId) {
        warnings.push(`GCP account "${account.accountName}" has no usable service-account key`);
        continue;
      }
      if (!table) {
        warnings.push(`GCP account "${account.accountName}" has no billingTable configured`);
        continue;
      }

      const bq = new BigQuery({ projectId, credentials: key });

      // usage_start_time is a timestamp; the export is partitioned on
      // _PARTITIONTIME / export_time. Filtering on DATE(usage_start_time) alone
      // scans the whole table, so the range is also applied to the partition
      // column with a margin for late-arriving rows.
      const query = `
        SELECT
          DATE(usage_start_time)                       AS usage_date,
          billing_account_id                           AS billing_account_id,
          project.id                                   AS project_id,
          project.name                                 AS project_name,
          service.description                          AS service_name,
          sku.description                              AS sku_description,
          location.region                              AS region,
          currency                                     AS currency,
          SUM(cost)                                    AS billed_cost,
          SUM(cost + IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)) AS effective_cost,
          SUM(usage.amount)                            AS usage_amount,
          ANY_VALUE(usage.unit)                        AS usage_unit,
          TO_JSON_STRING(labels)                       AS labels_json
        FROM \`${projectId}.${dataset}.${table}\`
        WHERE DATE(usage_start_time) >= @startDate
          AND DATE(usage_start_time) <= @endDate
          AND DATE(_PARTITIONTIME) >= DATE_SUB(@startDate, INTERVAL 3 DAY)
        GROUP BY
          usage_date, billing_account_id, project_id, project_name,
          service_name, sku_description, region, currency, labels_json
      `;

      try {
        apiCalls++;
        const [rows] = await bq.query({
          query,
          params: { startDate: range.start, endDate: range.end },
        });

        for (const row of rows as any[]) {
          const billedCost = Number(row.billed_cost) || 0;
          const effectiveCost = row.effective_cost === null || row.effective_cost === undefined
            ? null
            : Number(row.effective_cost);

          if (billedCost === 0 && (effectiveCost === null || effectiveCost === 0)) continue;

          const day: string = row.usage_date?.value ?? row.usage_date;
          const serviceName = row.service_name || 'Unknown';

          records.push({
            provider: 'gcp',
            billingAccountId: row.billing_account_id ?? null,
            billingAccountName: account.accountName,
            subAccountId: row.project_id || account.accountId,
            subAccountName: row.project_name || row.project_id || null,
            chargePeriodStart: day,
            chargePeriodEnd: nextDay(day),
            billingPeriodStart: `${day.slice(0, 7)}-01`,
            serviceName,
            serviceCategory: categorizeService(serviceName),
            chargeCategory: billedCost < 0 ? 'Credit' : 'Usage',
            chargeDescription: row.sku_description ?? null,
            regionId: row.region ?? null,
            billedCost,
            effectiveCost,
            billingCurrency: row.currency || 'USD',
            pricingQuantity: row.usage_amount !== null ? Number(row.usage_amount) : null,
            pricingUnit: row.usage_unit ?? null,
            tags: labelsToTags(row.labels_json),
          });
        }
      } catch (err: any) {
        warnings.push(`GCP account "${account.accountName}": ${err?.message ?? err}`);
      }
    }

    return { records, apiCalls, warnings };
  }
}
