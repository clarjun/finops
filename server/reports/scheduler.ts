/**
 * Scheduled report delivery.
 *
 * report_schedules, next_run_at and storage.getDueReportSchedules() have existed
 * since the feature was built. Nothing ever called them. A customer could
 * configure a weekly cost report, see it listed in the UI, and never receive
 * anything — with no error raised anywhere, because no code was looking.
 *
 * Reports are built from cost_facts rather than by calling provider billing APIs
 * at send time. A scheduled job hitting Cost Explorer for every tenant every
 * morning is both slow and billed per request, and the fact store already holds
 * the answer.
 */
import { and, eq, lte } from "drizzle-orm";
import { db, pool } from "../db";
import { reportSchedules, type ReportSchedule } from "@shared/schema";
import { storage } from "../storage";
import { runAsSystem, currentOrgId } from "../tenant-context";
import { emailService } from "../email-service";
import { getTotalCost, getDailyTrend, getServiceBreakdown } from "../ingestion/queries";

/** Distinct from the alert and ingest job keys. */
const REPORT_JOB_LOCK_KEY = 4711003;

export interface ReportRunResult {
  scheduleId: number;
  scheduleName: string;
  status: 'success' | 'failed' | 'skipped';
  recipients: number;
  error?: string;
}

/** The window a report covers, derived from its frequency. */
function periodFor(frequency: string): { start: Date; end: Date; label: string } {
  // Reports end yesterday: today's cloud costs are always incomplete, and a
  // report that includes a partial day understates spend without saying so.
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  end.setUTCDate(end.getUTCDate() - 1);

  const start = new Date(end);
  switch (frequency.toLowerCase()) {
    case 'daily':
      start.setUTCDate(start.getUTCDate() - 0);
      return { start, end, label: 'Daily' };
    case 'weekly':
      start.setUTCDate(start.getUTCDate() - 6);
      return { start, end, label: 'Weekly' };
    case 'monthly':
    default:
      start.setUTCDate(start.getUTCDate() - 29);
      return { start, end, label: 'Monthly' };
  }
}

/**
 * Next run time, computed from now rather than from the previous next_run_at.
 *
 * Advancing from the stored value would make a schedule that was down for a
 * week fire seven times in a row catching up. Nobody wants six stale cost
 * reports at once.
 */
function nextRunAfter(frequency: string): Date {
  const next = new Date();
  next.setUTCHours(6, 0, 0, 0);          // early morning, after overnight ingestion
  switch (frequency.toLowerCase()) {
    case 'daily':   next.setUTCDate(next.getUTCDate() + 1); break;
    case 'weekly':  next.setUTCDate(next.getUTCDate() + 7); break;
    case 'monthly': next.setUTCMonth(next.getUTCMonth() + 1); break;
    default:        next.setUTCDate(next.getUTCDate() + 1); break;
  }
  return next;
}

function toCsv(rows: Array<Record<string, string | number>>): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const escape = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map(r => headers.map(h => escape(r[h])).join(','))].join('\n');
}

/** Build and send one report. Never throws; the outcome is recorded. */
async function deliver(schedule: ReportSchedule): Promise<ReportRunResult> {
  const recipients = (schedule.emailRecipients ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);

  const base = {
    scheduleId: schedule.id,
    scheduleName: schedule.scheduleName,
    recipients: recipients.length,
  };

  if (recipients.length === 0) {
    return { ...base, status: 'skipped', error: 'No recipients configured' };
  }

  const { start, end, label } = periodFor(schedule.frequency);
  const filters = { start, end, costBasis: 'effective' as const };

  const [total, trend, services] = await Promise.all([
    getTotalCost(filters),
    getDailyTrend(filters),
    getServiceBreakdown(filters, 25),
  ]);

  // No ingested data for the window is a skip, not a success. Emailing a report
  // full of zeros reads as "you spent nothing", which is worse than no email.
  if (trend.length === 0) {
    return {
      ...base,
      status: 'skipped',
      error: `No ingested cost data for ${start.toISOString().slice(0, 10)}..${end.toISOString().slice(0, 10)}`,
    };
  }

  const top = services[0];
  const csv = schedule.format === 'pdf' ? undefined : toCsv([
    ...trend.map(d => ({ section: 'daily', name: d.date, cost: d.cost.toFixed(2) })),
    ...services.map(s => ({ section: 'service', name: s.serviceName, cost: s.cost.toFixed(2) })),
  ]);

  const sent = await emailService.sendScheduledReport({
    to: recipients,
    reportType: `${label} ${schedule.reportType}`,
    csvAttachment: csv,
    summary: {
      totalCost: total,
      avgDailyCost: total / trend.length,
      topService: top?.serviceName ?? 'n/a',
      topServiceCost: top?.cost ?? 0,
    },
  });

  return sent
    ? { ...base, status: 'success' }
    : { ...base, status: 'failed', error: 'Email service reported a delivery failure' };
}

/** Run every report due now for the current tenant. */
export async function runDueReportSchedules(): Promise<ReportRunResult[]> {
  const due = await storage.getDueReportSchedules();
  const results: ReportRunResult[] = [];

  for (const schedule of due) {
    let result: ReportRunResult;
    try {
      result = await deliver(schedule);
    } catch (err: any) {
      result = {
        scheduleId: schedule.id,
        scheduleName: schedule.scheduleName,
        status: 'failed',
        recipients: 0,
        error: err?.message ?? String(err),
      };
    }

    // Always advance next_run_at, even on failure. Leaving it in the past makes
    // the schedule retry on every tick, which for a broken recipient address
    // means a retry loop rather than one visible failure per period.
    await db.update(reportSchedules).set({
      nextRunAt: nextRunAfter(schedule.frequency),
      lastRunAt: new Date(),
      lastRunStatus: result.status,
      lastRunError: result.error ?? null,
      updatedAt: new Date(),
    }).where(and(
      eq(reportSchedules.id, schedule.id),
      eq(reportSchedules.organizationId, currentOrgId()),
    ));

    results.push(result);
  }

  return results;
}

async function withJobLock(fn: () => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked', [REPORT_JOB_LOCK_KEY]
    );
    if (!rows[0]?.locked) return;   // another replica is handling this tick
    try {
      await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [REPORT_JOB_LOCK_KEY]);
    }
  } catch (err: any) {
    console.error('[Report Scheduler] Job lock error:', err?.message ?? err);
  } finally {
    client.release();
  }
}

/** Deliver due reports for every active tenant. */
export async function runReportsForAllTenants() {
  const orgs = await storage.listActiveOrganizations();
  let sent = 0, failed = 0, skipped = 0;

  for (const org of orgs) {
    try {
      const results = await runAsSystem(org.id, () => runDueReportSchedules());
      for (const r of results) {
        if (r.status === 'success') sent++;
        else if (r.status === 'failed') failed++;
        else skipped++;
        if (r.status !== 'success') {
          console.warn(`[Report Scheduler] org ${org.id} "${r.scheduleName}": ${r.status} — ${r.error}`);
        }
      }
    } catch (err: any) {
      failed++;
      console.error(`[Report Scheduler] org ${org.id} failed:`, err?.message ?? err);
    }
  }

  return { organizations: orgs.length, sent, failed, skipped };
}

/**
 * Start the report scheduler.
 *
 * Checks every 15 minutes. Schedules are due at a wall-clock time, so the tick
 * interval sets how late a report can be; 15 minutes keeps that tolerable
 * without polling constantly.
 */
export function startReportScheduler(intervalMinutes = 15): NodeJS.Timeout {
  console.log(`[Report Scheduler] Starting (checking every ${intervalMinutes} minutes)`);

  const tick = async () => {
    await withJobLock(async () => {
      const result = await runReportsForAllTenants();
      if (result.sent || result.failed || result.skipped) {
        console.log(
          `[Report Scheduler] ${result.organizations} org(s): ` +
          `${result.sent} sent, ${result.failed} failed, ${result.skipped} skipped`
        );
      }
    });
  };

  void tick();

  return setInterval(() => { void tick(); }, intervalMinutes * 60 * 1000);
}
