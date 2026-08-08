/**
 * Cloud clients for executing an action, built from the tenant's stored
 * credentials.
 *
 * The executor previously constructed its AWS clients once, at module load,
 * from process.env.AWS_ACCESS_KEY_ID. In a multi-tenant deployment that is a
 * loaded gun: whatever keys happen to be in the server's environment would be
 * used to mutate infrastructure on behalf of whichever customer clicked
 * execute. Even single-tenant it was wrong, because the credentials a customer
 * entered through Configuration were ignored in favour of the deploy's own.
 *
 * Credentials are now resolved per action, from the calling tenant's
 * cloud_accounts row, and there is no environment fallback. No credentials
 * means no execution.
 */
import { EC2Client } from "@aws-sdk/client-ec2";
import { S3Client } from "@aws-sdk/client-s3";
import { getActiveCloudAccounts, type CloudCredentials } from "../cloud-config-manager";

export class CredentialResolutionError extends Error {}

export interface ResolvedAwsClients {
  ec2: EC2Client;
  s3: S3Client;
  account: CloudCredentials;
  /** Set when the account was chosen by fallback rather than an id match. */
  warning?: string;
}

/**
 * The tenant's cloud account for an action.
 *
 * Matches on accountId first. Where the action's accountId does not match any
 * stored account — which happens because cloud_accounts.account_id is a
 * free-text field, and because ingestion now records the provider's real
 * account id rather than that label — it falls back to the single active
 * account for the provider.
 *
 * If more than one account exists and none matches, it refuses. Guessing which
 * of several AWS accounts to mutate is precisely the case that must never be
 * resolved by picking the first one.
 */
export async function resolveAccountForAction(
  provider: string,
  accountId: string | null,
): Promise<{ account: CloudCredentials; warning?: string }> {
  const accounts = await getActiveCloudAccounts(provider as 'aws' | 'gcp' | 'azure');

  if (accounts.length === 0) {
    throw new CredentialResolutionError(
      `No active ${provider.toUpperCase()} account is configured for this organization. ` +
      `Add credentials in Configuration before executing actions.`
    );
  }

  const exact = accountId ? accounts.find(a => a.accountId === accountId) : undefined;
  if (exact) return { account: exact };

  if (accounts.length === 1) {
    return {
      account: accounts[0],
      warning: accountId
        ? `Action targets account '${accountId}' but no stored account has that id; ` +
          `used the only active ${provider.toUpperCase()} account ('${accounts[0].accountName}').`
        : undefined,
    };
  }

  throw new CredentialResolutionError(
    `Action targets ${provider.toUpperCase()} account '${accountId ?? 'unspecified'}', which matches none of ` +
    `the ${accounts.length} configured accounts. Refusing to guess which account to modify.`
  );
}

/** AWS clients scoped to the account this action targets. */
export async function getAwsClientsForAction(
  accountId: string | null,
  region?: string,
): Promise<ResolvedAwsClients> {
  const { account, warning } = await resolveAccountForAction('aws', accountId);
  const creds = account.credentials ?? {};

  if (!creds.accessKeyId || !creds.secretAccessKey) {
    throw new CredentialResolutionError(
      `AWS account '${account.accountName}' has no access key stored; cannot execute against it.`
    );
  }

  const config = {
    region: region || creds.region || 'us-east-1',
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
    },
  };

  return {
    ec2: new EC2Client(config),
    s3: new S3Client(config),
    account,
    warning,
  };
}
