/**
 * Teardown is the only irreversible thing this system does, so the parts that
 * decide *what* gets destroyed are tested directly.
 *
 * The drift check is the one that matters most. Between someone reading an
 * approval and clicking approve, the account can change; if the executed set is
 * allowed to be larger than the reviewed set, the approval stops meaning
 * anything.
 */
import { describe, it, expect } from 'vitest';
import { destroyAddresses, unapprovedAdditions } from './teardown-safety';

const change = (address: string, action: string) => ({ address, action });

describe('destroyAddresses', () => {
  it('lists what the plan will delete', () => {
    expect(destroyAddresses({
      changes: [change('aws_vpc.main', 'delete'), change('aws_subnet.a', 'delete')],
    })).toEqual(['aws_subnet.a', 'aws_vpc.main']);
  });

  it('counts a replace, because a replace destroys the existing resource', () => {
    // Terraform reports ["delete","create"] as a replacement. The delete half is
    // real destruction and an approver has to see it.
    expect(destroyAddresses({ changes: [change('aws_db_instance.pg', 'replace')] }))
      .toEqual(['aws_db_instance.pg']);
  });

  it('ignores creates and no-ops', () => {
    expect(destroyAddresses({
      changes: [change('aws_vpc.main', 'create'), change('aws_s3_bucket.b', 'no-op'), change('aws_eip.e', 'delete')],
    })).toEqual(['aws_eip.e']);
  });

  it('sorts, so the same plan always reads the same way', () => {
    // The list goes into an approval record. Two identical plans that render in
    // different orders would look like different decisions in the audit trail.
    const a = destroyAddresses({ changes: [change('b', 'delete'), change('a', 'delete')] });
    const b = destroyAddresses({ changes: [change('a', 'delete'), change('b', 'delete')] });
    expect(a).toEqual(b);
  });

  it('is empty when nothing would be destroyed', () => {
    expect(destroyAddresses({ changes: [] })).toEqual([]);
  });
});

describe('unapprovedAdditions', () => {
  const approved = ['aws_subnet.a', 'aws_vpc.main'];

  it('passes when the set is unchanged', () => {
    expect(unapprovedAdditions(approved, ['aws_subnet.a', 'aws_vpc.main'])).toEqual([]);
  });

  it('passes when fewer resources remain', () => {
    // Something was destroyed by hand in between. The teardown does less than
    // was approved, which cannot surprise the approver.
    expect(unapprovedAdditions(approved, ['aws_vpc.main'])).toEqual([]);
  });

  it('catches a resource that appeared after the approval', () => {
    // The whole point. Someone approved destroying a VPC and a subnet; by the
    // time they clicked, a production database had joined the plan.
    expect(unapprovedAdditions(approved, [...approved, 'aws_db_instance.prod']))
      .toEqual(['aws_db_instance.prod']);
  });

  it('catches a substitution even when the count is identical', () => {
    // A count check would pass this. Two resources approved, two resources
    // destroyed — different two.
    expect(unapprovedAdditions(approved, ['aws_subnet.a', 'aws_db_instance.prod']))
      .toEqual(['aws_db_instance.prod']);
  });

  it('treats an empty approved set as approving nothing', () => {
    // Not as approving everything. A missing or malformed record must fail
    // closed; the alternative destroys an unreviewed set.
    expect(unapprovedAdditions([], ['aws_vpc.main'])).toEqual(['aws_vpc.main']);
  });
});
