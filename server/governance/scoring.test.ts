import { describe, it, expect } from 'vitest';
import { scorePolicies, type PolicyOutcome } from './scoring';

const outcome = (over: Partial<PolicyOutcome> = {}): PolicyOutcome => ({
  policyKey: 'test.policy',
  domain: 'cost',
  severity: 'medium',
  checked: 100,
  violatingUnits: 0,
  exemptUnits: 0,
  costAtRisk: 0,
  ...over,
});

describe('posture scoring', () => {
  it('scores a clean estate at 100', () => {
    expect(scorePolicies([outcome(), outcome({ severity: 'critical' })]).score).toBe(100);
  });

  it('scores total failure of every policy at 0', () => {
    const result = scorePolicies([
      outcome({ checked: 10, violatingUnits: 10 }),
      outcome({ checked: 5, violatingUnits: 5, severity: 'critical' }),
    ]);
    expect(result.score).toBe(0);
    expect(result.grade).toBe('F');
  });

  it('weights a critical failure far above a low one', () => {
    // The property that makes the number worth reading: one unencrypted
    // database must not score the same as one missing cost-centre tag.
    const criticalBroken = scorePolicies([
      outcome({ policyKey: 'a', severity: 'critical', checked: 10, violatingUnits: 10 }),
      outcome({ policyKey: 'b', severity: 'low', checked: 10, violatingUnits: 0 }),
    ]).score;

    const lowBroken = scorePolicies([
      outcome({ policyKey: 'a', severity: 'critical', checked: 10, violatingUnits: 0 }),
      outcome({ policyKey: 'b', severity: 'low', checked: 10, violatingUnits: 10 }),
    ]).score;

    expect(criticalBroken).toBeLessThan(lowBroken);
    expect(lowBroken).toBeGreaterThan(80);
  });

  it('scores on the violation rate, not the violation count', () => {
    // A large estate with a few exceptions must not score worse than a tiny
    // careless one, or every enterprise customer sees an F on day one.
    const bigEstate = scorePolicies([outcome({ checked: 3000, violatingUnits: 30 })]).score;
    const smallMess = scorePolicies([outcome({ checked: 3, violatingUnits: 2 })]).score;
    expect(bigEstate).toBeGreaterThan(smallMess);
  });

  it('excludes inconclusive policies from the score and names them', () => {
    // The central honesty property. A policy that could not run must not be
    // counted as a pass, because that turns missing data into a green tick.
    const result = scorePolicies([
      outcome({ policyKey: 'ran', checked: 10, violatingUnits: 5 }),
      outcome({ policyKey: 'no-data', checked: 0, inconclusive: 'No ingested spend' }),
    ]);

    // Only the policy that actually ran contributes: 5/10 at equal weight.
    expect(result.score).toBe(50);

    // The reason travels with the key. Without it the dashboard can only say
    // "1 policy not assessed", which tells the reader nothing to act on.
    const unassessed = result.notAssessed.find(n => n.policyKey === 'no-data');
    expect(unassessed).toBeDefined();
    expect(unassessed!.reason).toBe('No ingested spend');
    expect(unassessed!.failed).toBe(false);
  });

  it('distinguishes a policy that failed from one that merely had no data', () => {
    const result = scorePolicies([
      outcome({ policyKey: 'ok', checked: 10, violatingUnits: 0 }),
      outcome({ policyKey: 'broken', checked: 0, error: 'boom' }),
      outcome({ policyKey: 'empty', checked: 0, inconclusive: 'nothing to look at' }),
    ]);

    // Neither contributes to the score...
    expect(result.score).toBe(100);
    // ...but a crash is a different problem from an unconfigured check, and the
    // dashboard has to be able to say which is which.
    expect(result.failed).toEqual(['broken']);

    const broken = result.notAssessed.find(n => n.policyKey === 'broken')!;
    expect(broken.failed).toBe(true);
    expect(broken.reason).toContain('boom');

    expect(result.notAssessed.find(n => n.policyKey === 'empty')!.failed).toBe(false);
  });

  it('returns 100 when nothing at all could be assessed', () => {
    // Defensible only because notAssessed is non-empty and the UI shows it
    // beside the number. A score with no evidence behind it must be visibly so.
    const result = scorePolicies([outcome({ checked: 0, inconclusive: 'nothing' })]);
    expect(result.score).toBe(100);
    expect(result.notAssessed).toHaveLength(1);
    expect(result.notAssessed[0].reason).toBe('nothing');
  });

  it('clamps a policy that reports more findings than units checked', () => {
    // The platform-hardening policy can emit several findings per unit. Without
    // clamping, its gap exceeds 1 and drags the whole score negative.
    const result = scorePolicies([outcome({ checked: 2, violatingUnits: 7 })]);
    expect(result.score).toBe(0);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it('gives informational policies no influence over the score', () => {
    const result = scorePolicies([
      outcome({ policyKey: 'real', severity: 'high', checked: 10, violatingUnits: 0 }),
      outcome({ policyKey: 'fyi', severity: 'info', checked: 10, violatingUnits: 10 }),
    ]);
    expect(result.score).toBe(100);
  });

  it('still produces a defined score when every policy is informational', () => {
    const result = scorePolicies([outcome({ severity: 'info', checked: 10, violatingUnits: 10 })]);
    expect(Number.isFinite(result.score)).toBe(true);
    expect(result.score).toBe(0);
  });

  it('breaks the score down by domain', () => {
    const result = scorePolicies([
      outcome({ policyKey: 'a', domain: 'security', severity: 'critical', checked: 10, violatingUnits: 10 }),
      outcome({ policyKey: 'b', domain: 'tagging', severity: 'medium', checked: 10, violatingUnits: 0 }),
    ]);

    const security = result.domains.find(d => d.domain === 'security')!;
    const tagging = result.domains.find(d => d.domain === 'tagging')!;

    expect(security.score).toBe(0);
    expect(security.violations).toBe(10);
    expect(tagging.score).toBe(100);
    expect(tagging.policiesPassing).toBe(1);
  });

  it('reports every domain, including ones with no policies', () => {
    // The dashboard renders one card per domain. A missing entry would silently
    // drop a whole area of governance from the view.
    const result = scorePolicies([outcome({ domain: 'cost' })]);
    expect(result.domains).toHaveLength(5);
    expect(result.domains.every(d => Number.isFinite(d.score))).toBe(true);
  });

  it('sums the spend at risk across policies', () => {
    const result = scorePolicies([
      outcome({ policyKey: 'a', costAtRisk: 1200.5 }),
      outcome({ policyKey: 'b', costAtRisk: 800.25 }),
    ]);
    expect(result.costAtRisk).toBeCloseTo(2000.75, 2);
  });

  it('grades on the published boundaries', () => {
    const at = (score: number) => scorePolicies([
      // One policy, weight 1, gap chosen to hit the score exactly.
      outcome({ severity: 'low', checked: 100, violatingUnits: 100 - score }),
    ]).grade;

    expect(at(96)).toBe('A');
    expect(at(86)).toBe('B');
    expect(at(72)).toBe('C');
    expect(at(55)).toBe('D');
    expect(at(20)).toBe('F');
  });
});

// ── Per-policy score impact ───────────────────────────────────────────────────

describe('policy impacts', () => {
  const outcome = (over: Partial<PolicyOutcome>): PolicyOutcome => ({
    policyKey: 'p', domain: 'security', severity: 'high',
    checked: 10, violatingUnits: 0, exemptUnits: 0, costAtRisk: 0, ...over,
  });

  it('is exact: applying a gain reproduces the score after that policy is fixed', () => {
    // The property the whole panel rests on. If this drifts, the UI promises a
    // score the next run will not deliver.
    const outcomes = [
      outcome({ policyKey: 'a', severity: 'critical', checked: 30, violatingUnits: 14 }),
      outcome({ policyKey: 'b', severity: 'high', checked: 13, violatingUnits: 13 }),
      outcome({ policyKey: 'c', severity: 'low', checked: 100, violatingUnits: 2 }),
    ];

    const before = scorePolicies(outcomes);
    const gainOfA = before.impacts.find(i => i.policyKey === 'a')!.potentialGain;

    const afterFixingA = scorePolicies(
      outcomes.map(o => (o.policyKey === 'a' ? { ...o, violatingUnits: 0 } : o)),
    );

    expect(afterFixingA.score).toBeCloseTo(before.score + gainOfA, 1);
  });

  it('gains are additive, so a running total is honest', () => {
    const outcomes = [
      outcome({ policyKey: 'a', severity: 'critical', checked: 20, violatingUnits: 10 }),
      outcome({ policyKey: 'b', severity: 'medium', checked: 8, violatingUnits: 8 }),
    ];
    const before = scorePolicies(outcomes);
    const total = before.impacts.reduce((s, i) => s + i.potentialGain, 0);

    // Fixing everything reaches 100. The only slack is the score's own rounding
    // to one decimal — the gains themselves are exact, which is why they can be
    // summed into a running total at all.
    expect(before.score + total).toBeCloseTo(100, 1);

    // And the same thing proved the hard way, by actually fixing everything.
    const allFixed = scorePolicies(outcomes.map(o => ({ ...o, violatingUnits: 0 })));
    expect(allFixed.score).toBe(100);
  });

  it('ranks a wholly failing small rule above a partly failing big one', () => {
    // The finding COUNT says the opposite, which is the entire reason this
    // exists: 14 findings looks worse than 3 until you see the denominators.
    const before = scorePolicies([
      outcome({ policyKey: 'big', severity: 'critical', checked: 3000, violatingUnits: 14 }),
      outcome({ policyKey: 'small', severity: 'high', checked: 3, violatingUnits: 3 }),
    ]);

    expect(before.impacts[0].policyKey).toBe('small');
    expect(before.impacts[0].potentialGain).toBeGreaterThan(before.impacts[1].potentialGain);
  });

  it('leaves out rules with nothing failing', () => {
    const r = scorePolicies([
      outcome({ policyKey: 'clean', checked: 50, violatingUnits: 0 }),
      outcome({ policyKey: 'dirty', checked: 50, violatingUnits: 5 }),
    ]);
    expect(r.impacts.map(i => i.policyKey)).toEqual(['dirty']);
  });

  it('leaves out rules that reached no verdict, exactly as the score does', () => {
    // A policy excluded from the score must not appear as recoverable points;
    // its gain would be points the score cannot actually move by.
    const r = scorePolicies([
      outcome({ policyKey: 'noData', checked: 0, violatingUnits: 0 }),
      outcome({ policyKey: 'broke', checked: 10, violatingUnits: 4, error: 'boom' }),
      outcome({ policyKey: 'unsure', checked: 10, violatingUnits: 4, inconclusive: 'no allow-list' }),
      outcome({ policyKey: 'real', checked: 10, violatingUnits: 4 }),
    ]);
    expect(r.impacts.map(i => i.policyKey)).toEqual(['real']);
  });

  it('reports the denominator so a count can be read in context', () => {
    const r = scorePolicies([outcome({ policyKey: 'a', checked: 30, violatingUnits: 14 })]);
    expect(r.impacts[0]).toMatchObject({ checked: 30, violating: 14 });
    expect(r.impacts[0].failRate).toBeCloseTo(0.467, 2);
  });

  it('gives informational rules no recoverable points', () => {
    // Severity weight zero: they report without moving the number, so claiming
    // a gain would promise a score change that never arrives.
    const r = scorePolicies([
      outcome({ policyKey: 'info', severity: 'info', checked: 10, violatingUnits: 10 }),
      outcome({ policyKey: 'real', severity: 'high', checked: 10, violatingUnits: 5 }),
    ]);
    expect(r.impacts.find(i => i.policyKey === 'info')?.potentialGain).toBe(0);
  });

  it('returns nothing when no policy was scorable', () => {
    expect(scorePolicies([outcome({ checked: 0 })]).impacts).toEqual([]);
    expect(scorePolicies([]).impacts).toEqual([]);
  });
});
