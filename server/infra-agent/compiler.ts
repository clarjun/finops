/**
 * Architecture compiler: estimator output -> deployable topology.
 *
 * The estimator lists what costs money. Deploying needs everything else too. An
 * "Amazon RDS PostgreSQL, Multi-AZ" line implies a VPC, two private subnets in
 * different availability zones, a DB subnet group and a security group — none of
 * which appear in a pricing breakdown because none of them are billed. Handing
 * the estimator's list straight to Terraform would fail on the first apply.
 *
 * This module is deterministic on purpose. Classification is a table of
 * patterns, not a second LLM call: the same requirement must compile to the same
 * topology every time, or a plan a human approved is not the plan that runs.
 * The LLM's judgement is already spent upstream choosing the services.
 */
import {
  type EstimatorLayer, type Clarifications, type LamNode, type LogicalArchitecture,
  type LogicalType, type RiskAssessment, type RiskReason, type LamMetadata,
} from './types';

/* -------------------------------------------------------------------------- */
/*  Service classification                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Maps a free-text service name onto a logical type. The estimator's `service`
 * field is model-written prose ("Amazon S3 + CloudFront"), so matching is by
 * substring, most specific first — the same ordering discipline as the cost
 * service categoriser, and for the same reason.
 */
/**
 * Services the agent builds for every deployment regardless of the estimate.
 *
 * An estimate that names them is not describing something missing — it is
 * naming the foundation the compiler synthesises anyway. Reporting those lines
 * as "not in the deployment plan" was flatly untrue: the plan contained a VPC,
 * subnets, routing and a NAT gateway while a warning said the VPC was absent.
 * On a screen someone demonstrates to their manager, that is the worst kind of
 * wrong — confidently stated and easy to check.
 */
const FOUNDATION: Array<{ match: RegExp; provides: string }> = [
  { match: /\bvpc\b|virtual network|\bvnet\b|networking/i, provides: 'the VPC, subnets and routing' },
  { match: /nat gateway|\bnat\b/i, provides: 'a NAT gateway for private egress' },
  { match: /internet gateway|\bigw\b/i, provides: 'an internet gateway' },
  { match: /security group|firewall rule/i, provides: 'security groups around each resource' },
  { match: /\biam\b|instance profile|service account/i, provides: 'an instance role with scoped permissions' },
  { match: /subnet/i, provides: 'public and private subnets across availability zones' },
];

/** What the agent already builds for a line it could not classify, if anything. */
function foundationCover(service: string, layer: string): string | null {
  const text = `${service} ${layer}`;
  return FOUNDATION.find((f) => f.match.test(text))?.provides ?? null;
}

const CLASSIFIERS: Array<{ match: RegExp; type: LogicalType }> = [
  { match: /\b(rds|aurora)\b.*postgres|postgres.*\b(rds|aurora)\b|azure database for postgres|cloud sql.*postgres/i, type: 'MANAGED_POSTGRES' },
  { match: /postgres/i, type: 'MANAGED_POSTGRES' },
  { match: /\b(rds|aurora)\b.*mysql|mysql/i, type: 'MANAGED_MYSQL' },
  { match: /dynamodb|cosmos|firestore|bigtable/i, type: 'NOSQL' },
  { match: /elasticache|memorystore|redis|memcached|cache for redis/i, type: 'CACHE' },
  // Storage ranks above CDN: on a combined "S3 + CloudFront" line the priced
  // resource is the bucket (storageSize), and cost is attributed to whichever
  // type matches first. Both are still emitted — see classifyServices.
  { match: /\bs3\b|simple storage|blob storage|cloud storage|object storage/i, type: 'OBJECT_STORAGE' },
  { match: /cloudfront|cdn|front door/i, type: 'CDN' },
  { match: /load balanc|\balb\b|\bnlb\b|\belb\b|application gateway/i, type: 'LOAD_BALANCER' },
  { match: /route\s?53|cloud dns|\bdns\b/i, type: 'DNS' },
  { match: /\bsqs\b|\bsns\b|service bus|pub\/?sub|queue/i, type: 'QUEUE' },
  { match: /secrets manager|key vault|secret manager/i, type: 'SECRETS' },
  { match: /\bkms\b|encryption key/i, type: 'ENCRYPTION_KEY' },
  { match: /cloudwatch|monitor|logging|observability/i, type: 'OBSERVABILITY' },
  { match: /backup/i, type: 'BACKUP' },
  { match: /ec2|compute|auto scaling|fargate|ecs|eks|kubernetes|lambda|app service|virtual machine/i, type: 'COMPUTE' },
];

/**
 * Every logical type a service line implies, not just the first match.
 *
 * The estimator routinely prices two resources on one line — "Amazon S3 +
 * CloudFront" is a bucket AND a CDN. Returning only the first match dropped one
 * of them from the deployment while the user was still quoted for it, which is
 * precisely the silent-omission failure this compiler exists to prevent.
 */
export function classifyServices(service: string, layer?: string): LogicalType[] {
  const haystack = `${service} ${layer ?? ''}`;
  const found: LogicalType[] = [];
  for (const c of CLASSIFIERS) {
    if (c.match.test(haystack) && !found.includes(c.type)) found.push(c.type);
  }
  return found;
}

/** The primary classification — the most specific match. Null if unrecognised. */
export function classifyService(service: string, layer?: string): LogicalType | null {
  return classifyServices(service, layer)[0] ?? null;
}

/* -------------------------------------------------------------------------- */
/*  Risk                                                                       */
/* -------------------------------------------------------------------------- */

/** Base risk per logical type, before environment and cost adjustments. */
const BASE_RISK: Partial<Record<LogicalType, { level: RiskAssessment['level']; reasons: RiskReason[] }>> = {
  IAM: { level: 'high', reasons: ['iam'] },
  SECRETS: { level: 'high', reasons: ['secrets'] },
  ENCRYPTION_KEY: { level: 'high', reasons: ['secrets'] },
  INTERNET_GATEWAY: { level: 'medium', reasons: ['public_exposure', 'network_change'] },
  LOAD_BALANCER: { level: 'medium', reasons: ['public_exposure'] },
  SECURITY_GROUP: { level: 'medium', reasons: ['network_change'] },
  NETWORK: { level: 'medium', reasons: ['network_change'] },
  ROUTING: { level: 'medium', reasons: ['network_change'] },
  MANAGED_POSTGRES: { level: 'medium', reasons: ['data_store'] },
  MANAGED_MYSQL: { level: 'medium', reasons: ['data_store'] },
  NOSQL: { level: 'medium', reasons: ['data_store'] },
  OBJECT_STORAGE: { level: 'medium', reasons: ['data_store'] },
};

const LEVEL_ORDER: RiskAssessment['level'][] = ['low', 'medium', 'high', 'critical'];

function raise(level: RiskAssessment['level'], to: RiskAssessment['level']): RiskAssessment['level'] {
  return LEVEL_ORDER.indexOf(to) > LEVEL_ORDER.indexOf(level) ? to : level;
}

/** Recurring cost above which a single resource warrants a human decision. */
const EXPENSIVE_MONTHLY_USD = 200;

export function assessRisk(
  logicalType: LogicalType,
  metadata: LamMetadata,
  estimatedMonthlyCost?: number,
): RiskAssessment {
  const base = BASE_RISK[logicalType] ?? { level: 'low' as const, reasons: [] as RiskReason[] };
  let level = base.level;
  const reasons = [...base.reasons];

  // Production is not inherently riskier to build, but a mistake there is
  // costlier to undo, so it raises anything already non-trivial.
  if (metadata.environment === 'production' && level !== 'low') {
    level = raise(level, 'high');
    reasons.push('production');
  }

  if (estimatedMonthlyCost != null && estimatedMonthlyCost >= EXPENSIVE_MONTHLY_USD) {
    level = raise(level, 'high');
    reasons.push('expensive');
  }

  // A regulated workload makes data stores and key material a compliance
  // question, not just an engineering one.
  if (metadata.compliance.length > 0 && (reasons.includes('data_store') || reasons.includes('secrets'))) {
    level = raise(level, 'high');
  }

  return { level, reasons, explanation: explainRisk(logicalType, reasons, estimatedMonthlyCost) };
}

function explainRisk(type: LogicalType, reasons: RiskReason[], cost?: number): string {
  if (reasons.length === 0) return `${type} carries no elevated risk.`;
  const parts: string[] = [];
  if (reasons.includes('iam')) parts.push('grants permissions that outlive this deployment');
  if (reasons.includes('public_exposure')) parts.push('makes resources reachable from the public internet');
  if (reasons.includes('network_change')) parts.push('changes network connectivity or routing');
  if (reasons.includes('secrets')) parts.push('handles credential or key material');
  if (reasons.includes('data_store')) parts.push('stores customer data');
  if (reasons.includes('production')) parts.push('targets a production environment');
  if (reasons.includes('expensive') && cost != null) parts.push(`adds roughly $${cost.toFixed(0)}/month`);
  return `This step ${parts.join(', ')}.`;
}

/** Approval is required above 'low' — policy can tighten this per organization. */
function needsApproval(risk: RiskAssessment): boolean {
  return risk.level !== 'low';
}

/* -------------------------------------------------------------------------- */
/*  Compilation                                                                */
/* -------------------------------------------------------------------------- */

interface NodeSeed {
  key: string;
  label: string;
  logicalType: LogicalType;
  config?: Record<string, unknown>;
  dependsOn?: string[];
  source: LamNode['source'];
  estimatedMonthlyCost?: number;
}

/** Availability levels that require spreading across two zones. */
function isMultiAz(metadata: LamMetadata): boolean {
  return metadata.availability !== 'standard';
}

export function compileArchitecture(
  layers: EstimatorLayer[],
  clarifications: Clarifications,
  requirements: string,
): LogicalArchitecture {
  const metadata: LamMetadata = {
    requirements,
    environment: clarifications.environment ?? 'development',
    availability: clarifications.availability ?? inferAvailability(requirements),
    region: clarifications.region,
    compliance: clarifications.compliance ?? [],
  };

  const warnings: string[] = [];
  const seeds: NodeSeed[] = [];
  const multiAz = isMultiAz(metadata);

  /* --- Foundation: always synthesized, never priced by the estimator ------ */

  seeds.push({
    key: 'network.vpc',
    label: 'Virtual Network',
    logicalType: 'NETWORK',
    config: { cidrBlock: '10.0.0.0/16', enableDnsHostnames: true },
    source: 'synthesized',
  });

  const zones = multiAz ? ['a', 'b'] : ['a'];
  const publicSubnets: string[] = [];
  const privateSubnets: string[] = [];

  for (let i = 0; i < zones.length; i++) {
    const az = zones[i];
    const pub = `network.subnet.public.${az}`;
    const priv = `network.subnet.private.${az}`;
    publicSubnets.push(pub);
    privateSubnets.push(priv);

    seeds.push({
      key: pub,
      label: `Public Subnet ${az.toUpperCase()}`,
      logicalType: 'SUBNET',
      config: { tier: 'public', cidrBlock: `10.0.${i * 2}.0/24`, availabilityZoneIndex: i },
      dependsOn: ['network.vpc'],
      source: 'synthesized',
    });
    seeds.push({
      key: priv,
      label: `Private Subnet ${az.toUpperCase()}`,
      logicalType: 'SUBNET',
      config: { tier: 'private', cidrBlock: `10.0.${i * 2 + 1}.0/24`, availabilityZoneIndex: i },
      dependsOn: ['network.vpc'],
      source: 'synthesized',
    });
  }

  seeds.push({
    key: 'network.igw',
    label: 'Internet Gateway',
    logicalType: 'INTERNET_GATEWAY',
    dependsOn: ['network.vpc'],
    source: 'synthesized',
  });

  seeds.push({
    key: 'network.routing.public',
    label: 'Public Route Table',
    logicalType: 'ROUTING',
    config: { tier: 'public', subnets: publicSubnets },
    dependsOn: ['network.igw', ...publicSubnets],
    source: 'synthesized',
  });

  /* --- Estimator-derived resources --------------------------------------- */

  const seen = new Map<LogicalType, number>();

  for (const layer of layers) {
    const logicalTypes = classifyServices(layer.service, layer.layer);
    if (logicalTypes.length === 0) {
      // Two different situations were being reported in identical words.
      const covered = foundationCover(layer.service, layer.layer ?? '');

      if (covered) {
        // The estimate named part of the foundation. It is in the plan — the
        // agent builds it for every deployment — just not from this line.
        warnings.push(
          `"${layer.service}" is part of the foundation the agent always builds, so it is already in this plan: ` +
          `${covered}. The estimate line itself was not used.`,
        );
      } else {
        // Genuinely absent. Never silently dropped, because the user would be
        // shown a plan missing something they were quoted for.
        warnings.push(
          `"${layer.service}" (${layer.layer}) is not supported yet and will NOT be deployed. ` +
          `Anything depending on it will need to be added by hand.`,
        );
      }
      continue;
    }

    // A line can imply several resources ("S3 + CloudFront"). Cost is attributed
    // to the primary one only, so a combined line is not counted twice.
    for (const [index, logicalType] of logicalTypes.map((t, i) => [i, t] as const)) {
    const cost = index === 0 ? layer.monthlyCost : undefined;
    const ordinal = (seen.get(logicalType) ?? 0) + 1;
    seen.set(logicalType, ordinal);
    const suffix = ordinal > 1 ? `.${ordinal}` : '';

    switch (logicalType) {
      case 'MANAGED_POSTGRES':
      case 'MANAGED_MYSQL': {
        const key = `data.${logicalType === 'MANAGED_POSTGRES' ? 'postgres' : 'mysql'}${suffix}`;
        seeds.push({
          key: `${key}.sg`,
          label: 'Database Security Group',
          logicalType: 'SECURITY_GROUP',
          config: { target: key, ingressFrom: 'compute', port: logicalType === 'MANAGED_POSTGRES' ? 5432 : 3306 },
          dependsOn: ['network.vpc'],
          source: 'synthesized',
        });
        seeds.push({
          key,
          label: layer.service,
          logicalType,
          config: {
            instanceType: layer.instanceType,
            storageGb: layer.storageSize,
            multiAz,
            // Encryption and backups are defaults, not options. A compliance
            // regime cannot be satisfied by remembering to tick a box later.
            encrypted: true,
            backupRetentionDays: metadata.environment === 'production' ? 30 : 7,
            subnets: privateSubnets,
          },
          dependsOn: [...privateSubnets, `${key}.sg`],
          source: 'estimator',
          estimatedMonthlyCost: cost,
        });
        break;
      }

      case 'OBJECT_STORAGE': {
        const key = `storage.object${suffix}`;
        seeds.push({
          key,
          label: layer.service,
          logicalType,
          config: {
            storageGb: layer.storageSize,
            versioning: true,
            encrypted: true,
            // Public access is off unless the plan explicitly asks otherwise;
            // an accidentally public bucket is the classic cloud incident.
            publicAccess: false,
            lifecycleDays: 90,
          },
          source: 'estimator',
          estimatedMonthlyCost: cost,
        });
        break;
      }

      case 'COMPUTE': {
        const key = `compute.app${suffix}`;
        seeds.push({
          key: `${key}.sg`,
          label: 'Application Security Group',
          logicalType: 'SECURITY_GROUP',
          config: { target: key, ingressFrom: 'load_balancer', port: 8080 },
          dependsOn: ['network.vpc'],
          source: 'synthesized',
        });
        seeds.push({
          key: `${key}.iam`,
          label: 'Application Instance Role',
          logicalType: 'IAM',
          config: { target: key, capabilities: ['logs:write', 'objectStorage:readWrite'] },
          source: 'synthesized',
        });
        seeds.push({
          key,
          label: layer.service,
          logicalType,
          config: {
            instanceType: layer.instanceType,
            desiredCount: layer.instanceCount ?? (multiAz ? 2 : 1),
            subnets: privateSubnets,
            autoScaling: multiAz,
          },
          dependsOn: [...privateSubnets, `${key}.sg`, `${key}.iam`],
          source: 'estimator',
          estimatedMonthlyCost: cost,
        });
        break;
      }

      case 'LOAD_BALANCER': {
        const key = `network.lb${suffix}`;
        seeds.push({
          key,
          label: layer.service,
          logicalType,
          config: { scheme: 'internet-facing', subnets: publicSubnets, healthCheckPath: '/health' },
          dependsOn: [...publicSubnets, 'network.igw'],
          source: 'estimator',
          estimatedMonthlyCost: cost,
        });
        break;
      }

      case 'CACHE': {
        const key = `data.cache${suffix}`;
        seeds.push({
          key,
          label: layer.service,
          logicalType,
          config: { instanceType: layer.instanceType, subnets: privateSubnets, multiAz },
          dependsOn: privateSubnets,
          source: 'estimator',
          estimatedMonthlyCost: cost,
        });
        break;
      }

      default: {
        const key = `${logicalType.toLowerCase()}${suffix}`;
        seeds.push({
          key,
          label: layer.service,
          logicalType,
          config: {
            instanceType: layer.instanceType,
            storageGb: layer.storageSize,
            dataTransferGb: layer.dataTransfer,
          },
          source: 'estimator',
          estimatedMonthlyCost: cost,
        });
      }
    }
    }
  }

  /* --- Implied additions -------------------------------------------------- */

  const hasPrivateWorkload = seeds.some(
    (s) => s.source === 'estimator' && Array.isArray(s.dependsOn) && s.dependsOn.some((d) => privateSubnets.includes(d)),
  );

  // Private workloads with no egress path cannot reach package repositories or
  // provider APIs. A NAT gateway is not free, so it is added only when the plan
  // actually puts something in a private subnet, and it is called out.
  if (hasPrivateWorkload) {
    seeds.push({
      key: 'network.nat',
      label: 'NAT Gateway',
      logicalType: 'NAT_GATEWAY',
      config: { subnet: publicSubnets[0] },
      dependsOn: [publicSubnets[0], 'network.igw'],
      source: 'synthesized',
    });
    seeds.push({
      key: 'network.routing.private',
      label: 'Private Route Table',
      logicalType: 'ROUTING',
      config: { tier: 'private', subnets: privateSubnets },
      dependsOn: ['network.nat', ...privateSubnets],
      source: 'synthesized',
    });
    warnings.push('A NAT gateway was added so private workloads have outbound internet access; it carries an hourly charge the estimate may not include.');
  }

  if (!seeds.some((s) => s.logicalType === 'OBSERVABILITY')) {
    seeds.push({
      key: 'ops.observability',
      label: 'Logs and Metrics',
      logicalType: 'OBSERVABILITY',
      config: { retentionDays: metadata.environment === 'production' ? 90 : 14 },
      source: 'synthesized',
    });
  }

  /* --- Finalise ----------------------------------------------------------- */

  const keys = new Set(seeds.map((s) => s.key));
  const nodes: LamNode[] = seeds.map((s) => {
    const risk = assessRisk(s.logicalType, metadata, s.estimatedMonthlyCost);
    // A dependency on a node that was never created would deadlock the DAG.
    const dependsOn = (s.dependsOn ?? []).filter((d) => {
      if (keys.has(d)) return true;
      warnings.push(`Dropped dependency ${s.key} -> ${d}: no such node.`);
      return false;
    });

    return {
      key: s.key,
      label: s.label,
      logicalType: s.logicalType,
      config: s.config ?? {},
      dependsOn,
      risk,
      requiresApproval: needsApproval(risk),
      source: s.source,
      estimatedMonthlyCost: s.estimatedMonthlyCost,
    };
  });

  return { nodes, metadata, warnings };
}

/** Availability inferred from the requirement text when not explicitly answered. */
function inferAvailability(requirements: string): LamMetadata['availability'] {
  const t = requirements.toLowerCase();
  if (/multi[- ]region|cross[- ]region/.test(t)) return 'multi_region';
  if (/multi[- ]az/.test(t)) return 'multi_az';
  if (/high availability|highly available|\bha\b/.test(t)) return 'high';
  return 'standard';
}

/* -------------------------------------------------------------------------- */
/*  Graph validation                                                           */
/* -------------------------------------------------------------------------- */

export interface GraphValidation {
  valid: boolean;
  errors: string[];
  /** Nodes grouped into dependency waves; each wave can run in parallel. */
  waves: string[][];
}

/**
 * Kahn's algorithm. Returns execution waves rather than a flat order, because
 * the engine runs independent resources concurrently — a VPC's four subnets
 * have no reason to be created one after another.
 */
export function validateGraph(nodes: LamNode[]): GraphValidation {
  const errors: string[] = [];
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const n of nodes) {
    indegree.set(n.key, 0);
    dependents.set(n.key, []);
  }
  for (const n of nodes) {
    for (const dep of n.dependsOn) {
      if (!indegree.has(dep)) {
        errors.push(`${n.key} depends on unknown node ${dep}`);
        continue;
      }
      indegree.set(n.key, (indegree.get(n.key) ?? 0) + 1);
      dependents.get(dep)!.push(n.key);
    }
  }

  const waves: string[][] = [];
  let frontier = nodes.filter((n) => (indegree.get(n.key) ?? 0) === 0).map((n) => n.key);
  let placed = 0;

  while (frontier.length > 0) {
    waves.push([...frontier].sort());
    placed += frontier.length;
    const next: string[] = [];
    for (const key of frontier) {
      for (const d of dependents.get(key) ?? []) {
        indegree.set(d, (indegree.get(d) ?? 0) - 1);
        if ((indegree.get(d) ?? 0) === 0) next.push(d);
      }
    }
    frontier = next;
  }

  if (placed !== nodes.length) {
    errors.push('Dependency cycle detected; the plan cannot be ordered for execution.');
  }

  return { valid: errors.length === 0, errors, waves };
}
