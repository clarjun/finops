/**
 * The Standard Step Library.
 *
 * When a deployment succeeds, the agent knows something it did not know before:
 * that this particular way of building a resource, on this provider, actually
 * worked. Discarding that means every future deployment re-derives it, and the
 * agent never gets better at its job.
 *
 * A step is stored knowledge, not a cached answer. Three properties make the
 * difference, and all three are why this is a structured table rather than an
 * embedding:
 *
 *   provenance   where the knowledge came from, so it can be re-checked
 *   versioning   a new version when the implementation changes, with the old
 *                one kept, so a past deployment can still be explained
 *   evidence     how often it was used and how often it worked, so a step that
 *                keeps failing stops being recommended
 *
 * None of that is expressible as a vector. "Find me something similar" is not
 * the question being asked; "is this still the right way to do it" is.
 */
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '../../db';
import { standardSteps, docSources, infraPlanNodes, infraRunNodes, infraRuns, infraPlans } from '@shared/schema';
import { currentOrgId } from '../../tenant-context';
import { appendEvent } from '../events';
import { generateTerraform } from '../terraform/generator';
import { awsMapper } from '../providers/aws';
import type { LamNode, LogicalArchitecture, LogicalType } from '../types';

/**
 * How long a validated step is trusted before it should be re-checked against
 * current provider documentation. Cloud providers deprecate and re-recommend;
 * ninety days is long enough to be useful and short enough that a step cannot
 * quietly rot for a year.
 */
const FRESHNESS_DAYS = 90;

export interface StepCandidate {
  slug: string;
  name: string;
  provider: string;
  service: string;
  logicalType: LogicalType;
  resourceType: string | null;
  description: string;
  /** The HCL this step contributes, as generated for the node that worked. */
  implementation: string;
  inputs: Record<string, unknown>;
  dependencies: string[];
  approvalLevel: string;
}

/** Stable identity for a step: what it builds, on which cloud, at what type. */
export function stepSlug(provider: string, logicalType: string, resourceType?: string | null): string {
  return [provider, logicalType.toLowerCase(), resourceType ?? 'default']
    .join('-')
    .replace(/[^a-z0-9-]/gi, '-')
    .toLowerCase();
}

/* -------------------------------------------------------------------------- */
/*  Extraction — learning from a successful deployment                         */
/* -------------------------------------------------------------------------- */

/**
 * Records what worked, after a run succeeds.
 *
 * Only nodes that actually reached `applied` are learned from. A node that was
 * skipped, or that a simulation merely planned, proves nothing — recording it
 * would fill the library with implementations never executed against a cloud,
 * which is worse than an empty library because it looks like evidence.
 */
export async function extractStepsFromRun(runId: number): Promise<{ learned: number; updated: number }> {
  const organizationId = currentOrgId();

  const [run] = await db.select().from(infraRuns)
    .where(and(eq(infraRuns.id, runId), eq(infraRuns.organizationId, organizationId)));
  if (!run) return { learned: 0, updated: 0 };

  // A simulation created nothing, so it validates nothing.
  if (run.executionMode === 'simulate') return { learned: 0, updated: 0 };

  const [plan] = await db.select().from(infraPlans)
    .where(and(eq(infraPlans.id, run.planId), eq(infraPlans.organizationId, organizationId)));
  if (!plan) return { learned: 0, updated: 0 };

  const appliedKeys = (await db.select().from(infraRunNodes)
    .where(and(
      eq(infraRunNodes.runId, runId),
      eq(infraRunNodes.organizationId, organizationId),
      eq(infraRunNodes.status, 'applied'),
    ))).map((r) => r.nodeKey);

  if (appliedKeys.length === 0) return { learned: 0, updated: 0 };

  const architecture = plan.logicalModel as LogicalArchitecture | null;
  if (!architecture?.nodes) return { learned: 0, updated: 0 };

  // Regenerate the configuration so each step stores the HCL that actually ran.
  const generated = generateTerraform({
    architecture,
    mapper: awsMapper,
    region: plan.region ?? 'us-east-1',
    namePrefix: 'step',
  });

  let learned = 0;
  let updated = 0;

  for (const node of architecture.nodes) {
    if (!appliedKeys.includes(node.key)) continue;

    const address = generated.addressByNode[node.key];
    if (!address) continue;

    const result = await upsertStep({
      slug: stepSlug(plan.provider ?? 'aws', node.logicalType, address.split('.')[0]),
      name: `${(plan.provider ?? 'aws').toUpperCase()} ${node.logicalType.replace(/_/g, ' ').toLowerCase()}`,
      provider: plan.provider ?? 'aws',
      service: address.split('.')[0],
      logicalType: node.logicalType,
      resourceType: address.split('.')[0],
      description: `Builds ${node.logicalType} as ${address.split('.')[0]}, proven by a successful deployment.`,
      implementation: extractFragment(generated.mainTf, address),
      inputs: node.config,
      dependencies: node.dependsOn,
      approvalLevel: node.risk.level,
    });

    if (result === 'created') learned++;
    else updated++;
  }

  if (learned + updated > 0) {
    await appendEvent({
      runId,
      eventType: 'KNOWLEDGE_SAVED',
      message: `Learned from this deployment: ${learned} new step(s), ${updated} confirmed.`,
      data: { learned, updated },
    });
  }

  return { learned, updated };
}

/**
 * Inserts a step, or records another success against the existing one.
 *
 * A changed implementation creates a NEW VERSION rather than overwriting.
 * Overwriting would make a past deployment unexplainable: its plan references a
 * step whose content has since silently changed.
 */
async function upsertStep(candidate: StepCandidate): Promise<'created' | 'confirmed' | 'versioned'> {
  const [existing] = await db.select().from(standardSteps)
    .where(and(
      eq(standardSteps.slug, candidate.slug),
      // Platform-wide steps only; a tenant-private step is a separate lineage.
      isNull(standardSteps.organizationId),
    ))
    .orderBy(desc(standardSteps.version))
    .limit(1);

  if (!existing) {
    await db.insert(standardSteps).values({
      organizationId: null,
      slug: candidate.slug,
      name: candidate.name,
      provider: candidate.provider,
      service: candidate.service,
      logicalType: candidate.logicalType,
      resourceType: candidate.resourceType,
      description: candidate.description,
      inputs: candidate.inputs as never,
      dependencies: candidate.dependencies as never,
      implementation: candidate.implementation,
      approvalLevel: candidate.approvalLevel,
      version: 1,
      // Validated on first sight because it only gets here after a real apply.
      validationStatus: 'validated',
      usageCount: 1,
      successCount: 1,
      lastValidatedAt: new Date(),
    });
    return 'created';
  }

  const changed = normalise(existing.implementation) !== normalise(candidate.implementation);

  if (changed) {
    await db.insert(standardSteps).values({
      organizationId: null,
      slug: candidate.slug,
      name: candidate.name,
      provider: candidate.provider,
      service: candidate.service,
      logicalType: candidate.logicalType,
      resourceType: candidate.resourceType,
      description: candidate.description,
      inputs: candidate.inputs as never,
      dependencies: candidate.dependencies as never,
      implementation: candidate.implementation,
      approvalLevel: candidate.approvalLevel,
      version: existing.version + 1,
      validationStatus: 'validated',
      usageCount: 1,
      successCount: 1,
      lastValidatedAt: new Date(),
    });
    return 'versioned';
  }

  await db.update(standardSteps).set({
    usageCount: sql`${standardSteps.usageCount} + 1`,
    successCount: sql`${standardSteps.successCount} + 1`,
    validationStatus: 'validated',
    lastValidatedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(standardSteps.id, existing.id));

  return 'confirmed';
}

/** Whitespace-insensitive comparison, so formatting alone never forks a version. */
function normalise(hcl: string | null): string {
  return (hcl ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * The HCL block for one resource address.
 *
 * Brace-counting rather than a regex: nested blocks (tags, ingress,
 * versioning_configuration) mean a non-greedy match to the first closing brace
 * truncates the resource mid-definition, and a greedy one swallows the rest of
 * the file.
 */
export function extractFragment(hcl: string, address: string): string {
  const [type, name] = address.split('.');
  const header = `resource "${type}" "${name}" {`;
  const start = hcl.indexOf(header);
  if (start === -1) return '';

  let depth = 0;
  for (let i = start; i < hcl.length; i++) {
    if (hcl[i] === '{') depth++;
    else if (hcl[i] === '}') {
      depth--;
      if (depth === 0) return hcl.slice(start, i + 1);
    }
  }
  return hcl.slice(start);
}

/* -------------------------------------------------------------------------- */
/*  Retrieval — reusing what was learned                                       */
/* -------------------------------------------------------------------------- */

export interface LibraryStep {
  id: number;
  slug: string;
  name: string;
  provider: string;
  logicalType: string;
  resourceType: string | null;
  version: number;
  validationStatus: string;
  usageCount: number;
  successCount: number;
  successRate: number;
  lastValidatedAt: Date | null;
  stale: boolean;
  implementation: string | null;
}

function decorate(row: typeof standardSteps.$inferSelect): LibraryStep {
  const ageMs = row.lastValidatedAt ? Date.now() - row.lastValidatedAt.getTime() : Infinity;
  return {
    id: Number(row.id),
    slug: row.slug,
    name: row.name,
    provider: row.provider,
    logicalType: row.logicalType,
    resourceType: row.resourceType,
    version: row.version,
    validationStatus: row.validationStatus,
    usageCount: row.usageCount,
    successCount: row.successCount,
    successRate: row.usageCount > 0 ? row.successCount / row.usageCount : 0,
    lastValidatedAt: row.lastValidatedAt,
    // Not an error, a prompt to re-check. A step older than the freshness
    // window may still be right; it just has not been confirmed lately.
    stale: ageMs > FRESHNESS_DAYS * 24 * 3600_000,
    implementation: row.implementation,
  };
}

/** Latest version of every step this tenant may use. */
export async function listSteps(provider?: string): Promise<LibraryStep[]> {
  const organizationId = currentOrgId();

  const rows = await db.select().from(standardSteps)
    .where(and(
      or(isNull(standardSteps.organizationId), eq(standardSteps.organizationId, organizationId)),
      provider ? eq(standardSteps.provider, provider) : undefined,
    ))
    .orderBy(desc(standardSteps.version));

  // Keep only the newest version per slug. Older ones are retained in the table
  // for auditability but are not offered for reuse.
  const newest = new Map<string, typeof rows[number]>();
  for (const row of rows) {
    if (!newest.has(row.slug)) newest.set(row.slug, row);
  }

  return [...newest.values()].map(decorate).sort((a, b) => b.usageCount - a.usageCount);
}

/**
 * Steps applicable to a compiled architecture.
 *
 * Deliberately reports matches rather than substituting implementations. A step
 * that succeeded once is evidence, not proof, and quietly swapping generated
 * configuration for stored configuration would mean the plan a human reviews is
 * not the plan the compiler produced. Reuse is shown, and the generator stays
 * the single source of the HCL.
 */
export async function matchSteps(
  provider: string,
  nodes: LamNode[],
): Promise<Array<{ nodeKey: string; step: LibraryStep }>> {
  const available = await listSteps(provider);
  const byType = new Map<string, LibraryStep>();
  for (const step of available) {
    // Prefer the most-proven step for a logical type.
    const current = byType.get(step.logicalType);
    if (!current || step.successRate > current.successRate) byType.set(step.logicalType, step);
  }

  const matches: Array<{ nodeKey: string; step: LibraryStep }> = [];
  for (const node of nodes) {
    const step = byType.get(node.logicalType);
    if (step && step.validationStatus === 'validated') {
      matches.push({ nodeKey: node.key, step });
    }
  }
  return matches;
}

/** Records that a step was used and whether it worked, so evidence stays honest. */
export async function recordStepOutcome(stepId: number, succeeded: boolean): Promise<void> {
  await db.update(standardSteps).set({
    usageCount: sql`${standardSteps.usageCount} + 1`,
    successCount: succeeded ? sql`${standardSteps.successCount} + 1` : standardSteps.successCount,
    // A step that fails is marked for re-checking rather than deleted: the
    // failure may be environmental, and losing the knowledge would mean
    // rediscovering it.
    validationStatus: succeeded ? 'validated' : 'stale',
    updatedAt: new Date(),
  }).where(eq(standardSteps.id, stepId));
}

/* -------------------------------------------------------------------------- */
/*  Provenance                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Attaches a documentation source to a step.
 *
 * A step with no source cannot be trusted and must not be presented as
 * validated knowledge — that is the whole point of recording where it came from.
 */
export async function recordProvenance(input: {
  standardStepId: number;
  provider: string;
  service?: string;
  title?: string;
  url: string;
  docVersion?: string;
  excerpt?: string;
  runId?: number;
}): Promise<void> {
  await db.insert(docSources).values({
    standardStepId: input.standardStepId,
    provider: input.provider,
    service: input.service ?? null,
    title: input.title ?? null,
    url: input.url,
    docVersion: input.docVersion ?? null,
    excerpt: input.excerpt ?? null,
    runId: input.runId ?? null,
    retrievedAt: new Date(),
  });
}

export async function getProvenance(standardStepId: number) {
  return db.select().from(docSources)
    .where(eq(docSources.standardStepId, standardStepId))
    .orderBy(desc(docSources.retrievedAt));
}

/** Every version of a step, newest first — the audit trail for §21. */
export async function getStepHistory(slug: string) {
  return db.select().from(standardSteps)
    .where(eq(standardSteps.slug, slug))
    .orderBy(desc(standardSteps.version));
}
