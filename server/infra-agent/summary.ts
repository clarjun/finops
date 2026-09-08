/**
 * Deployment summary and blueprints.
 *
 * The summary is assembled from what was recorded during the run, not
 * recomputed. A count derived at read time would drift from what actually
 * happened the moment anything changed — and the summary is the artefact people
 * quote in a change record.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  infraPlans, infraPlanNodes, infraRuns, infraRunNodes, infraApprovals, infraDeployments, infraEvents,
} from '@shared/schema';
import { currentOrgId, currentUserId } from '../tenant-context';
import { recordAudit } from '../audit';
import type { LogicalArchitecture } from './types';

export interface DeploymentSummary {
  runId: number;
  planId: number;
  name: string;
  provider: string;
  region: string | null;
  environment: string | null;
  /** live | simulate — stated everywhere, so a simulation is never read as real. */
  executionMode: string;
  status: string;
  resourcesCreated: number;
  /** Planned but deliberately not applied, because the run was a simulation. */
  resourcesPlanned: number;
  resourcesSkipped: number;
  /** Excluded because the provider mapper cannot build them. */
  resourcesUnsupported: number;
  resourcesFailed: number;
  approvalsRequired: number;
  approvalsGranted: number;
  approvalsRejected: number;
  durationSeconds: number | null;
  estimatedMonthlyCost: number | null;
  eventCount: number;
  resources: string[];
  approvals: Array<{ summary: string; riskLevel: string; status: string; decidedBy: string | null; reason: string | null }>;
  error: string | null;
}

export async function getDeploymentSummary(runId: number): Promise<DeploymentSummary | null> {
  const organizationId = currentOrgId();

  const [run] = await db.select().from(infraRuns)
    .where(and(eq(infraRuns.id, runId), eq(infraRuns.organizationId, organizationId)));
  if (!run) return null;

  const [plan] = await db.select().from(infraPlans)
    .where(and(eq(infraPlans.id, run.planId), eq(infraPlans.organizationId, organizationId)));

  const [nodes, approvals, deployment, eventCount] = await Promise.all([
    db.select().from(infraRunNodes).where(and(
      eq(infraRunNodes.runId, runId), eq(infraRunNodes.organizationId, organizationId))),
    db.select().from(infraApprovals).where(and(
      eq(infraApprovals.runId, runId), eq(infraApprovals.organizationId, organizationId))),
    db.select().from(infraDeployments).where(and(
      eq(infraDeployments.runId, runId), eq(infraDeployments.organizationId, organizationId))).limit(1),
    db.select({ n: sql<number>`count(*)::int` }).from(infraEvents).where(eq(infraEvents.runId, runId)),
  ]);

  const count = (status: string) => nodes.filter((n) => n.status === status).length;

  return {
    runId,
    planId: run.planId,
    name: plan?.name ?? 'Untitled deployment',
    provider: plan?.provider ?? 'aws',
    region: plan?.region ?? null,
    environment: plan?.environment ?? null,
    executionMode: run.executionMode,
    status: run.status,
    resourcesCreated: count('applied'),
    // A simulation applies nothing, so 'applied' is always zero and reporting
    // it as "would create" told the user their plan would build nothing. The
    // planned count is what a simulation actually establishes.
    resourcesPlanned: count('skipped'),
    resourcesSkipped: count('skipped'),
    resourcesUnsupported: count('unsupported'),
    resourcesFailed: count('failed'),
    approvalsRequired: run.approvalsRequired,
    approvalsGranted: approvals.filter((a) => a.status === 'approved').length,
    approvalsRejected: approvals.filter((a) => a.status === 'rejected').length,
    durationSeconds: run.startedAt && run.finishedAt
      ? Math.round((run.finishedAt.getTime() - run.startedAt.getTime()) / 1000)
      : null,
    estimatedMonthlyCost: plan?.estimatedMonthlyCost != null ? Number(plan.estimatedMonthlyCost) : null,
    eventCount: eventCount[0]?.n ?? 0,
    // In a simulation this is empty by construction — the engine records no
    // resources for a run that created none.
    resources: (deployment[0]?.resources as string[]) ?? [],
    approvals: approvals.map((a) => ({
      summary: a.summary,
      riskLevel: a.riskLevel,
      status: a.status,
      decidedBy: a.decidedBy,
      reason: a.decisionReason,
    })),
    error: run.error,
  };
}

/* -------------------------------------------------------------------------- */
/*  Blueprints                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Saves a successful deployment's architecture as a reusable blueprint.
 *
 * Only a live run that succeeded may become a blueprint. A simulation proves the
 * plan is valid, not that it works — and a blueprint is a claim that this
 * arrangement has actually been built.
 */
export async function saveAsTemplate(input: {
  runId: number;
  name: string;
  description?: string;
}): Promise<{ templateId: number }> {
  const organizationId = currentOrgId();

  const [run] = await db.select().from(infraRuns)
    .where(and(eq(infraRuns.id, input.runId), eq(infraRuns.organizationId, organizationId)));
  if (!run) throw new Error('Run not found');
  if (run.status !== 'succeeded') {
    throw new Error(`Only a successful deployment can become a blueprint; this run is ${run.status}.`);
  }
  if (run.executionMode === 'simulate') {
    throw new Error(
      'This was a simulation, so nothing was built. A blueprint asserts that an arrangement has actually been deployed.',
    );
  }

  const [plan] = await db.select().from(infraPlans)
    .where(and(eq(infraPlans.id, run.planId), eq(infraPlans.organizationId, organizationId)));
  if (!plan) throw new Error('Plan not found');

  const [template] = await db.insert(infraPlans).values({
    organizationId,
    name: input.name,
    requirements: plan.requirements,
    estimatorOutput: plan.estimatorOutput,
    clarifications: plan.clarifications,
    provider: plan.provider,
    // Deliberately NOT copied: a blueprint must not carry the account it was
    // first built in, or reusing it would silently deploy into that account.
    cloudAccountId: null,
    region: plan.region,
    environment: plan.environment,
    logicalModel: plan.logicalModel,
    estimatedMonthlyCost: plan.estimatedMonthlyCost,
    status: 'compiled',
    isTemplate: true,
    templateDescription: input.description ?? null,
    templateSourceRunId: input.runId,
    createdByUserId: currentUserId(),
  }).returning();

  await recordAudit({
    action: 'infra.template.created',
    outcome: 'success',
    resourceType: 'infra_plan',
    resourceId: String(template.id),
    metadata: { sourceRunId: input.runId, name: input.name },
  });

  return { templateId: Number(template.id) };
}

export async function listTemplates() {
  return db.select().from(infraPlans)
    .where(and(eq(infraPlans.organizationId, currentOrgId()), eq(infraPlans.isTemplate, true)))
    .orderBy(desc(infraPlans.templateUseCount), desc(infraPlans.id))
    .limit(50);
}

/**
 * Clones a blueprint into a new, runnable plan.
 *
 * The clone starts at `clarifying`, not `compiled`: the target account and
 * environment must be chosen deliberately for each deployment. Carrying them
 * over would make "deploy this blueprint" quietly mean "deploy it where the last
 * one went".
 */
export async function instantiateTemplate(templateId: number, name?: string): Promise<{ planId: number }> {
  const organizationId = currentOrgId();

  const [template] = await db.select().from(infraPlans)
    .where(and(
      eq(infraPlans.id, templateId),
      eq(infraPlans.organizationId, organizationId),
      eq(infraPlans.isTemplate, true),
    ));
  if (!template) throw new Error('Blueprint not found');

  const clarifications = { ...(template.clarifications as Record<string, unknown>) };
  delete clarifications.cloudAccountId;
  delete clarifications.environment;

  const [plan] = await db.insert(infraPlans).values({
    organizationId,
    name: name ?? `${template.name} (from blueprint)`,
    requirements: template.requirements,
    estimatorOutput: template.estimatorOutput,
    clarifications: clarifications as never,
    provider: template.provider,
    region: template.region,
    logicalModel: template.logicalModel,
    estimatedMonthlyCost: template.estimatedMonthlyCost,
    status: 'clarifying',
    createdByUserId: currentUserId(),
  }).returning();

  // Copy the node set so the clone is immediately reviewable; recompiling
  // happens when the new answers are supplied.
  const architecture = template.logicalModel as LogicalArchitecture | null;
  if (architecture?.nodes?.length) {
    await db.insert(infraPlanNodes).values(architecture.nodes.map((n) => ({
      organizationId,
      planId: Number(plan.id),
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
  }

  await db.update(infraPlans)
    .set({ templateUseCount: sql`${infraPlans.templateUseCount} + 1` })
    .where(eq(infraPlans.id, templateId));

  await recordAudit({
    action: 'infra.template.instantiated',
    outcome: 'success',
    resourceType: 'infra_plan',
    resourceId: String(plan.id),
    metadata: { templateId },
  });

  return { planId: Number(plan.id) };
}
