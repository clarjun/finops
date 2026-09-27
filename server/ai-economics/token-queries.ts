/**
 * The AI token economics read layer.
 *
 * Aggregation happens in Postgres, unlike ./queries.ts which had to group in
 * Node because its grouping key was parsed out of a string. Here the model id,
 * provider, application and environment are real columns, so the database can
 * do the work — which matters, because hourly rows across twenty models over a
 * year is a volume you do not want in a Node heap.
 *
 * Every figure that divides by tokens or calls returns null rather than zero or
 * Infinity when the denominator is missing. A cost-per-call of Infinity renders
 * as something; a null renders as "—", which is the truth.
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { currentOrgId } from '../tenant-context';

export interface TokenFilters {
  start: Date;
  end: Date;
  providers?: string[];
  models?: string[];
  applications?: string[];
  environments?: string[];
}

/**
 * Predicates against the `u` alias.
 *
 * Written as raw column references rather than Drizzle column objects, and that
 * is not a style choice. A Drizzle column renders as its fully-qualified name —
 * "ai_usage_records"."organization_id" — but the FROM clause aliases the table
 * as `u`, and Postgres drops the original name once a table is aliased. Mixing
 * the two produced `invalid reference to FROM-clause entry for table
 * "ai_usage_records"` on every query against this view.
 *
 * The values are still parameterised by the sql template, so nothing here is
 * interpolated into the statement.
 */
function conditions(f: TokenFilters): SQL[] {
  const where: SQL[] = [
    sql`u.organization_id = ${currentOrgId()}`,
    sql`u.period_start >= ${f.start}`,
    sql`u.period_start <= ${f.end}`,
  ];

  // An empty list would generate `IN ()`, which is a syntax error, so each
  // filter is applied only when it has entries — and an absent filter
  // correctly means "no restriction".
  if (f.providers?.length) {
    where.push(sql`u.provider_key IN (${sql.join(f.providers.map((p) => sql`${p}`), sql`, `)})`);
  }
  if (f.models?.length) {
    where.push(sql`u.model_id IN (${sql.join(f.models.map((m) => sql`${m}`), sql`, `)})`);
  }
  if (f.applications?.length) {
    where.push(sql`COALESCE(u.application, '(unattributed)') IN (${sql.join(f.applications.map((a) => sql`${a}`), sql`, `)})`);
  }
  if (f.environments?.length) {
    where.push(sql`COALESCE(u.environment, '(unattributed)') IN (${sql.join(f.environments.map((e) => sql`${e}`), sql`, `)})`);
  }

  return where;
}

/**
 * Usage joined to its computed spend.
 *
 * LEFT JOIN, not INNER: usage that has not been priced yet — a model with no
 * rate configured — must still appear with its tokens and calls. An inner join
 * would make unpriced usage vanish entirely, which is the one outcome worse
 * than showing it at zero cost.
 */
const spendJoin = sql`LEFT JOIN ai_spend_records s ON s.usage_record_id = u.id`;

function whereClause(f: TokenFilters): SQL {
  const parts = conditions(f);
  return sql.join(
    parts.map((p) => sql`(${p})`),
    sql` AND `,
  );
}

// The same expression set, reused so every view agrees on what a total is.
const AGG = sql`
  COALESCE(SUM(u.input_tokens), 0)::bigint        AS input_tokens,
  COALESCE(SUM(u.output_tokens), 0)::bigint       AS output_tokens,
  COALESCE(SUM(u.cache_read_tokens), 0)::bigint   AS cache_read_tokens,
  COALESCE(SUM(u.cache_write_tokens), 0)::bigint  AS cache_write_tokens,
  COALESCE(SUM(u.inference_calls), 0)::bigint     AS inference_calls,
  COALESCE(SUM(s.input_cost), 0)                  AS input_cost,
  COALESCE(SUM(s.output_cost), 0)                 AS output_cost,
  COALESCE(SUM(s.cache_cost), 0)                  AS cache_cost,
  COALESCE(SUM(s.total_cost), 0)                  AS total_cost,
  COUNT(*) FILTER (WHERE s.id IS NULL OR s.pricing_id IS NULL)::int AS unpriced_rows
`;

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
};

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  inferenceCalls: number;
  inputCost: number;
  outputCost: number;
  cacheCost: number;
  totalCost: number;
  /** Null when no calls were recorded — never Infinity. */
  costPerCall: number | null;
  costPerMillionTokens: number | null;
  /** Rows whose model has no price configured, so the cost is understated. */
  unpricedRows: number;
}

function toTotals(row: any): TokenTotals {
  const inputTokens = num(row.input_tokens);
  const outputTokens = num(row.output_tokens);
  const totalTokens = inputTokens + outputTokens;
  const calls = num(row.inference_calls);
  const totalCost = num(row.total_cost);

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: num(row.cache_read_tokens),
    cacheWriteTokens: num(row.cache_write_tokens),
    totalTokens,
    inferenceCalls: calls,
    inputCost: num(row.input_cost),
    outputCost: num(row.output_cost),
    cacheCost: num(row.cache_cost),
    totalCost,
    costPerCall: calls > 0 ? totalCost / calls : null,
    costPerMillionTokens: totalTokens > 0 ? (totalCost / totalTokens) * 1_000_000 : null,
    unpricedRows: num(row.unpriced_rows),
  };
}

export async function totals(f: TokenFilters): Promise<TokenTotals> {
  const res = await db.execute(sql`
    SELECT ${AGG} FROM ai_usage_records u ${spendJoin} WHERE ${whereClause(f)}
  `);
  return toTotals((res.rows as any[])[0] ?? {});
}

export interface GroupedSpend extends TokenTotals {
  key: string;
  label: string;
  share: number;
}

async function groupBy(f: TokenFilters, column: SQL, label: SQL): Promise<GroupedSpend[]> {
  const res = await db.execute(sql`
    SELECT ${label} AS key, ${AGG}
      FROM ai_usage_records u ${spendJoin}
     WHERE ${whereClause(f)}
     GROUP BY ${column}
     ORDER BY total_cost DESC
     LIMIT 200
  `);

  const rows = (res.rows as any[]).map((r) => ({ key: String(r.key), ...toTotals(r) }));
  const grand = rows.reduce((s, r) => s + r.totalCost, 0);

  return rows.map((r) => ({ ...r, label: r.key, share: grand > 0 ? (r.totalCost / grand) * 100 : 0 }));
}

export const byProvider = (f: TokenFilters) =>
  groupBy(f, sql`u.provider_key`, sql`u.provider_key`);

export const byModel = (f: TokenFilters) =>
  groupBy(f, sql`u.provider_key, u.model_id`, sql`u.provider_key || ' / ' || u.model_id`);

export const byApplication = (f: TokenFilters) =>
  groupBy(f, sql`COALESCE(u.application, '(unattributed)')`, sql`COALESCE(u.application, '(unattributed)')`);

export const byEnvironment = (f: TokenFilters) =>
  groupBy(f, sql`COALESCE(u.environment, '(unattributed)')`, sql`COALESCE(u.environment, '(unattributed)')`);

export interface TrendPoint {
  day: string;
  inputTokens: number;
  outputTokens: number;
  inferenceCalls: number;
  totalCost: number;
  costPerCall: number | null;
}

/** Daily series for the charts. Days with no usage are simply absent. */
export async function trend(f: TokenFilters): Promise<TrendPoint[]> {
  const res = await db.execute(sql`
    SELECT to_char(date_trunc('day', u.period_start), 'YYYY-MM-DD') AS day, ${AGG}
      FROM ai_usage_records u ${spendJoin}
     WHERE ${whereClause(f)}
     GROUP BY 1
     ORDER BY 1
  `);

  return (res.rows as any[]).map((r) => {
    const t = toTotals(r);
    return {
      day: String(r.day),
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      inferenceCalls: t.inferenceCalls,
      totalCost: t.totalCost,
      costPerCall: t.costPerCall,
    };
  });
}

/**
 * The values available in each filter.
 *
 * Derived from the data rather than from a fixed list, so a filter never offers
 * an option that matches nothing, and never omits an application that started
 * appearing yesterday.
 */
export interface FilterOptions {
  providers: string[];
  models: Array<{ providerKey: string; modelId: string }>;
  applications: string[];
  environments: string[];
}

export async function filterOptions(start: Date, end: Date): Promise<FilterOptions> {
  const orgId = currentOrgId();
  // No alias here, so plain column names are correct.
  const res = await db.execute(sql`
    SELECT DISTINCT provider_key, model_id,
           COALESCE(application, '(unattributed)') AS application,
           COALESCE(environment, '(unattributed)') AS environment
      FROM ai_usage_records
     WHERE organization_id = ${orgId}
       AND period_start >= ${start}
       AND period_start <= ${end}
     LIMIT 5000
  `);

  const rows = res.rows as any[];
  const models = new Map<string, { providerKey: string; modelId: string }>();
  for (const r of rows) {
    models.set(`${r.provider_key}|${r.model_id}`, { providerKey: r.provider_key, modelId: r.model_id });
  }

  return {
    providers: Array.from(new Set(rows.map((r) => String(r.provider_key)))).sort(),
    models: Array.from(models.values()).sort((a, b) => a.modelId.localeCompare(b.modelId)),
    applications: Array.from(new Set(rows.map((r) => String(r.application)))).sort(),
    environments: Array.from(new Set(rows.map((r) => String(r.environment)))).sort(),
  };
}

/** Models with usage but no applicable price, so a customer can add the rate. */
export async function unpricedModels(f: TokenFilters): Promise<Array<{
  providerKey: string; modelId: string; tokens: number; calls: number; firstSeen: string;
}>> {
  const res = await db.execute(sql`
    SELECT u.provider_key, u.model_id,
           COALESCE(SUM(u.input_tokens + u.output_tokens), 0)::bigint AS tokens,
           COALESCE(SUM(u.inference_calls), 0)::bigint                AS calls,
           to_char(MIN(u.period_start), 'YYYY-MM-DD')                 AS first_seen
      FROM ai_usage_records u
      LEFT JOIN ai_spend_records s ON s.usage_record_id = u.id
     WHERE ${whereClause(f)}
       AND (s.id IS NULL OR s.pricing_id IS NULL)
     GROUP BY u.provider_key, u.model_id
     ORDER BY tokens DESC
     LIMIT 50
  `);

  return (res.rows as any[]).map((r) => ({
    providerKey: String(r.provider_key),
    modelId: String(r.model_id),
    tokens: num(r.tokens),
    calls: num(r.calls),
    firstSeen: String(r.first_seen),
  }));
}

export interface AiTokenDashboard {
  windowStart: string;
  windowEnd: string;
  totals: TokenTotals;
  byProvider: GroupedSpend[];
  byModel: GroupedSpend[];
  byApplication: GroupedSpend[];
  byEnvironment: GroupedSpend[];
  trend: TrendPoint[];
  unpriced: Array<{ providerKey: string; modelId: string; tokens: number; calls: number; firstSeen: string }>;
  filters: FilterOptions;
}

export async function buildDashboard(f: TokenFilters): Promise<AiTokenDashboard> {
  // Sequential rather than Promise.all. The pool is shared with live HTTP
  // traffic and capped at ten; eight concurrent aggregates from one request
  // would starve every other request behind it. These are indexed and fast.
  const t = await totals(f);
  const providers = await byProvider(f);
  const models = await byModel(f);
  const applications = await byApplication(f);
  const environments = await byEnvironment(f);
  const series = await trend(f);
  const gaps = await unpricedModels(f);
  const options = await filterOptions(f.start, f.end);

  return {
    windowStart: f.start.toISOString().slice(0, 10),
    windowEnd: f.end.toISOString().slice(0, 10),
    totals: t,
    byProvider: providers,
    byModel: models,
    byApplication: applications,
    byEnvironment: environments,
    trend: series,
    unpriced: gaps,
    filters: options,
  };
}
