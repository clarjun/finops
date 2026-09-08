/**
 * Teardown, against a real database and a fake Terraform.
 *
 * The unit tests cover which addresses get destroyed. These cover the parts
 * that only exist once rows and a state machine are involved — above all, that
 * a teardown run cannot be driven by the deploy engine. Deploy and teardown
 * share infra_runs and its statuses, and the deploy engine applies the plan's
 * configuration; if the wrong engine picks one up, the system recreates exactly
 * what somebody asked it to delete.
 */
import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';

/* ---- Terraform double ---------------------------------------------------- */

const tf = {
  /** What `plan -destroy` reports. */
  destroyChanges: [] as Array<{ address: string; action: string }>,
  /** What `state list` reports after an apply. */
  stateAfter: [] as string[],
  planFails: false,
  applyFails: false,
};

const applyCalls: unknown[] = [];

vi.mock('./terraform/executor', () => ({
  terraformExecutor: {
    createWorkspace: vi.fn(async (runId: number | string) => `/tmp/fake-ws-${runId}`),
    init: vi.fn(async () => ({ ok: true, exitCode: 0, stdout: '', stderr: '', durationMs: 1, aborted: false })),
    validate: vi.fn(async () => ({ ok: true, exitCode: 0, stdout: 'valid', stderr: '', durationMs: 1, aborted: false })),
    plan: vi.fn(async (_dir: string, _creds: unknown, opts: { destroy?: boolean } = {}) => {
      if (tf.planFails) {
        return { ok: false, exitCode: 1, stdout: '', stderr: 'plan exploded', durationMs: 1, aborted: false,
          changes: [], toAdd: 0, toChange: 0, toDestroy: 0, destructive: [], diagnostics: [] };
      }
      const changes = opts.destroy ? tf.destroyChanges : [];
      return { ok: true, exitCode: 0, stdout: '', stderr: '', durationMs: 1, aborted: false,
        changes, toAdd: 0, toChange: 0, toDestroy: changes.length, destructive: [], diagnostics: [] };
    }),
    apply: vi.fn(async (...args: unknown[]) => {
      applyCalls.push(args);
      return tf.applyFails
        ? { ok: false, exitCode: 1, stdout: '', stderr: 'apply exploded', durationMs: 1, aborted: false }
        : { ok: true, exitCode: 0, stdout: 'destroyed', stderr: '', durationMs: 1, aborted: false };
    }),
    listState: vi.fn(async () => tf.stateAfter),
    destroy: vi.fn(async () => ({ ok: true, exitCode: 0, stdout: '', stderr: '', durationMs: 1, aborted: false })),
  },
}));

vi.mock('./tools/credentials', () => ({
  resolveTerraformCredentials: vi.fn(async () => ({ provider: 'aws', env: { AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'y' } })),
  hasUsableCredentials: vi.fn(async () => true),
}));

import { db, pool } from '../db';
import { organizations, users, infraPlans, infraRuns, infraApprovals, infraDeployments } from '@shared/schema';
import { runAsSystem, runWithTenant } from '../tenant-context';
import { advance, decideApproval } from './engine';
import { startTeardown, advanceTeardown, TeardownError } from './teardown';

const SLUG = 'itest-infra-teardown';
let orgId: number;
/**
 * A run is authorized as the person who started it, so tests have to start
 * runs as somebody. Driving the engine from a bare system context would leave
 * no principal to authorize the apply, and every deployment would be correctly
 * refused — which is the behaviour, not a test-harness detail to paper over.
 */
let operatorId: number;

async function seedOperator(username: string): Promise<number> {
  const [existing] = await db.select().from(users).where(eq(users.username, username));
  if (existing) return existing.id;

  const [created] = await db.insert(users).values({
    organizationId: orgId,
    username,
    passwordHash: 'itest-not-a-real-hash',
    role: 'owner',
    isActive: true,
  }).returning();
  return created.id;
}

/** Runs `fn` as the operator, the way an API request would. */
const asOperator = <T>(fn: () => T): T =>
  runWithTenant({ organizationId: orgId, userId: operatorId, username: 'itest-operator', role: 'owner' }, fn);


// Unique per seeded deployment. Sharing one path would make each test's
// teardown collide with the previous test's, via the very in-flight guard one
// of these tests is asserting.
let workspaceSeq = 0;
const nextWorkspace = () => `/tmp/fake-ws-teardown-${++workspaceSeq}`;

async function seedPlan(): Promise<number> {
  const [plan] = await db.insert(infraPlans).values({
    organizationId: orgId,
    name: 'Teardown test plan',
    requirements: 'storage only',
    estimatorOutput: [] as never,
    clarifications: {} as never,
    provider: 'aws',
    cloudAccountId: 1,
    region: 'us-east-1',
    environment: 'development',
    status: 'deployed',
  }).returning();
  return Number(plan.id);
}

/** A completed live deployment: the thing a teardown removes. */
async function seedDeployedRun(overrides: Record<string, unknown> = {}): Promise<{ runId: number; workspace: string }> {
  const planId = await seedPlan();
  const workspace = nextWorkspace();

  const [run] = await db.insert(infraRuns).values({
    organizationId: orgId,
    planId,
    mode: 'apply',
    executionMode: 'live',
    status: 'succeeded',
    workspacePath: workspace,
    resourcesCreated: 2,
    ...overrides,
  }).returning();

  await db.insert(infraDeployments).values({
    organizationId: orgId,
    planId,
    runId: Number(run.id),
    name: 'Teardown test deployment',
    provider: 'aws',
    stateRef: (overrides.workspacePath as string | null | undefined) ?? workspace,
    resourceCount: 2,
    status: 'active',
  });

  return { runId: Number(run.id), workspace };
}

const runRow = async (runId: number) => (await db.select().from(infraRuns).where(eq(infraRuns.id, runId)))[0];

const pendingApproval = async (runId: number) =>
  (await db.select().from(infraApprovals).where(eq(infraApprovals.runId, runId)))[0];

beforeAll(async () => {
  const [org] = await db.insert(organizations)
    .values({ name: 'Teardown itest', slug: SLUG, plan: 'standard' })
    .onConflictDoNothing()
    .returning();
  if (org) orgId = org.id;
  else {
    const [existing] = await db.select().from(organizations).where(eq(organizations.slug, SLUG));
    orgId = existing.id;
  }
  operatorId = await seedOperator('itest-teardown-operator');
});

afterAll(async () => {
  await db.delete(users).where(eq(users.username, 'itest-teardown-operator'));
  await db.delete(organizations).where(eq(organizations.slug, SLUG));
  try { await pool.end(); } catch { /* shared pool, already closed */ }
});

beforeEach(() => {
  tf.destroyChanges = [
    { address: 'aws_s3_bucket.storage_object', action: 'delete' },
    { address: 'aws_vpc.network_vpc', action: 'delete' },
  ];
  tf.stateAfter = [];
  tf.planFails = false;
  tf.applyFails = false;
  applyCalls.length = 0;
  vi.clearAllMocks();
});

/* -------------------------------------------------------------------------- */

describe('starting a teardown', () => {
  it('refuses a simulation, which created nothing', async () => {
    await asOperator(async () => {
      const { runId } = await seedDeployedRun({ executionMode: 'simulate' });
      await expect(startTeardown(runId)).rejects.toThrow(/simulation/i);
    });
  });

  it('refuses a run with no workspace, since its state cannot be read', async () => {
    await asOperator(async () => {
      const { runId } = await seedDeployedRun({ workspacePath: null });
      await expect(startTeardown(runId)).rejects.toThrow(/workspace/i);
    });
  });

  it('refuses to tear down a teardown', async () => {
    await asOperator(async () => {
      const { runId } = await seedDeployedRun({ mode: 'destroy' });
      await expect(startTeardown(runId)).rejects.toThrow(/itself a teardown/i);
    });
  });

  it('refuses a second teardown of the same workspace', async () => {
    await asOperator(async () => {
      const { runId } = await seedDeployedRun();
      await startTeardown(runId);
      // Two destroys against one state file race each other, each reading a set
      // the other is part-way through deleting.
      await expect(startTeardown(runId)).rejects.toThrow(/already in progress/i);
    });
  });

  it('creates a destroy run pointing at the deployment’s own state', async () => {
    await asOperator(async () => {
      const { runId: sourceId, workspace } = await seedDeployedRun();
      const { teardownRunId } = await startTeardown(sourceId);

      const row = await runRow(teardownRunId);
      expect(row.mode).toBe('destroy');
      // Not simulate: there is no useful "pretend to delete".
      expect(row.executionMode).toBe('live');
      expect(row.workspacePath).toBe(workspace);
    });
  });

  it('destroys nothing when it is merely started', async () => {
    await asOperator(async () => {
      await startTeardown((await seedDeployedRun()).runId);
      expect(applyCalls).toHaveLength(0);
    });
  });
});

/* -------------------------------------------------------------------------- */

describe('the deploy engine and a teardown run', () => {
  it('refuses to advance a teardown, instead of applying the configuration', async () => {
    // The single most dangerous confusion in this system. Both kinds of run
    // live in infra_runs with the same statuses, and advance() applies the
    // plan — so being handed a teardown would recreate what was being removed.
    await asOperator(async () => {
      const { teardownRunId } = await startTeardown((await seedDeployedRun()).runId);

      const result = await advance(teardownRunId);

      expect(result.action).toMatch(/teardown/i);
      expect(result.done).toBe(false);
      expect(applyCalls).toHaveLength(0);
    });
  });
});

/* -------------------------------------------------------------------------- */

describe('proposing the destroy', () => {
  it('stops for approval listing every address, and destroys nothing', async () => {
    await asOperator(async () => {
      const { teardownRunId } = await startTeardown((await seedDeployedRun()).runId);

      const result = await advanceTeardown(teardownRunId);

      expect(result.status).toBe('awaiting_approval');
      expect(applyCalls).toHaveLength(0);

      const approval = await pendingApproval(teardownRunId);
      expect(approval.status).toBe('pending');
      expect(approval.riskLevel).toBe('critical');
      expect(approval.riskReasons).toContain('destructive');
      expect(approval.details).toContain('aws_s3_bucket.storage_object');
      expect(approval.details).toContain('aws_vpc.network_vpc');
    });
  });

  it('succeeds without an approval when there is nothing to destroy', async () => {
    // Already removed by hand, or never created. The end state holds, so
    // demanding a signature for a no-op would only teach people to click through.
    await asOperator(async () => {
      tf.destroyChanges = [];
      const { teardownRunId } = await startTeardown((await seedDeployedRun()).runId);

      const result = await advanceTeardown(teardownRunId);

      expect(result.status).toBe('succeeded');
      expect(applyCalls).toHaveLength(0);
      expect(await pendingApproval(teardownRunId)).toBeUndefined();
    });
  });

  it('stays waiting while the approval is undecided', async () => {
    await asOperator(async () => {
      const { teardownRunId } = await startTeardown((await seedDeployedRun()).runId);
      await advanceTeardown(teardownRunId);

      const again = await advanceTeardown(teardownRunId);

      expect(again.status).toBe('awaiting_approval');
      expect(applyCalls).toHaveLength(0);
    });
  });
});

/* -------------------------------------------------------------------------- */

describe('executing the approved destroy', () => {
  it('applies the saved plan once approved', async () => {
    await asOperator(async () => {
      const { teardownRunId } = await startTeardown((await seedDeployedRun()).runId);
      await advanceTeardown(teardownRunId);

      const approval = await pendingApproval(teardownRunId);
      await decideApproval(approval.ref, 'approved', 'no longer needed');

      const result = await advanceTeardown(teardownRunId);

      expect(result.status).toBe('succeeded');
      expect(applyCalls).toHaveLength(1);
    });
  });

  it('marks the deployment destroyed', async () => {
    await asOperator(async () => {
      const { runId: sourceId } = await seedDeployedRun();
      const { teardownRunId } = await startTeardown(sourceId);
      await advanceTeardown(teardownRunId);
      await decideApproval((await pendingApproval(teardownRunId)).ref, 'approved');
      await advanceTeardown(teardownRunId);

      const [deployment] = await db.select().from(infraDeployments)
        .where(eq(infraDeployments.runId, sourceId));
      expect(deployment.status).toBe('destroyed');
    });
  });

  it('destroys nothing when the approval is rejected', async () => {
    await asOperator(async () => {
      const { teardownRunId } = await startTeardown((await seedDeployedRun()).runId);
      await advanceTeardown(teardownRunId);
      await decideApproval((await pendingApproval(teardownRunId)).ref, 'rejected', 'still in use');

      const result = await advanceTeardown(teardownRunId);

      expect(result.status).toBe('cancelled');
      expect(applyCalls).toHaveLength(0);
    });
  });

  it('refuses when a resource appeared after the approval', async () => {
    // The reason the plan is taken twice. Someone approved destroying a bucket
    // and a VPC; by the time they clicked, a database had joined the plan.
    await asOperator(async () => {
      const { teardownRunId } = await startTeardown((await seedDeployedRun()).runId);
      await advanceTeardown(teardownRunId);
      await decideApproval((await pendingApproval(teardownRunId)).ref, 'approved');

      tf.destroyChanges = [...tf.destroyChanges, { address: 'aws_db_instance.prod', action: 'delete' }];

      const result = await advanceTeardown(teardownRunId);

      expect(result.status).toBe('failed');
      expect(result.action).toMatch(/aws_db_instance\.prod/);
      expect(applyCalls).toHaveLength(0);
    });
  });

  it('proceeds when a resource disappeared after the approval', async () => {
    // Narrowing is safe: the teardown does less than was approved.
    await asOperator(async () => {
      const { teardownRunId } = await startTeardown((await seedDeployedRun()).runId);
      await advanceTeardown(teardownRunId);
      await decideApproval((await pendingApproval(teardownRunId)).ref, 'approved');

      tf.destroyChanges = [{ address: 'aws_vpc.network_vpc', action: 'delete' }];

      const result = await advanceTeardown(teardownRunId);

      expect(result.status).toBe('succeeded');
      expect(applyCalls).toHaveLength(1);
    });
  });

  it('fails when state is not empty afterwards, rather than claiming success', async () => {
    // Terraform can exit zero having left a resource behind — a bucket with
    // objects, a database with deletion protection. Reporting success would
    // tell someone their bill had stopped when it had not.
    await asOperator(async () => {
      const { teardownRunId } = await startTeardown((await seedDeployedRun()).runId);
      await advanceTeardown(teardownRunId);
      await decideApproval((await pendingApproval(teardownRunId)).ref, 'approved');

      tf.stateAfter = ['aws_s3_bucket.storage_object'];

      const result = await advanceTeardown(teardownRunId);

      expect(result.status).toBe('failed');
      expect(result.action).toMatch(/still exist/i);
    });
  });

  it('reports a failed destroy instead of marking the deployment gone', async () => {
    await asOperator(async () => {
      const { runId: sourceId } = await seedDeployedRun();
      const { teardownRunId } = await startTeardown(sourceId);
      await advanceTeardown(teardownRunId);
      await decideApproval((await pendingApproval(teardownRunId)).ref, 'approved');

      tf.applyFails = true;
      tf.stateAfter = ['aws_vpc.network_vpc'];

      const result = await advanceTeardown(teardownRunId);

      expect(result.status).toBe('failed');
      const [deployment] = await db.select().from(infraDeployments)
        .where(eq(infraDeployments.runId, sourceId));
      expect(deployment.status).toBe('active');
    });
  });
});
