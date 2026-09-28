/**
 * Raising a deployment as a pull request.
 *
 * The alternative delivery mode to applying directly. The agent still generates
 * the same Terraform from the same approved plan; what changes is where it goes
 * — into the customer's repository as a reviewable diff, applied afterwards by
 * the customer's own pipeline with the customer's own credentials.
 *
 * Three properties this is built around:
 *
 *   Idempotent. The branch name is derived from a hash of the file contents, so
 *   raising the same plan twice returns the SAME pull request instead of a
 *   second one. Two open pull requests for one deployment would be two
 *   competing statements of what that infrastructure should be.
 *
 *   No debris. Everything is validated before the first write, and a failure
 *   after the branch exists deletes it. A half-written branch in a customer's
 *   repository is worse than a clean failure.
 *
 *   Honest about state. A plan with no remote backend can still be raised —
 *   sometimes that is genuinely what a sandbox wants — but the README and the
 *   pull request body both say, prominently, that anything merged will become
 *   untracked infrastructure.
 */
import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../db';
import { infraPlans, infraPullRequests, type InfraPullRequest } from '@shared/schema';
import { currentOrgId, currentUserId, currentUsername } from '../../tenant-context';
import { recordAudit } from '../../audit';
import { generateTerraform } from '../terraform/generator';
import { resolveStateBackend, BackendConfigError } from '../terraform/resolve-backend';
import { awsMapper } from '../providers/aws';
import { loadPlanContext, namePrefixFor } from '../engine';
import { computeStages } from '../staging';
import { requireGitConnection } from './connection';
import { buildDeploymentFiles, buildPullRequestBody } from './files';
import { GitProviderError, type FileChange } from './types';

export interface DeliverResult {
  pullRequest: InfraPullRequest;
  /** True when an existing, unchanged pull request was returned rather than a new one raised. */
  reused: boolean;
}

/** Directory and branch name component. Stable for the life of the plan. */
function slugFor(planId: number, name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'deployment';
  return `${slug}-${planId}`;
}

/**
 * Branch name derived from the content that will be committed.
 *
 * Content-addressed so the operation is idempotent: identical files produce the
 * identical branch, and the unique index on (org, repo, branch) then turns a
 * duplicate raise into a lookup instead of a second pull request. Changed files
 * produce a new branch, which is correct — it is a different proposal.
 */
function branchFor(slug: string, files: FileChange[]): string {
  const digest = createHash('sha256');
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    digest.update(f.path).update('\0').update(f.content).update('\0');
  }
  return `cloudwise/${slug}-${digest.digest('hex').slice(0, 10)}`;
}

export async function deliverAsPullRequest(planId: number): Promise<DeliverResult> {
  const orgId = currentOrgId();

  // ── Gather everything and fail before touching the repository ─────────────

  const { plan, architecture, nodes } = await loadPlanContext(planId, orgId);

  if (!plan.logicalModel) {
    throw new GitProviderError(
      'This plan has not been compiled yet. Compile it first so there is an architecture to generate Terraform from.',
      null,
    );
  }

  const provider = plan.provider ?? 'aws';
  if (provider !== 'aws') {
    // Honest failure. The Azure and GCP mappers do not exist yet, and emitting
    // an empty configuration would produce a pull request that merges cleanly
    // and creates nothing.
    throw new GitProviderError(
      `Pull request delivery supports AWS today; this plan targets ${provider}.`,
      null,
    );
  }

  const region = plan.region ?? 'us-east-1';
  const environment = plan.environment ?? 'dev';
  let backend;
  try {
    backend = await resolveStateBackend(provider, planId, plan.name);
  } catch (err) {
    // Surfaced as a client error, not a 500: the operator configured this and
    // the operator can fix it.
    if (err instanceof BackendConfigError) {
      throw new GitProviderError(`${err.message}
Fix the state backend before raising a pull request.`, null);
    }
    throw err;
  }

  const generated = generateTerraform({
    architecture,
    mapper: awsMapper,
    region,
    namePrefix: namePrefixFor(plan.name, environment),
    backend,
  });

  // Risk comes from the same staging logic the direct-apply path uses, so the
  // pull request and the approval card describe the same deployment.
  const { stages } = computeStages(nodes);
  const riskOrder = ['low', 'medium', 'high', 'critical'];
  const riskLevel = stages.reduce(
    (worst, s) => (riskOrder.indexOf(s.riskLevel) > riskOrder.indexOf(worst) ? s.riskLevel : worst),
    'low',
  );
  const riskReasons = Array.from(new Set(stages.flatMap((s) => s.riskReasons))).slice(0, 12);

  const connection = await requireGitConnection();

  // Proves the token and repository before anything is generated into them.
  const { defaultBranch, canWrite } = await connection.provider.verify();
  if (!canWrite) {
    throw new GitProviderError(
      `The token cannot write to ${connection.provider.describe()}. It needs "Contents: write" and "Pull requests: write".`,
      403,
    );
  }
  const baseBranch = connection.baseBranch ?? defaultBranch;

  const slug = slugFor(planId, plan.name);
  const estimatedMonthlyCost = plan.estimatedMonthlyCost === null ? null : Number(plan.estimatedMonthlyCost);

  const files = buildDeploymentFiles({
    basePath: connection.basePath,
    slug,
    planName: plan.name,
    environment,
    region,
    provider,
    generated,
    estimatedMonthlyCost,
    backendDescription: generated.backendDescription,
    emitPipeline: connection.emitPipeline,
  });

  const headBranch = branchFor(slug, files);

  // ── Idempotency ───────────────────────────────────────────────────────────

  const [existing] = await db
    .select()
    .from(infraPullRequests)
    .where(and(
      eq(infraPullRequests.organizationId, orgId),
      eq(infraPullRequests.repoOwner, connection.provider.repo.owner),
      eq(infraPullRequests.repoName, connection.provider.repo.repo),
      eq(infraPullRequests.headBranch, headBranch),
    ))
    .limit(1);

  if (existing && existing.status === 'open' && existing.url) {
    return { pullRequest: existing, reused: true };
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  const body = buildPullRequestBody({
    basePath: connection.basePath,
    slug,
    planName: plan.name,
    environment,
    region,
    provider,
    generated,
    estimatedMonthlyCost,
    backendDescription: generated.backendDescription,
    emitPipeline: connection.emitPipeline,
    requirements: plan.requirements,
    riskLevel,
    riskReasons,
    raisedBy: currentUsername() ?? null,
  });

  let branchCreated = false;
  try {
    if (await connection.provider.branchExists(headBranch)) {
      // The branch exists but we have no open pull request for it — a previous
      // attempt died between the commit and the pull request. Reuse the branch
      // rather than orphaning it.
      branchCreated = true;
    } else {
      await connection.provider.commit({
        branch: headBranch,
        baseBranch,
        files,
        message:
          `infra(${slug}): ${plan.name}\n\n` +
          `Generated by the CloudWise infrastructure agent.\n` +
          `${generated.resourceCount} resource(s), ${environment}, ${region}.\n` +
          `State: ${generated.backendDescription ?? 'local (not durable)'}`,
      });
      branchCreated = true;
    }

    const opened = await connection.provider.openPullRequest({
      branch: headBranch,
      baseBranch,
      title: `CloudWise: deploy ${plan.name} (${environment})`,
      body,
      // A plan the agent could not fully express must not be merged by someone
      // skimming. A draft has to be deliberately marked ready first.
      draft: (generated.unsupported?.length ?? 0) > 0,
    });

    const [row] = await db
      .insert(infraPullRequests)
      .values({
        organizationId: orgId,
        planId,
        connectionId: connection.connectionId,
        provider: connection.provider.kind,
        repoOwner: connection.provider.repo.owner,
        repoName: connection.provider.repo.repo,
        baseBranch,
        headBranch,
        number: opened.number,
        url: opened.url,
        headSha: opened.headSha,
        status: 'open',
        filePaths: files.map((f) => f.path) as unknown as string[],
        resourceCount: generated.resourceCount,
        estimatedMonthlyCost: estimatedMonthlyCost === null ? null : String(estimatedMonthlyCost),
        stateBackend: generated.backendDescription,
        createdBy: currentUserId() ?? null,
      })
      .onConflictDoUpdate({
        target: [infraPullRequests.organizationId, infraPullRequests.repoOwner, infraPullRequests.repoName, infraPullRequests.headBranch],
        set: {
          number: opened.number,
          url: opened.url,
          headSha: opened.headSha,
          status: 'open',
          error: null,
          updatedAt: new Date(),
        },
      })
      .returning();

    void recordAudit({
      action: 'infra.pull_request.open',
      resourceType: 'infra_plan',
      resourceId: String(planId),
      metadata: {
        repository: connection.provider.describe(),
        pullRequest: opened.url,
        branch: headBranch,
        resourceCount: generated.resourceCount,
        estimatedMonthlyCost,
        stateBackend: generated.backendDescription ?? 'local',
        durableState: Boolean(generated.backendDescription),
        devFallback: connection.isDevFallback,
      },
    });

    return { pullRequest: row, reused: false };
  } catch (err: any) {
    // Leave nothing behind in someone else's repository.
    if (branchCreated) await connection.provider.deleteBranch(headBranch);

    void recordAudit({
      action: 'infra.pull_request.open',
      outcome: 'failure',
      resourceType: 'infra_plan',
      resourceId: String(planId),
      metadata: { repository: connection.provider.describe(), branch: headBranch, error: err?.message ?? String(err) },
    });

    throw err;
  }
}

/** Pull requests raised for a plan, newest first. */
export async function listPullRequests(planId: number): Promise<InfraPullRequest[]> {
  return db
    .select()
    .from(infraPullRequests)
    .where(and(eq(infraPullRequests.organizationId, currentOrgId()), eq(infraPullRequests.planId, planId)))
    .orderBy(desc(infraPullRequests.createdAt));
}

/** Every pull request for the tenant, newest first. */
export async function listAllPullRequests(limit = 50): Promise<InfraPullRequest[]> {
  return db
    .select()
    .from(infraPullRequests)
    .where(eq(infraPullRequests.organizationId, currentOrgId()))
    .orderBy(desc(infraPullRequests.createdAt))
    .limit(Math.min(limit, 200));
}

export { infraPlans };
