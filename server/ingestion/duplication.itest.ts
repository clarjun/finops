/**
 * The fact store must never hold the same charge twice.
 *
 * This exists because it happened. Porting the AWS connector to an adapter
 * dropped its STS account-id resolution, so `subAccountId` changed from
 * `890882436612` to the free-text label in cloud_accounts. Since subAccountId
 * feeds sourceHash(), the ingester's UPSERT became an INSERT and five days of
 * AWS spend was stored twice — the dashboard read $8,468 instead of $4,308.
 *
 * Nothing failed. No error, no warning. The number was simply wrong, and
 * plausible enough that only someone who knew the account questioned it.
 *
 * These are integration tests because the invariant is a property of the data,
 * not of any function.
 */
import "dotenv/config";
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../db';

describe('no duplicated charges', () => {
  it('has at most one row per natural key', async () => {
    /*
     * The key must mirror sourceHash() exactly — organization, provider,
     * subAccount, day, service, region, resourceId, chargeCategory and
     * chargeDescription. My first version of this test omitted resource_id and
     * charge_description and reported false duplicates: GCP and Azure legitimately
     * emit several rows per service per day distinguished only by SKU
     * description, so a partial key makes normal data look broken.
     *
     * source_hash is stored on the row, so the honest check is on the column the
     * upsert actually keys on rather than on a reconstruction of it.
     */
    const { rows } = await db.execute(sql`
      select provider, count(*)::int as duplicate_groups
      from (
        select provider, source_hash
        from cost_facts
        group by 1, 2
        having count(*) > 1
      ) dupes
      group by provider
    `);

    expect(rows, `rows sharing a source_hash: ${JSON.stringify(rows)}`).toHaveLength(0);
  });

  it('uses one sub_account_id per provider account, not several spellings', async () => {
    /*
     * The symptom that actually surfaced. One AWS account appearing under both
     * its 12-digit id and a free-text label means a connector changed how it
     * derives the field — and every historical row is now orphaned rather than
     * updated.
     *
     * AWS account ids are 12 digits. Anything else in that column for AWS is a
     * label leaking through, which is precisely the bug.
     */
    const { rows } = await db.execute(sql`
      select distinct sub_account_id
      from cost_facts
      where provider = 'aws'
        and sub_account_id !~ '^[0-9]{12}$'
    `);

    expect(
      rows,
      `AWS facts keyed on something that is not a 12-digit account id: ${JSON.stringify(rows)}. ` +
      `A connector is writing the stored label instead of the STS-resolved account id.`,
    ).toHaveLength(0);
  });

  it('does not hold wildly more rows than distinct days x services', async () => {
    /*
     * A coarse ceiling, deliberately generous. It catches wholesale duplication
     * (every row twice) without being brittle about legitimate cardinality from
     * region and resource-group grouping.
     */
    const { rows } = await db.execute(sql`
      select provider,
             count(*)::int as total_rows,
             (count(distinct charge_period_start) * count(distinct service_name)
              * count(distinct coalesce(region_id, 'none'))
              * count(distinct sub_account_id))::bigint as max_possible
      from cost_facts
      group by provider
    `);

    for (const r of rows as any[]) {
      expect(
        Number(r.total_rows),
        `${r.provider}: ${r.total_rows} rows exceeds the maximum distinct combinations ` +
        `(${r.max_possible}), which is only possible with duplication.`,
      ).toBeLessThanOrEqual(Number(r.max_possible));
    }
  });
});
