/**
 * The graph's arithmetic, kept apart from its rendering.
 *
 * These three functions decide what the deployment screen claims: which
 * resource is built before which, and how long each one took. All three are
 * wrong in ways that look plausible — a wave computed from a cycle recurses
 * forever, and a duration parsed from a timestamp without a zone is off by
 * whatever the browser's offset happens to be. This project has already shipped
 * that second bug once, in the engine's lease expiry.
 *
 * Separated from the component so they can be tested without a DOM.
 */

/** The shape the layout needs; the full node carries more. */
export interface LayoutNode {
  key: string;
  dependsOn: string[];
  startedAt?: string | null;
  finishedAt?: string | null;
}

/**
 * Groups nodes into dependency waves — the engine's own ordering.
 *
 * A node's depth is one past its deepest dependency, so everything in a wave
 * can be built at the same time and an edge always points downward.
 */
export function toWaves<T extends LayoutNode>(nodes: T[]): T[][] {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const depth = new Map<string, number>();

  const resolve = (key: string, seen = new Set<string>()): number => {
    if (depth.has(key)) return depth.get(key)!;
    // A cycle cannot be rendered as a layered graph. Treating it as depth 0
    // draws something wrong; recursing draws nothing and hangs the tab.
    if (seen.has(key)) return 0;
    seen.add(key);

    const node = byKey.get(key);
    // Dependencies outside this graph (a node the mapper excluded) must not
    // push depth; they are not drawn, so an edge to them cannot be seen.
    const deps = (node?.dependsOn ?? []).filter((d) => byKey.has(d));
    const d = deps.length === 0 ? 0 : Math.max(...deps.map((x) => resolve(x, seen))) + 1;
    depth.set(key, d);
    return d;
  };

  for (const n of nodes) resolve(n.key);

  const waves: T[][] = [];
  for (const n of nodes) {
    const d = depth.get(n.key) ?? 0;
    (waves[d] ??= []).push(n);
  }
  return waves.filter(Boolean).map((w) => w.sort((a, b) => a.key.localeCompare(b.key)));
}

/**
 * Elapsed seconds, still counting for a node that has not finished.
 *
 * `now` is a parameter rather than a call to Date.now() so the result is a
 * function of its inputs and can be asserted.
 */
export function elapsedSeconds(node: LayoutNode, now: number): number | null {
  if (!node.startedAt) return null;

  const start = Date.parse(node.startedAt);
  if (Number.isNaN(start)) return null;

  const end = node.finishedAt ? Date.parse(node.finishedAt) : now;
  if (Number.isNaN(end)) return null;

  // Clock skew between the server that stamped these and the browser reading
  // them can put "now" before the start. A negative age is never shown; it
  // reads as a bug in the deployment rather than in the clock.
  return Math.max(0, Math.round((end - start) / 1000));
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
