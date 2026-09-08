/**
 * Pure helpers for AWS cross-account identity: External IDs, role ARNs, and
 * session names.
 *
 * Separated from the credential provider so they can be tested without AWS,
 * a database, or a clock. Every one of them is a security control:
 *
 *   External ID   the confused-deputy defence. If it is guessable, an attacker
 *                 who learns a customer's role ARN can have Cloudwise assume it
 *                 on their behalf.
 *   Role ARN      parsed rather than trusted. The account in the ARN is checked
 *                 against the account the connection claims, and the assumed
 *                 identity is re-verified against AWS afterwards.
 *   Session name  lands in the customer's CloudTrail. It has to identify us and
 *                 the tenant, and must not leak anything else.
 */
import { randomBytes } from 'node:crypto';

/** Prefix so a customer reading their own trust policy can see what it is for. */
const EXTERNAL_ID_PREFIX = 'cloudwise';

/**
 * 32 bytes of CSPRNG entropy, base64url.
 *
 * Deliberately not derived from tenant name, tenant id, email, or AWS account
 * id, and not a v4 UUID: the value's only job is to be unguessable by someone
 * who knows everything else about the customer. Anything derived from public
 * facts fails that test, and a UUID advertises its own structure.
 */
export function generateExternalId(): string {
  return `${EXTERNAL_ID_PREFIX}-${randomBytes(32).toString('base64url')}`;
}

/** Shape check only — proves nothing about whether the value is correct. */
export function isPlausibleExternalId(value: unknown): boolean {
  return typeof value === 'string'
    && value.startsWith(`${EXTERNAL_ID_PREFIX}-`)
    // 32 bytes base64url is 43 chars; allow longer for future widening.
    && value.length >= EXTERNAL_ID_PREFIX.length + 1 + 43;
}

export interface ParsedRoleArn {
  accountId: string;
  roleName: string;
  /** Present for roles created under a path, e.g. /service-roles/Foo. */
  path: string;
}

/**
 * Parses an IAM role ARN, or returns null.
 *
 * Only `arn:<partition>:iam::<account>:role/...` is accepted. Rejecting other
 * services and resource types here means a caller cannot be tricked into
 * assuming something that merely looks like a role, and the account id becomes
 * available for the cross-check against what the connection claims.
 *
 * Partition is allowed to vary (aws, aws-cn, aws-us-gov) because the value is
 * the customer's, not ours.
 */
export function parseRoleArn(arn: unknown): ParsedRoleArn | null {
  if (typeof arn !== 'string') return null;

  const m = arn.trim().match(
    /^arn:(aws|aws-cn|aws-us-gov):iam::(\d{12}):role\/(.*)$/,
  );
  if (!m) return null;

  const [, , accountId, remainder] = m;
  if (remainder.length === 0 || remainder.length > 512) return null;

  const lastSlash = remainder.lastIndexOf('/');
  const roleName = lastSlash === -1 ? remainder : remainder.slice(lastSlash + 1);
  const path = lastSlash === -1 ? '/' : `/${remainder.slice(0, lastSlash)}/`;

  // IAM role names permit these characters and nothing else.
  if (!/^[\w+=,.@-]{1,64}$/.test(roleName)) return null;

  return { accountId, roleName, path };
}

/** True when the ARN is a well-formed IAM role ARN. */
export function isValidRoleArn(arn: unknown): boolean {
  return parseRoleArn(arn) !== null;
}

/**
 * The RoleSessionName recorded in the customer's CloudTrail.
 *
 * Carries the product, the tenant and the privilege tier — enough for a
 * customer auditing their own account to see who did what and with which role,
 * and nothing more. No usernames, no emails: this string is written into logs
 * outside our control.
 *
 * AWS allows 2-64 chars of [\w+=,.@-]; anything else is rejected at the API and
 * would surface as an opaque validation error deep inside a cost fetch.
 */
export function buildSessionName(organizationId: number, tier: string): string {
  const raw = `cloudwise-${tier}-org${organizationId}`;
  return raw.replace(/[^\w+=,.@-]/g, '-').slice(0, 64);
}
