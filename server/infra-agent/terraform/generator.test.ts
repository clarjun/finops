import { describe, it, expect } from 'vitest';
import { compileArchitecture } from '../compiler';
import { generateTerraform } from './generator';
import { awsMapper } from '../providers/aws';
import type { EstimatorLayer } from '../types';

const LAYERS: EstimatorLayer[] = [
  { layer: 'Frontend', service: 'Amazon S3 + CloudFront', storageSize: 500, monthlyCost: 15 },
  { layer: 'Backend', service: 'Amazon EC2 Auto Scaling', instanceType: 't3.medium', instanceCount: 2, monthlyCost: 120 },
  { layer: 'Database', service: 'Amazon RDS PostgreSQL', instanceType: 'db.t3.medium', storageSize: 100, monthlyCost: 180 },
];

function build(env: 'production' | 'development' = 'production') {
  const architecture = compileArchitecture(
    LAYERS,
    { provider: 'aws', region: 'us-east-1', environment: env, availability: 'high', compliance: [] },
    'E-commerce platform, high availability',
  );
  return generateTerraform({ architecture, mapper: awsMapper, region: 'us-east-1', namePrefix: 'ecom' });
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
    // The slice covers network + storage. Compute, database, CDN and IAM are
    // out of scope today and must be visible, not missing.
    const cfg = build();
    const types = cfg.unsupported.map((u) => u.logicalType);
    expect(types).toContain('MANAGED_POSTGRES');
    expect(types).toContain('COMPUTE');
    expect(cfg.unsupported.every((u) => u.reason.length > 0)).toBe(true);
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

  it('never opens a security group to the internet', () => {
    const tf = build().mainTf;
    const sgStart = tf.indexOf('resource "aws_security_group"');
    const sgBlock = tf.slice(sgStart, tf.indexOf('resource "aws_subnet"', sgStart));
    expect(sgBlock).toContain('ingress {');
    // Egress to 0.0.0.0/0 is normal; ingress from it is not.
    const ingress = sgBlock.slice(sgBlock.indexOf('ingress {'), sgBlock.indexOf('egress {'));
    expect(ingress).not.toContain('0.0.0.0/0');
    expect(ingress).toContain('10.0.0.0/16');
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
