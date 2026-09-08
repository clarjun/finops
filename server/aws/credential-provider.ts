/**
 * The single place Cloudwise obtains AWS credentials.
 *
 *   caller → resolveAwsCredentials(tier) → STS AssumeRole → temporary creds
 *
 * Every AWS client in the application is built from this. The point of having
 * exactly one is that the security properties below hold everywhere rather than
 * wherever someone remembered them:
 *
 *   tenant isolation   the connection is loaded with an unconditional
 *                      organization_id predicate, and the cache key includes it.
 *                      A tenant cannot reach another tenant's role even by
 *                      supplying its connection id.
 *   least privilege    the tier selects which of the customer's three roles is
 *                      assumed. A cost query is issued with credentials that
 *                      physically cannot stop an instance, because AWS — not our
 *                      code — refuses.
 *   no persistence     temporary credentials live in this module's memory and
 *                      nowhere else. They are never written to Postgres, never
 *                      returned from an API, never logged, and never placed in a
 *                      model prompt.
 *   no leakage         errors are translated. The raw STS message can contain
 *                      the External ID and full role ARNs, which must not reach
 *                      a client or a log line.
 *
 * Legacy access keys are still honoured when auth_type = 'access_keys', so
 * existing connections keep working. That path is deprecated and logs a warning
 * once per connection.
 */
import { and, eq } from 'drizzle-orm';
import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import type { AwsCredentialIdentity } from '@aws-sdk/types';
import { db } from '../db';
import { cloudAccounts, type AwsRoleTier } from '@shared/schema';
import { decrypt } from '../encryption';
import { currentOrgId } from '../tenant-context';
import { parseRoleArn, buildSessionName } from './identity';
import { entraFederatedCredentials } from './entra-federation';

/** Region for the STS call itself. Regional endpoints are lower latency and stay up when us-east-1 does not. */
const STS_REGION = process.env.AWS_STS_REGION || 'us-east-1';

/**
 * Requested session lifetime.
 *
 * One hour is the ceiling for a chained role, and chaining is what happens when
 * Cloudwise's own identity is itself an assumed role — so asking for more would
 * fail in exactly the deployment topology we intend to move to.
 */
const SESSION_DURATION_SECONDS = 3600;

/**
 * Renew this long before expiry.
 *
 * Five minutes because a Terraform plan or a paginated Cost Explorer sweep can
 * run for minutes after credentials are handed out. Cutting it finer means an
 * operation that started with valid credentials finishes without them.
 */
const REFRESH_MARGIN_MS = 5 * 60_000;

export class AwsAuthError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'not_configured'
      | 'no_role_for_tier'
      | 'invalid_role_arn'
      | 'assume_role_denied'
      | 'external_id_mismatch'
      | 'account_mismatch'
      | 'throttled'
      | 'unavailable',
    /** Whether retrying the identical call could succeed. */
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'AwsAuthError';
  }
}

/** A cached session. Values never leave this module except as an SDK provider. */
interface CachedSession {
  credentials: AwsCredentialIdentity;
  expiresAtMs: number;
}

/**
 * Keyed by organization, connection and tier.
 *
 * The organization id is in the key deliberately. A cache keyed on connection
 * id alone would let a bug elsewhere serve one tenant a session minted for
 * another — the same class of fault as the shared Azure inventory cache.
 */
const sessionCache = new Map<string, CachedSession>();

const cacheKey = (orgId: number, connectionId: number, tier: AwsRoleTier) =>
  `${orgId}:${connectionId}:${tier}`;

/** Test seam, and used when a connection is revoked or revalidated. */
export function invalidateAwsSessions(connectionId?: number): void {
  if (connectionId === undefined) {
    sessionCache.clear();
    return;
  }
  for (const key of [...sessionCache.keys()]) {
    if (key.split(':')[1] === String(connectionId)) sessionCache.delete(key);
  }
}

export interface AwsConnection {
  id: number;
  organizationId: number;
  accountId: string;
  accountName: string;
  authType: string;
  roleArn: string | null;
  remediationRoleArn: string | null;
  deployRoleArn: string | null;
  externalId: string | null;
  credentials: unknown;
}

/**
 * The calling tenant's active AWS connection.
 *
 * Scoped to currentOrgId() unconditionally. currentOrgId() throws outside a
 * request or runAsSystem() block, so a caller with no tenant context gets an
 * exception rather than another tenant's role.
 */
export async function loadAwsConnection(connectionId?: number): Promise<AwsConnection | null> {
  const organizationId = currentOrgId();

  const where = connectionId !== undefined
    ? and(
        eq(cloudAccounts.id, connectionId),
        eq(cloudAccounts.organizationId, organizationId),
        eq(cloudAccounts.provider, 'aws'),
        eq(cloudAccounts.isActive, true),
      )
    : and(
        eq(cloudAccounts.organizationId, organizationId),
        eq(cloudAccounts.provider, 'aws'),
        eq(cloudAccounts.isActive, true),
      );

  const [row] = await db.select().from(cloudAccounts).where(where).limit(1);
  if (!row) return null;

  return {
    id: row.id,
    organizationId: row.organizationId,
    accountId: row.accountId,
    accountName: row.accountName,
    authType: row.authType,
    roleArn: row.roleArn,
    remediationRoleArn: row.remediationRoleArn,
    deployRoleArn: row.deployRoleArn,
    externalId: row.externalId,
    credentials: row.credentials,
  };
}

/** Which of the customer's roles a tier uses. */
export function roleArnForTier(conn: AwsConnection, tier: AwsRoleTier): string | null {
  switch (tier) {
    case 'readonly': return conn.roleArn;
    // No silent fall back to the read-only role: a remediation attempt against a
    // connection that never configured one must fail, not quietly run with
    // credentials that will be denied deep inside an SDK call.
    case 'remediation': return conn.remediationRoleArn;
    case 'deploy': return conn.deployRoleArn;
  }
}

/** Decrypts the stored External ID. Never logged, never returned to a caller. */
function decryptExternalId(conn: AwsConnection): string {
  if (!conn.externalId) {
    throw new AwsAuthError(
      `AWS connection "${conn.accountName}" has no External ID. Reconnect the account to generate one.`,
      'not_configured',
    );
  }
  try {
    return decrypt(conn.externalId);
  } catch {
    throw new AwsAuthError(
      `The stored External ID for "${conn.accountName}" could not be decrypted. Reconnect the account.`,
      'not_configured',
    );
  }
}

/**
 * The identity Cloudwise itself authenticates as when calling STS.
 *
 * The single place any credential enters the system, which is why swapping how
 * Cloudwise authenticates touches one function and no connector.
 *
 * Preference order:
 *
 *   1. Entra workload identity federation, when deployed to Azure with it
 *      configured. No long-lived AWS secret exists anywhere in that case.
 *   2. The SDK's default chain — an IAM user's key in the environment, or an
 *      instance/task role if Cloudwise is ever hosted on AWS.
 *
 * Federation returns null rather than throwing when unavailable, so the same
 * build runs on a developer laptop (default chain) and in Azure (federated)
 * without a flag.
 */
function stsClient(): STSClient {
  const federated = entraFederatedCredentials();

  if (federated) {
    return new STSClient({ region: STS_REGION, maxAttempts: 3, credentials: federated });
  }

  return new STSClient({ region: STS_REGION, maxAttempts: 3 });
}

/**
 * Turns an STS failure into something a user can act on.
 *
 * The raw messages name the role ARN and sometimes the External ID, so they are
 * logged at a coarse level and never surfaced verbatim.
 */
function translateStsError(err: unknown, conn: AwsConnection, tier: AwsRoleTier): AwsAuthError {
  const name = (err as { name?: string })?.name ?? '';
  const message = (err as Error)?.message ?? String(err);

  if (name === 'AccessDenied' || /not authorized to perform: sts:AssumeRole/i.test(message)) {
    // AWS returns AccessDenied both for "trust policy does not name us" and for
    // "External ID does not match", and does not distinguish them — on purpose.
    // The message therefore covers both rather than guessing.
    return new AwsAuthError(
      `Cloudwise could not assume the ${tier} IAM role for "${conn.accountName}". ` +
      `Check that the role's trust policy allows the Cloudwise AWS principal and that the ` +
      `External ID matches the value shown in Cloudwise.`,
      'assume_role_denied',
    );
  }

  if (name === 'NoSuchEntity' || /role .* does not exist|cannot be found/i.test(message)) {
    return new AwsAuthError(
      `The ${tier} IAM role configured for "${conn.accountName}" does not exist in that AWS account.`,
      'invalid_role_arn',
    );
  }

  if (name === 'Throttling' || name === 'ThrottlingException' || /rate exceeded|throttl/i.test(message)) {
    return new AwsAuthError(
      `AWS is rate-limiting credential requests for "${conn.accountName}". This usually clears in a moment.`,
      'throttled',
      true,
    );
  }

  if (/InvalidClientTokenId|SignatureDoesNotMatch|ExpiredToken/i.test(message)) {
    // Cloudwise's OWN identity is broken, not the customer's configuration.
    return new AwsAuthError(
      `Cloudwise's AWS identity was rejected by STS. This is a Cloudwise configuration problem, not a customer one.`,
      'unavailable',
    );
  }

  return new AwsAuthError(
    `Could not obtain AWS credentials for "${conn.accountName}" (${name || 'unknown error'}).`,
    'unavailable',
    true,
  );
}

/**
 * Assumes the tier's role and returns temporary credentials.
 *
 * Not exported: callers get a refreshing provider from resolveAwsCredentials()
 * so nobody holds a credential object long enough for it to expire underneath
 * them.
 */
async function assumeRole(conn: AwsConnection, tier: AwsRoleTier): Promise<CachedSession> {
  const roleArn = roleArnForTier(conn, tier);

  if (!roleArn) {
    throw new AwsAuthError(
      `AWS connection "${conn.accountName}" has no ${tier} role configured. ` +
      `Add the ${tier} role ARN in Configuration to enable this capability.`,
      'no_role_for_tier',
    );
  }

  const parsed = parseRoleArn(roleArn);
  if (!parsed) {
    throw new AwsAuthError(
      `The ${tier} role ARN stored for "${conn.accountName}" is not a valid IAM role ARN.`,
      'invalid_role_arn',
    );
  }

  // Checked before the call, not after: assuming a role in an account the
  // connection does not claim is the shape of a tenant escaping its own
  // boundary, and it should never reach AWS.
  if (parsed.accountId !== conn.accountId) {
    throw new AwsAuthError(
      `The ${tier} role ARN belongs to AWS account ${parsed.accountId}, but this connection is ` +
      `registered for ${conn.accountId}. Refusing to assume a role in a different account.`,
      'account_mismatch',
    );
  }

  const externalId = decryptExternalId(conn);

  let response;
  try {
    response = await stsClient().send(new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: buildSessionName(conn.organizationId, tier),
      ExternalId: externalId,
      DurationSeconds: SESSION_DURATION_SECONDS,
    }));
  } catch (err) {
    // Coarse log only: never the External ID, never the raw AWS message.
    console.error(
      `[AWS Auth] AssumeRole failed for connection ${conn.id} (${tier}): ` +
      `${(err as { name?: string })?.name ?? 'error'}`,
    );
    throw translateStsError(err, conn, tier);
  }

  const c = response.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) {
    throw new AwsAuthError(
      `STS returned an incomplete credential set for "${conn.accountName}".`,
      'unavailable',
      true,
    );
  }

  return {
    credentials: {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
      expiration: c.Expiration,
    },
    expiresAtMs: c.Expiration ? c.Expiration.getTime() : Date.now() + SESSION_DURATION_SECONDS * 1000,
  };
}

/** Warned once per connection rather than on every call. */
const legacyWarned = new Set<number>();

/** Decrypts legacy static keys. Deprecated path, retained for migration only. */
function legacyCredentials(conn: AwsConnection): AwsCredentialIdentity {
  if (!legacyWarned.has(conn.id)) {
    legacyWarned.add(conn.id);
    console.warn(
      `[AWS Auth] Connection ${conn.id} ("${conn.accountName}") still uses long-lived access keys. ` +
      `Migrate it to cross-account role authentication; key-based auth is deprecated.`,
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(decrypt(String(conn.credentials)));
  } catch (err) {
    throw new AwsAuthError(
      `Stored credentials for "${conn.accountName}" could not be decrypted.`,
      'not_configured',
    );
  }

  const accessKeyId = String(parsed.accessKeyId ?? '');
  const secretAccessKey = String(parsed.secretAccessKey ?? '');
  if (!accessKeyId || !secretAccessKey) {
    throw new AwsAuthError(
      `AWS account "${conn.accountName}" has no usable stored credentials.`,
      'not_configured',
    );
  }

  return {
    accessKeyId,
    secretAccessKey,
    ...(parsed.sessionToken ? { sessionToken: String(parsed.sessionToken) } : {}),
  };
}

/**
 * A credential provider for the given privilege tier.
 *
 * Returns a FUNCTION rather than a credential object, which is what the AWS SDK
 * expects: it calls the provider again when a request finds the credentials
 * near expiry, so a long-running client refreshes without the caller knowing.
 * Handing back a plain object is how a 45-minute Terraform run ends up holding
 * a 60-minute credential that dies two thirds of the way through.
 */
export async function resolveAwsCredentials(
  tier: AwsRoleTier,
  connectionId?: number,
): Promise<() => Promise<AwsCredentialIdentity>> {
  const conn = await loadAwsConnection(connectionId);

  if (!conn) {
    throw new AwsAuthError(
      'No active AWS account is connected for this organization. Add one in Configuration.',
      'not_configured',
    );
  }

  if (conn.authType === 'access_keys') {
    // Static keys have no tier separation to offer — the single key does
    // whatever its IAM policy permits. Surfaced rather than hidden, because the
    // absence of separation is exactly what the migration exists to fix.
    const creds = legacyCredentials(conn);
    return async () => creds;
  }

  const key = cacheKey(conn.organizationId, conn.id, tier);

  return async () => {
    const hit = sessionCache.get(key);
    if (hit && hit.expiresAtMs - Date.now() > REFRESH_MARGIN_MS) {
      return hit.credentials;
    }

    const session = await assumeRole(conn, tier);
    sessionCache.set(key, session);
    return session.credentials;
  };
}

export interface VerifiedIdentity {
  accountId: string;
  arn: string;
  userId: string;
}

/**
 * Proves the assumed credentials really belong to the expected account.
 *
 * The role ARN arrives from a form, so the account inside it is a claim. This
 * asks AWS who we actually are and compares. Without it a customer could
 * register an ARN for an account they do not own and Cloudwise would happily
 * read someone else's costs — a tenant-isolation failure originating outside
 * our system entirely.
 */
export async function verifyAssumedIdentity(
  credentials: AwsCredentialIdentity,
  expectedAccountId: string,
): Promise<VerifiedIdentity> {
  const client = new STSClient({ region: STS_REGION, credentials, maxAttempts: 3 });
  const identity = await client.send(new GetCallerIdentityCommand({}));

  if (!identity.Account || !identity.Arn) {
    throw new AwsAuthError('AWS did not return a caller identity for the assumed role.', 'unavailable', true);
  }

  if (identity.Account !== expectedAccountId) {
    throw new AwsAuthError(
      `The role resolves to AWS account ${identity.Account}, but this connection is registered ` +
      `for ${expectedAccountId}. Refusing the connection.`,
      'account_mismatch',
    );
  }

  return { accountId: identity.Account, arn: identity.Arn, userId: identity.UserId ?? '' };
}

/** Cache statistics for diagnostics. Deliberately exposes no credential material. */
export function awsSessionCacheStats(): { sessions: number } {
  return { sessions: sessionCache.size };
}
