/**
 * Infrastructure Deployment Agent API.
 *
 * The surface the Cost Estimator's "Create your agent" action drives:
 *
 *   POST /api/infra/plans            create an agent from a requirement
 *   POST /api/infra/plans/:id/compile   answer clarifications, compile a topology
 *   POST /api/infra/plans/:id/runs   start a deployment
 *   GET  /api/infra/runs/:id         status, nodes, stages
 *   GET  /api/infra/runs/:id/stream  live events (SSE)
 *   POST /api/infra/approvals/:ref/decide   approve or reject a held stage
 *
 * Advancing a run is a background concern, not a request concern: a deployment
 * outlives any HTTP request, so routes start or nudge a run and return. The
 * worker drives it forward and the event stream reports what happens.
 */
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db';
import {
  infraPlans, infraPlanNodes, infraRuns, infraRunNodes, infraApprovals, infraDeployments, cloudAccounts,
} from '@shared/schema';
import { currentOrgId, currentUserId } from '../tenant-context';
import { compileArchitecture, validateGraph } from './compiler';
import { computeStages } from './staging';
import { buildQuestions, applyInferences } from './clarify';
import { createRun, decideApproval } from './engine';
import { listEvents, subscribe } from './events';
import { scheduleAdvance } from './worker';
import { listSteps, matchSteps, getStepHistory, getProvenance } from './knowledge/step-library';
import { researchSteps } from './knowledge/docs';
import { getDeploymentSummary, saveAsTemplate, listTemplates, instantiateTemplate } from './summary';
import type { Clarifications, EstimatorLayer } from './types';

const dayRe = /^\d{4}-\d{2}-\d{2}$/;

function fail(res: Response, err: unknown, what: string) {
  const status = err instanceof z.ZodError ? 400 : 500;
  console.error(`[InfraAgent] ${what}:`, err instanceof Error ? err.message : err);
  res.status(status).json({
    error: err instanceof z.ZodError ? 'Invalid request' : `Failed to ${what}`,
    details: err instanceof z.ZodError ? err.errors : (err as Error)?.message,
  });
}

export function registerInfraAgentRoutes(app: Express) {

  /* ---- Create an agent from a Cost Estimator requirement ---------------- */

  app.post('/api/infra/plans', async (req, res) => {
    try {
      const body = z.object({
        name: z.string().min(1).max(200),
        requirements: z.string().min(10),
        estimate: z.array(z.object({
          layer: z.string(),
          service: z.string(),
          configuration: z.string().optional(),
          instanceType: z.string().optional(),
          instanceCount: z.number().optional(),
          storageSize: z.number().optional(),
          dataTransfer: z.number().optional(),
          monthlyCost: z.number().optional(),
        })).default([]),
        estimatedMonthlyCost: z.number().optional(),
      }).parse(req.body);

      const [plan] = await db.insert(infraPlans).values({
        organizationId: currentOrgId(),
        name: body.name,
        requirements: body.requirements,
        estimatorOutput: body.estimate as never,
        estimatedMonthlyCost: body.estimatedMonthlyCost != null ? String(body.estimatedMonthlyCost) : null,
        status: 'clarifying',
        createdByUserId: currentUserId(),
      }).returning();

      // Questions come back with the create, so the client never has to ask
      // twice to know what it needs.
      res.json({
        plan: { id: Number(plan.id), name: plan.name, status: plan.status },
        questions: buildQuestions(body.requirements, body.estimate as EstimatorLayer[]),
      });
    } catch (err) { fail(res, err, 'create the deployment plan'); }
  });

  /* ---- Clarifications --------------------------------------------------- */

  app.get('/api/infra/plans/:id/questions', async (req, res) => {
    try {
      const plan = await loadPlan(Number(req.params.id));
      if (!plan) return res.status(404).json({ error: 'Plan not found' });

      res.json({
        questions: buildQuestions(
          plan.requirements,
          (plan.estimatorOutput as EstimatorLayer[]) ?? [],
          (plan.clarifications as Clarifications) ?? {},
        ),
        answered: plan.clarifications,
      });
    } catch (err) { fail(res, err, 'load clarification questions'); }
  });

  /**
   * Compiles the topology. Separate from creation so the plan a human reviews
   * is produced once, deliberately, from answers they have seen.
   */
  app.post('/api/infra/plans/:id/compile', async (req, res) => {
    try {
      const body = z.object({
        provider: z.enum(['aws', 'azure', 'gcp']).optional(),
        cloudAccountId: z.number().int().positive().optional(),
        region: z.string().max(64).optional(),
        environment: z.enum(['development', 'staging', 'production']).optional(),
        availability: z.enum(['standard', 'high', 'multi_az', 'multi_region']).optional(),
        compliance: z.array(z.string()).optional(),
      }).parse(req.body ?? {});

      const planId = Number(req.params.id);
      const plan = await loadPlan(planId);
      if (!plan) return res.status(404).json({ error: 'Plan not found' });

      const clarifications = applyInferences(plan.requirements, {
        ...(plan.clarifications as Clarifications),
        ...body,
      });

      const outstanding = buildQuestions(plan.requirements, [], clarifications).filter((q) => q.required);
      if (outstanding.length > 0) {
        return res.status(400).json({
          error: 'More information is needed before this can be compiled.',
          questions: outstanding,
        });
      }

      const architecture = compileArchitecture(
        (plan.estimatorOutput as EstimatorLayer[]) ?? [],
        clarifications,
        plan.requirements,
      );

      const graph = validateGraph(architecture.nodes);
      if (!graph.valid) {
        return res.status(422).json({ error: 'The compiled topology is not executable.', details: graph.errors });
      }

      const { stages } = computeStages(architecture.nodes);

      // What the agent already knows how to build. Reported, not substituted:
      // the generator stays the single source of the HCL, so the plan a human
      // reviews is the plan the compiler produced.
      const reused = await matchSteps(clarifications.provider ?? 'aws', architecture.nodes);

      // Replace previous nodes: recompiling after changed answers must not leave
      // resources from the earlier topology behind.
      await db.delete(infraPlanNodes).where(and(
        eq(infraPlanNodes.planId, planId),
        eq(infraPlanNodes.organizationId, currentOrgId()),
      ));

      await db.insert(infraPlanNodes).values(architecture.nodes.map((n) => ({
        organizationId: currentOrgId(),
        planId,
        nodeKey: n.key,
        label: n.label,
        logicalType: n.logicalType,
        config: n.config as never,
        dependsOn: n.dependsOn as never,
        riskLevel: n.risk.level,
        riskReasons: n.risk.reasons as never,
        requiresApproval: n.requiresApproval,
        estimatedMonthlyCost: n.estimatedMonthlyCost != null ? String(n.estimatedMonthlyCost) : null,
      })));

      await db.update(infraPlans).set({
        clarifications: clarifications as never,
        provider: clarifications.provider ?? 'aws',
        cloudAccountId: clarifications.cloudAccountId ?? null,
        region: clarifications.region ?? 'us-east-1',
        environment: clarifications.environment ?? 'development',
        logicalModel: architecture as never,
        status: 'compiled',
        updatedAt: new Date(),
      }).where(eq(infraPlans.id, planId));

      res.json({
        planId,
        nodes: architecture.nodes,
        stages,
        warnings: architecture.warnings,
        waves: graph.waves,
        reusedSteps: reused.map((r) => ({
          nodeKey: r.nodeKey, slug: r.step.slug, version: r.step.version,
          usageCount: r.step.usageCount, successRate: r.step.successRate, stale: r.step.stale,
        })),
        summary: {
          total: architecture.nodes.length,
          fromEstimate: architecture.nodes.filter((n) => n.source === 'estimator').length,
          synthesized: architecture.nodes.filter((n) => n.source === 'synthesized').length,
          approvalGates: stages.filter((s) => s.requiresApproval).length,
          knownSteps: reused.length,
        },
      });
    } catch (err) { fail(res, err, 'compile the architecture'); }
  });

  app.get('/api/infra/plans/:id', async (req, res) => {
    try {
      const plan = await loadPlan(Number(req.params.id));
      if (!plan) return res.status(404).json({ error: 'Plan not found' });

      const nodes = await db.select().from(infraPlanNodes)
        .where(and(eq(infraPlanNodes.planId, plan.id), eq(infraPlanNodes.organizationId, currentOrgId())));

      const runs = await db.select().from(infraRuns)
        .where(and(eq(infraRuns.planId, plan.id), eq(infraRuns.organizationId, currentOrgId())))
        .orderBy(desc(infraRuns.id));

      res.json({ plan, nodes, runs });
    } catch (err) { fail(res, err, 'load the plan'); }
  });

  app.get('/api/infra/plans', async (_req, res) => {
    try {
      const plans = await db.select().from(infraPlans)
        .where(eq(infraPlans.organizationId, currentOrgId()))
        .orderBy(desc(infraPlans.id))
        .limit(50);
      res.json({ plans });
    } catch (err) { fail(res, err, 'list plans'); }
  });

  /* ---- Runs -------------------------------------------------------------- */

  app.post('/api/infra/plans/:id/runs', async (req, res) => {
    try {
      const body = z.object({
        // Defaults to simulate. Starting a real deployment must be an explicit
        // choice, never what happens because a field was omitted.
        executionMode: z.enum(['live', 'simulate']).default('simulate'),
      }).parse(req.body ?? {});

      const planId = Number(req.params.id);
      const plan = await loadPlan(planId);
      if (!plan) return res.status(404).json({ error: 'Plan not found' });
      if (plan.status === 'draft' || plan.status === 'clarifying') {
        return res.status(409).json({ error: 'Compile the plan before running it.' });
      }
      if (body.executionMode === 'live' && !plan.cloudAccountId) {
        return res.status(400).json({ error: 'A live deployment needs a connected cloud account.' });
      }

      const runId = await createRun({ planId, mode: 'apply', executionMode: body.executionMode });
      scheduleAdvance(runId, currentOrgId());

      res.json({ runId, executionMode: body.executionMode, streamUrl: `/api/infra/runs/${runId}/stream` });
    } catch (err) { fail(res, err, 'start the deployment run'); }
  });

  app.get('/api/infra/runs/:id', async (req, res) => {
    try {
      const runId = Number(req.params.id);
      const [run] = await db.select().from(infraRuns)
        .where(and(eq(infraRuns.id, runId), eq(infraRuns.organizationId, currentOrgId())));
      if (!run) return res.status(404).json({ error: 'Run not found' });

      const [nodes, approvals, planNodes, plans] = await Promise.all([
        db.select().from(infraRunNodes).where(and(
          eq(infraRunNodes.runId, runId), eq(infraRunNodes.organizationId, currentOrgId()))),
        db.select().from(infraApprovals).where(and(
          eq(infraApprovals.runId, runId), eq(infraApprovals.organizationId, currentOrgId()))),
        db.select().from(infraPlanNodes).where(and(
          eq(infraPlanNodes.planId, run.planId), eq(infraPlanNodes.organizationId, currentOrgId()))),
        // Provider and region live on the plan, not the run. Without them the
        // console can only label a reloaded deployment from answers still held
        // in browser state, which a refresh throws away.
        db.select({ name: infraPlans.name, provider: infraPlans.provider, region: infraPlans.region })
          .from(infraPlans)
          .where(and(eq(infraPlans.id, run.planId), eq(infraPlans.organizationId, currentOrgId()))),
      ]);

      res.json({ run, nodes, approvals, planNodes, plan: plans[0] ?? null });
    } catch (err) { fail(res, err, 'load the run'); }
  });

  /** Nudges a stalled run. The worker normally does this. */
  app.post('/api/infra/runs/:id/advance', async (req, res) => {
    try {
      const runId = Number(req.params.id);
      const [run] = await db.select().from(infraRuns)
        .where(and(eq(infraRuns.id, runId), eq(infraRuns.organizationId, currentOrgId())));
      if (!run) return res.status(404).json({ error: 'Run not found' });

      scheduleAdvance(runId, currentOrgId());
      res.json({ runId, scheduled: true });
    } catch (err) { fail(res, err, 'advance the run'); }
  });

  /* ---- Live events (SSE) ------------------------------------------------- */

  app.get('/api/infra/runs/:id/stream', async (req, res) => {
    const runId = Number(req.params.id);
    const organizationId = currentOrgId();

    const [run] = await db.select().from(infraRuns)
      .where(and(eq(infraRuns.id, runId), eq(infraRuns.organizationId, organizationId)));
    if (!run) return res.status(404).json({ error: 'Run not found' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (event: unknown) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // Replay from the client's cursor. A browser that reconnects after a drop
    // resumes exactly, rather than losing what happened while it was away —
    // during a ten-minute deployment, the part it most wanted to see.
    const after = Number(req.query.after ?? req.headers['last-event-id'] ?? 0);
    let lastSequence = Number.isFinite(after) ? after : 0;

    for (const event of await listEvents(runId, lastSequence)) {
      send(event);
      lastSequence = event.sequence;
    }

    const unsubscribe = subscribe(runId, (event) => {
      if (event.sequence <= lastSequence) return;   // already replayed
      lastSequence = event.sequence;
      send(event);
    });

    // Proxies close an idle connection; a comment keeps it open without
    // polluting the event stream.
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  });

  /* ---- Approvals --------------------------------------------------------- */

  app.get('/api/infra/approvals', async (req, res) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : 'pending';
      const rows = await db.select().from(infraApprovals)
        .where(and(
          eq(infraApprovals.organizationId, currentOrgId()),
          eq(infraApprovals.status, status),
        ))
        .orderBy(desc(infraApprovals.id))
        .limit(100);
      res.json({ approvals: rows });
    } catch (err) { fail(res, err, 'list approvals'); }
  });

  app.post('/api/infra/approvals/:ref/decide', async (req, res) => {
    try {
      const body = z.object({
        decision: z.enum(['approved', 'rejected']),
        reason: z.string().max(1000).optional(),
      }).parse(req.body);

      const result = await decideApproval(req.params.ref, body.decision, body.reason);

      // Approving resumes the deployment; rejecting stops it, and the engine
      // records why on its next pass.
      scheduleAdvance(result.runId, currentOrgId());

      res.json(result);
    } catch (err) { fail(res, err, 'record the approval decision'); }
  });

  /* ---- Deployment summary and blueprints --------------------------------- */

  app.get('/api/infra/runs/:id/summary', async (req, res) => {
    try {
      const summary = await getDeploymentSummary(Number(req.params.id));
      if (!summary) return res.status(404).json({ error: 'Run not found' });
      res.json(summary);
    } catch (err) { fail(res, err, 'load the deployment summary'); }
  });

  app.post('/api/infra/runs/:id/save-as-template', async (req, res) => {
    try {
      const body = z.object({
        name: z.string().min(1).max(200),
        description: z.string().max(1000).optional(),
      }).parse(req.body);

      res.json(await saveAsTemplate({ runId: Number(req.params.id), ...body }));
    } catch (err) { fail(res, err, 'save this deployment as a blueprint'); }
  });

  app.get('/api/infra/templates', async (_req, res) => {
    try {
      res.json({ templates: await listTemplates() });
    } catch (err) { fail(res, err, 'list blueprints'); }
  });

  app.post('/api/infra/templates/:id/instantiate', async (req, res) => {
    try {
      const body = z.object({ name: z.string().max(200).optional() }).parse(req.body ?? {});
      res.json(await instantiateTemplate(Number(req.params.id), body.name));
    } catch (err) { fail(res, err, 'create a plan from the blueprint'); }
  });

  /* ---- Standard Step Library --------------------------------------------- */

  app.get('/api/infra/steps', async (req, res) => {
    try {
      const provider = typeof req.query.provider === 'string' ? req.query.provider : undefined;
      res.json({ steps: await listSteps(provider) });
    } catch (err) { fail(res, err, 'list standard steps'); }
  });

  /** Every version of a step, plus where its knowledge came from. */
  app.get('/api/infra/steps/:slug', async (req, res) => {
    try {
      const versions = await getStepHistory(req.params.slug);
      if (versions.length === 0) return res.status(404).json({ error: 'Step not found' });
      res.json({ versions, provenance: await getProvenance(Number(versions[0].id)) });
    } catch (err) { fail(res, err, 'load the step'); }
  });

  /**
   * Finds provider documentation for steps that have none.
   *
   * Reports what it could not retrieve rather than leaving those steps looking
   * researched — the library distinguishes a cited step from an uncited one, and
   * that distinction is only worth anything if this endpoint is honest about it.
   */
  app.post('/api/infra/steps/research', async (_req, res) => {
    try {
      res.json(await researchSteps({}));
    } catch (err) { fail(res, err, 'research documentation'); }
  });

  /* ---- Deployments and accounts ------------------------------------------ */

  app.get('/api/infra/deployments', async (_req, res) => {
    try {
      const rows = await db.select().from(infraDeployments)
        .where(eq(infraDeployments.organizationId, currentOrgId()))
        .orderBy(desc(infraDeployments.id))
        .limit(50);
      res.json({ deployments: rows });
    } catch (err) { fail(res, err, 'list deployments'); }
  });

  /** Accounts available to deploy into. Never returns credentials. */
  app.get('/api/infra/accounts', async (_req, res) => {
    try {
      const rows = await db.select({
        id: cloudAccounts.id,
        provider: cloudAccounts.provider,
        accountName: cloudAccounts.accountName,
        accountId: cloudAccounts.accountId,
        isActive: cloudAccounts.isActive,
      }).from(cloudAccounts)
        .where(and(eq(cloudAccounts.organizationId, currentOrgId()), eq(cloudAccounts.isActive, true)));
      res.json({ accounts: rows });
    } catch (err) { fail(res, err, 'list cloud accounts'); }
  });
}

async function loadPlan(id: number) {
  const [plan] = await db.select().from(infraPlans)
    .where(and(eq(infraPlans.id, id), eq(infraPlans.organizationId, currentOrgId())));
  return plan ?? null;
}
