/**
 * Zero-secret AWS access from Azure, via Entra workload identity federation.
 *
 *   Container App managed identity
 *          │  1. ask Azure for a token (the platform vouches for us; nothing stored)
 *          ▼
 *   JWT signed by Entra
 *          │  2. sts:AssumeRoleWithWebIdentity  ← an UNSIGNED AWS operation,
 *          ▼                                      so no AWS credential is needed
 *   temporary credentials for CloudwiseFederatedRole
 *          │  3. sts:AssumeRole (chained)
 *          ▼
 *   the customer's read-only role
 *
 * This replaces the bootstrap IAM user. With it configured there is no
 * long-lived AWS secret anywhere in the deployment — not in the environment, not
 * in Key Vault, not in the database.
 *
 * Returns null when it is not configured, so local development (and any host
 * without a managed identity) falls through to the SDK's normal chain. Zero
 * secrets is a property of the deployment, not of this file.
 *
 * The claim-matching trap this is built to avoid:
 *
 *   AWS validates the token's `iss` against the OIDC provider URL you register,
 *   as an exact string. Azure's managed-identity endpoint issues v1 tokens whose
 *   issuer is `https://sts.windows.net/<tenant>/` — WITH the trailing slash, and
 *   NOT the `login.microsoftonline.com/<tenant>/v2.0` form most documentation
 *   shows. Configure the wrong one and every call fails with an unhelpful
 *   InvalidIdentityToken. `federationDiagnostics()` exists so an operator can
 *   read the real claims out of a real token and configure AWS to match, instead
 *   of guessing.
 */
import { STSClient, AssumeRoleWithWebIdentityCommand } from '@aws-sdk/client-sts';
import type { AwsCredentialIdentity } from '@aws-sdk/types';

/** The AWS role the federated identity assumes. Replaces the bootstrap IAM user. */
const FEDERATION_ROLE_ARN = () => process.env.AWS_FEDERATION_ROLE_ARN;

/**
 * The `aud` claim AWS will match on — the Application ID URI of the Entra app
 * registration created to represent AWS.
 */
const FEDERATION_AUDIENCE = () => process.env.AWS_FEDERATION_AUDIENCE;

/** Optional: pins the token to one user-assigned identity when several exist. */
const MANAGED_IDENTITY_CLIENT_ID = () => process.env.AZURE_CLIENT_ID_FOR_AWS;

const STS_REGION = () => process.env.AWS_STS_REGION || 'us-east-1';

/** Renew this far ahead of expiry, matching the credential provider's margin. */
const REFRESH_MARGIN_MS = 5 * 60_000;

export class FederationError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = 'FederationError';
  }
}

/**
 * Whether federation can be attempted at all.
 *
 * Requires both our own configuration AND a platform identity to exist. On a
 * developer laptop the second is absent, which is why this returns false there
 * rather than failing.
 */
export function isFederationAvailable(): boolean {
  const hasConfig = !!FEDERATION_ROLE_ARN() && !!FEDERATION_AUDIENCE();
  const hasPlatformIdentity = !!process.env.IDENTITY_ENDPOINT || !!process.env.MSI_ENDPOINT;
  return hasConfig && hasPlatformIdentity;
}

/* -------------------------------------------------------------------------- */
/*  Step 1: get a token from Azure                                            */
/* -------------------------------------------------------------------------- */

interface AzureTokenResponse {
  access_token: string;
  expires_on?: string;
  client_id?: string;
}

/**
 * Requests a managed-identity token from the platform.
 *
 * Container Apps and App Service inject IDENTITY_ENDPOINT and IDENTITY_HEADER;
 * plain VMs expose IMDS at a link-local address with a `Metadata: true` header.
 * Both are supported because the deployment target may still change, and the
 * difference is four lines.
 */
async function fetchEntraToken(audience: string): Promise<string> {
  const endpoint = process.env.IDENTITY_ENDPOINT || process.env.MSI_ENDPOINT;
  const header = process.env.IDENTITY_HEADER || process.env.MSI_SECRET;

  const clientId = MANAGED_IDENTITY_CLIENT_ID();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    let url: string;
    const headers: Record<string, string> = {};

    if (endpoint && header) {
      // App Service / Container Apps style.
      const u = new URL(endpoint);
      u.searchParams.set('resource', audience);
      u.searchParams.set('api-version', '2019-08-01');
      if (clientId) u.searchParams.set('client_id', clientId);
      url = u.toString();
      headers['X-IDENTITY-HEADER'] = header;
    } else {
      // Azure VM IMDS style.
      const u = new URL('http://169.254.169.254/metadata/identity/oauth2/token');
      u.searchParams.set('resource', audience);
      u.searchParams.set('api-version', '2018-02-01');
      if (clientId) u.searchParams.set('client_id', clientId);
      url = u.toString();
      headers['Metadata'] = 'true';
    }

    const res = await fetch(url, { headers, signal: controller.signal });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new FederationError(
        `Azure refused to issue a managed-identity token (${res.status}).`,
        res.status === 400
          ? `Check that AWS_FEDERATION_AUDIENCE ("${audience}") matches the Application ID URI ` +
            `of the Entra app registration, and that the Container App has a managed identity enabled.`
          : body.slice(0, 200),
      );
    }

    const payload = await res.json() as AzureTokenResponse;
    if (!payload.access_token) {
      throw new FederationError('Azure returned a token response with no access_token.');
    }
    return payload.access_token;
  } catch (err) {
    if (err instanceof FederationError) throw err;
    if ((err as Error)?.name === 'AbortError') {
      throw new FederationError(
        'Timed out requesting a managed-identity token from Azure.',
        'The identity endpoint is only reachable from inside Azure. This will always fail locally.',
      );
    }
    throw new FederationError(
      `Could not reach the Azure identity endpoint: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- */
/*  Diagnostics                                                               */
/* -------------------------------------------------------------------------- */

export interface TokenClaims {
  issuer: string | null;
  audience: string | null;
  subject: string | null;
  expiresAt: string | null;
}

/**
 * Reads the claims out of a JWT WITHOUT verifying it.
 *
 * Deliberately unverified: we are not the verifier — AWS is, against Entra's
 * JWKS. This exists purely so an operator can see the exact `iss`, `aud` and
 * `sub` values to configure on the AWS side. Guessing them is the single most
 * common way this setup fails, and the resulting AWS error names none of them.
 *
 * Never returns the token or the signature.
 */
export function decodeTokenClaims(jwt: string): TokenClaims {
  const parts = jwt.split('.');
  if (parts.length !== 3) {
    return { issuer: null, audience: null, subject: null, expiresAt: null };
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return {
      issuer: payload.iss ?? null,
      audience: Array.isArray(payload.aud) ? payload.aud.join(',') : payload.aud ?? null,
      subject: payload.sub ?? null,
      expiresAt: payload.exp ? new Date(payload.exp * 1000).toISOString() : null,
    };
  } catch {
    return { issuer: null, audience: null, subject: null, expiresAt: null };
  }
}

export interface FederationDiagnostics {
  available: boolean;
  configured: { roleArn: boolean; audience: boolean; platformIdentity: boolean };
  claims?: TokenClaims;
  /** The exact values to configure in AWS IAM, derived from a real token. */
  awsSetup?: { oidcProviderUrl: string; audienceCondition: string; subjectCondition: string };
  error?: string;
}

/**
 * Fetches one real token and reports what AWS must be configured to expect.
 *
 * Run this once from the deployed environment; the output is the AWS-side setup,
 * with no guesswork about issuer format.
 */
export async function federationDiagnostics(): Promise<FederationDiagnostics> {
  const base: FederationDiagnostics = {
    available: isFederationAvailable(),
    configured: {
      roleArn: !!FEDERATION_ROLE_ARN(),
      audience: !!FEDERATION_AUDIENCE(),
      platformIdentity: !!(process.env.IDENTITY_ENDPOINT || process.env.MSI_ENDPOINT),
    },
  };

  const audience = FEDERATION_AUDIENCE();
  if (!audience) return { ...base, error: 'AWS_FEDERATION_AUDIENCE is not set.' };

  try {
    const token = await fetchEntraToken(audience);
    const claims = decodeTokenClaims(token);

    // The OIDC provider URL must equal the issuer with no trailing slash, since
    // AWS stores it without the scheme and compares the rest exactly.
    const issuer = claims.issuer ?? '';
    const providerUrl = issuer.replace(/\/+$/, '');
    const conditionKey = providerUrl.replace(/^https:\/\//, '');

    return {
      ...base,
      claims,
      awsSetup: {
        oidcProviderUrl: providerUrl,
        audienceCondition: `${conditionKey}:aud = ${claims.audience}`,
        subjectCondition: `${conditionKey}:sub = ${claims.subject}`,
      },
    };
  } catch (err) {
    return { ...base, error: (err as Error).message };
  }
}

/* -------------------------------------------------------------------------- */
/*  Step 2: exchange it for AWS credentials                                   */
/* -------------------------------------------------------------------------- */

let cached: { credentials: AwsCredentialIdentity; expiresAtMs: number } | null = null;

/** Test seam, and used when configuration changes. */
export function invalidateFederatedCredentials(): void {
  cached = null;
}

/**
 * A credential provider backed by Entra federation, or null when unavailable.
 *
 * Returning null rather than throwing lets the caller fall back to the SDK's
 * normal chain, which is what makes the same build work on a laptop and in
 * Azure.
 */
export function entraFederatedCredentials(): (() => Promise<AwsCredentialIdentity>) | null {
  if (!isFederationAvailable()) return null;

  return async () => {
    if (cached && cached.expiresAtMs - Date.now() > REFRESH_MARGIN_MS) {
      return cached.credentials;
    }

    const roleArn = FEDERATION_ROLE_ARN()!;
    const audience = FEDERATION_AUDIENCE()!;
    const token = await fetchEntraToken(audience);

    // No credentials on this client, deliberately: AssumeRoleWithWebIdentity is
    // an unsigned operation. Verified — calling it with an empty environment
    // returns InvalidIdentityToken, not a credentials error. That is the property
    // the whole design rests on.
    const sts = new STSClient({ region: STS_REGION(), maxAttempts: 3 });

    let response;
    try {
      response = await sts.send(new AssumeRoleWithWebIdentityCommand({
        RoleArn: roleArn,
        RoleSessionName: 'cloudwise-federated',
        WebIdentityToken: token,
      }));
    } catch (err) {
      const name = (err as { name?: string })?.name ?? '';
      const claims = decodeTokenClaims(token);

      // The claims, never the token. These three values are what the AWS side
      // must match, and naming them turns a dead end into a fixable error.
      if (name === 'InvalidIdentityToken' || name === 'InvalidIdentityTokenException') {
        throw new FederationError(
          'AWS rejected the Azure identity token.',
          `Register an OIDC provider in AWS whose URL is exactly "${claims.issuer}" ` +
          `(without a trailing slash) with audience "${claims.audience}", and allow subject ` +
          `"${claims.subject}" in the role's trust policy.`,
        );
      }

      if (name === 'AccessDenied') {
        throw new FederationError(
          `AWS accepted the token but refused to let it assume ${roleArn}.`,
          `The trust policy's aud/sub conditions must match: aud="${claims.audience}", ` +
          `sub="${claims.subject}".`,
        );
      }

      throw new FederationError(
        `AssumeRoleWithWebIdentity failed (${name || 'unknown error'}).`,
      );
    }

    const c = response.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) {
      throw new FederationError('AWS returned an incomplete credential set for the federated role.');
    }

    cached = {
      credentials: {
        accessKeyId: c.AccessKeyId,
        secretAccessKey: c.SecretAccessKey,
        sessionToken: c.SessionToken,
        expiration: c.Expiration,
      },
      expiresAtMs: c.Expiration ? c.Expiration.getTime() : Date.now() + 3600_000,
    };

    console.log('[AWS Federation] Assumed federated role via Entra workload identity.');
    return cached.credentials;
  };
}
