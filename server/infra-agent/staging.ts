/**
 * Turning a dependency graph into approval stages.
 *
 * Terraform owns resource ordering — it builds its own dependency graph and
 * applies a whole configuration in one pass. Re-implementing per-resource
 * orchestration on top of it would fight the tool and lose.
 *
 * So the LAM graph is not used to order the apply. It is used to decide WHERE A
 * HUMAN GETS TO INTERVENE. Nodes are grouped into stages such that every stage
 * requiring approval is isolated: the operator can approve "create the network"
 * without simultaneously approving "create the IAM role that can read every
 * bucket".
 *
 * Without staging there is exactly one gate — approve the entire plan or refuse
 * it — which is not a control, it is a formality.
 */
import type { LamNode } from './types';
import { validateGraph } from './compiler';

export interface Stage {
  index: number;
  /** LAM node keys applied together. */
  nodeKeys: string[];
  /** True when any node in the stage needs a human before it runs. */
  requiresApproval: boolean;
  /** Highest risk level present, which the approval card leads with. */
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  /** Distinct reasons across the stage, for the approval explanation. */
  riskReasons: string[];
  estimatedMonthlyCost: number;
}

const LEVELS = ['low', 'medium', 'high', 'critical'] as const;

function highest(levels: Array<Stage['riskLevel']>): Stage['riskLevel'] {
  return levels.reduce<Stage['riskLevel']>(
    (acc, l) => (LEVELS.indexOf(l) > LEVELS.indexOf(acc) ? l : acc),
    'low',
  );
}

/**
 * Groups dependency waves into stages, breaking whenever approval is needed.
 *
 * Waves come from the graph, so a stage never contains a node whose dependency
 * is in a later stage. Approval-requiring nodes are placed in a stage of their
 * own, so approving one does not implicitly approve unrelated work scheduled
 * beside it.
 */
export function computeStages(nodes: LamNode[]): { stages: Stage[]; errors: string[] } {
  const { waves, errors, valid } = validateGraph(nodes);
  if (!valid) return { stages: [], errors };

  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const stages: Stage[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length === 0) return;
    stages.push(buildStage(stages.length, current, byKey));
    current = [];
  };

  for (const wave of waves) {
    const gated = wave.filter((k) => byKey.get(k)?.requiresApproval);
    const ungated = wave.filter((k) => !byKey.get(k)?.requiresApproval);

    // Ungated work in this wave joins whatever is being accumulated.
    current.push(...ungated);

    // Each gated node becomes its own stage, so its approval covers only it.
    if (gated.length > 0) {
      flush();
      for (const key of gated) {
        stages.push(buildStage(stages.length, [key], byKey));
      }
    }
  }

  flush();
  return { stages, errors: [] };
}

function buildStage(index: number, nodeKeys: string[], byKey: Map<string, LamNode>): Stage {
  const nodes = nodeKeys.map((k) => byKey.get(k)).filter((n): n is LamNode => !!n);
  const reasons = new Set<string>();
  for (const n of nodes) for (const r of n.risk.reasons) reasons.add(r);

  return {
    index,
    nodeKeys: [...nodeKeys].sort(),
    requiresApproval: nodes.some((n) => n.requiresApproval),
    riskLevel: highest(nodes.map((n) => n.risk.level)),
    riskReasons: [...reasons].sort(),
    estimatedMonthlyCost: nodes.reduce((sum, n) => sum + (n.estimatedMonthlyCost ?? 0), 0),
  };
}

/** Terraform addresses for a stage, for `-target`. Nodes the mapper skipped are absent. */
export function stageTargets(stage: Stage, addressByNode: Record<string, string>): string[] {
  return stage.nodeKeys.map((k) => addressByNode[k]).filter((a): a is string => !!a);
}
