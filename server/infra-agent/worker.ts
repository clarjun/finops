/**
 * The run worker.
 *
 * A deployment outlives any HTTP request, so nothing drives it from one. Routes
 * schedule work and return; this pushes runs forward until they finish or stop
 * for a human.
 *
 * Two entry points, deliberately:
 *
 *   scheduleAdvance  immediately after something changed — a run started, an
 *                    approval decided. Responsive, and the common case.
 *   the sweep        periodically, for runs nothing nudged: a process that died
 *                    mid-step, an approval decided on another replica, a lease
 *                    that expired. Without it a run could stall silently.
 *
 * Both funnel into engine.advance(), which takes the lease. Overlapping calls
 * are therefore safe: one proceeds, the others return immediately.
 */
import { and, inArray, sql } from 'drizzle-orm';
import { db, pool } from '../db';
import { infraRuns } from '@shared/schema';
import { runAsSystem } from '../tenant-context';
import { advance } from './engine';

/** Statuses that still have work to do. `awaiting_approval` deliberately does not. */
const ACTIVE = ['queued', 'initializing', 'planning', 'applying', 'verifying'] as const;

/** Distinct from the alert, ingest and report job keys. */
const SWEEP_LOCK_KEY = 4711004;

/** Runs currently being advanced in this process, so we do not stack calls. */
const inFlight = new Set<number>();

/**
 * Advances a run in the background.
 *
 * Fire-and-forget on purpose: the caller is an HTTP handler that must not wait
 * for a Terraform apply. Progress is reported through the event stream.
 */
export function scheduleAdvance(runId: number, organizationId: number): void {
  if (inFlight.has(runId)) return;
  inFlight.add(runId);

  // Detached from the request that triggered it.
  setImmediate(() => {
    void driveToPause(runId, organizationId).finally(() => inFlight.delete(runId));
  });
}

/**
 * Advances repeatedly until the run finishes or stops for a human.
 *
 * advance() performs one step, so a deployment with several stages needs
 * several calls. Looping here rather than making advance() recursive keeps each
 * step's lease short and lets the run be taken over cleanly if this process
 * dies mid-deployment.
 */
async function driveToPause(runId: number, organizationId: number): Promise<void> {
  // A generous ceiling that still cannot spin forever if a step stops making
  // progress. Reaching it means a bug, and the run is left for the sweep.
  const MAX_STEPS = 200;

  for (let step = 0; step < MAX_STEPS; step++) {
    try {
      const result = await runAsSystem(organizationId, () => advance(runId));

      if (result.done) return;
      if (result.status === 'awaiting_approval') return;   // a human now owns it
      if (result.action.includes('another worker')) return;
    } catch (err) {
      // A thrown error means the engine could not even record a failure, so
      // stop rather than hammer it; the sweep will retry once the lease lapses.
      console.error(`[InfraWorker] run ${runId} step failed:`, (err as Error)?.message ?? err);
      return;
    }
  }

  console.warn(`[InfraWorker] run ${runId} hit the step ceiling without finishing; leaving it for the sweep.`);
}

/** Picks up runs nothing nudged — a dead process, or a cross-replica decision. */
export async function sweepStalledRuns(): Promise<{ picked: number }> {
  const rows = await db.select({
    id: infraRuns.id,
    organizationId: infraRuns.organizationId,
  }).from(infraRuns)
    .where(and(
      inArray(infraRuns.status, ACTIVE as unknown as string[]),
      // Only runs nobody currently holds. A live lease means another worker is
      // mid-step and must not be interrupted.
      sql`(${infraRuns.leaseOwner} is null or ${infraRuns.leaseExpiresAt} < now())`,
    ))
    .limit(25);

  for (const row of rows) {
    scheduleAdvance(Number(row.id), row.organizationId);
  }

  return { picked: rows.length };
}

async function withSweepLock(fn: () => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked', [SWEEP_LOCK_KEY],
    );
    if (!rows[0]?.locked) return;
    try {
      await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [SWEEP_LOCK_KEY]);
    }
  } catch (err) {
    console.error('[InfraWorker] sweep lock error:', (err as Error)?.message ?? err);
  } finally {
    client.release();
  }
}

/**
 * Starts the sweep.
 *
 * Every 30 seconds: frequent enough that a stalled deployment recovers while
 * someone is still watching, cheap enough that it is a single indexed query
 * against a table with few active rows.
 */
export function startInfraWorker(intervalSeconds = 30): NodeJS.Timeout {
  console.log(`[InfraWorker] Started (sweeping every ${intervalSeconds}s)`);

  const tick = async () => {
    await withSweepLock(async () => {
      const { picked } = await sweepStalledRuns();
      if (picked > 0) console.log(`[InfraWorker] picked up ${picked} stalled run(s)`);
    });
  };

  void tick();
  return setInterval(() => { void tick(); }, intervalSeconds * 1000);
}
