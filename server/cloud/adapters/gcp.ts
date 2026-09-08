/**
 * GCP BigQuery billing-export adapter.
 *
 * The connector this replaces had **no retry at all** — a single BigQuery
 * hiccup, an expired key, or a transient network drop lost the whole run with
 * one warning. It was the least protected of the three purely because BigQuery
 * is the most forgiving, not because anyone decided that was acceptable. On the
 * runtime it now inherits the same classification, backoff and budget as the
 * others.
 *
 * GCP-specific facts that stay here:
 *
 *   - one pass, one page. BigQuery returns a complete result set, so there is no
 *     cursor. `nextCursor: null` says so explicitly rather than by omission.
 *   - the end date is INCLUSIVE (`<=`), unlike AWS's exclusive `End`.
 *   - cost must be netted against the `credits` array. Summing `cost` alone
 *     reports gross list price and overstated a real bill by 10.2%.
 *   - the export is partitioned, so the range is applied to _PARTITIONTIME as
 *     well, with a margin for late-arriving rows. Without it every query scans
 *     the entire table, and BigQuery bills per byte scanned.
 */
import { BigQuery } from '@google-cloud/bigquery';
import type { CloudCostAdapter, FetchContext, PageResult, AdapterAccount } from '../fetch-runtime';
import type { NormalizedCostRecord } from '../../ingestion/types';
import { getActiveCloudAccounts } from '../../cloud-config-manager';
import { categorizeService } from '../../ingestion/service-category';

export interface GcpRow {
  usage_date: { value?: string } | string;
  billing_account_id: string | null;
  project_id: string | null;
  project_name: string | null;
  service_name: string | null;
  sku_description: string | null;
  region: string | null;
  currency: string | null;
  billed_cost: number | string | null;
  effective_cost: number | string | null;
  usage_amount: number | string | null;
  usage_unit: string | null;
  labels_json: string | null;
}

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** The billing export stores labels as a repeated key/value struct. */
function labelsToTags(json: string | null | undefined): Record<string, string> | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const tags: Record<string, string> = {};
    for (const l of parsed) {
      if (l?.key && l?.value) tags[l.key] = l.value;
    }
    return Object.keys(tags).length > 0 ? tags : null;
  } catch {
    return null;
  }
}

function parseServiceAccountKey(credentials: Record<string, any>): Record<string, any> | null {
  const raw = credentials?.serviceAccountKey;
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

interface GcpTarget {
  projectId: string;
  dataset: string;
  table: string;
  key: Record<string, any>;
}

/**
 * Resolves what to query, or throws with a message the classifier will read as
 * `blocked` — a missing key or table is a configuration problem, not something
 * to retry.
 */
function resolveTarget(account: AdapterAccount): GcpTarget {
  const credentials = account.credentials ?? {};
  const key = parseServiceAccountKey(credentials);
  const projectId = credentials.projectId || key?.project_id;
  const table = credentials.billingTable;

  if (!key || !projectId) {
    throw new Error(`no usable service-account key: PERMISSION_DENIED for "${account.accountName}"`);
  }
  if (!table) {
    throw new Error(`billing export not configured: dataset/table not found for "${account.accountName}"`);
  }

  return {
    projectId,
    dataset: credentials.billingDataset || 'cloud_billing_data',
    table,
    key,
  };
}

export const gcpCostAdapter: CloudCostAdapter<GcpRow> = {
  provider: 'gcp',

  passes: ['default'],

  // BigQuery returns one complete result set. The cap exists only so the
  // runtime's loop has a bound; it can never be reached.
  maxPages: 1,

  async listAccounts() {
    const accounts = await getActiveCloudAccounts('gcp');
    return accounts.map((a) => ({
      id: a.id,
      accountId: a.accountId,
      accountName: a.accountName,
      credentials: a.credentials ?? {},
      authType: a.authType,
    }));
  },

  async fetchPage(ctx: FetchContext): Promise<PageResult<GcpRow>> {
    const { projectId, dataset, table, key } = resolveTarget(ctx.account);
    const bq = new BigQuery({ projectId, credentials: key });

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
        -- Net of credits: sustained-use and committed-use discounts live in the
        -- credits array as negative amounts. Summing cost alone reports gross
        -- list price, which overstated a real bill by 10.2%.
        SUM(cost + IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)) AS effective_cost,
        SUM(usage.amount)                            AS usage_amount,
        ANY_VALUE(usage.unit)                        AS usage_unit,
        TO_JSON_STRING(labels)                       AS labels_json
      FROM \`${projectId}.${dataset}.${table}\`
      WHERE DATE(usage_start_time) >= @startDate
        AND DATE(usage_start_time) <= @endDate
        -- Also on the partition column, with a margin for late-arriving rows.
        -- Without it every query scans the whole table, and BigQuery bills per
        -- byte scanned.
        AND DATE(_PARTITIONTIME) >= DATE_SUB(@startDate, INTERVAL 3 DAY)
      GROUP BY
        usage_date, billing_account_id, project_id, project_name,
        service_name, sku_description, region, currency, labels_json
    `;

    const [rows] = await bq.query({
      query,
      params: { startDate: ctx.range.start, endDate: ctx.range.end },
    });

    // One page, always. No cursor exists for a completed BigQuery result.
    return { rows: rows as GcpRow[], nextCursor: null };
  },

  mapRows(rowsByPass, ctx): NormalizedCostRecord[] {
    const rows = rowsByPass.get('default') ?? [];
    const out: NormalizedCostRecord[] = [];

    for (const row of rows) {
      const billedCost = Number(row.billed_cost) || 0;
      const effectiveCost =
        row.effective_cost === null || row.effective_cost === undefined
          ? null
          : Number(row.effective_cost);

      // A row that is zero on both measures carries no information. Negative
      // rows are kept: they are refunds and adjustments, and dropping them
      // overstates the bill.
      if (billedCost === 0 && (effectiveCost === null || effectiveCost === 0)) continue;

      const day = typeof row.usage_date === 'string'
        ? row.usage_date
        : row.usage_date?.value ?? '';
      if (!day) continue;

      const serviceName = row.service_name || 'Unknown';

      out.push({
        provider: 'gcp',
        billingAccountId: row.billing_account_id ?? null,
        billingAccountName: ctx.account.accountName,
        subAccountId: row.project_id || ctx.account.accountId,
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

    return out;
  },
};
