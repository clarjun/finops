/**
 * Ingestion scheduler.
 *
 * Same shape as the budget-alert scheduler: a Postgres advisory lock so only one
 * replica runs a tick, and an explicit loop over organizations because there is
 * no ambient tenant in a background job.
 *
 * This is deliberately not a general job queue. When a third scheduled job
 * appears, replace both of these with pg-boss rather than copying the pattern a
 * third time.
 */
import { pool } from "../db";
import { storage } from "../storage";
import { runAsSystem } from "../tenant-context";
import { ingestAllProviders, defaultRange, type ProviderIngestResult } from "./ingest";
import { runDueMeasurements } from "../savings/measurement";

/** Distinct from the alert scheduler's key so the two jobs never block each other. */
const INGEST_JOB_LOCK_KEY = 4711002;

async function withJobLock(fn: () => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked', [INGEST_JOB_LOCK_KEY]
    );
    if (!rows[0]?.locked) {
      console.log('[Ingest Scheduler] Another replica holds the lock, skipping this tick');
      return;
    }
    try {
      await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [INGEST_JOB_LOCK_KEY]);
    }
  } catch (err: any) {
    console.error('[Ingest Scheduler] Job lock error:', err?.message ?? err);
  } finally {
    client.release();
  }
}

/** Ingest the rolling restatement window for every active tenant. */
export async function ingestAllTenants(): Promise<{
  organizations: number;
  records: number;
  apiCalls: number;
  measurements: number;
  failures: string[];
}> {
  const orgs = await storage.listActiveOrganizations();
  const range = defaultRange();
  let records = 0;
  let apiCalls = 0;
  let measurements = 0;
  const failures: string[] = [];

  for (const org of orgs) {
    try {
      const results: ProviderIngestResult[] = await runAsSystem(org.id, () =>
        ingestAllProviders({ range, trigger: 'scheduled' })
      );

      for (const r of results) {
        records += r.recordsIngested;
        apiCalls += r.apiCalls;
        if (r.status === 'failed') {
          failures.push(`org ${org.id} ${r.provider}: ${r.error}`);
        }
      }

      // Measure realized savings immediately after ingesting, while the cost
      // data backing the comparison is as fresh as it will get this cycle.
      // A measurement failure must not mark the ingest as failed.
      try {
        const outcomes = await runAsSystem(org.id, () => runDueMeasurements());
        measurements += outcomes.length;
      } catch (err: any) {
        failures.push(`org ${org.id} savings measurement: ${err?.message ?? err}`);
      }
    } catch (err: any) {
      failures.push(`org ${org.id}: ${err?.message ?? err}`);
    }
  }

  return { organizations: orgs.length, records, apiCalls, measurements, failures };
}

/**
 * Start the periodic ingest.
 *
 * Default is every 6 hours. Billing data updates only a few times a day at best,
 * so a tighter interval spends money on Cost Explorer calls (billed per request)
 * without producing fresher numbers.
 */
export function startIngestionScheduler(intervalHours = 6): NodeJS.Timeout {
  console.log(`[Ingest Scheduler] Starting (every ${intervalHours}h, ${defaultRange().start}..${defaultRange().end} window)`);

  const tick = async () => {
    await withJobLock(async () => {
      const result = await ingestAllTenants();
      console.log(
        `[Ingest Scheduler] ${result.organizations} org(s): ` +
        `${result.records} rows, ${result.apiCalls} API call(s), ` +
        `${result.measurements} savings measurement(s)`
      );
      if (result.failures.length > 0) {
        console.error('[Ingest Scheduler] Failures:', result.failures);
      }
    });
  };

  void tick();

  return setInterval(() => { void tick(); }, intervalHours * 60 * 60 * 1000);
}
