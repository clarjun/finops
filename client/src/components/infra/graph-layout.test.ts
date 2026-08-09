import { describe, it, expect } from 'vitest';
import { toWaves, elapsedSeconds, formatDuration, type LayoutNode } from './graph-layout';

const node = (key: string, dependsOn: string[] = []): LayoutNode => ({ key, dependsOn });

describe('toWaves', () => {
  it('puts independent nodes in the first wave', () => {
    const waves = toWaves([node('vpc'), node('igw')]);
    expect(waves).toHaveLength(1);
    expect(waves[0].map((n) => n.key)).toEqual(['igw', 'vpc']);
  });

  it('places a node one wave past its deepest dependency', () => {
    // subnet waits on vpc; db waits on subnet. Three layers, in build order.
    const waves = toWaves([node('db', ['subnet']), node('vpc'), node('subnet', ['vpc'])]);
    expect(waves.map((w) => w.map((n) => n.key))).toEqual([['vpc'], ['subnet'], ['db']]);
  });

  it('uses the deepest dependency, not the first', () => {
    // If it took the first, `app` would land beside `subnet` and the picture
    // would claim it can be built before its security group exists.
    const waves = toWaves([
      node('vpc'),
      node('subnet', ['vpc']),
      node('sg', ['subnet']),
      node('app', ['vpc', 'sg']),
    ]);
    expect(waves[3].map((n) => n.key)).toEqual(['app']);
  });

  it('ignores dependencies that are not in the graph', () => {
    // The mapper excludes what it cannot build. An edge to a node nobody can
    // see must not push everything down a wave.
    const waves = toWaves([node('vpc'), node('subnet', ['vpc', 'observability'])]);
    expect(waves.map((w) => w.map((n) => n.key))).toEqual([['vpc'], ['subnet']]);
  });

  it('terminates on a cycle instead of recursing forever', () => {
    // A malformed plan must render something wrong, not hang the tab.
    const waves = toWaves([node('a', ['b']), node('b', ['a'])]);
    expect(waves.flat()).toHaveLength(2);
  });

  it('keeps every node exactly once', () => {
    const nodes = [node('a'), node('b', ['a']), node('c', ['a']), node('d', ['b', 'c'])];
    expect(toWaves(nodes).flat().map((n) => n.key).sort()).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('elapsedSeconds', () => {
  const NOW = Date.parse('2026-08-09T12:00:30.000Z');

  it('is null before a node starts', () => {
    expect(elapsedSeconds({ key: 'x', dependsOn: [] }, NOW)).toBeNull();
  });

  it('counts from the start while still running', () => {
    expect(elapsedSeconds({ key: 'x', dependsOn: [], startedAt: '2026-08-09T12:00:00.000Z' }, NOW)).toBe(30);
  });

  it('freezes at the finish once done', () => {
    const done = elapsedSeconds({
      key: 'x', dependsOn: [],
      startedAt: '2026-08-09T12:00:00.000Z',
      finishedAt: '2026-08-09T12:00:12.000Z',
    }, NOW);
    // Not 30 — the node stopped at 12 seconds regardless of what time it is now.
    expect(done).toBe(12);
  });

  it('respects the zone in the timestamp', () => {
    // The engine records UTC. Reading it as local time is exactly the bug that
    // put the run lease five and a half hours out.
    const utc = elapsedSeconds({ key: 'x', dependsOn: [], startedAt: '2026-08-09T12:00:00.000Z' }, NOW);
    const offset = elapsedSeconds({ key: 'x', dependsOn: [], startedAt: '2026-08-09T17:30:00.000+05:30' }, NOW);
    expect(offset).toBe(utc);
  });

  it('never reports a negative age when the clocks disagree', () => {
    const skewed = elapsedSeconds(
      { key: 'x', dependsOn: [], startedAt: '2026-08-09T12:00:45.000Z' },
      NOW, // 15 seconds before it started
    );
    expect(skewed).toBe(0);
  });

  it('is null for an unparseable timestamp rather than NaN', () => {
    // NaN would render as "NaNs" on the deployment screen.
    expect(elapsedSeconds({ key: 'x', dependsOn: [], startedAt: 'not a date' }, NOW)).toBeNull();
    expect(elapsedSeconds(
      { key: 'x', dependsOn: [], startedAt: '2026-08-09T12:00:00.000Z', finishedAt: 'broken' },
      NOW,
    )).toBeNull();
  });
});

describe('formatDuration', () => {
  it('reads in seconds under a minute', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(59)).toBe('59s');
  });

  it('reads in minutes and seconds', () => {
    expect(formatDuration(60)).toBe('1m 0s');
    expect(formatDuration(125)).toBe('2m 5s');
  });

  it('reads in hours past sixty minutes', () => {
    // An RDS instance takes over ten minutes; a full deployment can pass an
    // hour, and "3620m 0s" is not a duration anyone can read.
    expect(formatDuration(3600)).toBe('1h 0m');
    expect(formatDuration(3900)).toBe('1h 5m');
  });
});
