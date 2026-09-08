/**
 * Resolves cloud credentials for a deployment.
 *
 * Credentials are read here, inside the tool layer, and handed straight to the
 * container as environment variables. They are never returned to a caller, never
 * placed in a tool's arguments, and therefore never reach the model. The agent
 * proposes "apply this plan against account 4"; the executor is what holds the
 * key.
 *
 * This is the concrete form of the rule that the LLM must never have
 * unrestricted authority over the cloud: it cannot, because it never has the
 * material required to act.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { cloudAccounts } from '@shared/schema';
import { decrypt } from '../../encryption';
import { currentOrgId } from '../../tenant-context';
import type { TerraformCredentials } from '../terraform/executor';

export class CredentialError extends Error {}

/**
 * Terraform environment for a tenant's cloud account.
 *
 * Scoped to the calling organization, so a run cannot deploy using another
 * tenant's credentials even if it were given their account id.
 */
export async function resolveTerraformCredentials(cloudAccountId: number): Promise<TerraformCredentials> {
  const [account] = await db.select().from(cloudAccounts).where(and(
    eq(cloudAccounts.id, cloudAccountId),
    eq(cloudAccounts.organizationId, currentOrgId()),
    eq(cloudAccounts.isActive, true),
  ));

  if (!account) {
    throw new CredentialError(
      `No active cloud account ${cloudAccountId} for this organization. Add credentials in Configuration.`,
    );
  }

  let credentials: Record<string, unknown>;
  try {
    credentials = JSON.parse(decrypt(account.credentials as string));
  } catch (err) {
    throw new CredentialError(
      `Stored credentials for "${account.accountName}" could not be decrypted (${(err as Error).message}).`,
    );
  }

  const provider = account.provider as 'aws' | 'azure' | 'gcp';

  switch (provider) {
    case 'aws': {
      const accessKeyId = String(credentials.accessKeyId ?? '');
      const secretAccessKey = String(credentials.secretAccessKey ?? '');
      if (!accessKeyId || !secretAccessKey) {
        throw new CredentialError(`AWS account "${account.accountName}" has no access key stored.`);
      }
      return {
        provider,
        env: {
          AWS_ACCESS_KEY_ID: accessKeyId,
          AWS_SECRET_ACCESS_KEY: secretAccessKey,
          ...(credentials.sessionToken ? { AWS_SESSION_TOKEN: String(credentials.sessionToken) } : {}),
          // Region comes from the plan, not the stored account: one account can
          // host deployments in several regions.
        },
      };
    }

    case 'azure': {
      const { tenantId, clientId, clientSecret, subscriptionId } = credentials as Record<string, string>;
      if (!tenantId || !clientId || !clientSecret) {
        throw new CredentialError(`Azure account "${account.accountName}" is missing service-principal credentials.`);
      }
      return {
        provider,
        env: {
          ARM_TENANT_ID: tenantId,
          ARM_CLIENT_ID: clientId,
          ARM_CLIENT_SECRET: clientSecret,
          ARM_SUBSCRIPTION_ID: String(subscriptionId ?? account.accountId),
        },
      };
    }

    case 'gcp': {
      const key = credentials.serviceAccountKey;
      if (!key) {
        throw new CredentialError(`GCP account "${account.accountName}" has no service-account key stored.`);
      }
      return {
        provider,
        env: {
          // The provider accepts the key inline, which keeps it out of the
          // filesystem entirely.
          GOOGLE_CREDENTIALS: typeof key === 'string' ? key : JSON.stringify(key),
          GOOGLE_PROJECT: String(credentials.projectId ?? account.accountId),
        },
      };
    }

    default:
      throw new CredentialError(`Unsupported provider "${provider}".`);
  }
}

/**
 * Whether a tenant has usable credentials, without decrypting or returning them.
 * Used to decide between a live run and a simulation before either starts.
 */
export async function hasUsableCredentials(cloudAccountId: number): Promise<boolean> {
  try {
    await resolveTerraformCredentials(cloudAccountId);
    return true;
  } catch {
    return false;
  }
}
