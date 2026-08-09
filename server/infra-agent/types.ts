/**
 * The Logical Architecture Model.
 *
 * The Cost Estimator produces a *pricing* model: a flat list of billable
 * services with instance types and sizes. It deliberately omits everything that
 * costs nothing to list but is mandatory to deploy — VPCs, subnets, route
 * tables, security groups, IAM roles. You cannot deploy from it.
 *
 * The LAM is the deployable form: a dependency graph of provider-neutral
 * resources. It sits between the estimator and every provider mapper, which is
 * what stops the agent being forked three times for AWS, Azure and GCP.
 *
 * Nothing here knows what a VPC is called on any particular cloud. `NETWORK`
 * becomes aws_vpc, azurerm_virtual_network or google_compute_network in the
 * mapper, not here.
 */

/** Provider-neutral resource classes. */
export const LOGICAL_TYPES = [
  'NETWORK',          // VPC / VNet / VPC network
  'SUBNET',           // public or private subnet
  'INTERNET_GATEWAY', // ingress from the public internet
  'NAT_GATEWAY',      // egress for private subnets
  'ROUTING',          // route tables and associations
  'SECURITY_GROUP',   // L4 firewall around a resource
  'LOAD_BALANCER',
  'COMPUTE',          // VMs, autoscaling groups, containers
  'MANAGED_POSTGRES',
  'MANAGED_MYSQL',
  'NOSQL',
  'OBJECT_STORAGE',
  'CACHE',
  'CDN',
  'DNS',
  'QUEUE',
  'IAM',              // roles, instance profiles, service accounts
  'SECRETS',
  'ENCRYPTION_KEY',
  'OBSERVABILITY',    // metrics, logs, alarms
  'BACKUP',
] as const;

export type LogicalType = (typeof LOGICAL_TYPES)[number];

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/**
 * Why a step might need a human. Kept as an enum rather than free text because
 * policy decides on these, and a policy that matches on prose is not a policy.
 */
export const RISK_REASONS = [
  'iam',              // grants permissions
  'public_exposure',  // reachable from the internet
  'network_change',   // alters routing or connectivity
  'secrets',          // handles credential material
  'production',       // targets a production environment
  'expensive',        // material recurring cost
  'destructive',      // destroys or replaces existing state
  'data_store',       // holds customer data
] as const;

export type RiskReason = (typeof RISK_REASONS)[number];

export interface RiskAssessment {
  level: RiskLevel;
  reasons: RiskReason[];
  /** Human-readable justification shown on the approval card. */
  explanation: string;
}

export interface LamNode {
  /** Stable within a plan, e.g. 'network.vpc'. Edges reference this. */
  key: string;
  label: string;
  logicalType: LogicalType;
  /** Provider-neutral configuration; the mapper translates it. */
  config: Record<string, unknown>;
  /** Keys of nodes that must exist first. */
  dependsOn: string[];
  risk: RiskAssessment;
  /**
   * Whether the estimator asked for this, or the compiler added it because the
   * requested resources cannot exist without it. Surfaced in the UI so the user
   * can see what the agent inferred rather than being silently charged for it.
   */
  source: 'estimator' | 'synthesized';
  /** Carried through from the estimator where it priced this resource. */
  estimatedMonthlyCost?: number;
  /** Set when composed from a Standard Step rather than generated fresh. */
  standardStepSlug?: string;
}

export interface LamMetadata {
  /** Verbatim requirement text the estimate was produced from. */
  requirements: string;
  environment: 'development' | 'staging' | 'production';
  availability: 'standard' | 'high' | 'multi_az' | 'multi_region';
  region?: string;
  /** Compliance regimes that tighten defaults (encryption, retention, logging). */
  compliance: string[];
}

export interface LogicalArchitecture {
  nodes: LamNode[];
  metadata: LamMetadata;
  /** Compiler notes: what was inferred, and what could not be determined. */
  warnings: string[];
}

/** The estimator's output shape, restated so this module has no import cycle. */
export interface EstimatorLayer {
  layer: string;
  service: string;
  configuration?: string;
  instanceType?: string;
  instanceCount?: number;
  storageSize?: number;
  dataTransfer?: number;
  monthlyCost?: number;
}

/** Answers to the clarification phase. Only what materially changes the build. */
export interface Clarifications {
  provider?: 'aws' | 'azure' | 'gcp';
  cloudAccountId?: number;
  region?: string;
  environment?: LamMetadata['environment'];
  availability?: LamMetadata['availability'];
  compliance?: string[];
  reuseNetworkId?: string;
}
