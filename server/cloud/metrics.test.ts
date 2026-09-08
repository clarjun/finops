/**
 * Metrics capability declaration.
 *
 * The point of these tests is not the data — it is that a missing capability is
 * STATED. Idle detection drives every rightsizing and shutdown recommendation,
 * and there is no GCP metrics fetcher, so GCP resources were never assessed and
 * nothing said so. A recommendations page covering two of three clouds looked
 * identical to one where the third cloud genuinely had nothing idle.
 *
 * Silence is this codebase's recurring failure mode: zero cost for an
 * unreachable provider, no anomalies for a provider with no metrics, an empty
 * inventory for expired credentials. These tests exist to keep one instance of
 * it explicit.
 */
import { describe, it, expect } from 'vitest';
import {
  METRICS_CAPABILITY,
  metricsSupported,
  unsupportedMetricsProviders,
} from './metrics';
import { idleAnalysisCoverage } from '../utils/service-level-idle-analyzer';
import { idleCoverageNote } from '../utils/ai-context-builder';

describe('metrics capability', () => {
  it('declares a decision for every provider, with no silent gaps', () => {
    // Typed as Record<CloudProvider, …>, so adding a provider to the union
    // forces an entry here rather than defaulting to unsupported-by-omission.
    for (const p of ['aws', 'azure', 'gcp'] as const) {
      expect(METRICS_CAPABILITY[p], p).toBeDefined();
      expect(typeof METRICS_CAPABILITY[p].supported, p).toBe('boolean');
    }
  });

  it('reports AWS and Azure as supported, GCP as not', () => {
    expect(metricsSupported('aws')).toBe(true);
    expect(metricsSupported('azure')).toBe(true);
    expect(metricsSupported('gcp')).toBe(false);
  });

  it('requires an explanation for any unsupported provider', () => {
    // An unsupported capability with no reason is just a silent gap with extra
    // steps. The reason is what a user reads on the page.
    for (const p of ['aws', 'azure', 'gcp'] as const) {
      const c = METRICS_CAPABILITY[p];
      if (!c.supported) {
        expect(c.reason, p).toBeTruthy();
        expect(c.reason!.length, p).toBeGreaterThan(40);
      }
    }
  });

  it('names the specific blocker for GCP, not a vague apology', () => {
    // Actionable: it says which client and which IAM role are needed, so the
    // gap can be closed rather than merely acknowledged.
    const reason = METRICS_CAPABILITY.gcp.reason!;
    expect(reason).toMatch(/monitoring/i);
    expect(reason).toMatch(/roles\/monitoring\.viewer/);
  });

  it('lists only the unsupported providers asked about', () => {
    expect(unsupportedMetricsProviders(['aws', 'azure'])).toHaveLength(0);
    expect(unsupportedMetricsProviders(['aws', 'gcp']).map((x) => x.provider)).toEqual(['gcp']);
  });

  it('declares which resource types a supported provider covers', () => {
    // Partial coverage matters too: AWS covers ec2 and rds, so an idle Lambda or
    // an idle load balancer is also "not assessed" rather than "not idle".
    expect(METRICS_CAPABILITY.aws.resourceTypes).toContain('ec2');
    expect(METRICS_CAPABILITY.aws.resourceTypes).toContain('rds');
    expect(METRICS_CAPABILITY.gcp.resourceTypes).toHaveLength(0);
  });
});

describe('idle analysis coverage', () => {
  it('separates what was assessed from what was not', () => {
    const c = idleAnalysisCoverage(['aws', 'azure', 'gcp']);
    expect(c.assessed).toEqual(['aws', 'azure']);
    expect(c.notAssessed.map((x) => x.provider)).toEqual(['gcp']);
  });

  it('carries the reason through, so a caller can render it', () => {
    const c = idleAnalysisCoverage(['gcp']);
    expect(c.assessed).toHaveLength(0);
    expect(c.notAssessed[0].reason).toMatch(/not collected yet/i);
  });

  it('reports full coverage when every provider asked about is supported', () => {
    const c = idleAnalysisCoverage(['aws']);
    expect(c.assessed).toEqual(['aws']);
    expect(c.notAssessed).toHaveLength(0);
  });
});

describe('AI idle-analysis context', () => {
  // The consumer is a language model, so the assertion is on the prose it reads.
  // A model will caveat an answer if the context says what is missing; it cannot
  // caveat an omission it cannot see.
  it('says nothing extra when only AWS was asked about', () => {
    expect(idleCoverageNote('aws')).toBe('');
  });

  it('names Azure and GCP as unassessed for an all-clouds question', () => {
    const note = idleCoverageNote('all');
    expect(note).toMatch(/Assessed: AWS/);
    expect(note).toMatch(/AZURE: not assessed/);
    expect(note).toMatch(/GCP: not assessed/);
  });

  it('tells the model that unassessed is not the same as nothing idle', () => {
    // The instruction that actually changes the answer. Without it the model
    // reported AWS-only findings as a complete multi-cloud result.
    expect(idleCoverageNote('all')).toMatch(/UNKNOWN, not as having nothing idle/);
  });

  it('reports zero coverage for a GCP-only question rather than staying silent', () => {
    // Previously this query skipped idle analysis entirely and produced no note
    // at all — an idle question answered with no idle analysis.
    const note = idleCoverageNote('gcp');
    expect(note).toMatch(/Assessed: none/);
    expect(note).toMatch(/roles\/monitoring\.viewer/);
  });

  it('distinguishes "no metrics exist" from "metrics exist but are not wired up"', () => {
    // Azure has a metrics fetcher; this path just does not call it. Collapsing
    // the two reasons would misdirect whoever tries to close the gap.
    const note = idleCoverageNote('all');
    expect(note).toMatch(/Utilisation metrics exist for AZURE/);
    expect(note).toMatch(/not collected yet/);
  });
});
