/**
 * Builds AWS SDK clients from tier-scoped temporary credentials.
 *
 * Before this existed, credentials were resolved at 34 separate client
 * constructions across 16 files. Each was an opportunity to forget the tenant
 * predicate, to reach for process.env, or to hand a cost query a credential
 * that could terminate an instance — and two of those had already happened.
 *
 * Every AWS client in the application should be built here, so the privilege
 * tier is a required argument rather than an afterthought.
 *
 *     const ce = await awsClient('readonly', CostExplorerClient);
 *     const ec2 = await awsClient('remediation', EC2Client, { region: 'eu-west-1' });
 *
 * The tier is first because it is the security-relevant decision, and being
 * unable to omit it is the point.
 */
import type { AwsRoleTier } from '@shared/schema';
import { resolveAwsCredentials } from './credential-provider';

/** Anything constructible with `{ region, credentials, maxAttempts }`. */
type AwsClientCtor<T> = new (config: {
  region: string;
  credentials: () => Promise<any>;
  maxAttempts?: number;
  retryMode?: string;
}) => T;

export interface AwsClientOptions {
  /** Defaults to AWS_DEFAULT_REGION, then us-east-1. */
  region?: string;
  /** Which connection, when a tenant has more than one AWS account. */
  connectionId?: number;
  /**
   * Retries. Adaptive by default: it backs off on throttling rather than
   * hammering, which matters for Cost Explorer and for paginated inventory
   * sweeps over large accounts.
   */
  maxAttempts?: number;
}

export const DEFAULT_AWS_REGION = process.env.AWS_DEFAULT_REGION || 'us-east-1';

/**
 * Cost Explorer, Budgets, Organizations and IAM are global services whose
 * endpoints live in us-east-1. Sending them to a customer's regional endpoint
 * fails with an unhelpful signing error, so the caller's region is ignored for
 * these rather than being obeyed into a bug.
 */
const GLOBAL_SERVICES = new Set([
  'CostExplorerClient',
  'BudgetsClient',
  'OrganizationsClient',
  'IAMClient',
  'PricingClient',
]);

/**
 * An AWS client for one privilege tier.
 *
 * `credentials` is passed as the provider FUNCTION, not a resolved object, so
 * the SDK re-invokes it when a request finds the session near expiry. That is
 * what lets a 45-minute operation outlive a 60-minute credential.
 */
export async function awsClient<T>(
  tier: AwsRoleTier,
  Ctor: AwsClientCtor<T>,
  options: AwsClientOptions = {},
): Promise<T> {
  const provider = await resolveAwsCredentials(tier, options.connectionId);

  const region = GLOBAL_SERVICES.has(Ctor.name)
    ? 'us-east-1'
    : options.region ?? DEFAULT_AWS_REGION;

  return new Ctor({
    region,
    credentials: provider,
    maxAttempts: options.maxAttempts ?? 5,
    retryMode: 'adaptive',
  });
}

/**
 * A read-only client. The overwhelming majority of calls.
 *
 * Named separately so the common case is short and the privileged cases have to
 * be spelled out — reading `awsClient('remediation', …)` at a call site should
 * feel like a decision.
 */
export async function awsReadClient<T>(
  Ctor: AwsClientCtor<T>,
  options: AwsClientOptions = {},
): Promise<T> {
  return awsClient('readonly', Ctor, options);
}
