/**
 * Reading a Terraform plan for the things that actually go wrong.
 *
 * The approval gate has always told an approver *that* a stage is risky —
 * "Creates a database — risk: high". It never told them *what* about it was
 * risky, because the evidence was thrown away: `terraform show -json` contains
 * every attribute the apply will set, and the parser discarded all of it.
 *
 * This is the difference between this review surface and a pull request diff.
 * A diff shows a reviewer text and hopes they notice `publicly_accessible =
 * true` in the fortieth line of a resource block. This reads the value and says
 * so, at the top, in red.
 *
 * ── Design rules ────────────────────────────────────────────────────────────
 *
 * Only explicit values are flagged. A missing attribute is NOT treated as
 * insecure: Terraform omits attributes whose value is not yet known, and
 * providers apply their own defaults. Flagging absence would produce a finding
 * on almost every resource, and a review surface that cries wolf is one people
 * learn to click past — which is worse than no review at all, because it
 * manufactures a record of oversight that did not happen.
 *
 * Every rule is a pure function of one planned change, so the whole inspector
 * is testable without Terraform, a cloud account, or a database.
 */
import type { PlannedChange } from './executor';

export type PlanFindingSeverity = 'critical' | 'high' | 'medium';

export interface PlanFinding {
  /** Terraform address, e.g. aws_db_instance.main. */
  address: string;
  resourceType: string;
  severity: PlanFindingSeverity;
  /** Short, specific, readable on one line. */
  title: string;
  /** Why it matters, and what to do instead. */
  detail: string;
  /** The attribute that triggered it, for the reviewer to find in the config. */
  attribute?: string;
}

/** Ports that should essentially never be open to the whole internet. */
const ADMIN_PORTS: Record<number, string> = {
  22: 'SSH',
  3389: 'RDP',
  3306: 'MySQL',
  5432: 'PostgreSQL',
  1433: 'SQL Server',
  27017: 'MongoDB',
  6379: 'Redis',
  9200: 'Elasticsearch',
};

const OPEN_WORLD = new Set(['0.0.0.0/0', '::/0']);

/**
 * Resources whose replacement destroys data rather than swapping a component.
 *
 * Terraform reports a replacement as delete+create, which reads in a summary as
 * "1 to add, 1 to destroy" — the same shape as replacing a security group.
 * For these, it means the contents are gone.
 */
const STATEFUL_TYPES = new Set([
  'aws_db_instance',
  'aws_rds_cluster',
  'aws_dynamodb_table',
  'aws_s3_bucket',
  'aws_ebs_volume',
  'aws_efs_file_system',
  'aws_elasticache_cluster',
  'aws_docdb_cluster',
  'azurerm_mssql_database',
  'azurerm_storage_account',
  'google_sql_database_instance',
  'google_storage_bucket',
]);

const isTrue = (v: unknown): boolean => v === true || v === 'true';
const isFalse = (v: unknown): boolean => v === false || v === 'false';

function asRecords(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v));
  }
  if (value && typeof value === 'object') return [value as Record<string, unknown>];
  return [];
}

function cidrsOf(rule: Record<string, unknown>): string[] {
  const raw = rule.cidr_blocks ?? rule.ipv6_cidr_blocks ?? rule.source_address_prefixes ?? rule.source_ranges;
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === 'string');
  if (typeof raw === 'string') return [raw];
  return [];
}

// ── Rules ─────────────────────────────────────────────────────────────────────

type Rule = (change: PlannedChange, after: Record<string, unknown>) => PlanFinding[];

/** Reachable from the public internet. */
const publicExposure: Rule = (c, after) => {
  const findings: PlanFinding[] = [];

  if (isTrue(after.publicly_accessible)) {
    findings.push({
      address: c.address,
      resourceType: c.resourceType,
      severity: 'critical',
      title: 'Database will be reachable from the public internet',
      detail:
        'publicly_accessible is true, so this database gets a public endpoint. Public exposure of a data ' +
        'store is the most common root cause of a cloud data breach. Place it in a private subnet and reach ' +
        'it through the application tier instead.',
      attribute: 'publicly_accessible',
    });
  }

  if (isTrue(after.associate_public_ip_address)) {
    findings.push({
      address: c.address,
      resourceType: c.resourceType,
      severity: 'high',
      title: 'Instance will get a public IP address',
      detail:
        'associate_public_ip_address is true. If this instance does not need to serve traffic directly, ' +
        'put it behind a load balancer or NAT gateway so it is not addressable from the internet.',
      attribute: 'associate_public_ip_address',
    });
  }

  // Azure and GCP spell the same idea differently.
  if (after.public_network_access_enabled === true || after.public_network_access === 'Enabled') {
    findings.push({
      address: c.address,
      resourceType: c.resourceType,
      severity: 'critical',
      title: 'Public network access is enabled',
      detail: 'This resource accepts connections from outside the virtual network. Restrict it to a private endpoint.',
      attribute: 'public_network_access_enabled',
    });
  }

  return findings;
};

/** Encryption at rest switched off explicitly. */
const encryption: Rule = (c, after) => {
  const findings: PlanFinding[] = [];

  for (const key of ['storage_encrypted', 'encrypted', 'encryption_enabled', 'infrastructure_encryption_enabled']) {
    if (isFalse(after[key])) {
      findings.push({
        address: c.address,
        resourceType: c.resourceType,
        severity: 'critical',
        title: 'Data at rest will not be encrypted',
        detail:
          `${key} is false. Encryption at rest is assumed by SOC 2, ISO 27001 and most customer contracts, ` +
          'it costs nothing on every major provider, and on several resource types it can only be set at ' +
          'creation — so fixing it later means rebuilding this resource.',
        attribute: key,
      });
      break;   // one finding per resource; the several spellings mean the same thing
    }
  }

  return findings;
};

/** Ingress open to the entire internet. */
const openIngress: Rule = (c, after) => {
  const findings: PlanFinding[] = [];

  for (const rule of asRecords(after.ingress)) {
    const open = cidrsOf(rule).filter((cidr) => OPEN_WORLD.has(cidr));
    if (open.length === 0) continue;

    const from = Number(rule.from_port ?? rule.port ?? NaN);
    const to = Number(rule.to_port ?? rule.port ?? NaN);
    const named = Object.entries(ADMIN_PORTS)
      .filter(([port]) => Number.isFinite(from) && Number.isFinite(to) && Number(port) >= from && Number(port) <= to)
      .map(([, name]) => name);

    const wholeRange = from === 0 && to === 65535;

    findings.push({
      address: c.address,
      resourceType: c.resourceType,
      severity: named.length > 0 || wholeRange ? 'critical' : 'high',
      title: wholeRange
        ? 'Every port is open to the entire internet'
        : named.length > 0
          ? `${named.join('/')} is open to the entire internet`
          : `Port ${Number.isFinite(from) ? from : '?'} is open to the entire internet`,
      detail:
        `An ingress rule allows ${open.join(' and ')}. ` +
        (named.length > 0
          ? `${named.join('/')} exposed to the world is scanned continuously and will be found within minutes. ` +
            'Restrict it to a known CIDR, or reach the host through SSM Session Manager or a bastion.'
          : 'Restrict the source to the CIDR that actually needs access.'),
      attribute: 'ingress',
    });
  }

  return findings;
};

/** Object storage left publicly readable. */
const publicStorage: Rule = (c, after) => {
  const findings: PlanFinding[] = [];

  if (typeof after.acl === 'string' && after.acl.startsWith('public')) {
    findings.push({
      address: c.address,
      resourceType: c.resourceType,
      severity: 'critical',
      title: 'Bucket ACL makes its contents public',
      detail: `acl is "${after.acl}", so anyone can read the objects in this bucket. Use a bucket policy scoped to the principals that need it.`,
      attribute: 'acl',
    });
  }

  // aws_s3_bucket_public_access_block: every one of these being false is the
  // configuration that has caused most public-bucket incidents.
  const blocks = ['block_public_acls', 'block_public_policy', 'ignore_public_acls', 'restrict_public_buckets'];
  const disabled = blocks.filter((b) => isFalse(after[b]));
  if (disabled.length > 0) {
    findings.push({
      address: c.address,
      resourceType: c.resourceType,
      severity: disabled.length === blocks.length ? 'critical' : 'high',
      title: 'Public access protections are disabled on this bucket',
      detail: `${disabled.join(', ')} ${disabled.length === 1 ? 'is' : 'are'} false. Leave every public access block enabled unless this bucket is deliberately a public website.`,
      attribute: disabled[0],
    });
  }

  return findings;
};

/** Safety nets on data stores turned off. */
const dataProtection: Rule = (c, after) => {
  const findings: PlanFinding[] = [];

  if (isFalse(after.deletion_protection)) {
    findings.push({
      address: c.address,
      resourceType: c.resourceType,
      severity: 'medium',
      title: 'Deletion protection is disabled',
      detail: 'A mistaken destroy or a replacement would remove this resource and its data with no confirmation step.',
      attribute: 'deletion_protection',
    });
  }

  if (after.backup_retention_period === 0) {
    findings.push({
      address: c.address,
      resourceType: c.resourceType,
      severity: 'high',
      title: 'Automated backups are disabled',
      detail: 'backup_retention_period is 0, so there is no point-in-time recovery. Any data loss is permanent.',
      attribute: 'backup_retention_period',
    });
  }

  if (isTrue(after.skip_final_snapshot)) {
    findings.push({
      address: c.address,
      resourceType: c.resourceType,
      severity: 'medium',
      title: 'No final snapshot will be taken on deletion',
      detail: 'skip_final_snapshot is true. If this database is ever destroyed, its contents are unrecoverable.',
      attribute: 'skip_final_snapshot',
    });
  }

  return findings;
};

/** IAM grants wider than the workload needs. */
const iamBreadth: Rule = (c, after) => {
  if (!/iam|role_policy|policy/i.test(c.resourceType)) return [];

  const doc = after.policy ?? after.assume_role_policy ?? after.inline_policy;
  const text = typeof doc === 'string' ? doc : doc ? JSON.stringify(doc) : '';
  if (!text) return [];

  const wildcardAction = /"Action"\s*:\s*(\[\s*)?"\*"/i.test(text);
  const wildcardResource = /"Resource"\s*:\s*(\[\s*)?"\*"/i.test(text);
  if (!wildcardAction && !wildcardResource) return [];

  return [{
    address: c.address,
    resourceType: c.resourceType,
    severity: wildcardAction && wildcardResource ? 'critical' : 'high',
    title: wildcardAction && wildcardResource
      ? 'Policy grants every action on every resource'
      : `Policy uses a wildcard ${wildcardAction ? 'action' : 'resource'}`,
    detail:
      'A wildcard grant outlives this deployment and applies to anything that can assume the role. ' +
      'Scope it to the actions and ARNs this workload actually uses.',
    attribute: 'policy',
  }];
};

/**
 * Replacement of a resource that holds data.
 *
 * Terraform reports a replacement as delete+create, which in a summary looks
 * identical to swapping a security group. For a database or a bucket it means
 * the contents are destroyed, and that distinction is invisible in the counts.
 */
const statefulReplacement: Rule = (c) => {
  if (c.action !== 'replace' && c.action !== 'delete') return [];
  if (!STATEFUL_TYPES.has(c.resourceType)) return [];

  return [{
    address: c.address,
    resourceType: c.resourceType,
    severity: 'critical',
    title: c.action === 'replace'
      ? 'This resource will be DESTROYED and recreated — its data will be lost'
      : 'This resource will be DESTROYED — its data will be lost',
    detail:
      c.action === 'replace'
        ? 'Terraform plans to replace this resource because an immutable attribute changed. The existing ' +
          'instance is deleted first: contents are not migrated. Take a snapshot before approving, or change ' +
          'the plan so the attribute is not modified.'
        : 'Terraform plans to delete this resource. Its contents go with it.',
  }];
};

const RULES: Rule[] = [
  publicExposure,
  encryption,
  openIngress,
  publicStorage,
  dataProtection,
  iamBreadth,
  statefulReplacement,
];

// ── Entry point ───────────────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<PlanFindingSeverity, number> = { critical: 0, high: 1, medium: 2 };

/**
 * Inspects a planned change set.
 *
 * Worst first, because a reviewer reads the top of a list and skims the rest.
 */
export function inspectPlan(changes: PlannedChange[]): PlanFinding[] {
  const findings: PlanFinding[] = [];

  for (const change of changes) {
    // statefulReplacement needs no attributes; the others do.
    findings.push(...statefulReplacement(change, {}));

    const after = change.after;
    if (!after) continue;

    for (const rule of RULES) {
      if (rule === statefulReplacement) continue;
      try {
        findings.push(...rule(change, after));
      } catch (err) {
        // One malformed attribute must not hide every other finding in the
        // plan. Silence here would be the dangerous outcome, so it is logged.
        console.error(`[PlanRisk] Rule failed on ${change.address}:`, (err as Error)?.message ?? err);
      }
    }
  }

  return findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/** One line for the approval summary: "2 critical, 1 high". */
export function summarizeFindings(findings: PlanFinding[]): string {
  if (findings.length === 0) return 'No attribute-level risks detected in the plan.';
  const counts = findings.reduce<Record<string, number>>((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, {});
  return (['critical', 'high', 'medium'] as const)
    .filter((s) => counts[s])
    .map((s) => `${counts[s]} ${s}`)
    .join(', ');
}

/** True when the plan contains something that should stop an approval. */
export function hasBlockingFindings(findings: PlanFinding[]): boolean {
  return findings.some((f) => f.severity === 'critical');
}
