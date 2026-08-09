import { describe, it, expect } from 'vitest';
import { compileArchitecture, classifyService, assessRisk, validateGraph } from './compiler';
import type { EstimatorLayer, Clarifications, LamMetadata } from './types';

const ECOMMERCE: EstimatorLayer[] = [
  { layer: 'Frontend', service: 'Amazon S3 + CloudFront', configuration: 'Static hosting with global CDN', storageSize: 500, dataTransfer: 1000 },
  { layer: 'Backend', service: 'Amazon EC2 Auto Scaling', configuration: 'Auto-scaling group', instanceType: 't3.medium', instanceCount: 2 },
  { layer: 'Database', service: 'Amazon RDS PostgreSQL', configuration: 'Multi-AZ deployment', instanceType: 'db.t3.medium', storageSize: 100 },
];

const HA: Clarifications = { provider: 'aws', region: 'us-east-1', environment: 'production', availability: 'high', compliance: [] };
const REQ = 'E-commerce platform, 50,000 MAU, PostgreSQL 100GB, 500GB images, high availability required';

const compile = (layers = ECOMMERCE, c: Clarifications = HA) => compileArchitecture(layers, c, REQ);
const keys = (a = compile()) => a.nodes.map((n) => n.key);
const byKey = (k: string, a = compile()) => a.nodes.find((n) => n.key === k);

describe('service classification', () => {
  it('classifies the estimator’s prose service names', () => {
    expect(classifyService('Amazon RDS PostgreSQL')).toBe('MANAGED_POSTGRES');
    expect(classifyService('Azure Database for PostgreSQL')).toBe('MANAGED_POSTGRES');
    expect(classifyService('Cloud SQL for PostgreSQL')).toBe('MANAGED_POSTGRES');
    expect(classifyService('Amazon S3 + CloudFront')).toBe('OBJECT_STORAGE');
    expect(classifyService('Amazon EC2 Auto Scaling')).toBe('COMPUTE');
    expect(classifyService('Application Load Balancer')).toBe('LOAD_BALANCER');
    expect(classifyService('Amazon ElastiCache (Redis)')).toBe('CACHE');
  });

  it('returns null rather than guessing', () => {
    expect(classifyService('Some Unreleased Service')).toBeNull();
  });
});

describe('compiling a deployable topology', () => {
  it('synthesizes the network foundation the estimator never prices', () => {
    // The whole reason this compiler exists: none of these appear in a pricing
    // breakdown, and nothing can be deployed without them.
    const k = keys();
    expect(k).toContain('network.vpc');
    expect(k).toContain('network.igw');
    expect(k).toContain('network.routing.public');
    expect(k.filter((x) => x.startsWith('network.subnet.'))).toHaveLength(4); // 2 AZ x public/private
  });

  it('marks synthesized resources so the user can see what was inferred', () => {
    const a = compile();
    expect(byKey('network.vpc', a)!.source).toBe('synthesized');
    expect(byKey('data.postgres', a)!.source).toBe('estimator');
  });

  it('spreads across two zones only when availability requires it', () => {
    const single = compile(ECOMMERCE, { ...HA, availability: 'standard' });
    expect(single.nodes.filter((n) => n.logicalType === 'SUBNET')).toHaveLength(2);

    const ha = compile();
    expect(ha.nodes.filter((n) => n.logicalType === 'SUBNET')).toHaveLength(4);
  });

  it('infers high availability from the requirement text when not answered', () => {
    const a = compileArchitecture(ECOMMERCE, { provider: 'aws' }, 'needs high availability');
    expect(a.metadata.availability).toBe('high');
    const std = compileArchitecture(ECOMMERCE, { provider: 'aws' }, 'a small internal tool');
    expect(std.metadata.availability).toBe('standard');
  });

  it('places the database privately, with its own security group', () => {
    const a = compile();
    const db = byKey('data.postgres', a)!;
    expect(db.dependsOn).toContain('data.postgres.sg');
    expect(db.dependsOn.some((d) => d.includes('subnet.private'))).toBe(true);
    expect(db.dependsOn.some((d) => d.includes('subnet.public'))).toBe(false);
  });

  it('defaults data stores to encrypted and buckets to private', () => {
    // Defaults, not options: a compliance regime is not satisfied by
    // remembering to tick a box later.
    const a = compile();
    expect(byKey('data.postgres', a)!.config.encrypted).toBe(true);
    expect(byKey('storage.object', a)!.config.publicAccess).toBe(false);
    expect(byKey('storage.object', a)!.config.encrypted).toBe(true);
  });

  it('adds a NAT gateway only when something actually sits in a private subnet, and warns', () => {
    const a = compile();
    expect(keys(a)).toContain('network.nat');
    expect(a.warnings.join(' ')).toMatch(/NAT gateway .* hourly charge/i);

    const storageOnly = compile([ECOMMERCE[0]], HA);
    expect(keys(storageOnly)).not.toContain('network.nat');
  });

  it('never silently drops a priced service', () => {
    const a = compile([...ECOMMERCE, { layer: 'Other', service: 'Mystery Service 9000' }]);
    expect(a.warnings.join(' ')).toMatch(/Mystery Service 9000/);
  });

  it('longer retention in production', () => {
    const prod = compile();
    const dev = compile(ECOMMERCE, { ...HA, environment: 'development' });
    expect(byKey('data.postgres', prod)!.config.backupRetentionDays).toBe(30);
    expect(byKey('data.postgres', dev)!.config.backupRetentionDays).toBe(7);
  });
});

describe('risk assessment', () => {
  const meta = (over: Partial<LamMetadata> = {}): LamMetadata => ({
    requirements: REQ, environment: 'development', availability: 'high', compliance: [], ...over,
  });

  it('treats permissions and secrets as high risk', () => {
    expect(assessRisk('IAM', meta()).level).toBe('high');
    expect(assessRisk('SECRETS', meta()).level).toBe('high');
    expect(assessRisk('IAM', meta()).reasons).toContain('iam');
  });

  it('flags anything internet-facing', () => {
    expect(assessRisk('INTERNET_GATEWAY', meta()).reasons).toContain('public_exposure');
    expect(assessRisk('LOAD_BALANCER', meta()).reasons).toContain('public_exposure');
  });

  it('escalates in production but does not invent risk where there is none', () => {
    expect(assessRisk('MANAGED_POSTGRES', meta({ environment: 'production' })).level).toBe('high');
    // Observability has no base risk; production alone must not manufacture one.
    expect(assessRisk('OBSERVABILITY', meta({ environment: 'production' })).level).toBe('low');
  });

  it('escalates on material recurring cost', () => {
    const cheap = assessRisk('COMPUTE', meta(), 20);
    const dear = assessRisk('COMPUTE', meta(), 500);
    expect(cheap.level).toBe('low');
    expect(dear.level).toBe('high');
    expect(dear.reasons).toContain('expensive');
    expect(dear.explanation).toMatch(/\$500\/month/);
  });

  it('requires approval for everything above low risk', () => {
    const a = compile();
    for (const n of a.nodes) {
      expect(n.requiresApproval, `${n.key} (${n.risk.level})`).toBe(n.risk.level !== 'low');
    }
    // And the plan must actually contain gates, or the model is wrong.
    expect(a.nodes.some((n) => n.requiresApproval)).toBe(true);
  });
});

describe('graph validation', () => {
  it('orders a real plan into parallel waves', () => {
    const a = compile();
    const v = validateGraph(a.nodes);
    expect(v.valid).toBe(true);
    expect(v.waves.length).toBeGreaterThan(1);
    // The VPC has no dependencies, so it must be in the first wave.
    expect(v.waves[0]).toContain('network.vpc');
    // Every node appears exactly once.
    expect(v.waves.flat().sort()).toEqual(a.nodes.map((n) => n.key).sort());
  });

  it('never schedules a node before its dependency', () => {
    const a = compile();
    const v = validateGraph(a.nodes);
    const waveOf = new Map<string, number>();
    v.waves.forEach((w, i) => w.forEach((k) => waveOf.set(k, i)));
    for (const n of a.nodes) {
      for (const dep of n.dependsOn) {
        expect(waveOf.get(dep)!, `${n.key} after ${dep}`).toBeLessThan(waveOf.get(n.key)!);
      }
    }
  });

  it('detects a cycle instead of hanging', () => {
    const nodes = compile().nodes.slice(0, 2);
    nodes[0].dependsOn = [nodes[1].key];
    nodes[1].dependsOn = [nodes[0].key];
    const v = validateGraph(nodes);
    expect(v.valid).toBe(false);
    expect(v.errors.join(' ')).toMatch(/cycle/i);
  });

  it('reports a dangling dependency rather than deadlocking', () => {
    const nodes = compile().nodes;
    nodes[0].dependsOn = ['does.not.exist'];
    expect(validateGraph(nodes).errors.join(' ')).toMatch(/unknown node/);
  });

  it('produces no dangling dependencies from a normal compile', () => {
    const a = compile();
    expect(validateGraph(a.nodes).errors).toEqual([]);
  });
});
