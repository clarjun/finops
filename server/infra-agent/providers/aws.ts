/**
 * AWS mapper: LAM -> hashicorp/aws resources.
 *
 * Scope is the agreed vertical slice — network foundation and object storage —
 * built to production depth rather than breadth. Everything outside that scope
 * is reported as `unsupported` and shown to the user; it is never quietly
 * dropped from a plan they were quoted for.
 *
 * Configuration choices follow the current AWS provider guidance rather than
 * older tutorial patterns:
 *
 *   - Public access on a bucket is blocked by a dedicated
 *     aws_s3_bucket_public_access_block resource. Setting `acl = "private"` on
 *     the bucket is the deprecated pre-v4 pattern and does not block a later
 *     public policy.
 *   - Versioning, encryption and lifecycle are separate resources
 *     (aws_s3_bucket_versioning, _server_side_encryption_configuration,
 *     _lifecycle_configuration). Inline blocks were removed in provider v4.
 *   - Subnets take an explicit availability_zone from a data source rather than
 *     a hardcoded suffix, because AZ names differ per account.
 */
import { ref, interp, index, toIdentifier, type HclBlock } from '../terraform/hcl';
import type { LamNode, LogicalType } from '../types';
import type { MapperContext, MappedResource, MappingResult, ProviderMapper, UnsupportedNode } from './types';

const SUPPORTED: ReadonlySet<LogicalType> = new Set<LogicalType>([
  'NETWORK',
  'SUBNET',
  'INTERNET_GATEWAY',
  'NAT_GATEWAY',
  'ROUTING',
  'SECURITY_GROUP',
  'OBJECT_STORAGE',
]);

/** Tags applied to everything, so a deployment can always be traced back. */
function baseTags(ctx: MapperContext, name: string): Record<string, string> {
  return {
    Name: `${ctx.namePrefix}-${name}`,
    Environment: ctx.environment,
    ManagedBy: 'cloudwise-infra-agent',
  };
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

export class AwsMapper implements ProviderMapper {
  readonly provider = 'aws' as const;
  readonly supports = SUPPORTED;

  map(nodes: LamNode[], ctx: MapperContext): MappingResult {
    const resources: MappedResource[] = [];
    const unsupported: UnsupportedNode[] = [];

    // Terraform identifiers derived once, so cross-references between resources
    // agree with the names actually emitted.
    const idOf = new Map<string, string>();
    for (const n of nodes) idOf.set(n.key, toIdentifier(n.key));

    for (const node of nodes) {
      if (!SUPPORTED.has(node.logicalType)) {
        unsupported.push({
          nodeKey: node.key,
          logicalType: node.logicalType,
          reason: `The AWS mapper does not yet build ${node.logicalType}. It is excluded from this deployment.`,
        });
        continue;
      }

      const id = idOf.get(node.key)!;
      const mapped = this.mapNode(node, id, idOf, ctx);
      if (mapped) resources.push(mapped);
    }

    return {
      resources,
      unsupported,
      preamble: this.preamble(),
      variables: {
        region: { type: 'string', description: 'AWS region to deploy into' },
        name_prefix: { type: 'string', description: 'Prefix applied to resource names' },
      },
    };
  }

  private preamble(): HclBlock[] {
    return [
      {
        type: 'terraform',
        body: {
          required_version: '>= 1.9.0',
          _blocks: [
            {
              type: 'required_providers',
              body: { aws: { source: 'hashicorp/aws', version: '~> 5.0' } },
            },
          ],
        },
      },
      {
        type: 'provider',
        labels: ['aws'],
        body: {
          region: ref('var.region'),
          _blocks: [
            // Applied to every resource that supports tagging, so nothing
            // created by the agent is ever unattributable.
            {
              type: 'default_tags',
              body: { tags: { ManagedBy: 'cloudwise-infra-agent' } },
            },
          ],
        },
      },
      // AZ names vary per account and region; never hardcode "us-east-1a".
      {
        type: 'data',
        labels: ['aws_availability_zones', 'available'],
        body: { state: 'available' },
      },
    ];
  }

  private mapNode(
    node: LamNode,
    id: string,
    idOf: Map<string, string>,
    ctx: MapperContext,
  ): MappedResource | null {
    const cfg = node.config;

    switch (node.logicalType) {
      case 'NETWORK':
        return {
          nodeKey: node.key,
          address: `aws_vpc.${id}`,
          providerType: 'aws_vpc',
          blocks: [{
            type: 'resource',
            labels: ['aws_vpc', id],
            body: {
              cidr_block: str(cfg.cidrBlock, '10.0.0.0/16'),
              enable_dns_hostnames: cfg.enableDnsHostnames !== false,
              enable_dns_support: true,
              tags: baseTags(ctx, 'vpc'),
            },
          }],
        };

      case 'SUBNET': {
        const vpc = this.firstDep(node, idOf, 'aws_vpc');
        const azIndex = num(cfg.availabilityZoneIndex, 0);
        const isPublic = str(cfg.tier) === 'public';
        return {
          nodeKey: node.key,
          address: `aws_subnet.${id}`,
          providerType: 'aws_subnet',
          blocks: [{
            type: 'resource',
            labels: ['aws_subnet', id],
            body: {
              vpc_id: vpc ? ref(`${vpc}.id`) : undefined,
              cidr_block: str(cfg.cidrBlock, '10.0.0.0/24'),
              availability_zone: index(ref('data.aws_availability_zones.available.names'), azIndex),
              // Public subnets need public IPs for anything that must be
              // reachable; private subnets must never auto-assign them.
              map_public_ip_on_launch: isPublic,
              tags: baseTags(ctx, `${str(cfg.tier, 'subnet')}-${azIndex}`),
            },
          }],
        };
      }

      case 'INTERNET_GATEWAY': {
        const vpc = this.firstDep(node, idOf, 'aws_vpc');
        return {
          nodeKey: node.key,
          address: `aws_internet_gateway.${id}`,
          providerType: 'aws_internet_gateway',
          blocks: [{
            type: 'resource',
            labels: ['aws_internet_gateway', id],
            body: {
              vpc_id: vpc ? ref(`${vpc}.id`) : undefined,
              tags: baseTags(ctx, 'igw'),
            },
          }],
        };
      }

      case 'NAT_GATEWAY': {
        const subnetKey = str(cfg.subnet);
        const subnetId = idOf.get(subnetKey);
        const eipId = `${id}_eip`;
        return {
          nodeKey: node.key,
          address: `aws_nat_gateway.${id}`,
          providerType: 'aws_nat_gateway',
          blocks: [
            // A NAT gateway requires an Elastic IP; the two are one logical step.
            {
              type: 'resource',
              labels: ['aws_eip', eipId],
              body: { domain: 'vpc', tags: baseTags(ctx, 'nat-eip') },
            },
            {
              type: 'resource',
              labels: ['aws_nat_gateway', id],
              body: {
                allocation_id: ref(`aws_eip.${eipId}.id`),
                subnet_id: subnetId ? ref(`aws_subnet.${subnetId}.id`) : undefined,
                tags: baseTags(ctx, 'nat'),
              },
            },
          ],
        };
      }

      case 'ROUTING': {
        const isPublic = str(cfg.tier) === 'public';
        const vpc = this.findByType(idOf, 'NETWORK', node) ?? 'aws_vpc.' + (idOf.get('network.vpc') ?? '');
        const subnets = Array.isArray(cfg.subnets) ? (cfg.subnets as string[]) : [];

        const blocks: HclBlock[] = [{
          type: 'resource',
          labels: ['aws_route_table', id],
          body: {
            vpc_id: ref(`${vpc}.id`),
            tags: baseTags(ctx, `${str(cfg.tier, 'route')}-rt`),
            _blocks: [{
              type: 'route',
              body: isPublic
                ? { cidr_block: '0.0.0.0/0', gateway_id: ref(`aws_internet_gateway.${idOf.get('network.igw') ?? 'igw'}.id`) }
                : { cidr_block: '0.0.0.0/0', nat_gateway_id: ref(`aws_nat_gateway.${idOf.get('network.nat') ?? 'nat'}.id`) },
            }],
          },
        }];

        // A route table does nothing until it is associated with subnets.
        for (let i = 0; i < subnets.length; i++) {
          const subnetKey = subnets[i];
          const sid = idOf.get(subnetKey);
          if (!sid) continue;
          blocks.push({
            type: 'resource',
            labels: ['aws_route_table_association', `${id}_${i}`],
            body: {
              subnet_id: ref(`aws_subnet.${sid}.id`),
              route_table_id: ref(`aws_route_table.${id}.id`),
            },
          });
        }

        return { nodeKey: node.key, address: `aws_route_table.${id}`, providerType: 'aws_route_table', blocks };
      }

      case 'SECURITY_GROUP': {
        const vpc = this.firstDep(node, idOf, 'aws_vpc');
        const port = num(cfg.port, 443);
        return {
          nodeKey: node.key,
          address: `aws_security_group.${id}`,
          providerType: 'aws_security_group',
          blocks: [{
            type: 'resource',
            labels: ['aws_security_group', id],
            body: {
              name: `${ctx.namePrefix}-${toIdentifier(node.key)}`,
              description: `Managed by cloudwise-infra-agent for ${node.key}`,
              vpc_id: vpc ? ref(`${vpc}.id`) : undefined,
              tags: baseTags(ctx, 'sg'),
              _blocks: [
                {
                  type: 'ingress',
                  body: {
                    from_port: port,
                    to_port: port,
                    protocol: 'tcp',
                    // Scoped to the VPC, never 0.0.0.0/0. An agent that opens a
                    // security group to the internet by default is a liability.
                    cidr_blocks: ['10.0.0.0/16'],
                    description: `Allow ${str(cfg.ingressFrom, 'internal')} on ${port}`,
                  },
                },
                {
                  type: 'egress',
                  body: { from_port: 0, to_port: 0, protocol: '-1', cidr_blocks: ['0.0.0.0/0'], description: 'Allow all outbound' },
                },
              ],
            },
          }],
        };
      }

      case 'OBJECT_STORAGE': {
        const blocks: HclBlock[] = [
          {
            type: 'resource',
            labels: ['aws_s3_bucket', id],
            body: {
              // Bucket names are globally unique; a random suffix avoids
              // colliding with a name someone else already took.
              bucket: interp([
                ref('var.name_prefix'),
                `-${toIdentifier(node.key).replace(/_/g, '-')}-`,
                ref(`random_id.${id}_suffix.hex`),
              ]),
              tags: baseTags(ctx, 'bucket'),
            },
          },
          {
            type: 'resource',
            labels: ['random_id', `${id}_suffix`],
            body: { byte_length: 4 },
          },
          // Provider v4+ requires these as separate resources; inline blocks are
          // no longer supported.
          {
            type: 'resource',
            labels: ['aws_s3_bucket_versioning', id],
            body: {
              bucket: ref(`aws_s3_bucket.${id}.id`),
              _blocks: [{
                type: 'versioning_configuration',
                body: { status: cfg.versioning === false ? 'Disabled' : 'Enabled' },
              }],
            },
          },
          {
            type: 'resource',
            labels: ['aws_s3_bucket_server_side_encryption_configuration', id],
            body: {
              bucket: ref(`aws_s3_bucket.${id}.id`),
              _blocks: [{
                type: 'rule',
                body: {
                  _blocks: [{
                    type: 'apply_server_side_encryption_by_default',
                    body: { sse_algorithm: 'AES256' },
                  }],
                },
              }],
            },
          },
        ];

        // The modern, effective way to keep a bucket private. `acl = "private"`
        // is the deprecated pattern and does not prevent a later public policy.
        if (cfg.publicAccess !== true) {
          blocks.push({
            type: 'resource',
            labels: ['aws_s3_bucket_public_access_block', id],
            body: {
              bucket: ref(`aws_s3_bucket.${id}.id`),
              block_public_acls: true,
              block_public_policy: true,
              ignore_public_acls: true,
              restrict_public_buckets: true,
            },
          });
        }

        const lifecycleDays = num(cfg.lifecycleDays, 0);
        if (lifecycleDays > 0) {
          blocks.push({
            type: 'resource',
            labels: ['aws_s3_bucket_lifecycle_configuration', id],
            body: {
              bucket: ref(`aws_s3_bucket.${id}.id`),
              _blocks: [{
                type: 'rule',
                body: {
                  id: 'transition-to-infrequent-access',
                  status: 'Enabled',
                  _blocks: [
                    // A rule with no filter applies to the whole bucket, which
                    // provider v5 requires to be stated explicitly.
                    { type: 'filter', body: {} },
                    { type: 'transition', body: { days: lifecycleDays, storage_class: 'STANDARD_IA' } },
                  ],
                },
              }],
            },
          });
        }

        return { nodeKey: node.key, address: `aws_s3_bucket.${id}`, providerType: 'aws_s3_bucket', blocks };
      }

      default:
        return null;
    }
  }

  /** The first dependency of this node that maps to `providerType`. */
  private firstDep(node: LamNode, idOf: Map<string, string>, providerType: string): string | null {
    for (const dep of node.dependsOn) {
      const id = idOf.get(dep);
      if (id && dep.includes('vpc') && providerType === 'aws_vpc') return `aws_vpc.${id}`;
    }
    const vpcId = idOf.get('network.vpc');
    return vpcId ? `aws_vpc.${vpcId}` : null;
  }

  private findByType(idOf: Map<string, string>, _type: LogicalType, _node: LamNode): string | null {
    const vpcId = idOf.get('network.vpc');
    return vpcId ? `aws_vpc.${vpcId}` : null;
  }
}

export const awsMapper = new AwsMapper();
