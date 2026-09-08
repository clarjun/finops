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
import { awsClient } from "../aws/client-factory";

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

/**
 * AWS clients for executing an approved action, on the REMEDIATION tier.
 *
 * This is the only place in the application that builds write-capable AWS
 * clients for the optimization agent, and it deliberately asks for a different
 * customer IAM role than every read path does. The separation is enforced by
 * AWS: a cost query holds credentials that cannot call ec2:StopInstances, and
 * these credentials cannot read Cost Explorer. Previously a single access key
 * served both, so "read-only" was a property of our code being careful rather
 * than of the credential.
 *
 * Called after the guardrail and approval checks, so the write-capable session
 * is minted only once an action has been permitted — and expires within the
 * hour regardless.
 */
export async function getAwsClientsForAction(
  accountId: string | null,
  region?: string,
): Promise<ResolvedAwsClients> {
  const { account, warning } = await resolveAccountForAction('aws', accountId);

  try {
    const [ec2, s3] = await Promise.all([
      awsClient('remediation', EC2Client, { region, connectionId: account.id }),
      awsClient('remediation', S3Client, { region, connectionId: account.id }),
    ]);

    return { ec2, s3, account, warning };
  } catch (err) {
    // AwsAuthError messages already name what the operator must fix — most
    // often that the connection has no remediation role configured, which is a
    // deliberate default: read-only is the safe starting posture.
    throw new CredentialResolutionError(
      `Cannot execute against AWS account '${account.accountName}': ${(err as Error).message}`,
    );
  }
}
