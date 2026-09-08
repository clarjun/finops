/**
 * AWS mapper: LAM -> hashicorp/aws resources.
 *
 * Covers what a three-tier application needs to actually run: the network
 * foundation, object storage, an instance role, compute behind a load balancer,
 * and a managed relational database. Built to production depth rather than
 * breadth — everything outside that is reported as `unsupported` and shown to
 * the user; it is never quietly dropped from a plan they were quoted for.
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
import { ref, interp, index, toIdentifier, type HclBlock, type HclBody, type HclRef } from '../terraform/hcl';
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
  'IAM',
  'COMPUTE',
  'LOAD_BALANCER',
  'MANAGED_POSTGRES',
  'MANAGED_MYSQL',
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
      preamble: [...this.preamble(), ...this.conditionalData(nodes)],
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

  /**
   * Data sources only some graphs need.
   *
   * Declared conditionally because each one is an API call at plan time. A
   * network-only deployment should not describe every AMI in the account to
   * find an image it will never launch.
   */
  private conditionalData(nodes: LamNode[]): HclBlock[] {
    const blocks: HclBlock[] = [];
    const has = (t: LogicalType) => nodes.some((n) => n.logicalType === t);

    if (has('IAM')) {
      // Needed to scope policy ARNs to this account and region rather than "*".
      blocks.push(
        { type: 'data', labels: ['aws_caller_identity', 'current'], body: {} },
        { type: 'data', labels: ['aws_region', 'current'], body: {} },
      );
    }

    if (has('COMPUTE')) {
      // Resolved at plan time rather than pinned: a hardcoded AMI id is wrong in
      // every region but one, and is an unpatched image the day after it is
      // written. Amazon Linux 2 is end-of-life, so this tracks 2023.
      blocks.push({
        type: 'data',
        labels: ['aws_ami', 'al2023'],
        body: {
          most_recent: true,
          owners: ['amazon'],
          _blocks: [
            { type: 'filter', body: { name: 'name', values: ['al2023-ami-2023.*-x86_64'] } },
            { type: 'filter', body: { name: 'state', values: ['available'] } },
          ],
        },
      });
    }

    return blocks;
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

      case 'IAM': {
        const capabilities = Array.isArray(cfg.capabilities) ? (cfg.capabilities as string[]) : [];
        const blocks: HclBlock[] = [
          // A policy document data source rather than a jsonencode() literal:
          // the HCL writer only emits references it built itself, so an inline
          // JSON policy would have to be assembled by string concatenation —
          // the exact thing this generator refuses to do.
          {
            type: 'data',
            labels: ['aws_iam_policy_document', `${id}_assume`],
            body: {
              _blocks: [{
                type: 'statement',
                body: {
                  actions: ['sts:AssumeRole'],
                  _blocks: [{
                    type: 'principals',
                    body: { type: 'Service', identifiers: ['ec2.amazonaws.com'] },
                  }],
                },
              }],
            },
          },
          {
            type: 'resource',
            labels: ['aws_iam_role', id],
            body: {
              name: interp([ref('var.name_prefix'), `-${toIdentifier(node.key).replace(/_/g, '-')}`]),
              assume_role_policy: ref(`data.aws_iam_policy_document.${id}_assume.json`),
              tags: baseTags(ctx, 'role'),
            },
          },
          {
            type: 'resource',
            labels: ['aws_iam_instance_profile', `${id}_profile`],
            body: {
              name: interp([ref('var.name_prefix'), `-${toIdentifier(node.key).replace(/_/g, '-')}`]),
              role: ref(`aws_iam_role.${id}.name`),
              tags: baseTags(ctx, 'instance-profile'),
            },
          },
        ];

        // Each capability becomes a policy scoped to specific ARNs. A wildcard
        // resource would be shorter and is what a naive generator emits; it
        // would also hand every instance the agent creates a permission far
        // wider than the plan called for, on an account the agent does not own.
        for (const capability of capabilities) {
          const statement = this.capabilityStatement(capability, id, idOf);
          if (!statement) continue;   // nothing in this graph to grant against

          blocks.push(
            { type: 'data', labels: ['aws_iam_policy_document', statement.docId], body: statement.body },
            {
              type: 'resource',
              labels: ['aws_iam_role_policy', statement.docId],
              body: {
                name: statement.name,
                role: ref(`aws_iam_role.${id}.id`),
                policy: ref(`data.aws_iam_policy_document.${statement.docId}.json`),
              },
            },
          );
        }

        return { nodeKey: node.key, address: `aws_iam_role.${id}`, providerType: 'aws_iam_role', blocks };
      }

      case 'COMPUTE': {
        const sgId = this.depId(node, idOf, '.sg');
        const iamId = this.depId(node, idOf, '.iam');
        const subnetIds = this.subnetIds(cfg, idOf);
        const instanceType = str(cfg.instanceType, 't3.small');
        const desired = Math.max(1, num(cfg.desiredCount, 1));
        const lbId = this.findLoadBalancer(idOf);

        const blocks: HclBlock[] = [{
          type: 'resource',
          labels: ['aws_launch_template', id],
          body: {
            name_prefix: interp([ref('var.name_prefix'), '-app-']),
            image_id: ref('data.aws_ami.al2023.id'),
            instance_type: instanceType,
            vpc_security_group_ids: sgId ? [ref(`aws_security_group.${sgId}.id`)] : undefined,
            update_default_version: true,
            _blocks: [
              ...(iamId ? [{
                type: 'iam_instance_profile',
                body: { name: ref(`aws_iam_instance_profile.${iamId}_profile.name`) },
              }] : []),
              {
                // IMDSv2 required. The v1 endpoint is what turns a single SSRF
                // in an application into stolen instance credentials, and it is
                // still the default on a launch template that says nothing.
                type: 'metadata_options',
                body: { http_tokens: 'required', http_endpoint: 'enabled', http_put_response_hop_limit: 1 },
              },
              {
                type: 'block_device_mappings',
                body: {
                  device_name: '/dev/xvda',
                  _blocks: [{
                    type: 'ebs',
                    body: { volume_size: num(cfg.rootVolumeGb, 20), volume_type: 'gp3', encrypted: true, delete_on_termination: true },
                  }],
                },
              },
              { type: 'monitoring', body: { enabled: true } },
              {
                type: 'tag_specifications',
                body: { resource_type: 'instance', tags: baseTags(ctx, 'app') },
              },
            ],
          },
        }];

        if (cfg.autoScaling === false) {
          // A single instance still goes through the launch template, so the
          // hardened settings above apply either way.
          blocks.push({
            type: 'resource',
            labels: ['aws_instance', id],
            body: {
              subnet_id: subnetIds[0],
              tags: baseTags(ctx, 'app'),
              _blocks: [{
                type: 'launch_template',
                body: { id: ref(`aws_launch_template.${id}.id`), version: ref(`aws_launch_template.${id}.latest_version`) },
              }],
            },
          });
          return { nodeKey: node.key, address: `aws_instance.${id}`, providerType: 'aws_instance', blocks };
        }

        blocks.push({
          type: 'resource',
          labels: ['aws_autoscaling_group', id],
          body: {
            name_prefix: interp([ref('var.name_prefix'), '-app-']),
            vpc_zone_identifier: subnetIds,
            min_size: desired,
            max_size: desired * 2,
            desired_capacity: desired,
            // Behind a load balancer, "healthy" means the target group says so.
            // EC2 health checks only notice an instance that has stopped, not
            // an application that has stopped answering.
            health_check_type: lbId ? 'ELB' : 'EC2',
            health_check_grace_period: 300,
            target_group_arns: lbId ? [ref(`aws_lb_target_group.${lbId}_tg.arn`)] : undefined,
            _blocks: [
              {
                type: 'launch_template',
                body: { id: ref(`aws_launch_template.${id}.id`), version: ref(`aws_launch_template.${id}.latest_version`) },
              },
              {
                // Replace instances rather than delete-then-create, so a
                // rolling change never drops capacity to zero.
                type: 'instance_refresh',
                body: { strategy: 'Rolling', _blocks: [{ type: 'preferences', body: { min_healthy_percentage: 50 } }] },
              },
            ],
          },
        });

        return { nodeKey: node.key, address: `aws_autoscaling_group.${id}`, providerType: 'aws_autoscaling_group', blocks };
      }

      case 'LOAD_BALANCER': {
        const vpc = this.firstDep(node, idOf, 'aws_vpc');
        const subnetIds = this.subnetIds(cfg, idOf);
        const internetFacing = str(cfg.scheme, 'internet-facing') === 'internet-facing';
        const targetPort = num(cfg.targetPort, 8080);

        return {
          nodeKey: node.key,
          address: `aws_lb.${id}`,
          providerType: 'aws_lb',
          blocks: [
            {
              type: 'resource',
              labels: ['aws_security_group', `${id}_sg`],
              body: {
                name: interp([ref('var.name_prefix'), '-alb']),
                description: 'Managed by cloudwise-infra-agent for the load balancer',
                vpc_id: vpc ? ref(`${vpc}.id`) : undefined,
                tags: baseTags(ctx, 'alb-sg'),
                _blocks: [
                  // The one place 0.0.0.0/0 ingress is correct rather than a
                  // mistake: an internet-facing load balancer that the internet
                  // cannot reach serves no purpose. Everything behind it is
                  // still scoped to the VPC. An internal scheme gets neither.
                  ...(internetFacing ? [
                    { type: 'ingress', body: { from_port: 80, to_port: 80, protocol: 'tcp', cidr_blocks: ['0.0.0.0/0'], description: 'HTTP from the internet' } },
                    { type: 'ingress', body: { from_port: 443, to_port: 443, protocol: 'tcp', cidr_blocks: ['0.0.0.0/0'], description: 'HTTPS from the internet' } },
                  ] : [
                    { type: 'ingress', body: { from_port: 80, to_port: 80, protocol: 'tcp', cidr_blocks: ['10.0.0.0/16'], description: 'HTTP from within the VPC' } },
                  ]),
                  { type: 'egress', body: { from_port: 0, to_port: 0, protocol: '-1', cidr_blocks: ['0.0.0.0/0'], description: 'Allow all outbound' } },
                ],
              },
            },
            {
              type: 'resource',
              labels: ['aws_lb', id],
              body: {
                name: interp([ref('var.name_prefix'), '-alb']),
                internal: !internetFacing,
                load_balancer_type: 'application',
                security_groups: [ref(`aws_security_group.${id}_sg.id`)],
                subnets: subnetIds,
                // Headers that do not parse are dropped rather than forwarded;
                // forwarding them is how request smuggling reaches the app.
                drop_invalid_header_fields: true,
                enable_deletion_protection: ctx.environment === 'production',
                tags: baseTags(ctx, 'alb'),
              },
            },
            {
              type: 'resource',
              labels: ['aws_lb_target_group', `${id}_tg`],
              body: {
                name: interp([ref('var.name_prefix'), '-tg']),
                port: targetPort,
                protocol: 'HTTP',
                vpc_id: vpc ? ref(`${vpc}.id`) : undefined,
                target_type: 'instance',
                tags: baseTags(ctx, 'tg'),
                _blocks: [{
                  type: 'health_check',
                  body: {
                    path: str(cfg.healthCheckPath, '/health'),
                    matcher: '200',
                    interval: 30,
                    timeout: 5,
                    healthy_threshold: 2,
                    unhealthy_threshold: 3,
                  },
                }],
              },
            },
            {
              // Plain HTTP. Terminating TLS needs a certificate for a domain
              // the estimate does not name and this agent has no authority to
              // issue, so the listener is HTTP and the node carries a
              // public-exposure approval gate where a human sees exactly that.
              type: 'resource',
              labels: ['aws_lb_listener', `${id}_http`],
              body: {
                load_balancer_arn: ref(`aws_lb.${id}.arn`),
                port: 80,
                protocol: 'HTTP',
                _blocks: [{
                  type: 'default_action',
                  body: { type: 'forward', target_group_arn: ref(`aws_lb_target_group.${id}_tg.arn`) },
                }],
              },
            },
          ],
        };
      }

      case 'MANAGED_POSTGRES':
      case 'MANAGED_MYSQL': {
        const isPostgres = node.logicalType === 'MANAGED_POSTGRES';
        const sgId = this.depId(node, idOf, '.sg');
        const subnetIds = this.subnetIds(cfg, idOf);
        const production = ctx.environment === 'production';
        const rawClass = str(cfg.instanceType, 't3.micro');
        const instanceClass = rawClass.startsWith('db.') ? rawClass : `db.${rawClass}`;

        const blocks: HclBlock[] = [
          {
            type: 'resource',
            labels: ['aws_db_subnet_group', `${id}_subnets`],
            body: {
              name: interp([ref('var.name_prefix'), `-${isPostgres ? 'pg' : 'mysql'}`]),
              subnet_ids: subnetIds,
              tags: baseTags(ctx, 'db-subnets'),
            },
          },
        ];

        // A production database is never destroyed without a final snapshot,
        // and a snapshot identifier must be unique across the account or the
        // destroy fails at the worst possible moment.
        if (production) {
          blocks.push({ type: 'resource', labels: ['random_id', `${id}_final`], body: { byte_length: 4 } });
        }

        blocks.push({
          type: 'resource',
          labels: ['aws_db_instance', id],
          body: {
            identifier: interp([ref('var.name_prefix'), `-${isPostgres ? 'pg' : 'mysql'}`]),
            engine: isPostgres ? 'postgres' : 'mysql',
            instance_class: instanceClass,
            allocated_storage: num(cfg.storageGb, 20),
            storage_type: 'gp3',
            storage_encrypted: cfg.encrypted !== false,
            db_subnet_group_name: ref(`aws_db_subnet_group.${id}_subnets.name`),
            vpc_security_group_ids: sgId ? [ref(`aws_security_group.${sgId}.id`)] : undefined,
            publicly_accessible: false,
            multi_az: cfg.multiAz === true,
            backup_retention_period: num(cfg.backupRetentionDays, 7),
            copy_tags_to_snapshot: true,
            auto_minor_version_upgrade: true,
            username: 'cloudwise_admin',
            db_name: isPostgres ? 'appdb' : 'appdb',
            // RDS generates the password and stores it in Secrets Manager. The
            // alternative is a password in the configuration, which means a
            // password in the Terraform state file and in version control.
            // There is no version of that which is acceptable.
            manage_master_user_password: true,
            performance_insights_enabled: production,
            deletion_protection: production,
            skip_final_snapshot: !production,
            final_snapshot_identifier: production
              ? interp([ref('var.name_prefix'), '-final-', ref(`random_id.${id}_final.hex`)])
              : undefined,
            tags: baseTags(ctx, isPostgres ? 'postgres' : 'mysql'),
          },
        });

        return { nodeKey: node.key, address: `aws_db_instance.${id}`, providerType: 'aws_db_instance', blocks };
      }

      default:
        return null;
    }
  }

  /**
   * The policy statement for one capability, or null when the graph contains
   * nothing to scope it to.
   *
   * Returning null is deliberate: granting `s3:*` on `*` because no bucket was
   * found would satisfy the capability while inverting its meaning.
   */
  private capabilityStatement(
    capability: string,
    roleId: string,
    idOf: Map<string, string>,
  ): { docId: string; name: string; body: HclBody } | null {
    switch (capability) {
      case 'logs:write': {
        const docId = `${roleId}_logs`;
        return {
          docId,
          name: 'cloudwise-logs-write',
          body: {
            _blocks: [{
              type: 'statement',
              body: {
                actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
                resources: [interp([
                  'arn:aws:logs:', ref('data.aws_region.current.name'),
                  ':', ref('data.aws_caller_identity.current.account_id'),
                  ':log-group:/cloudwise/', ref('var.name_prefix'), '*',
                ])],
              },
            }],
          },
        };
      }

      case 'objectStorage:readWrite': {
        const bucketId = this.findObjectStorage(idOf);
        if (!bucketId) return null;
        const docId = `${roleId}_s3`;
        return {
          docId,
          name: 'cloudwise-object-storage',
          body: {
            _blocks: [
              {
                type: 'statement',
                body: {
                  actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
                  // Objects, not the bucket itself: object actions on a bucket
                  // ARN silently grant nothing, and bucket actions on an object
                  // ARN grant more than intended.
                  resources: [interp([ref(`aws_s3_bucket.${bucketId}.arn`), '/*'])],
                },
              },
              {
                type: 'statement',
                body: {
                  actions: ['s3:ListBucket'],
                  resources: [ref(`aws_s3_bucket.${bucketId}.arn`)],
                },
              },
            ],
          },
        };
      }

      default:
        return null;
    }
  }

  /** The Terraform id of the dependency whose key ends with `suffix`. */
  private depId(node: LamNode, idOf: Map<string, string>, suffix: string): string | null {
    const key = node.dependsOn.find((d) => d.endsWith(suffix));
    return key ? idOf.get(key) ?? null : null;
  }

  /**
   * Subnet references for a node, in the order the compiler listed them.
   *
   * Order matters for a database subnet group and an autoscaling group: both
   * spread across what they are given, and a silently reordered list changes
   * which availability zones are used.
   */
  private subnetIds(cfg: Record<string, unknown>, idOf: Map<string, string>): HclRef[] {
    const keys = Array.isArray(cfg.subnets) ? (cfg.subnets as string[]) : [];
    const refs: HclRef[] = [];
    for (const key of keys) {
      const id = idOf.get(key);
      if (id) refs.push(ref(`aws_subnet.${id}.id`));
    }
    return refs;
  }

  /** The load balancer in this graph, if there is one. */
  private findLoadBalancer(idOf: Map<string, string>): string | null {
    for (const [key, id] of idOf) if (key === 'network.lb' || key.startsWith('network.lb.')) return id;
    return null;
  }

  /** The object storage bucket in this graph, if there is one. */
  private findObjectStorage(idOf: Map<string, string>): string | null {
    for (const [key, id] of idOf) if (key === 'storage.object' || key.startsWith('storage.object.')) return id;
    return null;
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
