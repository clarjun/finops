/**
 * Realized-savings measurement.
 *
 * An optimization tool that reports its own estimates back as results is a
 * closed loop with no feedback. This module measures what actually happened to
 * spend after an action executed, and records the variance against what was
 * predicted — which is the only way the estimates ever get better, and the only
 * savings figure a finance team will accept.
 *
 * Method: difference-in-differences.
 *
 *   target   the series the action touched (provider + sub-account + service)
 *   control  everything else in that sub-account
 *
 *   expected = baseline_target x (control_after / control_before)
 *   realized = expected - observed_target
 *
 * The control term is what makes this defensible. A raw before/after comparison
 * credits the optimization for every unrelated decrease and blames it for every
 * unrelated increase; shut down an idle cluster in a month when the company
 * doubled its traffic and a naive comparison reports the change made things
 * worse.
 *
 * Known limitation, recorded on every row rather than hidden: cost_facts has no
 * resource_id today, so measurement is at service granularity — coarser than
 * the resource an action usually changes. Other activity in the same service
 * contaminates the result. Rows carry a confidence level and a note saying so.
 * Resource-level measurement needs resource-level ingestion first.
 */
import { and, eq, gte, lte, lt, ne, sql } from "drizzle-orm";
import { db } from "../db";
import { costFacts, optimizationActions, savingsMeasurements } from "@shared/schema";
import { currentOrgId } from "../tenant-context";

/** Days of history before the change used as the baseline. */
const BASELINE_DAYS = 14;
/**
 * How long to wait after execution before measuring. Long enough for the change
 * to take effect and for the provider to stop restating the bill; short enough
 * that the answer still arrives while anyone cares.
 */
const SETTLE_DAYS = 3;
/** Days of post-change data compared against the baseline. */
const MEASUREMENT_DAYS = 14;

const DAYS_PER_MONTH = 30.44;

/** Below this, daily costs are noise and a ratio is meaningless. */
const MIN_MEANINGFUL_DAILY_COST = 0.01;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

interface SeriesCost {
  /** Mean cost per day across days that had any data. */
  dailyCost: number;
  days: number;
}

/**
 * Mean daily cost of a series between two dates.
 * `invert` selects the control instead: same sub-account, every other service.
 */
async function seriesDailyCost(
  opts: {
    provider: string;
    subAccountId: string | null;
    serviceName: string | null;
    start: Date;
    end: Date;
    invert?: boolean;
  }
): Promise<SeriesCost> {
  const conditions = [
    eq(costFacts.organizationId, currentOrgId()),
    eq(costFacts.provider, opts.provider),
    gte(costFacts.chargePeriodStart, opts.start),
    lte(costFacts.chargePeriodStart, opts.end),
    // Tax is not attributable to a resource change and would add noise.
    sql`${costFacts.chargeCategory} <> 'Tax'`,
  ];

  if (opts.subAccountId) conditions.push(eq(costFacts.subAccountId, opts.subAccountId));
  if (opts.serviceName) {
    conditions.push(opts.invert
      ? ne(costFacts.serviceName, opts.serviceName)
      : eq(costFacts.serviceName, opts.serviceName));
  }

  const [row] = await db.select({
    total: sql<string>`sum(coalesce(${costFacts.effectiveCost}, ${costFacts.billedCost}))`,
    days: sql<number>`count(distinct ${costFacts.chargePeriodStart})::int`,
  }).from(costFacts).where(and(...conditions));

  const days = row?.days ?? 0;
  const total = Number(row?.total ?? 0);
  return { dailyCost: days > 0 ? total / days : 0, days };
}

/**
 * Record the baseline and schedule a measurement. Called when an action
 * completes successfully.
 *
 * The baseline is captured now, from data that already exists, because after
 * the change there is no way to reconstruct what the cost had been.
 */
export async function scheduleSavingsMeasurement(actionId: number): Promise<void> {
  const orgId = currentOrgId();

  const [action] = await db.select().from(optimizationActions)
    .where(and(
      eq(optimizationActions.id, actionId),
      eq(optimizationActions.organizationId, orgId),
    ));

  if (!action) return;

  const executedAt = action.executedAt ?? new Date();
  const baselineEnd = addDays(executedAt, -1);
  const baselineStart = addDays(baselineEnd, -(BASELINE_DAYS - 1));

  // The action stores accountId; cost_facts keys on sub_account_id. They agree
  // for AWS and GCP. Where they do not, the baseline query simply widens to the
  // whole provider, which the confidence level reflects.
  const subAccountId = action.accountId ?? null;
  const serviceName = deriveServiceName(action);

  const [target, control] = await Promise.all([
    seriesDailyCost({ provider: action.provider, subAccountId, serviceName, start: baselineStart, end: baselineEnd }),
    seriesDailyCost({ provider: action.provider, subAccountId, serviceName, start: baselineStart, end: baselineEnd, invert: true }),
  ]);

  const estimatedMonthly = action.estimatedSavings ? Number(action.estimatedSavings) : null;

  await db.insert(savingsMeasurements).values({
    organizationId: orgId,
    actionId,
    provider: action.provider,
    subAccountId,
    serviceName,
    resourceId: action.resourceId ?? null,
    // Recorded honestly: we key on service because the fact store has no
    // resource-level rows, even though the action names a resource.
    granularity: serviceName ? 'service' : 'account',
    baselineStart: isoDay(baselineStart),
    baselineEnd: isoDay(baselineEnd),
    baselineDays: target.days,
    baselineDailyCost: String(target.dailyCost),
    controlBaselineDailyCost: String(control.dailyCost),
    measureAfter: addDays(executedAt, SETTLE_DAYS + MEASUREMENT_DAYS),
    estimatedMonthlySavings: estimatedMonthly === null ? null : String(estimatedMonthly),
    status: 'pending',
    notes: target.days === 0
      ? 'No ingested cost data covering the baseline window; measurement will likely be inconclusive.'
      : null,
  }).onConflictDoNothing();
}

/** Best guess at the cost_facts service name for an action. */
function deriveServiceName(action: { actionType: string; resourceType: string | null }): string | null {
  const t = `${action.actionType} ${action.resourceType ?? ''}`.toLowerCase();
  if (t.includes('ec2') || t.includes('instance')) return 'Amazon Elastic Compute Cloud - Compute';
  if (t.includes('s3') || t.includes('bucket')) return 'Amazon Simple Storage Service';
  if (t.includes('ebs') || t.includes('volume') || t.includes('snapshot')) return 'EC2 - Other';
  if (t.includes('rds')) return 'Amazon Relational Database Service';
  if (t.includes('lambda') || t.includes('function')) return 'AWS Lambda';
  // Unknown mapping: measure the whole sub-account rather than guess wrong.
  return null;
}

export interface MeasurementOutcome {
  measurementId: number;
  actionId: number;
  status: 'measured' | 'inconclusive';
  realizedMonthlySavings?: number;
  estimatedMonthlySavings?: number | null;
  variancePercent?: number | null;
  confidence?: string;
  notes?: string;
}

/** Measure one scheduled comparison. */
export async function runMeasurement(measurementId: number): Promise<MeasurementOutcome | null> {
  const orgId = currentOrgId();

  const [m] = await db.select().from(savingsMeasurements)
    .where(and(
      eq(savingsMeasurements.id, measurementId),
      eq(savingsMeasurements.organizationId, orgId),
    ));

  if (!m || m.status !== 'pending') return null;

  const measurementEnd = addDays(new Date(), -1);           // yesterday; today is incomplete
  const measurementStart = addDays(measurementEnd, -(MEASUREMENT_DAYS - 1));

  const [target, control] = await Promise.all([
    seriesDailyCost({
      provider: m.provider, subAccountId: m.subAccountId, serviceName: m.serviceName,
      start: measurementStart, end: measurementEnd,
    }),
    seriesDailyCost({
      provider: m.provider, subAccountId: m.subAccountId, serviceName: m.serviceName,
      start: measurementStart, end: measurementEnd, invert: true,
    }),
  ]);

  const baselineDaily = Number(m.baselineDailyCost ?? 0);
  const controlBaselineDaily = Number(m.controlBaselineDailyCost ?? 0);

  const reasons: string[] = [];
  if ((m.baselineDays ?? 0) < 5) reasons.push(`only ${m.baselineDays ?? 0} day(s) of baseline data`);
  if (target.days < 5) reasons.push(`only ${target.days} day(s) of post-change data`);
  if (baselineDaily < MIN_MEANINGFUL_DAILY_COST) reasons.push('baseline spend was effectively zero');

  if (reasons.length > 0) {
    await db.update(savingsMeasurements).set({
      status: 'inconclusive',
      measurementStart: isoDay(measurementStart),
      measurementEnd: isoDay(measurementEnd),
      measurementDays: target.days,
      observedDailyCost: String(target.dailyCost),
      controlObservedDailyCost: String(control.dailyCost),
      notes: `Cannot measure: ${reasons.join('; ')}.`,
      measuredAt: new Date(),
    }).where(eq(savingsMeasurements.id, m.id));

    return { measurementId: m.id, actionId: m.actionId, status: 'inconclusive', notes: reasons.join('; ') };
  }

  // Counterfactual. When the control is too small to give a stable ratio, fall
  // back to a flat baseline (ratio 1) rather than amplifying noise.
  const controlUsable = controlBaselineDaily >= MIN_MEANINGFUL_DAILY_COST;
  const rawRatio = controlUsable ? control.dailyCost / controlBaselineDaily : 1;
  // Clamped: a control that moved 5x says something happened to the whole
  // account, and projecting that onto the target would invent a huge number.
  const ratio = Math.min(Math.max(rawRatio, 0.5), 2);

  const expectedDaily = baselineDaily * ratio;
  const realizedDaily = expectedDaily - target.dailyCost;
  const realizedMonthly = realizedDaily * DAYS_PER_MONTH;

  const estimatedMonthly = m.estimatedMonthlySavings === null ? null : Number(m.estimatedMonthlySavings);
  const variancePercent = estimatedMonthly && Math.abs(estimatedMonthly) > 0.01
    ? ((realizedMonthly - estimatedMonthly) / Math.abs(estimatedMonthly)) * 100
    : null;

  // Was anything else changed in the same series during the window? If so the
  // result cannot be attributed to this action alone.
  const [contamination] = await db.select({ n: sql<number>`count(*)::int` })
    .from(optimizationActions)
    .where(and(
      eq(optimizationActions.organizationId, orgId),
      eq(optimizationActions.provider, m.provider),
      eq(optimizationActions.status, 'completed'),
      ne(optimizationActions.id, m.actionId),
      gte(optimizationActions.completedAt, measurementStart),
      lt(optimizationActions.completedAt, addDays(measurementEnd, 1)),
    ));

  const otherActions = contamination?.n ?? 0;

  const notes: string[] = [];
  let confidence: 'high' | 'medium' | 'low';

  if (m.granularity === 'resource') {
    confidence = 'high';
  } else if (m.granularity === 'account') {
    confidence = 'low';
    notes.push('Measured across the whole sub-account: no service mapping for this action type.');
  } else {
    confidence = 'medium';
    notes.push('Measured at service granularity; other changes within the same service are not isolated.');
  }

  if (otherActions > 0) {
    confidence = 'low';
    notes.push(`${otherActions} other action(s) completed in the same window; attribution is shared.`);
  }
  if (!controlUsable) {
    confidence = 'low';
    notes.push('Control series too small to adjust for account-wide drift; assumed flat.');
  }
  if (rawRatio !== ratio) {
    confidence = 'low';
    notes.push(`Control moved ${(rawRatio * 100).toFixed(0)}% and was clamped; the account changed materially.`);
  }

  await db.update(savingsMeasurements).set({
    status: 'measured',
    measurementStart: isoDay(measurementStart),
    measurementEnd: isoDay(measurementEnd),
    measurementDays: target.days,
    observedDailyCost: String(target.dailyCost),
    controlObservedDailyCost: String(control.dailyCost),
    expectedDailyCost: String(expectedDaily),
    realizedDailySavings: String(realizedDaily),
    realizedMonthlySavings: String(realizedMonthly),
    variancePercent: variancePercent === null ? null : String(variancePercent),
    confidence,
    notes: notes.join(' '),
    measuredAt: new Date(),
  }).where(eq(savingsMeasurements.id, m.id));

  return {
    measurementId: m.id,
    actionId: m.actionId,
    status: 'measured',
    realizedMonthlySavings: realizedMonthly,
    estimatedMonthlySavings: estimatedMonthly,
    variancePercent,
    confidence,
    notes: notes.join(' '),
  };
}

/** Run every measurement now due for the current tenant. */
export async function runDueMeasurements(): Promise<MeasurementOutcome[]> {
  const orgId = currentOrgId();

  const due = await db.select({ id: savingsMeasurements.id })
    .from(savingsMeasurements)
    .where(and(
      eq(savingsMeasurements.organizationId, orgId),
      eq(savingsMeasurements.status, 'pending'),
      lte(savingsMeasurements.measureAfter, new Date()),
    ));

  const outcomes: MeasurementOutcome[] = [];
  for (const row of due) {
    const outcome = await runMeasurement(row.id);
    if (outcome) outcomes.push(outcome);
  }
  return outcomes;
}

/**
 * Estimated vs realized across all measurements.
 *
 * estimateAccuracy is the number worth watching: consistently above 100% means
 * the planner is over-promising, and it is the input a future tuning pass needs.
 */
export async function getRealizedSavingsSummary() {
  const orgId = currentOrgId();

  const [row] = await db.select({
    measured: sql<number>`count(*) filter (where ${savingsMeasurements.status} = 'measured')::int`,
    pending: sql<number>`count(*) filter (where ${savingsMeasurements.status} = 'pending')::int`,
    inconclusive: sql<number>`count(*) filter (where ${savingsMeasurements.status} = 'inconclusive')::int`,
    realized: sql<string>`coalesce(sum(${savingsMeasurements.realizedMonthlySavings}) filter (where ${savingsMeasurements.status} = 'measured'), 0)`,
    estimated: sql<string>`coalesce(sum(${savingsMeasurements.estimatedMonthlySavings}) filter (where ${savingsMeasurements.status} = 'measured'), 0)`,
    highConfidence: sql<number>`count(*) filter (where ${savingsMeasurements.confidence} = 'high')::int`,
    mediumConfidence: sql<number>`count(*) filter (where ${savingsMeasurements.confidence} = 'medium')::int`,
    lowConfidence: sql<number>`count(*) filter (where ${savingsMeasurements.confidence} = 'low')::int`,
  }).from(savingsMeasurements).where(eq(savingsMeasurements.organizationId, orgId));

  const realized = Number(row?.realized ?? 0);
  const estimated = Number(row?.estimated ?? 0);

  return {
    measuredActions: row?.measured ?? 0,
    pendingMeasurements: row?.pending ?? 0,
    inconclusiveMeasurements: row?.inconclusive ?? 0,
    realizedMonthlySavings: realized,
    estimatedMonthlySavings: estimated,
    estimateAccuracyPercent: Math.abs(estimated) > 0.01 ? (realized / estimated) * 100 : null,
    confidenceBreakdown: {
      high: row?.highConfidence ?? 0,
      medium: row?.mediumConfidence ?? 0,
      low: row?.lowConfidence ?? 0,
    },
  };
}
