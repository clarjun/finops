/**
 * Diagnosis: what actually went wrong, and what to do about it.
 *
 * The classifier in failure.ts decides whether to retry. This decides what to
 * tell the person left holding a stopped deployment. "terraform apply failed:
 * AccessDenied" is technically complete and practically useless — the useful
 * version names the permission, says which resource wanted it, and links the
 * page that documents it.
 *
 * Most of what is worth saying can be extracted from the error itself. AWS puts
 * the missing IAM action, the exhausted quota and the offending parameter
 * directly in the message, and pulling them out is deterministic. That is the
 * work this module does.
 *
 * The deliberate limit: a remedy is only ever *applied* automatically when it
 * maps onto an answer the user already gave — a clarification like availability
 * or region. Anything else is guidance for a human. Rewriting someone's
 * infrastructure from a guess about an error message, and then deploying it, is
 * the point at which a helpful agent becomes a dangerous one. Where we cannot
 * be sure, this says so instead of inventing a fix.
 */
import type { Clarifications } from './types';

export interface Remedy {
  /** Stable identifier, for tests and telemetry. */
  code: string;
  /** One line: what went wrong, in the reader's terms. */
  title: string;
  /** Why it happened and what will resolve it. */
  explanation: string;
  /** Provider documentation, where there is a specific page worth reading. */
  docUrl?: string;
  /**
   * A change to a clarification answer that would fix it. Present only when we
   * are confident; the deployment can be recompiled from it.
   */
  change?: { field: keyof Clarifications; to: string; describes: string };
  /** What a person has to do outside this system, when there is no change. */
  manualSteps?: string[];
}

const DOCS = {
  dbSubnetGroup: 'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_VPC.WorkingWithRDSInstanceinaVPC.html',
  iamActions: 'https://docs.aws.amazon.com/service-authorization/latest/reference/reference_policies_actions-resources-contextkeys.html',
  quotas: 'https://console.aws.amazon.com/servicequotas/home',
  instanceClasses: 'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.DBInstanceClass.html',
  capacity: 'https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/troubleshooting-launch.html#troubleshooting-launch-capacity',
} as const;

/** `not authorized to perform: ec2:CreateVpc` → `ec2:CreateVpc`. */
function missingAction(text: string): string | null {
  const m = text.match(/not authorized to perform:?\s*([a-z0-9-]+:[A-Za-z0-9*]+)/i)
    ?? text.match(/User:.*is not authorized to perform:?\s*([a-z0-9-]+:[A-Za-z0-9*]+)/i);
  return m?.[1] ?? null;
}

/** The quota AWS named, if it named one. */
function quotaName(text: string): string | null {
  const m = text.match(/\b([A-Za-z]*(?:Vcpu|Address|Vpc|Instance|Volume|Rule|Gateway)[A-Za-z]*LimitExceeded)\b/)
    ?? text.match(/\b(LimitExceeded|MaxNumberOf[A-Za-z]*)\b/);
  return m?.[1] ?? null;
}

/** The parameter and value a provider rejected. */
function invalidParameter(text: string): { name: string | null; value: string | null } {
  const value = text.match(/Invalid[A-Za-z]*(?:Value)?:\s*(?:Invalid\s+)?(?:DB instance class|value|parameter)?\s*:?\s*([A-Za-z0-9._-]+)/i)?.[1] ?? null;
  const name = text.match(/\b(Invalid[A-Za-z]+)\b/)?.[1] ?? null;
  return { name, value };
}

/**
 * Works out the most useful thing to say about a failure.
 *
 * Ordered most specific first. Returns null when the error is not one we can
 * say anything better about than the raw text — a wrong diagnosis is worse than
 * none, because it sends someone looking in the wrong place.
 */
export function diagnose(errorText: string, context: { clarifications?: Clarifications } = {}): Remedy | null {
  const text = (errorText ?? '').slice(0, 8000);
  if (!text.trim()) return null;

  /* ---- the spec's own example ------------------------------------------ */

  // RDS requires subnets in at least two availability zones, whatever the
  // requested availability. A single-AZ answer produces one private subnet and
  // the subnet group is rejected.
  if (/DBSubnetGroupDoesNotCoverEnoughAZs|subnet group.*at least two|does not cover enough availability zones/i.test(text)) {
    const current = context.clarifications?.availability;
    return {
      code: 'rds-subnet-group-azs',
      title: 'The database needs subnets in two availability zones',
      explanation:
        'RDS requires a subnet group spanning at least two availability zones, even for a single-instance database. ' +
        (current && current !== 'standard'
          ? 'The plan already asks for more than one zone, so this is worth checking against the subnets that were actually created.'
          : 'The current answer produced subnets in one zone only.'),
      docUrl: DOCS.dbSubnetGroup,
      // Only offered when the current answer is the cause; otherwise the change
      // would claim to fix something it does not.
      change: !current || current === 'standard'
        ? { field: 'availability', to: 'multi_az', describes: 'spread subnets across two availability zones' }
        : undefined,
      manualSteps: current && current !== 'standard'
        ? ['Check which subnets were created and whether two distinct availability zones were used.']
        : undefined,
    };
  }

  /* ---- permissions ------------------------------------------------------ */

  if (/AccessDenied|UnauthorizedOperation|not authorized to perform/i.test(text)) {
    const action = missingAction(text);
    return {
      code: 'iam-permission-missing',
      title: action
        ? `The deployment credentials cannot perform ${action}`
        : 'The deployment credentials are missing a permission',
      explanation: action
        ? `AWS refused the call because the credentials this deployment uses are not allowed to perform ${action}. ` +
          'Granting that action to the role or user behind the connected account will let the run continue from where it stopped.'
        : 'AWS refused a call as unauthorised but did not name the action. The raw error below will name the resource being created.',
      docUrl: DOCS.iamActions,
      manualSteps: [
        action ? `Add ${action} to the IAM policy for the connected AWS account.` : 'Identify the refused call in the error below.',
        'Then resume the deployment — nothing that was already created is affected.',
      ],
    };
  }

  /* ---- credentials ------------------------------------------------------ */

  if (/ExpiredToken|TokenRefreshRequired|security token.*expired/i.test(text)) {
    return {
      code: 'credentials-expired',
      title: 'The stored credentials have expired',
      explanation:
        'The credentials for this account are no longer valid. They are stored encrypted and are not readable here; ' +
        'they need replacing on the account before the run can continue.',
      manualSteps: [
        'Update the credentials for this cloud account under Configuration.',
        'Then resume the deployment.',
      ],
    };
  }

  /* ---- quota ------------------------------------------------------------ */

  if (/quota|LimitExceeded|MaxNumberOf|exceeded the maximum/i.test(text) && !/RequestLimitExceeded|Throttl/i.test(text)) {
    const quota = quotaName(text);
    return {
      code: 'quota-exhausted',
      title: quota ? `The account has reached its ${quota} limit` : 'An account limit was reached',
      explanation:
        'This is a limit on the AWS account rather than a problem with the plan. The same deployment will finish once ' +
        'the limit is raised — nothing needs to change in the architecture.',
      docUrl: DOCS.quotas,
      manualSteps: [
        quota ? `Request an increase for ${quota} in Service Quotas.` : 'Find the limit named in the error and request an increase.',
        'Then resume the deployment.',
      ],
    };
  }

  /* ---- capacity --------------------------------------------------------- */

  if (/InsufficientInstanceCapacity|capacity is not available/i.test(text)) {
    return {
      code: 'no-capacity',
      title: 'The region has no capacity for this instance type right now',
      explanation:
        'AWS could not provide the requested instance type in this availability zone. This is temporary and specific to ' +
        'the zone; it is not a fault in the plan.',
      docUrl: DOCS.capacity,
      manualSteps: [
        'Resume in a little while, or',
        'recompile the plan in a different region.',
      ],
    };
  }

  /* ---- an invalid parameter --------------------------------------------- */

  if (/InvalidParameterValue|ValidationError|is not a valid/i.test(text)) {
    const { value } = invalidParameter(text);
    const looksLikeDbClass = /db\.[a-z0-9]+\.[a-z]+/i.test(text);
    return {
      code: 'invalid-parameter',
      title: value ? `The provider rejected "${value}"` : 'The provider rejected a value in the configuration',
      explanation:
        'The configuration asked for something this provider does not accept. This will not resolve on its own; the ' +
        'estimate that produced the value needs correcting and the plan recompiling.' +
        (looksLikeDbClass ? ' Instance classes differ by engine and region, so a class valid elsewhere can be rejected here.' : ''),
      docUrl: looksLikeDbClass ? DOCS.instanceClasses : undefined,
      manualSteps: [
        'Correct the value in the Cost Estimator and create the agent again.',
        'The resources already created can be removed with a teardown if they are no longer wanted.',
      ],
    };
  }

  /* ---- name collisions -------------------------------------------------- */

  if (/AlreadyExists|EntityAlreadyExists|already in use|DuplicateName/i.test(text)) {
    return {
      code: 'name-taken',
      title: 'Something with this name already exists',
      explanation:
        'A resource this plan creates has a name that is already taken in the account. Deploying the same plan twice ' +
        'into one account is the usual cause; the existing resources are not touched by this failure.',
      manualSteps: [
        'Check whether an earlier deployment of this plan is still in place.',
        'Either tear that one down, or deploy this one into a different account or region.',
      ],
    };
  }

  return null;
}

/**
 * Whether a remedy can be applied by recompiling rather than by a person.
 *
 * Deliberately narrow. A remedy earns this only by mapping onto an answer the
 * user themselves gave, so applying it changes their stated intent in a way
 * they can recognise — not a rewrite of infrastructure derived from a guess
 * about an error message.
 */
export function isAutoApplicable(remedy: Remedy | null): remedy is Remedy & { change: NonNullable<Remedy['change']> } {
  return remedy?.change != null;
}
