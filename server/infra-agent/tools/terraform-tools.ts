/**
 * Terraform tools, registered into the infrastructure tool registry.
 *
 * Risk classes here describe the ACTION, not the chance of failure, because the
 * approval gate keys off them:
 *
 *   init / validate / plan / state   read-only or local — low risk, no gate
 *   apply                            creates real infrastructure — critical
 *   destroy                          removes real infrastructure — critical
 *
 * plan is deliberately NOT gated. Gating it would mean a human approving before
 * seeing what would happen, which inverts the point of the plan/apply split.
 * apply is gated, and it applies only the plan file that was shown.
 */
import { z } from 'zod';
import { infraToolRegistry } from './registry';
import { terraformExecutor } from '../terraform/executor';
import { resolveTerraformCredentials } from './credentials';

const workspaceArgs = z.object({
  workspacePath: z.string().min(1),
});

const credentialledArgs = workspaceArgs.extend({
  /**
   * Which stored account to act as. An identifier, never a credential — the
   * model can name an account but cannot supply keys.
   */
  cloudAccountId: z.number().int().positive(),
});

const planArgs = credentialledArgs.extend({
  /**
   * Resource addresses to narrow the plan to. The engine stages a deployment
   * around approval gates with these; without them a plan containing one
   * high-risk resource could only be approved or refused whole.
   */
  targets: z.array(z.string().min(1)).optional(),
  /** Plan the removal of everything in state, rather than its creation. */
  destroy: z.boolean().optional(),
});

/**
 * Registers the Terraform tools, once.
 *
 * Idempotent so the execution path can guarantee the registry is populated
 * without depending on server start-up order. That dependency is precisely why
 * this layer went unused: nothing on the path could safely assume registration
 * had happened, so nothing on the path used it.
 */
export function registerTerraformTools(): void {
  if (infraToolRegistry.has('terraform_apply')) return;

  infraToolRegistry.register({
    name: 'terraform_init',
    description: 'Initialise a Terraform workspace and download providers. Local only; creates no cloud resources.',
    input: workspaceArgs,
    risk: 'low',
    requiredPermission: 'account:read',
    idempotent: true,
    maxRetries: 2,
    timeoutMs: 15 * 60_000,
    handler: async (args, ctx) => {
      ctx.emit?.({ message: 'Initialising Terraform workspace…' });
      const r = await terraformExecutor.init(args.workspacePath, undefined, {
        signal: ctx.signal,
        onOutput: (chunk) => ctx.emit?.({ message: chunk.trim() }),
      });
      if (!r.ok) throw new Error(`terraform init failed: ${r.stderr.slice(-600)}`);
      return { durationMs: r.durationMs };
    },
  });

  infraToolRegistry.register({
    name: 'terraform_validate',
    description: 'Check that the generated configuration is syntactically and semantically valid. Contacts no cloud.',
    input: workspaceArgs,
    risk: 'low',
    requiredPermission: 'account:read',
    idempotent: true,
    maxRetries: 1,
    timeoutMs: 2 * 60_000,
    handler: async (args, ctx) => {
      const r = await terraformExecutor.validate(args.workspacePath, { signal: ctx.signal });
      if (!r.ok) throw new Error(`terraform validate failed: ${r.stderr.slice(-600)}`);
      return { valid: true };
    },
  });

  infraToolRegistry.register({
    name: 'terraform_plan',
    description:
      'Produce an execution plan and save it. Reads cloud state but changes nothing. Returns the resources that would be created, changed or destroyed.',
    input: planArgs,
    risk: 'medium',
    requiredPermission: 'account:read',
    idempotent: true,
    maxRetries: 1,
    timeoutMs: 15 * 60_000,
    handler: async (args, ctx) => {
      ctx.emit?.({ message: 'Planning changes against the live account…' });
      const creds = await resolveTerraformCredentials(args.cloudAccountId);
      const r = await terraformExecutor.plan(args.workspacePath, creds, {
        signal: ctx.signal,
        targets: args.targets,
        destroy: args.destroy,
        onOutput: (chunk) => ctx.emit?.({ message: chunk.trim() }),
      });

      if (!r.ok) {
        const diag = r.diagnostics.map((d) => d.summary).join('; ');
        // Carries the provider's own text: the caller classifies it to decide
        // whether a retry is safe.
        throw new Error(`terraform plan failed: ${diag || r.stderr.slice(-600)}`);
      }

      return {
        toAdd: r.toAdd,
        toChange: r.toChange,
        toDestroy: r.toDestroy,
        changes: r.changes,
        destructive: r.destructive,
      };
    },
  });

  infraToolRegistry.register({
    name: 'terraform_apply',
    description:
      'Apply the saved plan, creating real cloud infrastructure. Runs only the plan that was produced and approved.',
    input: credentialledArgs,
    risk: 'critical',
    requiredPermission: 'agent:execute',
    // Not idempotent, and therefore never retried automatically: a create that
    // failed after the resource was made would be repeated into a duplicate.
    // Recovery is a fresh plan against the real state, which is what resume does.
    idempotent: false,
    timeoutMs: 45 * 60_000,
    handler: async (args, ctx) => {
      ctx.emit?.({ message: 'Applying the approved plan…' });
      const creds = await resolveTerraformCredentials(args.cloudAccountId);
      const r = await terraformExecutor.apply(args.workspacePath, creds, {
        signal: ctx.signal,
        onOutput: (chunk) => ctx.emit?.({ message: chunk.trim() }),
      });
      if (!r.ok) throw new Error(`terraform apply failed: ${r.stderr.slice(-800)}`);

      const created = await terraformExecutor.listState(args.workspacePath, creds);
      return { durationMs: r.durationMs, resources: created, resourceCount: created.length };
    },
  });

  infraToolRegistry.register({
    name: 'terraform_state_list',
    description: 'List the resource addresses Terraform believes exist. Used to resume a run without duplicating work.',
    input: credentialledArgs,
    risk: 'low',
    requiredPermission: 'account:read',
    idempotent: true,
    maxRetries: 2,
    timeoutMs: 5 * 60_000,
    handler: async (args) => {
      const creds = await resolveTerraformCredentials(args.cloudAccountId);
      return { addresses: await terraformExecutor.listState(args.workspacePath, creds) };
    },
  });

  infraToolRegistry.register({
    name: 'terraform_destroy',
    description: 'Destroy all infrastructure tracked by this workspace. Irreversible.',
    input: credentialledArgs,
    risk: 'critical',
    requiredPermission: 'agent:execute',
    idempotent: false,
    timeoutMs: 45 * 60_000,
    handler: async (args, ctx) => {
      ctx.emit?.({ level: 'warn', message: 'Destroying infrastructure…' });
      const creds = await resolveTerraformCredentials(args.cloudAccountId);
      const r = await terraformExecutor.destroy(args.workspacePath, creds, {
        signal: ctx.signal,
        onOutput: (chunk) => ctx.emit?.({ message: chunk.trim() }),
      });
      if (!r.ok) throw new Error(`terraform destroy failed: ${r.stderr.slice(-800)}`);
      return { durationMs: r.durationMs };
    },
  });
}
