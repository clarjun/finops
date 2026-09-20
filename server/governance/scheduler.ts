/**
 * Periodic governance evaluation.
 *
 * Same shape as the ingestion and report schedulers: one advisory lock so a
 * single replica runs a tick, and an explicit loop over organizations because a
 * background job has no ambient tenant.
 *
 * Governance that only runs when somebody opens the page is not a control — the
 * finding that matters is the one raised on a Sunday, before anybody looked.
 * The default interval is deliberately slower than ingestion: evaluating more
 * often than the underlying cost data refreshes produces identical results at
 * real database cost.
 */
import { runExclusively, startTicker } from "../utils/advisory-lock";
import { storage } from "../storage";
import { runAsSystem } from "../tenant-context";
import { evaluateGovernance } from "./engine";

/** Distinct from every other scheduler's key so the jobs never block each other. */
const GOVERNANCE_JOB_LOCK_KEY = 4711005;

export interface SweepResult {
  organizations: number;
  violationsOpened: number;
  violationsResolved: number;
  failures: string[];
}

export async function evaluateAllTenants(): Promise<SweepResult> {
  const orgs = await storage.listActiveOrganizations();
  let violationsOpened = 0;
  let violationsResolved = 0;
  const failures: string[] = [];

  for (const org of orgs) {
    try {
      // One tenant's failure must not stop the rest of the sweep. evaluate()
      // already records its own failed run row, so the failure is visible in
      // that tenant's history rather than only in this log line.
      const summary = await runAsSystem(org.id, () => evaluateGovernance({ trigger: 'scheduled' }));
      violationsOpened += summary.violationsOpened;
      violationsResolved += summary.violationsResolved;
      if (summary.status === 'failed') failures.push(`org ${org.id}: ${summary.error}`);
    } catch (err: any) {
      failures.push(`org ${org.id}: ${err?.message ?? err}`);
    }
  }

  return { organizations: orgs.length, violationsOpened, violationsResolved, failures };
}

export function startGovernanceScheduler(intervalHours = 6): NodeJS.Timeout {
  console.log(`[Governance Scheduler] Starting (every ${intervalHours}h)`);

  return startTicker('Governance Scheduler', intervalHours * 60 * 60 * 1000, async () => {
    await runExclusively('Governance Scheduler', GOVERNANCE_JOB_LOCK_KEY, async () => {
      const result = await evaluateAllTenants();
      console.log(
        `[Governance Scheduler] ${result.organizations} org(s): ` +
        `${result.violationsOpened} opened, ${result.violationsResolved} resolved`
      );
      if (result.failures.length > 0) {
        console.error('[Governance Scheduler] Failures:', result.failures);
      }
    });
  });
}
