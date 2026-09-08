/**
 * Every adapter must treat `DateRange.end` as INCLUSIVE.
 *
 * This is asserted rather than trusted because the three providers disagree
 * natively, and the disagreement is invisible in normal use:
 *
 *   AWS    Cost Explorer `End` is EXCLUSIVE
 *   Azure  `timePeriod.to` is INCLUSIVE
 *   GCP    the query controls it (`<=` here)
 *
 * Passing the same string to all three produced a cross-cloud total that
 * combined 22 Azure days with 21 AWS days — a real shipped bug, and one nobody
 * spots by reading a dashboard. Each adapter converts to its provider's
 * convention; these tests prove the conversion, so a future edit that "tidies
 * up" `exclusiveEnd()` fails here instead of quietly under-reporting a day.
 *
 * The request each adapter builds is inspected directly. No network, no
 * credentials — the semantics are a property of the request, not of the data.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const RANGE = { start: '2026-09-01', end: '2026-09-05' };
/** The day after RANGE.end — what an exclusive bound must be set to. */
const DAY_AFTER_END = '2026-09-06';

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('AWS — converts to its exclusive End', () => {
  it('sets End to the day AFTER the inclusive range end', async () => {
    const sent: any[] = [];

    vi.doMock('../../aws/client-factory', () => ({
      awsReadClient: async () => ({
        send: async (cmd: any) => {
          sent.push(cmd.input);
          return { ResultsByTime: [], NextPageToken: undefined };
        },
      }),
      DEFAULT_AWS_REGION: 'us-east-1',
    }));
    vi.doMock('../../cloud-config-manager', () => ({
      getActiveCloudAccounts: async () => [
        { id: 1, accountId: '111111111111', accountName: 'a', credentials: {}, authType: 'access_keys' },
      ],
    }));

    const { awsCostAdapter } = await import('./aws');
    await awsCostAdapter.fetchPage(
      { account: { id: 1, accountId: '111111111111', accountName: 'a', credentials: {}, authType: 'access_keys' }, range: RANGE, pass: 'default' },
      null,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].TimePeriod.Start).toBe(RANGE.start);
    // The conversion. Passing RANGE.end straight through would silently drop
    // 2026-09-05 from every AWS figure.
    expect(sent[0].TimePeriod.End).toBe(DAY_AFTER_END);
  });
});

describe('Azure — passes the inclusive end through unchanged', () => {
  it('sets timePeriod.to to the range end itself', async () => {
    const bodies: any[] = [];

    vi.doMock('../../azure-client', () => ({ getAccessToken: async () => 'token' }));
    vi.doMock('../../cloud-config-manager', () => ({
      getActiveCloudAccounts: async () => [],
    }));

    vi.stubGlobal('fetch', async (_url: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ properties: { columns: [], rows: [] } }),
      } as any;
    });

    const { azureCostAdapter } = await import('./azure');
    await azureCostAdapter.fetchPage(
      {
        account: { id: 1, accountId: 'sub-1', accountName: 'a', credentials: { subscriptionId: 'sub-1' }, authType: 'access_keys' },
        range: RANGE,
        pass: 'ActualCost',
      },
      null,
    );

    expect(bodies).toHaveLength(1);
    expect(bodies[0].timePeriod.from).toBe(RANGE.start);
    // Azure's `to` is already inclusive. Converting it — as the AWS adapter
    // must — would add a day that does not belong to the requested range.
    expect(bodies[0].timePeriod.to).toBe(RANGE.end);
  });
});

describe('GCP — uses an inclusive comparison in SQL', () => {
  it('binds the range end unchanged and compares with <=', async () => {
    const queries: any[] = [];

    vi.doMock('@google-cloud/bigquery', () => ({
      BigQuery: class {
        async query(opts: any) { queries.push(opts); return [[]]; }
      },
    }));
    vi.doMock('../../cloud-config-manager', () => ({
      getActiveCloudAccounts: async () => [],
    }));

    const { gcpCostAdapter } = await import('./gcp');
    await gcpCostAdapter.fetchPage(
      {
        account: {
          id: 1, accountId: 'proj', accountName: 'a', authType: 'access_keys',
          credentials: {
            serviceAccountKey: JSON.stringify({ project_id: 'proj', client_email: 'x', private_key: 'y' }),
            billingTable: 'gcp_billing_export_v1_X',
          },
        },
        range: RANGE,
        pass: 'default',
      },
      null,
    );

    expect(queries).toHaveLength(1);
    expect(queries[0].params).toEqual({ startDate: RANGE.start, endDate: RANGE.end });
    // `<=` is what makes the bound inclusive. A `<` here would drop the last
    // day, which is exactly the bug the live GCP query had.
    expect(queries[0].query).toMatch(/DATE\(usage_start_time\)\s*<=\s*@endDate/);
    expect(queries[0].query).not.toMatch(/DATE\(usage_start_time\)\s*<\s*@endDate/);
  });
});

describe('the contract itself', () => {
  it('is documented as inclusive on both ends', async () => {
    // If someone changes DateRange's meaning, every adapter above becomes wrong
    // simultaneously. Pinning the docstring is crude but it is the only place
    // the intent is written down.
    const fs = await import('node:fs');
    const src = fs.readFileSync('server/ingestion/types.ts', 'utf8');
    const range = src.slice(src.indexOf('export interface DateRange'), src.indexOf('export interface NormalizedCostRecord'));
    expect(range).toMatch(/Inclusive/);
    expect((range.match(/Inclusive/g) ?? []).length).toBe(2);
  });
});
