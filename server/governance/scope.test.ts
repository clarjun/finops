import { describe, it, expect } from 'vitest';
import { matchesScope, filterByScope, sanitizeScope, describeScope, tagValue } from './scope';

describe('scope matching', () => {
  const resource = {
    provider: 'aws',
    accountId: '111122223333',
    region: 'eu-west-1',
    resourceId: 'i-abc',
    tags: { Environment: 'production' },
  };

  it('matches everything when the scope is empty', () => {
    // The asymmetry that matters: an unset dimension means "the whole estate".
    // If it meant "nothing", an unconfigured policy would render as a pass.
    expect(matchesScope({}, resource)).toBe(true);
    expect(matchesScope(undefined, resource)).toBe(true);
  });

  it('narrows by provider, account and region', () => {
    expect(matchesScope({ providers: ['aws'] }, resource)).toBe(true);
    expect(matchesScope({ providers: ['azure'] }, resource)).toBe(false);
    expect(matchesScope({ accountIds: ['111122223333'] }, resource)).toBe(true);
    expect(matchesScope({ accountIds: ['999'] }, resource)).toBe(false);
    expect(matchesScope({ regions: ['eu-west-1'] }, resource)).toBe(true);
    expect(matchesScope({ regions: ['us-east-1'] }, resource)).toBe(false);
  });

  it('requires every constrained dimension to match', () => {
    expect(matchesScope({ providers: ['aws'], regions: ['us-east-1'] }, resource)).toBe(false);
  });

  it('is case-insensitive on provider and region', () => {
    expect(matchesScope({ providers: ['AWS'] }, resource)).toBe(true);
    expect(matchesScope({ regions: ['EU-WEST-1'] }, resource)).toBe(true);
  });

  it('excludes a resource whose value is unknown on a constrained dimension', () => {
    // A null region cannot be proved to be inside a region allow-list, so it
    // must fall outside it rather than being waved through.
    expect(matchesScope({ regions: ['eu-west-1'] }, { ...resource, region: null })).toBe(false);
  });

  it('honours the exclusion list regardless of other matches', () => {
    expect(matchesScope({ providers: ['aws'], excludeResourceIds: ['i-abc'] }, resource)).toBe(false);
    expect(matchesScope({ excludeResourceIds: ['I-ABC'] }, resource)).toBe(false);
  });

  it('matches tag filters case-insensitively on both key and value', () => {
    expect(matchesScope({ includeTags: { environment: 'PRODUCTION' } }, resource)).toBe(true);
    expect(matchesScope({ includeTags: { Environment: 'staging' } }, resource)).toBe(false);
    expect(matchesScope({ includeTags: { Owner: 'x' } }, resource)).toBe(false);
  });

  it('filters a collection', () => {
    const items = [resource, { ...resource, provider: 'gcp' }];
    expect(filterByScope(items, { providers: ['aws'] })).toHaveLength(1);
    expect(filterByScope(items, {})).toHaveLength(2);
  });
});

describe('tagValue', () => {
  it('finds a key whatever its capitalisation', () => {
    expect(tagValue({ costcenter: 'CC-1' }, 'CostCenter')).toBe('CC-1');
    expect(tagValue({ CostCenter: 'CC-1' }, 'costcenter')).toBe('CC-1');
  });

  it('returns undefined rather than empty string for a missing key', () => {
    expect(tagValue({ a: '1' }, 'b')).toBeUndefined();
    expect(tagValue(null, 'b')).toBeUndefined();
  });
});

describe('sanitizeScope', () => {
  it('drops anything that is not a usable scope', () => {
    expect(sanitizeScope(null)).toEqual({});
    expect(sanitizeScope('aws')).toEqual({});
    expect(sanitizeScope(['aws'])).toEqual({});
  });

  it('keeps only non-empty string entries and trims them', () => {
    expect(sanitizeScope({ providers: [' aws ', '', 42, 'gcp'] })).toEqual({ providers: ['aws', 'gcp'] });
  });

  it('omits a dimension that ends up empty rather than storing an empty array', () => {
    // An empty array and an absent key must behave identically, and storing the
    // array invites a future reader to treat it as "matches nothing".
    expect(sanitizeScope({ providers: [], regions: ['eu-west-1'] })).toEqual({ regions: ['eu-west-1'] });
  });

  it('keeps only string tag values', () => {
    expect(sanitizeScope({ includeTags: { Env: 'prod', Bad: 5, Empty: '  ' } }))
      .toEqual({ includeTags: { Env: 'prod' } });
  });

  it('caps list length so a pasted export cannot become an unbounded filter', () => {
    const huge = Array.from({ length: 500 }, (_, i) => `acct-${i}`);
    expect(sanitizeScope({ accountIds: huge }).accountIds).toHaveLength(200);
  });
});

describe('describeScope', () => {
  it('says so plainly when nothing is narrowed', () => {
    expect(describeScope({})).toBe('Entire estate');
    expect(describeScope(undefined)).toBe('Entire estate');
  });

  it('summarises the constrained dimensions', () => {
    const text = describeScope({ providers: ['aws'], accountIds: ['1'], regions: ['eu-west-1'] });
    expect(text).toContain('AWS');
    expect(text).toContain('account 1');
    expect(text).toContain('eu-west-1');
  });

  it('collapses a long account list to a count', () => {
    expect(describeScope({ accountIds: ['1', '2', '3'] })).toContain('3 accounts');
  });
});
