/**
 * Cache key for a built FinOps report, stored in report_cache.
 *
 * report_cache rows are also filtered by organization_id, so the org segment is
 * redundant there. It stays in the key so that any in-process cache placed in
 * front of the table later cannot serve one organization another's report,
 * which is what happened when the key held only provider and dates.
 */
export function finopsReportCacheKey(
  orgId: number,
  provider: string,
  startDate: string,
  endDate: string,
): string {
  return `finops-report:org-${orgId}:${provider}:${startDate}:${endDate}`;
}
