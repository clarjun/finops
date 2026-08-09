/**
 * Engine behaviour, against a real database.
 *
 * The claims being tested — a run pauses at a gate, survives a restart, resumes
 * without redoing applied work, and cannot be driven by two workers at once —
 * are all claims about persisted state. Mocking the database would only assert
 * that the mock behaves as written.
 *
 * Terraform IS mocked. These tests are about the state machine, not about
 * Terraform, and a real apply would take minutes and create billable
 * infrastructure. The executor's own behaviour is covered separately, and was
 * verified against the real binary.
 *
 *   npm run test:integration
 */
import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';

/* ---- Terraform double ---------------------------------------------------- */

/** State the fake executor reports, so a test can simulate resources existing. */
const tfState = { addresses: [] as string[], planFails: false, applyFails: false };

vi.mock('./terraform/executor', () => ({
  terraformExecutor: {
    createWorkspace: vi.fn(async (runId: number | string) => `/tmp/fake-ws-${runId}`),
    init: vi.fn(async () => ({ ok: true, exitCode: 0, stdout: '', stderr: '', durationMs: 1, aborted: false })),
    validate: vi.fn(async () => ({ ok: true, exitCode: 0, stdout: 'valid', stderr: '', durationMs: 1, aborted: false })),
    fmt: vi.fn(async () => ({ ok: true, exitCode: 0, stdout: '', stderr: '', durationMs: 1, aborted: false })),
    plan: vi.fn(async () => tfState.planFails
      ? { ok: false, exitCode: 1, stdout: '', stderr: 'boom', durationMs: 1, aborted: false, changes: [], toAdd: 0, toChange: 0, toDestroy: 0, destructive: [], diagnostics: [{ severity: 'error', summary: 'planned failure' }] }
      : { ok: true, exitCode: 0, stdout: '', stderr: '', durationMs: 1, aborted: false, changes: [], toAdd: 1, toChange: 0, toDestroy: 0, destructive: [], diagnostics: [] }),
    apply: vi.fn(async () => tfState.applyFails
      ? { ok: false, exitCode: 1, stdout: '', stderr: 'apply exploded', durationMs: 1, aborted: false }
      : { ok: true, exitCode: 0, stdout: 'applied', stderr: '', durationMs: 1, aborted: false }),
    listState: vi.fn(async () => tfState.addresses),
    destroy: vi.fn(async () => ({ ok: true, exitCode: 0, stdout: '', stderr: '', durationMs: 1, aborted: false })),
  },
}));

vi.mock('./tools/credentials', () => ({
  resolveTerraformCredentials: vi.fn(async () => ({ provider: 'aws', env: { AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'y' } })),
  hasUsableCredentials: vi.fn(async () => true),
}));

import { db, pool } from '../db';
import { organizations, infraPlans, infraPlanNodes, infraRuns, infraRunNodes, infraApprovals } from '@shared/schema';
import { runAsSystem } from '../tenant-context';
import { createRun, advance, decideApproval } from './engine';
import { compileArchitecture } from './compiler';
import type { EstimatorLayer } from './types';

const SLUG = 'itest-infra-engine';
let orgId: number;

/** A small plan: one ungated stage, then one gated. */
function architecture() {
  return compileArchitecture(
    [{ layer: 'Frontend', service: 'Amazon S3', storageSize: 10, monthlyCost: 5 }] as EstimatorLayer[],
    { provider: 'aws', region: 'us-east-1', environment: 'development', availability: 'standard', compliance: [] },
    'storage only',
  );
}

async function seedPlan(): Promise<number> {
  const arch = architecture();
  const [plan] = await db.insert(infraPlans).values({
    organizationId: orgId,
    name: 'Engine test plan',
    requirements: 'storage only',
    estimatorOutput: [] as never,
    clarifications: {} as never,
    provider: 'aws',
    cloudAccountId: 1,
    region: 'us-east-1',
    environment: 'development',
    logicalModel: arch as never,
    status: 'compiled',
  }).returning();

  await db.insert(infraPlanNodes).values(arch.nodes.map((n) => ({
    organizationId: orgId,
    planId: Number(plan.id),
    nodeKey: n.key,
    label: n.label,
    logicalType: n.logicalType,
    config: n.config as never,
    dependsOn: n.dependsOn as never,
    riskLevel: n.risk.level,
    riskReasons: n.risk.reasons as never,
    requiresApproval: n.requiresApproval,
  })));

  return Number(plan.id);
}

const nodeStatuses = async (runId: number) => {
  const rows = await db.select().from(infraRunNodes).where(eq(infraRunNodes.runId, runId));
  return new Map(rows.map((r) => [r.nodeKey, r.status]));
};

const runRow = async (runId: number) => {
  const [r] = await db.select().from(infraRuns).where(eq(infraRuns.id, runId));
  return r;
};

/** Drives the run until it finishes or pauses, with a step ceiling. */
async function drive(runId: number, maxSteps = 40) {
  for (let i = 0; i < maxSteps; i++) {
    const r = await advance(runId);
    if (r.done || r.status === 'awaiting_approval') return r;
  }
  throw new Error('run did not settle within the step ceiling');
}

beforeAll(async () => {
  const [org] = await db.insert(organizations)
    .values({ name: 'Engine itest', slug: SLUG, plan: 'standard' })
    .onConflictDoNothing()
    .returning();
  if (org) orgId = org.id;
  else {
    const [existing] = await db.select().from(organizations).where(eq(organizations.slug, SLUG));
    orgId = existing.id;
  }
});

afterAll(async () => {
  // The pool is shared by every integration file in this worker, so the first
  // file to finish would otherwise close it under the others. Ending it is
  // best-effort and idempotent.
  const closePool = async () => { try { await pool.end(); } catch { /* already closed */ } };
  await db.delete(organizations).where(eq(organizations.slug, SLUG));
  await closePool();
});

beforeEach(() => {
  tfState.addresses = [];
  tfState.planFails = false;
  tfState.applyFails = false;
  // The executor mock is module-level, so call history leaks between tests.
  // Without this, "simulate never applies" passes or fails depending on which
  // live-run test happened to run before it.
  vi.clearAllMocks();
});

describe('run creation', () => {
  it('persists one node row per plan node, so resume has something to read', async () => {
    await runAsSystem(orgId, async () => {
      const planId = await seedPlan();
      const runId = await createRun({ planId, executionMode: 'live' });

      const nodes = await nodeStatuses(runId);
      const planNodes = await db.select().from(infraPlanNodes).where(eq(infraPlanNodes.planId, planId));

      expect(nodes.size).toBe(planNodes.length);
      expect([...nodes.values()].every((s) => s === 'pending')).toBe(true);
    });
  });

  it('refuses a plan with no compiled nodes', async () => {
    await runAsSystem(orgId, async () => {
      const [plan] = await db.insert(infraPlans).values({
        organizationId: orgId, name: 'empty', requirements: 'x',
        clarifications: {} as never, status: 'compiled',
      }).returning();

      await expect(createRun({ planId: Number(plan.id) })).rejects.toThrow(/no nodes/);
    });
  });
});

describe('approval gates', () => {
  it('pauses at a gate instead of applying', async () => {
    await runAsSystem(orgId, async () => {
      const runId = await createRun({ planId: await seedPlan(), executionMode: 'live' });
      const result = await drive(runId);

      expect(result.status).toBe('awaiting_approval');
      expect((await runRow(runId)).status).toBe('awaiting_approval');

      const [approval] = await db.select().from(infraApprovals).where(eq(infraApprovals.runId, runId));
      expect(approval.status).toBe('pending');
      // The approver must be shown what will run.
      expect(approval.summary.length).toBeGreaterThan(0);
      expect(approval.riskLevel).not.toBe('low');
    });
  });

  it('stays paused when advanced again — a gate is not a speed bump', async () => {
    await runAsSystem(orgId, async () => {
      const runId = await createRun({ planId: await seedPlan(), executionMode: 'live' });
      await drive(runId);

      for (let i = 0; i < 3; i++) {
        const again = await advance(runId);
        expect(again.status).toBe('awaiting_approval');
      }
      expect((await runRow(runId)).status).toBe('awaiting_approval');
    });
  });

  it('does not create a second approval for the same stage', async () => {
    // A duplicate would let one click approve a step twice, or strand the run
    // behind a gate nobody is looking at.
    await runAsSystem(orgId, async () => {
      const runId = await createRun({ planId: await seedPlan(), executionMode: 'live' });
      await drive(runId);
      await advance(runId);
      await advance(runId);

      const approvals = await db.select().from(infraApprovals).where(eq(infraApprovals.runId, runId));
      const forStage = approvals.filter((a) => a.nodeKey === approvals[0].nodeKey);
      expect(forStage).toHaveLength(1);
    });
  });

  it('resumes after approval and eventually completes', async () => {
    await runAsSystem(orgId, async () => {
      const runId = await createRun({ planId: await seedPlan(), executionMode: 'live' });

      // Work through every gate the plan raises.
      for (let gate = 0; gate < 20; gate++) {
        const r = await drive(runId);
        if (r.done) break;
        const [pending] = await db.select().from(infraApprovals)
          .where(and(eq(infraApprovals.runId, runId), eq(infraApprovals.status, 'pending')));
        if (!pending) break;
        await decideApproval(pending.ref, 'approved');
      }

      expect((await runRow(runId)).status).toBe('succeeded');
    });
  });

  it('stops the deployment when a gate is rejected', async () => {
    await runAsSystem(orgId, async () => {
      const runId = await createRun({ planId: await seedPlan(), executionMode: 'live' });
      await drive(runId);

      const [pending] = await db.select().from(infraApprovals)
        .where(and(eq(infraApprovals.runId, runId), eq(infraApprovals.status, 'pending')));
      await decideApproval(pending.ref, 'rejected', 'not this quarter');

      const result = await drive(runId);
      expect(result.status).toBe('failed');
      expect((await runRow(runId)).error).toMatch(/rejected/i);
    });
  });

  it('refuses to decide the same approval twice', async () => {
    // Otherwise a double-click would re-run a stage.
    await runAsSystem(orgId, async () => {
      const runId = await createRun({ planId: await seedPlan(), executionMode: 'live' });
      await drive(runId);

      const [pending] = await db.select().from(infraApprovals)
        .where(and(eq(infraApprovals.runId, runId), eq(infraApprovals.status, 'pending')));

      await decideApproval(pending.ref, 'approved');
      await expect(decideApproval(pending.ref, 'approved')).rejects.toThrow(/already/i);
    });
  });

  it('records who decided and why', async () => {
    await runAsSystem(orgId, async () => {
      const runId = await createRun({ planId: await seedPlan(), executionMode: 'live' });
      await drive(runId);

      const [pending] = await db.select().from(infraApprovals)
        .where(and(eq(infraApprovals.runId, runId), eq(infraApprovals.status, 'pending')));
      await decideApproval(pending.ref, 'rejected', 'budget freeze');

      const [after] = await db.select().from(infraApprovals).where(eq(infraApprovals.id, pending.id));
      expect(after.status).toBe('rejected');
      expect(after.decisionReason).toBe('budget freeze');
      expect(after.decidedAt).toBeTruthy();
    });
  });
});

describe('idempotent resume', () => {
  it('marks resources that already exist as applied instead of recreating them', async () => {
    // The property that makes a resumed deployment safe. Terraform state is the
    // source of truth for what is real.
    await runAsSystem(orgId, async () => {
      const planId = await seedPlan();
      const runId = await createRun({ planId, executionMode: 'live' });

      // Pretend the bucket already exists from an earlier, interrupted run.
      tfState.addresses = ['aws_s3_bucket.storage_object'];

      await advance(runId);

      const statuses = await nodeStatuses(runId);
      expect(statuses.get('storage.object')).toBe('applied');
    });
  });

  it('does not roll an applied node back to pending on a later pass', async () => {
    await runAsSystem(orgId, async () => {
      const runId = await createRun({ planId: await seedPlan(), executionMode: 'live' });
      tfState.addresses = ['aws_s3_bucket.storage_object'];

      await advance(runId);
      await advance(runId);
      await advance(runId);

      expect((await nodeStatuses(runId)).get('storage.object')).toBe('applied');
    });
  });
});

describe('simulation', () => {
  it('never applies, and says so', async () => {
    const executor = await import('./terraform/executor');

    await runAsSystem(orgId, async () => {
      const runId = await createRun({ planId: await seedPlan(), executionMode: 'simulate' });
      await drive(runId);

      // The whole promise of simulate mode: plan runs, apply does not.
      expect(executor.terraformExecutor.plan).toHaveBeenCalled();
      expect(executor.terraformExecutor.apply).not.toHaveBeenCalled();

      const run = await runRow(runId);
      expect(run.executionMode).toBe('simulate');
      expect(run.status).toBe('succeeded');
    });
  });
});

describe('failure handling', () => {
  it('fails the run and records why when planning fails', async () => {
    await runAsSystem(orgId, async () => {
      const runId = await createRun({ planId: await seedPlan(), executionMode: 'live' });
      tfState.planFails = true;

      const result = await drive(runId);
      expect(result.status).toBe('failed');

      const run = await runRow(runId);
      expect(run.error).toMatch(/planned failure|plan failed/i);
      expect(run.finishedAt).toBeTruthy();
    });
  });

  it('does not advance a run that already finished', async () => {
    await runAsSystem(orgId, async () => {
      const runId = await createRun({ planId: await seedPlan(), executionMode: 'live' });
      tfState.planFails = true;
      await drive(runId);

      const again = await advance(runId);
      expect(again.done).toBe(true);
      expect(again.action).toMatch(/already finished/);
    });
  });
});

describe('leasing', () => {
  it('refuses to advance a run another worker holds', async () => {
    // Two workers driving one deployment would plan and apply the same stage
    // twice. Asserted by holding the lease explicitly rather than by racing
    // three concurrent calls: with Terraform mocked each call finishes in
    // milliseconds, so a race would usually see the lease already released and
    // prove nothing.
    await runAsSystem(orgId, async () => {
      const runId = await createRun({ planId: await seedPlan(), executionMode: 'live' });

      await db.update(infraRuns).set({
        leaseOwner: 'another-worker',
        leaseExpiresAt: new Date(Date.now() + 60_000),
      }).where(eq(infraRuns.id, runId));

      const result = await advance(runId);
      expect(result.action).toMatch(/another worker/);
      // And it did nothing: the run is untouched.
      expect((await runRow(runId)).status).toBe('queued');
    });
  });

  it('takes over a run whose lease has expired', async () => {
    // A worker that dies mid-step must not strand the deployment forever.
    await runAsSystem(orgId, async () => {
      const runId = await createRun({ planId: await seedPlan(), executionMode: 'live' });

      await db.update(infraRuns).set({
        leaseOwner: 'dead-worker',
        leaseExpiresAt: new Date(Date.now() - 60_000),
      }).where(eq(infraRuns.id, runId));

      const result = await advance(runId);
      expect(result.action).not.toMatch(/another worker/);
    });
  });

  it('releases the lease so the next call proceeds', async () => {
    await runAsSystem(orgId, async () => {
      const runId = await createRun({ planId: await seedPlan(), executionMode: 'live' });
      await advance(runId);

      const after = await runRow(runId);
      expect(after.leaseOwner).toBeNull();

      const next = await advance(runId);
      expect(next.action).not.toMatch(/another worker/);
    });
  });
});