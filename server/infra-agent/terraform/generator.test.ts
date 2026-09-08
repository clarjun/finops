import { describe, it, expect } from 'vitest';
import { compileArchitecture } from '../compiler';
import { generateTerraform } from './generator';
import { awsMapper } from '../providers/aws';
import type { EstimatorLayer } from '../types';

const LAYERS: EstimatorLayer[] = [
  { layer: 'Frontend', service: 'Amazon S3 + CloudFront', storageSize: 500, monthlyCost: 15 },
  { layer: 'Backend', service: 'Amazon EC2 Auto Scaling', instanceType: 't3.medium', instanceCount: 2, monthlyCost: 120 },
  { layer: 'Database', service: 'Amazon RDS PostgreSQL', instanceType: 'db.t3.medium', storageSize: 100, monthlyCost: 180 },
  { layer: 'Network', service: 'Application Load Balancer', monthlyCost: 25 },
];

function build(env: 'production' | 'development' = 'production') {
  const architecture = compileArchitecture(
    LAYERS,
    { provider: 'aws', region: 'us-east-1', environment: env, availability: 'high', compliance: [] },
    'E-commerce platform, high availability',
  );
  return generateTerraform({ architecture, mapper: awsMapper, region: 'us-east-1', namePrefix: 'ecom' });
}


/**
 * One named resource block, brace-counted.
 *
 * Slicing to the next `resource` keyword breaks as soon as block order changes,
 * and an assertion that silently starts reading a different resource is worse
 * than no assertion.
 */
function resourceBlock(tf: string, type: string, name: string): string {
  const header = `resource "${type}" "${name}" {`;
  const start = tf.indexOf(header);
  if (start === -1) throw new Error(`No ${type}.${name} in the generated configuration`);
  let depth = 0;
  for (let i = start + header.length - 1; i < tf.length; i++) {
    if (tf[i] === '{') depth++;
    else if (tf[i] === '}' && --depth === 0) return tf.slice(start, i + 1);
  }
  throw new Error(`Unbalanced braces in ${type}.${name}`);
}

describe('terraform generation', () => {
  it('produces a config real Terraform accepts', () => {
    // Verified against hashicorp/terraform:1.9.8 — `validate` returns
    // "Success! The configuration is valid." These assertions guard the shape
    // that made that true.
    const tf = build().mainTf;
    expect(tf).toContain('required_version = ">= 1.9.0"');
    expect(tf).toContain('source = "hashicorp/aws"');
    expect(tf).toContain('provider "aws" {');
    expect(tf).toContain('variable "region"');
  });

  it('is deterministic — the same plan yields byte-identical config', () => {
    // What lets a plan be hashed, shown to an approver, and proven to be the
    // same plan that ran.
    expect(build().mainTf).toBe(build().mainTf);
  });

  it('maps every node it builds in both directions', () => {
    const cfg = build();
    for (const [nodeKey, address] of Object.entries(cfg.addressByNode)) {
      expect(cfg.nodeByAddress[address]).toBe(nodeKey);
    }
  });

  it('reports what it cannot build instead of silently dropping it', () => {
    // The mapper covers what a three-tier application needs to run. CDN and
    // observability are still out of scope, and must be visible as excluded
    // rather than simply absent from the plan.
    const cfg = build();
    const types = cfg.unsupported.map((u) => u.logicalType);
    expect(types).toContain('CDN');
    expect(types).toContain('OBSERVABILITY');
    expect(cfg.unsupported.every((u) => u.reason.length > 0)).toBe(true);
  });

  it('builds the tiers an application actually needs', () => {
    // The counterpart to the assertion above: these were out of scope once, and
    // a regression that quietly returns them to `unsupported` would leave a
    // deployment that succeeds while building nothing an application can run on.
    const cfg = build();
    const excluded = cfg.unsupported.map((u) => u.logicalType);
    for (const type of ['COMPUTE', 'MANAGED_POSTGRES', 'LOAD_BALANCER', 'IAM']) {
      expect(excluded).not.toContain(type);
    }
  });

  it('emits an output for every mapped resource', () => {
    const cfg = build();
    for (const address of Object.keys(cfg.nodeByAddress)) {
      expect(cfg.mainTf).toContain(`${address}.id`);
    }
  });
});

describe('AWS resource configuration', () => {
  it('blocks public access on buckets with the modern resource, not a deprecated ACL', () => {
    const tf = build().mainTf;
    expect(tf).toContain('resource "aws_s3_bucket_public_access_block"');
    expect(tf).toContain('block_public_policy = true');
    expect(tf).toContain('restrict_public_buckets = true');
    // `acl = "private"` is the pre-provider-v4 pattern and does not stop a
    // later public policy.
    expect(tf).not.toContain('acl = "private"');
  });

  it('enables versioning and encryption as separate resources', () => {
    const tf = build().mainTf;
    expect(tf).toContain('resource "aws_s3_bucket_versioning"');
    expect(tf).toContain('status = "Enabled"');
    expect(tf).toContain('resource "aws_s3_bucket_server_side_encryption_configuration"');
    expect(tf).toContain('sse_algorithm = "AES256"');
  });

  it('gives buckets a globally-unique name via a random suffix', () => {
    const tf = build().mainTf;
    expect(tf).toContain('resource "random_id"');
    expect(tf).toMatch(/bucket\s+=\s+"\$\{var\.name_prefix\}/);
  });

  it('never auto-assigns public IPs in private subnets', () => {
    const tf = build().mainTf;
    const privateBlock = tf.slice(tf.indexOf('resource "aws_subnet" "network_subnet_private_a"'));
    expect(privateBlock.slice(0, 400)).toContain('map_public_ip_on_launch = false');
  });

  it('resolves availability zones from a data source rather than hardcoding them', () => {
    // AZ names differ per account; "us-east-1a" is not the same zone everywhere.
    const tf = build().mainTf;
    expect(tf).toContain('data "aws_availability_zones" "available"');
    expect(tf).toContain('data.aws_availability_zones.available.names[0]');
    expect(tf).not.toMatch(/availability_zone\s+=\s+"us-east-1a"/);
  });

  it('never opens a workload security group to the internet', () => {
    // Checked per named group rather than by slicing the file, because the
    // load balancer's group legitimately does open to the internet and the
    // assertion has to distinguish the two rather than depend on which one
    // happens to be emitted first.
    const tf = build().mainTf;
    for (const name of ['compute_app_sg', 'data_postgres_sg']) {
      const block = resourceBlock(tf, 'aws_security_group', name);
      const ingress = block.slice(block.indexOf('ingress {'), block.indexOf('egress {'));
      // Egress to 0.0.0.0/0 is normal; ingress from it is not.
      expect(ingress).not.toContain('0.0.0.0/0');
      expect(ingress).toContain('10.0.0.0/16');
    }
  });

  it('opens the load balancer to the internet, and only the load balancer', () => {
    const tf = build().mainTf;
    const alb = resourceBlock(tf, 'aws_security_group', 'network_lb_sg');
    expect(alb).toContain('0.0.0.0/0');
    expect(alb).toContain('from_port = 443');
    // Every other 0.0.0.0/0 ingress in the file would be a finding.
    const groups = [...tf.matchAll(/resource "aws_security_group" "([a-z_0-9]+)"/g)].map((m) => m[1]);
    const open = groups.filter((n) => {
      const b = resourceBlock(tf, 'aws_security_group', n);
      return b.slice(b.indexOf('ingress {'), b.indexOf('egress {')).includes('0.0.0.0/0');
    });
    expect(open).toEqual(['network_lb_sg']);
  });

  it('requires IMDSv2 on every instance it launches', () => {
    // The v1 metadata endpoint is what turns one SSRF into stolen credentials,
    // and it is the default when a launch template says nothing.
    const tf = build().mainTf;
    expect(tf).toContain('http_tokens = "required"');
    expect(tf).toContain('http_put_response_hop_limit = 1');
  });

  it('encrypts instance root volumes', () => {
    const lt = resourceBlock(build().mainTf, 'aws_launch_template', 'compute_app');
    expect(lt).toContain('encrypted = true');
  });

  it('resolves the AMI at plan time instead of pinning an id', () => {
    const tf = build().mainTf;
    expect(tf).toContain('data "aws_ami" "al2023"');
    expect(tf).toContain('image_id = data.aws_ami.al2023.id');
    // A literal ami- id is wrong in every region but one and unpatched
    // immediately.
    expect(tf).not.toMatch(/image_id\s+=\s+"ami-/);
  });

  it('never writes a database password', () => {
    // RDS generates it and keeps it in Secrets Manager. A password in the
    // configuration is a password in the state file and in version control.
    const db = resourceBlock(build().mainTf, 'aws_db_instance', 'data_postgres');
    expect(db).toContain('manage_master_user_password = true');
    // A literal assignment, not the substring: `manage_master_user_password`
    // contains the word and is the very thing that makes this safe.
    expect(db).not.toMatch(/^\s*password\s*=/m);
  });

  it('keeps the database private and encrypted', () => {
    const db = resourceBlock(build().mainTf, 'aws_db_instance', 'data_postgres');
    expect(db).toContain('publicly_accessible = false');
    expect(db).toContain('storage_encrypted = true');
  });

  it('protects a production database from being destroyed without a snapshot', () => {
    const prod = resourceBlock(build('production').mainTf, 'aws_db_instance', 'data_postgres');
    expect(prod).toContain('deletion_protection = true');
    expect(prod).toContain('skip_final_snapshot = false');
    expect(prod).toContain('final_snapshot_identifier');

    // Development is deliberately the opposite: a snapshot nobody wants blocks
    // teardown and costs money until someone notices.
    const dev = resourceBlock(build('development').mainTf, 'aws_db_instance', 'data_postgres');
    expect(dev).toContain('skip_final_snapshot = true');
    expect(dev).toContain('deletion_protection = false');
  });

  it('scopes the instance role to specific ARNs, never a wildcard', () => {
    const tf = build().mainTf;
    expect(tf).toContain('data "aws_iam_policy_document"');
    // The bucket the plan actually contains, not "*".
    expect(tf).toContain('"${aws_s3_bucket.storage_object.arn}/*"');
    expect(tf).not.toMatch(/resources\s*=\s*\[\s*"\*"/);
  });

  it('health-checks through the load balancer, not just the instance', () => {
    const asg = resourceBlock(build().mainTf, 'aws_autoscaling_group', 'compute_app');
    // An EC2 health check notices a stopped instance, not a stopped
    // application.
    expect(asg).toContain('health_check_type = "ELB"');
    expect(asg).toContain('target_group_arns');
  });

  it('pairs a NAT gateway with its Elastic IP', () => {
    const tf = build().mainTf;
    expect(tf).toContain('resource "aws_nat_gateway"');
    expect(tf).toContain('resource "aws_eip"');
    expect(tf).toContain('allocation_id = aws_eip.');
  });

  it('associates route tables with subnets, since a route table alone does nothing', () => {
    const tf = build().mainTf;
    expect(tf).toContain('resource "aws_route_table_association"');
    expect(tf).toContain('route_table_id = aws_route_table.');
  });

  it('tags everything for attribution', () => {
    const tf = build().mainTf;
    expect(tf).toContain('ManagedBy = "cloudwise-infra-agent"');
    expect(tf).toContain('Environment = "production"');
  });

  it('carries the environment through to resource tags', () => {
    expect(build('development').mainTf).toContain('Environment = "development"');
  });
});
