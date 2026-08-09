/**
 * Live architecture graph.
 *
 * Nodes are laid out by dependency wave — the same waves the engine executes —
 * so the picture reads top-down in the order things are actually created, and an
 * edge always points downward. A force-directed layout would look livelier and
 * tell you nothing true.
 *
 * Every animation is bound to real state. A node pulses only while it is
 * genuinely being created, and stops the moment the engine says otherwise.
 * Motion that is not evidence is just noise on a screen someone is trusting to
 * tell them what is happening to their infrastructure.
 */
import { motion } from "framer-motion";
import {
  Network, HardDrive, Database, Server, Shield, Globe, Router,
  KeyRound, Activity, Boxes, Lock, CheckCircle2, XCircle, Loader2, MinusCircle,
} from "lucide-react";
import type { NodeStatus } from "@/hooks/use-infra-agent";

export interface GraphNode {
  key: string;
  label: string;
  logicalType: string;
  dependsOn: string[];
  requiresApproval: boolean;
  riskLevel: string;
  status: NodeStatus;
}

const ICONS: Record<string, typeof Network> = {
  NETWORK: Network,
  SUBNET: Boxes,
  INTERNET_GATEWAY: Globe,
  NAT_GATEWAY: Router,
  ROUTING: Router,
  SECURITY_GROUP: Shield,
  LOAD_BALANCER: Activity,
  COMPUTE: Server,
  MANAGED_POSTGRES: Database,
  MANAGED_MYSQL: Database,
  OBJECT_STORAGE: HardDrive,
  CACHE: Boxes,
  CDN: Globe,
  IAM: KeyRound,
  SECRETS: Lock,
  OBSERVABILITY: Activity,
};

/** Colour carries status; it is never decorative. */
const STATUS_STYLE: Record<NodeStatus, { ring: string; text: string; label: string }> = {
  pending:           { ring: 'border-border',        text: 'text-muted-foreground', label: 'Waiting' },
  ready:             { ring: 'border-border',        text: 'text-muted-foreground', label: 'Ready' },
  running:           { ring: 'border-blue-500',      text: 'text-blue-500',         label: 'Creating' },
  awaiting_approval: { ring: 'border-yellow-500',    text: 'text-yellow-600',       label: 'Approval required' },
  applied:           { ring: 'border-green-500',     text: 'text-green-600',        label: 'Created' },
  failed:            { ring: 'border-destructive',   text: 'text-destructive',      label: 'Failed' },
  skipped:           { ring: 'border-border',        text: 'text-muted-foreground', label: 'Not deployed' },
  rolled_back:       { ring: 'border-destructive',   text: 'text-destructive',      label: 'Rolled back' },
};

function StatusIcon({ status }: { status: NodeStatus }) {
  if (status === 'applied') return <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />;
  if (status === 'failed' || status === 'rolled_back') return <XCircle className="h-3.5 w-3.5 text-destructive" />;
  if (status === 'running') return <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />;
  if (status === 'awaiting_approval') return <Lock className="h-3.5 w-3.5 text-yellow-600" />;
  if (status === 'skipped') return <MinusCircle className="h-3.5 w-3.5 text-muted-foreground" />;
  return <div className="h-3.5 w-3.5 rounded-full border border-muted-foreground/40" />;
}

/** Groups nodes into dependency waves — the engine's own ordering. */
function toWaves(nodes: GraphNode[]): GraphNode[][] {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const depth = new Map<string, number>();

  const resolve = (key: string, seen = new Set<string>()): number => {
    if (depth.has(key)) return depth.get(key)!;
    // A cycle cannot render; treat it as depth 0 rather than recursing forever.
    if (seen.has(key)) return 0;
    seen.add(key);

    const node = byKey.get(key);
    const deps = (node?.dependsOn ?? []).filter((d) => byKey.has(d));
    const d = deps.length === 0 ? 0 : Math.max(...deps.map((x) => resolve(x, seen))) + 1;
    depth.set(key, d);
    return d;
  };

  for (const n of nodes) resolve(n.key);

  const waves: GraphNode[][] = [];
  for (const n of nodes) {
    const d = depth.get(n.key) ?? 0;
    (waves[d] ??= []).push(n);
  }
  return waves.filter(Boolean).map((w) => w.sort((a, b) => a.key.localeCompare(b.key)));
}

export function ArchitectureGraph({ nodes }: { nodes: GraphNode[] }) {
  if (nodes.length === 0) {
    return <p className="text-sm text-muted-foreground">No architecture compiled yet.</p>;
  }

  const waves = toWaves(nodes);

  return (
    <div className="space-y-1" data-testid="architecture-graph">
      {waves.map((wave, waveIndex) => (
        <div key={waveIndex}>
          {waveIndex > 0 && (
            // A single connector between waves. Drawing every edge across a
            // 17-node graph produces a hairball nobody can read.
            <div className="flex justify-center py-1" aria-hidden>
              <div className="h-4 w-px bg-border" />
            </div>
          )}

          <div className="flex flex-wrap justify-center gap-2">
            {wave.map((node) => {
              const style = STATUS_STYLE[node.status] ?? STATUS_STYLE.pending;
              const Icon = ICONS[node.logicalType] ?? Boxes;
              const active = node.status === 'running';

              return (
                <motion.div
                  key={node.key}
                  layout
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25 }}
                  className={`relative rounded-lg border-2 ${style.ring} bg-card px-3 py-2 min-w-[150px] max-w-[210px]`}
                  data-testid={`node-${node.key}`}
                  title={`${node.label} — ${style.label}`}
                >
                  {/* Pulses only while genuinely being created. */}
                  {active && (
                    <motion.div
                      className="absolute inset-0 rounded-lg bg-blue-500/10"
                      animate={{ opacity: [0.15, 0.45, 0.15] }}
                      transition={{ duration: 1.6, repeat: Infinity }}
                      aria-hidden
                    />
                  )}

                  <div className="relative flex items-start gap-2">
                    <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${style.text}`} />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium leading-tight truncate">{node.label}</p>
                      <p className="text-[10px] text-muted-foreground truncate">{node.logicalType.toLowerCase()}</p>
                    </div>
                    <StatusIcon status={node.status} />
                  </div>

                  {node.requiresApproval && node.status !== 'applied' && (
                    <p className="relative mt-1 text-[10px] text-yellow-600 flex items-center gap-1">
                      <Lock className="h-2.5 w-2.5" /> gated
                    </p>
                  )}
                </motion.div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
