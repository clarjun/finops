/**
 * Live architecture graph.
 *
 * Nodes are laid out by dependency wave — the same waves the engine executes —
 * so the picture reads top-down in the order things are actually created, and an
 * edge always points downward. A force-directed layout would look livelier and
 * tell you nothing true.
 *
 * Edges are the real dependency graph, measured from where the nodes actually
 * are on screen. The previous version drew one connector between waves, which
 * looked like a dependency graph without being one: it could not show that the
 * database waits on two subnets while the gateway waits on nothing.
 *
 * Every animation is bound to real state. A node pulses only while it is
 * genuinely being created; an edge flows only into a node genuinely running;
 * duration counts real elapsed time from the timestamp the engine recorded.
 * Nothing here interpolates a phase the system did not report — Terraform tells
 * us planning, applying, applied and failed, so those are the states shown. A
 * "Provisioning → Configuring → Validating" sequence would look better and would
 * be invented, and this screen is the one people trust to tell them what is
 * happening to their infrastructure.
 */
import { useCallback, useLayoutEffect, useRef, useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  Network, HardDrive, Database, Server, Shield, Globe, Router,
  KeyRound, Activity, Boxes, Lock, CheckCircle2, XCircle, Loader2, MinusCircle,
  Clock, DollarSign, AlertTriangle,
} from "lucide-react";
import type { NodeStatus } from "@/hooks/use-infra-agent";
import { toWaves, elapsedSeconds, formatDuration } from "./graph-layout";

export interface GraphNode {
  key: string;
  label: string;
  logicalType: string;
  dependsOn: string[];
  requiresApproval: boolean;
  riskLevel: string;
  status: NodeStatus;
  /** From the plan; absent for nodes the estimate did not price. */
  estimatedMonthlyCost?: number | null;
  /** Recorded by the engine, so duration survives a page reload. */
  startedAt?: string | null;
  finishedAt?: string | null;
  error?: string | null;
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
const STATUS_STYLE: Record<NodeStatus, { ring: string; text: string; label: string; edge: string }> = {
  pending:           { ring: 'border-border',      text: 'text-muted-foreground', label: 'Waiting',           edge: 'stroke-border' },
  ready:             { ring: 'border-border',      text: 'text-muted-foreground', label: 'Ready',             edge: 'stroke-border' },
  running:           { ring: 'border-blue-500',    text: 'text-blue-500',         label: 'Creating',          edge: 'stroke-blue-500' },
  awaiting_approval: { ring: 'border-yellow-500',  text: 'text-yellow-600',       label: 'Approval required', edge: 'stroke-yellow-500' },
  applied:           { ring: 'border-green-500',   text: 'text-green-600',        label: 'Created',           edge: 'stroke-green-500' },
  failed:            { ring: 'border-destructive', text: 'text-destructive',      label: 'Failed',            edge: 'stroke-destructive' },
  skipped:           { ring: 'border-border',      text: 'text-muted-foreground', label: 'Not deployed',      edge: 'stroke-border' },
  // Distinct from 'Not deployed': this one was never buildable, and saying so
  // is the difference between a gap in the product and a fault in the run.
  unsupported:       { ring: 'border-border',      text: 'text-muted-foreground', label: 'Not supported yet', edge: 'stroke-border' },
  rolled_back:       { ring: 'border-destructive', text: 'text-destructive',      label: 'Rolled back',       edge: 'stroke-destructive' },
};

function StatusIcon({ status }: { status: NodeStatus }) {
  if (status === 'applied') return <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />;
  if (status === 'failed' || status === 'rolled_back') return <XCircle className="h-3.5 w-3.5 text-destructive" />;
  if (status === 'running') return <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />;
  if (status === 'awaiting_approval') return <Lock className="h-3.5 w-3.5 text-yellow-600" />;
  if (status === 'skipped' || status === 'unsupported') return <MinusCircle className="h-3.5 w-3.5 text-muted-foreground" />;
  return <div className="h-3.5 w-3.5 rounded-full border border-muted-foreground/40" />;
}

interface Box { x: number; y: number; w: number; h: number }

export function ArchitectureGraph({ nodes, provider }: { nodes: GraphNode[]; provider?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<string, HTMLElement>());
  const [boxes, setBoxes] = useState<Record<string, Box>>({});
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [selected, setSelected] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const anyRunning = nodes.some((n) => n.status === 'running');

  // A clock, only while something is actually running. A timer that keeps
  // ticking after a deployment finishes burns battery to display a number that
  // has stopped changing.
  useEffect(() => {
    if (!anyRunning) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [anyRunning]);

  /** Positions read from the DOM, so edges follow whatever the layout did. */
  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const base = container.getBoundingClientRect();
    const next: Record<string, Box> = {};

    for (const [key, el] of nodeRefs.current) {
      if (!el.isConnected) continue;
      const r = el.getBoundingClientRect();
      next[key] = { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height };
    }

    setBoxes(next);
    setSize({ w: base.width, h: container.scrollHeight });
  }, []);

  useLayoutEffect(() => {
    measure();
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    // Wrapping and column counts change with width, which moves every edge.
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [measure, nodes.length]);

  if (nodes.length === 0) {
    return <p className="text-sm text-muted-foreground">No architecture compiled yet.</p>;
  }

  const waves = toWaves(nodes);
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const selectedNode = selected ? byKey.get(selected) ?? null : null;

  // Every real dependency, not one connector per wave.
  const edges = nodes.flatMap((node) =>
    (node.dependsOn ?? [])
      .filter((dep) => byKey.has(dep) && boxes[dep] && boxes[node.key])
      .map((dep) => ({ from: dep, to: node.key })),
  );

  const related = (edge: { from: string; to: string }) =>
    selected != null && (edge.from === selected || edge.to === selected);

  return (
    <div data-testid="architecture-graph">
      <div ref={containerRef} className="relative">
        {/* Edges sit behind the nodes and never intercept a click. */}
        <svg
          className="absolute inset-0 pointer-events-none"
          width={size.w || '100%'}
          height={size.h || '100%'}
          aria-hidden
        >
          {edges.map(({ from, to }) => {
            const a = boxes[from];
            const b = boxes[to];
            const target = byKey.get(to)!;
            const source = byKey.get(from)!;

            const x1 = a.x + a.w / 2, y1 = a.y + a.h;
            const x2 = b.x + b.w / 2, y2 = b.y;
            const mid = y1 + (y2 - y1) / 2;

            // A dependency is "carrying" only once the thing it points from
            // exists. Colouring it green before that would assert something
            // untrue about the deployment.
            const satisfied = source.status === 'applied';
            const feedsRunning = target.status === 'running' && satisfied;
            const dim = selected != null && !related({ from, to });

            return (
              <path
                key={`${from}->${to}`}
                d={`M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`}
                fill="none"
                strokeWidth={feedsRunning ? 2 : 1.25}
                className={
                  feedsRunning ? 'stroke-blue-500'
                  : satisfied ? 'stroke-green-500/60'
                  : 'stroke-border'
                }
                strokeOpacity={dim ? 0.15 : 1}
                // Flows only into a node genuinely being created, so motion on
                // this screen always means work is happening right now.
                strokeDasharray={feedsRunning ? '4 4' : undefined}
              >
                {feedsRunning && (
                  <animate attributeName="stroke-dashoffset" from="16" to="0" dur="0.8s" repeatCount="indefinite" />
                )}
              </path>
            );
          })}
        </svg>

        <div className="relative space-y-6">
          {waves.map((wave, waveIndex) => (
            <div key={waveIndex} className="flex flex-wrap justify-center gap-3">
              {wave.map((node) => {
                const style = STATUS_STYLE[node.status] ?? STATUS_STYLE.pending;
                const Icon = ICONS[node.logicalType] ?? Boxes;
                const active = node.status === 'running';
                const seconds = elapsedSeconds(node, now);
                const isSelected = selected === node.key;
                const dim = selected != null && !isSelected
                  && !node.dependsOn.includes(selected)
                  && !(byKey.get(selected)?.dependsOn.includes(node.key));

                return (
                  <motion.button
                    key={node.key}
                    ref={(el) => {
                      if (el) nodeRefs.current.set(node.key, el);
                      else nodeRefs.current.delete(node.key);
                    }}
                    type="button"
                    onClick={() => setSelected(isSelected ? null : node.key)}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: dim ? 0.35 : 1, y: 0 }}
                    transition={{ duration: 0.25 }}
                    className={`relative text-left rounded-lg border-2 ${style.ring} bg-card px-3 py-2 min-w-[168px] max-w-[220px] ${
                      isSelected ? 'ring-2 ring-primary ring-offset-1 ring-offset-background' : ''
                    }`}
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
                        <p className="text-[10px] text-muted-foreground truncate">
                          {provider ? `${provider} · ` : ''}{node.logicalType.toLowerCase()}
                        </p>
                      </div>
                      <StatusIcon status={node.status} />
                    </div>

                    {/* The facts the spec asks each resource to carry: what it
                        will cost, how long it took, whether it is gated. */}
                    <div className="relative mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10px]">
                      <span className={style.text}>{style.label}</span>

                      {seconds != null && (
                        <span className="text-muted-foreground flex items-center gap-0.5">
                          <Clock className="h-2.5 w-2.5" />{formatDuration(seconds)}
                        </span>
                      )}

                      {node.estimatedMonthlyCost != null && node.estimatedMonthlyCost > 0 && (
                        <span className="text-muted-foreground flex items-center gap-0.5">
                          <DollarSign className="h-2.5 w-2.5" />{node.estimatedMonthlyCost.toFixed(0)}/mo
                        </span>
                      )}

                      {node.requiresApproval && node.status !== 'applied' && (
                        <span className="text-yellow-600 flex items-center gap-0.5">
                          <Lock className="h-2.5 w-2.5" />gated
                        </span>
                      )}
                    </div>
                  </motion.button>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {selectedNode && <NodeDetail node={selectedNode} nodes={nodes} onClose={() => setSelected(null)} />}
    </div>
  );
}

/** What one resource is, what it waits on, and what went wrong if anything did. */
function NodeDetail({ node, nodes, onClose }: { node: GraphNode; nodes: GraphNode[]; onClose: () => void }) {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const dependents = nodes.filter((n) => n.dependsOn.includes(node.key));
  const seconds = elapsedSeconds(node, Date.now());

  return (
    <div className="mt-4 rounded-lg border bg-muted/30 p-3 text-xs space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-medium text-sm">{node.label}</p>
          <p className="text-muted-foreground font-mono text-[11px]">{node.key}</p>
        </div>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground shrink-0">Close</button>
      </div>

      <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
        <Fact label="Type" value={node.logicalType.toLowerCase()} />
        <Fact label="Status" value={(STATUS_STYLE[node.status] ?? STATUS_STYLE.pending).label} />
        <Fact label="Risk" value={node.riskLevel} />
        <Fact label="Approval" value={node.requiresApproval ? 'required' : 'not required'} />
        {node.estimatedMonthlyCost != null && (
          <Fact label="Estimated cost" value={`$${node.estimatedMonthlyCost.toFixed(2)}/month`} />
        )}
        {seconds != null && <Fact label="Duration" value={formatDuration(seconds)} />}
      </div>

      <div>
        <p className="text-muted-foreground">Waits for</p>
        <p>
          {node.dependsOn.length === 0
            ? 'nothing — this is built first'
            : node.dependsOn.map((d) => byKey.get(d)?.label ?? d).join(', ')}
        </p>
      </div>

      {dependents.length > 0 && (
        <div>
          <p className="text-muted-foreground">Blocks</p>
          <p>{dependents.map((d) => d.label).join(', ')}</p>
        </div>
      )}

      {node.error && (
        <p className="rounded border border-destructive/50 bg-destructive/10 p-2 flex gap-1.5 break-words">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px text-destructive" />
          <span>{node.error}</span>
        </p>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <p className="flex gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </p>
  );
}
