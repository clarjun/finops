/**
 * Single-runner scheduling via a Postgres advisory lock.
 *
 * Four schedulers needed this — cost ingestion, budget alerts, report delivery
 * and the infra-agent run sweep — and each had its own copy of the same twelve
 * lines. All four copies shared the same two defects:
 *
 *   1. `await pool.connect()` sat OUTSIDE the try, so the catch below it could
 *      not see a connection failure. A transient `read ECONNRESET` therefore
 *      escaped the helper entirely.
 *
 *   2. The callers invoked the tick as `void tick()` — a floating promise with
 *      no rejection handler. Combined with (1), one dropped database connection
 *      became an unhandled rejection, and Node exits the process on those. A
 *      thirty-second blip took the whole server down.
 *
 * Both are fixed here once. `runExclusively` never rejects: it reports and
 * returns, because a scheduler tick failing is normal operational noise and the
 * next tick will try again.
 */
import type { PoolClient } from "pg";
import { pool } from "../db";

/**
 * Runs `fn` only if this process can take the named advisory lock.
 *
 * Returns whether the work ran, which lets a caller distinguish "another
 * replica has it" from "it ran and did nothing".
 */
export async function runExclusively(
  label: string,
  lockKey: number,
  fn: () => Promise<void>,
): Promise<{ ran: boolean }> {
  // Explicitly typed: pool.connect() is overloaded (promise and callback
  // forms), and inferring from it resolves to the callback overload's void.
  let client: PoolClient | undefined;

  try {
    // Inside the try. This is the line whose absence from the try block turned
    // a recoverable connection error into a process exit.
    client = await pool.connect();

    const { rows } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [lockKey],
    );

    if (!rows[0]?.locked) {
      console.log(`[${label}] Another replica holds the lock, skipping this tick`);
      return { ran: false };
    }

    try {
      await fn();
      return { ran: true };
    } finally {
      // Released on the same client that took it — session-scoped advisory
      // locks belong to a connection, not to a transaction.
      await client.query('SELECT pg_advisory_unlock($1)', [lockKey]).catch(() => undefined);
    }
  } catch (err) {
    console.error(`[${label}] tick failed:`, (err as Error)?.message ?? err);
    return { ran: false };
  } finally {
    client?.release();
  }
}

/**
 * Starts a repeating tick that cannot crash the process.
 *
 * The `.catch()` is the point. `setInterval(() => { void tick(); })` discards
 * the promise, so any rejection inside becomes unhandled and Node terminates.
 */
export function startTicker(
  label: string,
  intervalMs: number,
  tick: () => Promise<void>,
): NodeJS.Timeout {
  const safeTick = () => {
    tick().catch((err) => {
      console.error(`[${label}] unhandled tick error:`, (err as Error)?.message ?? err);
    });
  };

  safeTick();
  return setInterval(safeTick, intervalMs);
}
