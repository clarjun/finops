import { describe, it, expect } from 'vitest';
import { computeStages, stageTargets } from './staging';
import { compileArchitecture } from './compiler';
import type { EstimatorLayer, LamNode } from './types';

const LAYERS: EstimatorLayer[] = [
  { layer: 'Frontend', service: 'Amazon S3', storageSize: 500, monthlyCost: 15 },
  { layer: 'Backend', service: 'Amazon EC2 Auto Scaling', instanceType: 't3.medium', monthlyCost: 120 },
];

const arch = () => compileArchitecture(
  LAYERS,
  { provider: 'aws', region: 'us-east-1', environment: 'production', availability: 'high', compliance: [] },
  'E-commerce, high availability',
);

/** A minimal node, for constructing graphs the compiler would not produce. */
const node = (key: string, over: Partial<LamNode> = {}): LamNode => ({
  key,
  label: key,
  logicalType: 'OBJECT_STORAGE',
  config: {},
  dependsOn: [],
  risk: { level: 'low', reasons: [], explanation: '' },
  requiresApproval: false,
  source: 'synthesized',
  ...over,
});

describe('approval staging', () => {
  it('never places a node before its dependency', () => {
    const { stages } = computeStages(arch().nodes);
    const stageOf = new Map<string, number>();
    stages.forEach((s, i) => s.nodeKeys.forEach((k) => stageOf.set(k, i)));

    for (const n of arch().nodes) {
      for (const dep of n.dependsOn) {
        expect(stageOf.get(dep)!, `${n.key} after ${dep}`).toBeLessThanOrEqual(stageOf.get(n.key)!);
      }
    }
  });

  it('isolates each approval-requiring node into its own stage', () => {
    // The point of staging. Batching them would mean approving an IAM role and
    // an internet gateway with one click, which is not a control.
    const { stages } = computeStages(arch().nodes);
    for (const stage of stages.filter((s) => s.requiresApproval)) {
      expect(stage.nodeKeys).toHaveLength(1);
    }
  });

  it('covers every node exactly once', () => {
    const nodes = arch().nodes;
    const { stages } = computeStages(nodes);
    const covered = stages.flatMap((s) => s.nodeKeys).sort();
    expect(covered).toEqual(nodes.map((n) => n.key).sort());
  });

  it('produces more than one gate on a realistic plan', () => {
    // A single gate for the whole deployment is a formality, not an approval.
    const { stages } = computeStages(arch().nodes);
    expect(stages.filter((s) => s.requiresApproval).length).toBeGreaterThan(1);
  });

  it('reports the highest risk in a stage, not the first', () => {
    const nodes = [
      node('a'),
      node('b', { risk: { level: 'medium', reasons: ['network_change'], explanation: '' } }),
    ];
    const { stages } = computeStages(nodes);
    expect(stages[0].riskLevel).toBe('medium');
  });

  it('collects distinct risk reasons across a stage', () => {
    const nodes = [
      node('a', { risk: { level: 'medium', reasons: ['network_change'], explanation: '' } }),
      node('b', { risk: { level: 'medium', reasons: ['data_store', 'network_change'], explanation: '' } }),
    ];
    const { stages } = computeStages(nodes);
    expect(stages[0].riskReasons).toEqual(['data_store', 'network_change']);
  });

  it('sums estimated cost per stage', () => {
    const nodes = [
      node('a', { estimatedMonthlyCost: 15 }),
      node('b', { estimatedMonthlyCost: 120 }),
    ];
    const { stages } = computeStages(nodes);
    expect(stages[0].estimatedMonthlyCost).toBe(135);
  });

  it('merges ungated waves into a single stage', () => {
    // Stages exist to create approval boundaries, not to order resources —
    // Terraform already does that within one apply. With nothing to approve,
    // splitting would mean extra applies for no safety gain.
    const { stages } = computeStages([node('a'), node('b', { dependsOn: ['a'] })]);
    expect(stages).toHaveLength(1);
    expect(stages[0].nodeKeys).toEqual(['a', 'b']);
    expect(stages[0].requiresApproval).toBe(false);
  });

  it('still breaks a stage when a gate appears mid-graph', () => {
    const { stages } = computeStages([
      node('a'),
      node('b', { dependsOn: ['a'], requiresApproval: true, risk: { level: 'high', reasons: ['iam'], explanation: '' } }),
      node('c', { dependsOn: ['b'] }),
    ]);
    expect(stages.map((s) => s.nodeKeys)).toEqual([['a'], ['b'], ['c']]);
    expect(stages[1].requiresApproval).toBe(true);
  });

  it('refuses to stage a cyclic graph instead of looping', () => {
    const a = node('a', { dependsOn: ['b'] });
    const b = node('b', { dependsOn: ['a'] });
    const { stages, errors } = computeStages([a, b]);
    expect(stages).toEqual([]);
    expect(errors.join(' ')).toMatch(/cycle/i);
  });
});

describe('stage targets', () => {
  it('maps node keys to Terraform addresses', () => {
    const stage = { index: 0, nodeKeys: ['x', 'y'], requiresApproval: false, riskLevel: 'low' as const, riskReasons: [], estimatedMonthlyCost: 0 };
    expect(stageTargets(stage, { x: 'aws_vpc.x', y: 'aws_subnet.y' })).toEqual(['aws_vpc.x', 'aws_subnet.y']);
  });

  it('drops nodes the mapper could not build', () => {
    // An unmapped node has no address. Passing an empty target list to
    // Terraform would mean "everything", so the engine checks for this and
    // skips the stage rather than applying the whole plan by accident.
    const stage = { index: 0, nodeKeys: ['x', 'unmapped'], requiresApproval: false, riskLevel: 'low' as const, riskReasons: [], estimatedMonthlyCost: 0 };
    expect(stageTargets(stage, { x: 'aws_vpc.x' })).toEqual(['aws_vpc.x']);
  });
});
