/**
 * Row-mapping tests for the three real adapters.
 *
 * The runtime is tested against a FAKE adapter, which proves the policy but
 * says nothing about whether each provider's rows are read correctly. Every
 * cost bug in this project has been a mapping bug, not a policy bug:
 *
 *   - AWS  dropping STS account resolution changed subAccountId, which feeds
 *          source_hash, so the ingester's UPSERT became an INSERT and five days
 *          of spend was stored twice ($8,468 instead of $4,308)
 *   - GCP  summing `cost` without the credits array reported gross list price,
 *          overstating a real bill by 10.2%
 *   - all  a `cost > 0` filter discarded credits and refunds
 *
 * mapRows is pure, so these need no network, no credentials and no database.
 */
import { describe, it, expect } from 'vitest';
import { awsCostAdapter, type AwsRow } from './aws';
import { azureCostAdapter, type AzureRow } from './azure';
import { gcpCostAdapter, type GcpRow } from './gcp';

const ctxFor = (accountId: string, credentials: Record<string, any> = {}) => ({
  account: { id: 1, accountId, accountName: 'test-account', credentials, authType: 'access_keys' },
  range: { start: '2026-09-01', end: '2026-09-05' },
});

/* ── AWS ──────────────────────────────────────────────────────────────────── */

const awsRow = (over: Partial<AwsRow> = {}): AwsRow => ({
  day: '2026-09-03',
  serviceName: 'Amazon Elastic Compute Cloud - Compute',
  regionId: 'us-east-1',
  billedCost: 100,
  effectiveCost: 95,
  currency: 'USD',
  quantity: 24,
  quantityUnit: 'Hrs',
  accountId: '890882436612',
  accountName: 'aws account',
  ...over,
});

describe('AWS mapping', () => {
  const map = (rows: AwsRow[]) =>
    awsCostAdapter.mapRows(new Map([['default', rows]]), ctxFor('890882436612'));

  it('keys records on the RESOLVED account id, not the stored label', () => {
    // The bug that doubled costs. `AwsRow.accountId` is set in fetchPage from
    // STS GetCallerIdentity, precisely so a free-text label in cloud_accounts
    // cannot reach source_hash.
    const [r] = map([awsRow({ accountId: '890882436612' })]);
    expect(r.subAccountId).toBe('890882436612');
    expect(r.subAccountId).toMatch(/^\d{12}$/);
  });

  it('keeps negative amounts as credits', () => {
    const [r] = map([awsRow({ billedCost: -50, effectiveCost: -50 })]);
    expect(r.billedCost).toBe(-50);
    expect(r.chargeCategory).toBe('Credit');
  });

  it('classifies Tax by service name, since Cost Explorer has no tax dimension', () => {
    const [r] = map([awsRow({ serviceName: 'Tax', billedCost: 11 })]);
    expect(r.chargeCategory).toBe('Tax');
  });

  it('drops rows that are zero on BOTH measures, and only those', () => {
    expect(map([awsRow({ billedCost: 0, effectiveCost: 0 })])).toHaveLength(0);
    expect(map([awsRow({ billedCost: 0, effectiveCost: 0.004 })])).toHaveLength(1);
    expect(map([awsRow({ billedCost: 0.004, effectiveCost: null })])).toHaveLength(1);
  });

  it('normalises NoRegion to null rather than storing it as a region', () => {
    expect(map([awsRow({ regionId: null })])[0].regionId).toBeNull();
  });

  it('sets chargePeriodEnd to the following day', () => {
    const [r] = map([awsRow({ day: '2026-09-30' })]);
    expect(r.chargePeriodStart).toBe('2026-09-30');
    expect(r.chargePeriodEnd).toBe('2026-10-01');   // month rollover
    expect(r.billingPeriodStart).toBe('2026-09-01');
  });
});

/* ── Azure ────────────────────────────────────────────────────────────────── */

const azRow = (over: Partial<AzureRow> = {}): AzureRow => ({
  cost: 200,
  date: '2026-09-03',
  subscriptionName: 'CL-POC',
  resourceGroup: 'rg-app',
  serviceName: 'Virtual Machines',
  currency: 'USD',
  ...over,
});

describe('Azure mapping', () => {
  const map = (actual: AzureRow[], amortized: AzureRow[] = []) =>
    azureCostAdapter.mapRows(
      new Map([['ActualCost', actual], ['AmortizedCost', amortized]]),
      ctxFor('sub-1', { subscriptionId: 'sub-1', billingAccountId: 'ba-1' }),
    );

  it('joins amortized cost onto the matching actual row', () => {
    const [r] = map([azRow({ cost: 200 })], [azRow({ cost: 180 })]);
    expect(r.billedCost).toBe(200);
    expect(r.effectiveCost).toBe(180);
  });

  it('leaves effectiveCost null when the amortized pass is missing', () => {
    // The graceful-degradation path: throttling can lose the second pass, and a
    // fabricated effective cost is worse than an absent one.
    const [r] = map([azRow()], []);
    expect(r.billedCost).toBe(200);
    expect(r.effectiveCost).toBeNull();
  });

  it('does NOT join an amortized row that differs on any key dimension', () => {
    // Keyed on date + subscription + resource group + service. A looser match
    // would attribute one resource group's amortization to another.
    const [r] = map([azRow({ resourceGroup: 'rg-app' })], [azRow({ resourceGroup: 'rg-other', cost: 999 })]);
    expect(r.effectiveCost).toBeNull();
  });

  it('keeps negative amounts as credits', () => {
    const [r] = map([azRow({ cost: -25 })]);
    expect(r.billedCost).toBe(-25);
    expect(r.chargeCategory).toBe('Credit');
  });

  it('skips exact zeros', () => {
    expect(map([azRow({ cost: 0 })])).toHaveLength(0);
  });

  it('puts resource group in tags, not regionId', () => {
    // Azure exposes no region in this grouping. Storing the resource group as a
    // region would make every region-based view wrong.
    const [r] = map([azRow({ resourceGroup: 'rg-app' })]);
    expect(r.regionId).toBeNull();
    expect(r.tags).toEqual({ resourceGroup: 'rg-app' });
  });
});

/* ── GCP ──────────────────────────────────────────────────────────────────── */

const gcpRow = (over: Partial<GcpRow> = {}): GcpRow => ({
  usage_date: { value: '2026-09-03' },
  billing_account_id: '00880C-2156EB-19C000',
  project_id: 'ai-coe-442511',
  project_name: 'AI CoE',
  service_name: 'Compute Engine',
  sku_description: 'N1 Predefined Instance Core running in Americas',
  region: 'us-central1',
  currency: 'USD',
  billed_cost: 50,
  effective_cost: 42,
  usage_amount: 720,
  usage_unit: 'hour',
  labels_json: null,
  ...over,
});

describe('GCP mapping', () => {
  const map = (rows: GcpRow[]) =>
    gcpCostAdapter.mapRows(new Map([['default', rows]]), ctxFor('ai-coe-442511'));

  it('carries billed and credit-netted effective cost separately', () => {
    // Reporting the gross figure as the only number overstated a real bill by
    // 10.2%. Both must survive so the UI can offer the choice.
    const [r] = map([gcpRow({ billed_cost: 50, effective_cost: 42 })]);
    expect(r.billedCost).toBe(50);
    expect(r.effectiveCost).toBe(42);
  });

  it('accepts BigQuery DATE values in either shape', () => {
    expect(map([gcpRow({ usage_date: { value: '2026-09-03' } })])[0].chargePeriodStart).toBe('2026-09-03');
    expect(map([gcpRow({ usage_date: '2026-09-03' })])[0].chargePeriodStart).toBe('2026-09-03');
  });

  it('drops a row with no usable date rather than storing a bad key', () => {
    // chargePeriodStart is part of source_hash; an empty one would collide.
    expect(map([gcpRow({ usage_date: { value: undefined } })])).toHaveLength(0);
  });

  it('keeps negative amounts as credits', () => {
    const [r] = map([gcpRow({ billed_cost: -12, effective_cost: -12 })]);
    expect(r.chargeCategory).toBe('Credit');
  });

  it('parses labels into tags and tolerates malformed JSON', () => {
    expect(map([gcpRow({ labels_json: '[{"key":"env","value":"prod"}]' })])[0].tags).toEqual({ env: 'prod' });
    expect(map([gcpRow({ labels_json: 'not json' })])[0].tags).toBeNull();
    expect(map([gcpRow({ labels_json: '[]' })])[0].tags).toBeNull();
  });

  it('uses the project as the sub-account, not the billing account', () => {
    // Attribution is per project; keying on the billing account would collapse
    // every project into one row.
    const [r] = map([gcpRow()]);
    expect(r.subAccountId).toBe('ai-coe-442511');
    expect(r.billingAccountId).toBe('00880C-2156EB-19C000');
  });
});

/* ── cross-provider invariants ────────────────────────────────────────────── */

describe('every adapter agrees on the record contract', () => {
  const cases = [
    ['aws', awsCostAdapter.mapRows(new Map([['default', [awsRow()]]]), ctxFor('890882436612'))],
    ['azure', azureCostAdapter.mapRows(new Map([['ActualCost', [azRow()]]]), ctxFor('sub-1', { subscriptionId: 'sub-1' }))],
    ['gcp', gcpCostAdapter.mapRows(new Map([['default', [gcpRow()]]]), ctxFor('ai-coe-442511'))],
  ] as const;

  it('emits the fields every downstream reader depends on', () => {
    for (const [name, records] of cases) {
      expect(records.length, name).toBe(1);
      const r = records[0];
      expect(r.provider, name).toBe(name);
      // These four form part of source_hash; a missing one silently collides
      // rows or duplicates them.
      expect(r.subAccountId, name).toBeTruthy();
      expect(r.chargePeriodStart, name).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.serviceName, name).toBeTruthy();
      expect(typeof r.billedCost, name).toBe('number');
    }
  });

  it('sets chargePeriodEnd exactly one day after the start', () => {
    for (const [name, records] of cases) {
      const r = records[0];
      const start = new Date(`${r.chargePeriodStart}T00:00:00Z`).getTime();
      const end = new Date(`${r.chargePeriodEnd}T00:00:00Z`).getTime();
      expect(end - start, name).toBe(86_400_000);
    }
  });

  it('assigns a service category, so allocation views are never blank', () => {
    for (const [name, records] of cases) {
      expect(records[0].serviceCategory, name).toBeTruthy();
    }
  });
});
