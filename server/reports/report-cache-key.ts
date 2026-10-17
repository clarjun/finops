/**
 * Cache key for a built FinOps report.
 *
 * The in-process report cache (utils/persistent-cache) is shared by every
 * tenant a replica serves, so the organization has to be part of the key.
 * Without it, two organizations asking for the same provider and date range
 * share one entry and the second is served the first one's report.
 *
 * report_cache rows are also filtered by organization_id, so the org segment is
 * redundant there but harmless — one key format for both layers.
 */
export function finopsReportCacheKey(
  orgId: number,
  provider: string,
  startDate: string,
  endDate: string,
): string {
  return `finops-report:org-${orgId}:${provider}:${startDate}:${endDate}`;
}
