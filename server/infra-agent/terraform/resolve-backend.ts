/**
 * Looks up the tenant's configured state backend.
 *
 * Its own module rather than a helper inside the GitOps delivery path, because
 * both delivery modes need it: a pull request must contain the backend block,
 * and the in-app review must show the reviewer the same configuration that will
 * actually run. Two copies of this lookup would eventually disagree, and the
 * disagreement would be invisible — the reviewer approving one thing and
 * Terraform running another.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { infraStateBackends } from '@shared/schema';
import { currentOrgId } from '../../tenant-context';
import { stateKeyFor, validateBackend, type BackendConfig, type BackendSettings } from './backend';

export class BackendConfigError extends Error {
  constructor(message: string, readonly errors: string[]) {
    super(message);
    this.name = 'BackendConfigError';
  }
}

/**
 * Returns local state when nothing is configured, and throws when something IS
 * configured but wrong.
 *
 * The asymmetry is deliberate. "Not configured yet" is a normal state for a new
 * tenant and blocking on it would stop people getting started; the warning
 * travels with the plan instead. "Configured but invalid" is different — silently
 * falling back to local state there would produce exactly the untracked
 * infrastructure this is meant to prevent, and nobody would notice until a
 * teardown found nothing to destroy.
 */
export async function resolveStateBackend(
  provider: string,
  planId: number,
  planName: string,
): Promise<BackendConfig> {
  const orgId = currentOrgId();
  const stateKey = stateKeyFor(orgId, planId, planName);

  const [row] = await db
    .select()
    .from(infraStateBackends)
    .where(and(eq(infraStateBackends.organizationId, orgId), eq(infraStateBackends.provider, provider)))
    .limit(1);

  if (!row || row.kind === 'local') {
    return { settings: { kind: 'local' }, stateKey };
  }

  const settings = { kind: row.kind, ...(row.settings as Record<string, unknown>) } as BackendSettings;
  const config: BackendConfig = { settings, stateKey };

  const errors = validateBackend(config);
  if (errors.length > 0) {
    throw new BackendConfigError(
      `The ${provider} Terraform state backend is misconfigured: ${errors.join('; ')}`,
      errors,
    );
  }

  return config;
}
