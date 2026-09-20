/**
 * Hooks over the governance API.
 *
 * Same shape as use-cost-store.ts. The types come from @shared/governance so
 * the console and the server cannot disagree about what a severity or an
 * enforcement mode is — the alternative is a string literal union copied into
 * the client that drifts the first time a policy domain is added.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  PostureSummary,
  PolicyCatalogEntry,
  ViolationView,
  ExemptionView,
  FrameworkCoverage,
  PolicyScope,
  PolicySeverity,
  EnforcementMode,
  DomainScore,
} from "@shared/governance";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || body.detail || `Request failed (${res.status})`);
  return body as T;
}

async function send<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || payload.detail || `Request failed (${res.status})`);
  return payload as T;
}

/** Everything the governance screens read, invalidated together after a sweep. */
const GOVERNANCE_KEYS = [
  ['/api/governance/summary'],
  ['/api/governance/policies'],
  ['/api/governance/violations'],
  ['/api/governance/exemptions'],
  ['/api/governance/frameworks'],
  ['/api/governance/history'],
];

function invalidateAll(qc: ReturnType<typeof useQueryClient>) {
  for (const key of GOVERNANCE_KEYS) qc.invalidateQueries({ queryKey: key });
}

export function usePosture() {
  return useQuery<PostureSummary>({
    queryKey: ['/api/governance/summary'],
    queryFn: () => getJson<PostureSummary>('/api/governance/summary'),
    staleTime: 60_000,
  });
}

export interface HistoryPoint {
  id: number;
  at: string;
  score: number;
  openViolations: number;
  costAtRisk: number;
  domains: DomainScore[];
}

export function useGovernanceHistory(limit = 30) {
  return useQuery<{ runs: HistoryPoint[] }>({
    queryKey: ['/api/governance/history', limit],
    queryFn: () => getJson(`/api/governance/history?limit=${limit}`),
    staleTime: 60_000,
  });
}

export function usePolicyCatalog() {
  return useQuery<{ policies: PolicyCatalogEntry[] }>({
    queryKey: ['/api/governance/policies'],
    queryFn: () => getJson('/api/governance/policies'),
    staleTime: 60_000,
  });
}

export interface ViolationFilters {
  status?: string;
  severity?: string;
  domain?: string;
  policyKey?: string;
  provider?: string;
  limit?: number;
}

export function useViolations(filters: ViolationFilters = {}) {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v !== undefined && v !== '') query.set(k, String(v));
  }
  const qs = query.toString();

  return useQuery<{ violations: ViolationView[]; truncated: boolean }>({
    queryKey: ['/api/governance/violations', qs],
    queryFn: () => getJson(`/api/governance/violations${qs ? `?${qs}` : ''}`),
    staleTime: 30_000,
  });
}

export function useExemptions() {
  return useQuery<{ exemptions: ExemptionView[] }>({
    queryKey: ['/api/governance/exemptions'],
    queryFn: () => getJson('/api/governance/exemptions'),
    staleTime: 60_000,
  });
}

export function useFrameworkCoverage() {
  return useQuery<{ frameworks: FrameworkCoverage[] }>({
    queryKey: ['/api/governance/frameworks'],
    queryFn: () => getJson('/api/governance/frameworks'),
    staleTime: 60_000,
  });
}

export interface PolicyUpdate {
  enabled: boolean;
  severity: PolicySeverity | null;
  enforcement: EnforcementMode;
  parameters: Record<string, unknown>;
  scope: PolicyScope;
}

export function useUpdatePolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ policyKey, update }: { policyKey: string; update: PolicyUpdate }) =>
      send<{ warnings: string[] }>('PUT', `/api/governance/policies/${encodeURIComponent(policyKey)}`, update),
    // The catalog and the posture both change; a stale score next to a freshly
    // toggled policy is the kind of inconsistency that makes people distrust
    // the whole screen.
    onSuccess: () => invalidateAll(qc),
  });
}

export function useResetPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (policyKey: string) =>
      send('POST', `/api/governance/policies/${encodeURIComponent(policyKey)}/reset`),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useRunEvaluation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => send<{ score: number; openViolations: number; violationsOpened: number; violationsResolved: number; notAssessed: string[] }>(
      'POST', '/api/governance/evaluate'),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useAcknowledgeViolation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: { id: number; note?: string }) =>
      send('POST', `/api/governance/violations/${id}/acknowledge`, { note }),
    onSuccess: () => invalidateAll(qc),
  });
}

export interface NewExemption {
  policyKey: string;
  resourceId?: string | null;
  reason: string;
  expiresInDays: number;
  scope?: PolicyScope;
}

export function useGrantExemption() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (exemption: NewExemption) => send('POST', '/api/governance/exemptions', exemption),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useRevokeExemption() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => send('DELETE', `/api/governance/exemptions/${id}`),
    onSuccess: () => invalidateAll(qc),
  });
}
