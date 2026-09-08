/**
 * AI spend classification and the report-wide data loss it exposed.
 *
 * Two separate defects sat behind "No AI/ML services usage detected":
 *
 *   1. The analyzer made its own live Cost Explorer call and returned zeros on
 *      any failure, which the UI renders identically to a genuine absence. One
 *      transient failure on 2026-09-06 was cached and served all day, while the
 *      previous day's cache for the same account held $2,205 of Bedrock spend.
 *
 *   2. The match list was written against older product names, so Azure
 *      "Foundry Models", GCP "Gemini API" and Claude-on-Vertex were never
 *      counted — and the Azure and GCP analyzers were stubs returning zeros
 *      regardless.
 */
import { describe, it, expect } from 'vitest';
import { analyzeAICosts, isAIService, type CostRecord } from './ai-cost-analyzer';
import { aggregateByDayAndService } from '../ingestion/cost-records';

describe('AI service classification', () => {
  it('matches Bedrock model line items, not just the Bedrock service', () => {
    // The real shape of this account's biggest cost. The old exact-name list
    // matched it only by accident, because the string happens to contain
    // "Amazon Bedrock".
    expect(isAIService('aws', 'Claude Opus 4.8 (Amazon Bedrock Edition)')).toBe(true);
    expect(isAIService('aws', 'Claude Haiku 4.5 (Amazon Bedrock Edition)')).toBe(true);
    expect(isAIService('aws', 'Amazon Bedrock')).toBe(true);
    expect(isAIService('aws', 'Amazon SageMaker')).toBe(true);
  });

  it('matches the current Azure and GCP names that were previously missed', () => {
    // Present in this account's billing data, absent from the old list.
    expect(isAIService('azure', 'Foundry Models')).toBe(true);
    expect(isAIService('gcp', 'Gemini API')).toBe(true);
    expect(isAIService('gcp', 'Claude Sonnet 4')).toBe(true);
    expect(isAIService('gcp', 'Vertex AI')).toBe(true);
  });

  it('does not misclassify infrastructure as AI', () => {
    // Guards the patterns against over-matching, which would inflate AI spend
    // and is harder to notice than under-matching.
    for (const s of ['Amazon Elastic Compute Cloud - Compute', 'EC2 - Other', 'AmazonCloudWatch', 'AWS CloudTrail']) {
      expect(isAIService('aws', s), s).toBe(false);
    }
    for (const s of ['Azure Kubernetes Service', 'Azure Monitor', 'Microsoft Fabric', 'Storage', 'Virtual Machines']) {
      expect(isAIService('azure', s), s).toBe(false);
    }
    for (const s of ['Compute Engine', 'Cloud Monitoring', 'Cloud Storage', 'Artifact Registry', 'Kubernetes Engine']) {
      expect(isAIService('gcp', s), s).toBe(false);
    }
  });
});

describe('analyzeAICosts', () => {
  const current: CostRecord[] = [
    { date: '2026-09-01', service: 'Claude Opus 4.8 (Amazon Bedrock Edition)', cost: 3000 },
    { date: '2026-09-01', service: 'Amazon SageMaker', cost: 30 },
    { date: '2026-09-01', service: 'Amazon Elastic Compute Cloud - Compute', cost: 470 },
    { date: '2026-09-02', service: 'EC2 - Other', cost: 500 },
  ];

  it('sums AI spend and reports its share of the total', () => {
    const a = analyzeAICosts('aws', current);
    expect(a.totalAISpend).toBeCloseTo(3030, 6);
    expect(a.aiPercentageOfTotal).toBeCloseTo((3030 / 4000) * 100, 6);
    expect(a.topAIService).toBe('Claude Opus 4.8 (Amazon Bedrock Edition)');
  });

  it('computes month-over-month instead of the hardcoded 0 it used to return', () => {
    const previous: CostRecord[] = [
      { date: '2026-08-15', service: 'Amazon Bedrock', cost: 1515 },
    ];
    expect(analyzeAICosts('aws', current, previous).monthOverMonthChange).toBeCloseTo(100, 6);
  });

  it('reports zero without dividing by zero when there is no prior AI spend', () => {
    expect(analyzeAICosts('aws', current, []).monthOverMonthChange).toBe(0);
  });

  it('reports a genuine absence as an absence', () => {
    // Still zero when there really is no AI usage — the fix is about not
    // reporting failures this way, not about never reporting zero.
    const a = analyzeAICosts('aws', [{ date: '2026-09-01', service: 'EC2 - Other', cost: 100 }]);
    expect(a.totalAISpend).toBe(0);
    expect(a.aiServices).toEqual([]);
    expect(a.topAIService).toBe('None');
  });

  it('excludes zero-cost AI line items from a spend report', () => {
    const a = analyzeAICosts('aws', [
      { date: '2026-09-01', service: 'Amazon Lex', cost: 0 },
      { date: '2026-09-01', service: 'Amazon Bedrock', cost: 5 },
    ]);
    expect(a.aiServices.map((s) => s.service)).toEqual(['Bedrock']);
  });

  it('handles an empty period without producing NaN', () => {
    const a = analyzeAICosts('gcp', []);
    expect(a.totalAISpend).toBe(0);
    expect(a.aiPercentageOfTotal).toBe(0);
    expect(Number.isNaN(a.monthOverMonthChange)).toBe(false);
  });
});

describe('aggregateByDayAndService', () => {
  const facts = [
    { provider: 'aws', accountId: '1', accountName: '1', date: '2026-09-01', serviceName: 'EC2', region: 'us-east-1', cost: 100, currency: 'USD' },
    { provider: 'aws', accountId: '1', accountName: '1', date: '2026-09-01', serviceName: 'EC2', region: 'eu-west-1', cost: 60, currency: 'USD' },
    { provider: 'aws', accountId: '1', accountName: '1', date: '2026-09-01', serviceName: 'EC2', region: 'ap-south-1', cost: 40, currency: 'USD' },
  ] as any[];

  it('SUMS regions rather than keeping one and discarding the rest', () => {
    // The bug that understated a September report by a third: the old dedup
    // keyed on date+service, so two of these three rows simply vanished.
    const out = aggregateByDayAndService([facts]);
    expect(out).toHaveLength(1);
    expect(out[0].cost).toBe(200);
  });

  it('deduplicates the overlap between two windows without double counting', () => {
    // The history window fully contains the reported period, so the same rows
    // arrive twice. They must collapse, not add up.
    const out = aggregateByDayAndService([facts, facts]);
    expect(out).toHaveLength(1);
    expect(out[0].cost).toBe(200);
  });

  it('keeps distinct sub-accounts separate before summing', () => {
    const twoAccounts = [
      facts[0],
      { ...facts[0], accountId: '2', accountName: '2' },
    ];
    // Same day, service and region but different accounts — both are real spend.
    expect(aggregateByDayAndService([twoAccounts])[0].cost).toBe(200);
  });

  it('does not merge different days or services', () => {
    const mixed = [
      facts[0],
      { ...facts[0], date: '2026-09-02' },
      { ...facts[0], serviceName: 'RDS' },
    ] as any[];
    expect(aggregateByDayAndService([mixed])).toHaveLength(3);
  });
});
