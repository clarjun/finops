import { describe, expect, it } from 'vitest';
import { finopsReportCacheKey } from './report-cache-key';
import { createCostCacheKey } from '../utils/api-cache';

/**
 * Both caches are process-wide and shared by every tenant on a replica, so the
 * key is the only thing keeping one organization's figures from another's.
 */
describe('tenant-scoped cache keys', () => {
  it('gives two organizations different report keys for the same request', () => {
    const a = finopsReportCacheKey(1, 'aws', '2026-10-01', '2026-10-17');
    const b = finopsReportCacheKey(2, 'aws', '2026-10-01', '2026-10-17');
    expect(a).not.toBe(b);
  });

  it('keeps the report key stable for one organization', () => {
    expect(finopsReportCacheKey(7, 'azure', '2026-10-01', '2026-10-17'))
      .toBe(finopsReportCacheKey(7, 'azure', '2026-10-01', '2026-10-17'));
  });

  it('does not let org 1 and org 11 collide', () => {
    expect(finopsReportCacheKey(1, 'gcp', '2026-10-01', '2026-10-17'))
      .not.toBe(finopsReportCacheKey(11, 'gcp', '2026-10-01', '2026-10-17'));
    expect(createCostCacheKey(1, 'azure', '2026-10-01', '2026-10-17'))
      .not.toBe(createCostCacheKey(11, 'azure', '2026-10-01', '2026-10-17'));
  });

  it('gives two organizations different cost-data keys for the same request', () => {
    const a = createCostCacheKey(1, 'azure', '2026-10-01', '2026-10-17');
    const b = createCostCacheKey(2, 'azure', '2026-10-01', '2026-10-17');
    expect(a).not.toBe(b);
  });
});
