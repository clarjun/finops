/**
 * Scope matching.
 *
 * A scope narrows a policy to part of the estate — one provider, three
 * production accounts, the EU regions. Every policy applies it the same way, so
 * it lives here rather than being re-derived (and re-bugged) in twenty
 * evaluators.
 *
 * An unset dimension matches everything. That asymmetry is deliberate: an empty
 * scope must mean "the whole estate", never "nothing", because a policy that
 * silently applies to zero resources renders as a passing control.
 */
import type { PolicyScope } from "@shared/governance";

export interface Scopeable {
  provider?: string | null;
  accountId?: string | null;
  region?: string | null;
  resourceId?: string | null;
  tags?: Record<string, string> | null;
}

function includesFold(list: string[] | undefined, value: string | null | undefined): boolean {
  if (!list || list.length === 0) return true;          // dimension not constrained
  if (value === null || value === undefined) return false; // constrained, and we cannot tell
  const needle = value.toLowerCase();
  return list.some(v => v.toLowerCase() === needle);
}

/** Tag lookup is case-insensitive on the key: AWS `Environment` vs `environment`. */
export function tagValue(tags: Record<string, string> | null | undefined, key: string): string | undefined {
  if (!tags) return undefined;
  const direct = tags[key];
  if (direct !== undefined) return direct;
  const needle = key.toLowerCase();
  for (const [k, v] of Object.entries(tags)) {
    if (k.toLowerCase() === needle) return v;
  }
  return undefined;
}

export function matchesScope(scope: PolicyScope | null | undefined, subject: Scopeable): boolean {
  if (!scope) return true;

  if (!includesFold(scope.providers, subject.provider)) return false;
  if (!includesFold(scope.accountIds, subject.accountId)) return false;
  if (!includesFold(scope.regions, subject.region)) return false;

  if (scope.excludeResourceIds?.length && subject.resourceId) {
    const id = subject.resourceId.toLowerCase();
    if (scope.excludeResourceIds.some(v => v.toLowerCase() === id)) return false;
  }

  if (scope.includeTags) {
    for (const [key, expected] of Object.entries(scope.includeTags)) {
      const actual = tagValue(subject.tags, key);
      if (actual === undefined || actual.toLowerCase() !== expected.toLowerCase()) return false;
    }
  }

  return true;
}

export function filterByScope<T extends Scopeable>(items: T[], scope: PolicyScope | null | undefined): T[] {
  if (!scope) return items;
  return items.filter(item => matchesScope(scope, item));
}

/** Normalises whatever arrived over HTTP into a scope we are willing to store. */
export function sanitizeScope(input: unknown): PolicyScope {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const raw = input as Record<string, unknown>;

  const list = (v: unknown): string[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const out = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
                 .map(x => x.trim())
                 .slice(0, 200);
    return out.length ? out : undefined;
  };

  const scope: PolicyScope = {};
  const providers = list(raw.providers);
  if (providers) scope.providers = providers;
  const accountIds = list(raw.accountIds);
  if (accountIds) scope.accountIds = accountIds;
  const regions = list(raw.regions);
  if (regions) scope.regions = regions;
  const excluded = list(raw.excludeResourceIds);
  if (excluded) scope.excludeResourceIds = excluded;

  if (raw.includeTags && typeof raw.includeTags === 'object' && !Array.isArray(raw.includeTags)) {
    const tags: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.includeTags as Record<string, unknown>)) {
      if (typeof v === 'string' && k.trim() && v.trim()) tags[k.trim()] = v.trim();
    }
    if (Object.keys(tags).length) scope.includeTags = tags;
  }

  return scope;
}

/** Human-readable one-liner for the UI and for audit metadata. */
export function describeScope(scope: PolicyScope | null | undefined): string {
  if (!scope) return 'Entire estate';
  const parts: string[] = [];
  if (scope.providers?.length) parts.push(scope.providers.join(', ').toUpperCase());
  if (scope.accountIds?.length) {
    parts.push(scope.accountIds.length === 1
      ? `account ${scope.accountIds[0]}`
      : `${scope.accountIds.length} accounts`);
  }
  if (scope.regions?.length) parts.push(`regions ${scope.regions.join(', ')}`);
  if (scope.includeTags) {
    parts.push(Object.entries(scope.includeTags).map(([k, v]) => `${k}=${v}`).join(' & '));
  }
  if (scope.excludeResourceIds?.length) parts.push(`${scope.excludeResourceIds.length} excluded`);
  return parts.length ? parts.join(' · ') : 'Entire estate';
}
