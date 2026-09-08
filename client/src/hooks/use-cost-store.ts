/**
 * Hooks over the cost fact store, ingestion, savings and audit APIs.
 *
 * These endpoints existed for a while with no consumer. Keeping the fetch logic
 * in one place rather than inline in each page means the cost-basis parameter
 * and the credentials mode are consistent everywhere — the alternative is one
 * page quietly reporting billed cost while another reports effective, which is
 * exactly the inconsistency the fact store was built to remove.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export type CostBasis = 'billed' | 'effective';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || body.detail || `Request failed (${res.status})`);
  }
  return res.json();
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || payload.detail || `Request failed (${res.status})`);
  return payload;
}

// ── Ingestion ────────────────────────────────────────────────────────────────

export interface Coverage {
  earliest: string | null;
  latest: string | null;
  rows: number;
  lastUpdated: string | null;
}

export interface IngestionRun {
  id: number;
  provider: string;
  status: 'running' | 'success' | 'failed' | 'partial';
  trigger: string;
  periodStart: string;
  periodEnd: string;
  recordsIngested: number;
  apiCalls: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export function useIngestionStatus() {
  return useQuery<{ coverage: Coverage; recentRuns: IngestionRun[] }>({
    queryKey: ['/api/costs/ingestion-status'],
    queryFn: () => getJson('/api/costs/ingestion-status'),
    // Ingestion is a background job; poll while the page is open so a run
    // started here shows its result without a manual refresh.
    refetchInterval: 30_000,
  });
}

export interface IngestResult {
  range: { start: string; end: string };
  totalRecords: number;
  totalApiCalls: number;
  results: Array<{
    provider: string;
    status: 'success' | 'failed' | 'partial' | 'skipped';
    recordsIngested: number;
    apiCalls: number;
    warnings: string[];
    error?: string;
  }>;
}

export function useRunIngestion() {
  const qc = useQueryClient();
  return useMutation<IngestResult, Error, { start?: string; end?: string; providers?: string[] }>({
    mutationFn: (body) => postJson('/api/costs/ingest', body),
    onSuccess: () => {
      // Everything downstream reads the fact store, so invalidate broadly.
      qc.invalidateQueries({ queryKey: ['/api/costs/ingestion-status'] });
      qc.invalidateQueries({ queryKey: ['/api/costs/processed'] });
      qc.invalidateQueries({ queryKey: ['/api/costs/summary'] });
      qc.invalidateQueries({ queryKey: ['/api/costs/by-tag'] });
      qc.invalidateQueries({ queryKey: ['/api/costs/by-category'] });
    },
  });
}

// ── Cost queries ─────────────────────────────────────────────────────────────

function costParams(o: { start?: string; end?: string; costBasis?: CostBasis; provider?: string }) {
  const p = new URLSearchParams();
  if (o.start) p.set('start', o.start);
  if (o.end) p.set('end', o.end);
  if (o.costBasis) p.set('costBasis', o.costBasis);
  if (o.provider && o.provider !== 'all') p.set('providers', o.provider);
  return p.toString();
}

export interface CategoryRow { serviceCategory: string | null; provider: string; cost: number }

export function useCostByCategory(o: { start: string; end: string; costBasis?: CostBasis; provider?: string }) {
  return useQuery<{ costBasis: CostBasis; categories: CategoryRow[] }>({
    queryKey: ['/api/costs/by-category', o.start, o.end, o.costBasis, o.provider],
    queryFn: () => getJson(`/api/costs/by-category?${costParams(o)}`),
  });
}

export interface TagAllocation {
  costBasis: CostBasis;
  tagKey: string;
  values: Array<{ tagValue: string; allocated: boolean; cost: number }>;
  totalCost: number;
  unallocatedCost: number;
  allocationCoveragePercent: number;
}

export function useCostByTag(o: { tagKey: string; start: string; end: string; costBasis?: CostBasis; provider?: string }) {
  return useQuery<TagAllocation>({
    queryKey: ['/api/costs/by-tag', o.tagKey, o.start, o.end, o.costBasis, o.provider],
    queryFn: () => getJson(`/api/costs/by-tag?tagKey=${encodeURIComponent(o.tagKey)}&${costParams(o)}`),
    enabled: !!o.tagKey,
  });
}

// ── Realized savings ─────────────────────────────────────────────────────────

export interface RealizedSavings {
  measuredActions: number;
  pendingMeasurements: number;
  inconclusiveMeasurements: number;
  realizedMonthlySavings: number;
  estimatedMonthlySavings: number;
  estimateAccuracyPercent: number | null;
  confidenceBreakdown: { high: number; medium: number; low: number };
}

export function useRealizedSavings() {
  return useQuery<RealizedSavings>({
    queryKey: ['/api/savings/realized'],
    queryFn: () => getJson('/api/savings/realized'),
  });
}

export interface SavingsMeasurement {
  id: number;
  actionId: number;
  provider: string;
  serviceName: string | null;
  granularity: string;
  status: 'pending' | 'measured' | 'inconclusive' | 'failed';
  confidence: string | null;
  baselineDailyCost: string | null;
  observedDailyCost: string | null;
  expectedDailyCost: string | null;
  realizedMonthlySavings: string | null;
  estimatedMonthlySavings: string | null;
  variancePercent: string | null;
  measureAfter: string;
  measuredAt: string | null;
  notes: string | null;
}

export function useSavingsMeasurements(status?: string) {
  return useQuery<{ measurements: SavingsMeasurement[]; count: number }>({
    queryKey: ['/api/savings/measurements', status],
    queryFn: () => getJson(`/api/savings/measurements${status ? `?status=${status}` : ''}`),
  });
}

// ── Audit log ────────────────────────────────────────────────────────────────

export interface AuditLogEntry {
  id: number;
  actorUsername: string | null;
  actorIp: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  method: string | null;
  path: string | null;
  statusCode: number | null;
  outcome: 'success' | 'failure' | 'denied';
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export function useAuditLogs(o: { limit?: number; action?: string } = {}) {
  const params = new URLSearchParams();
  if (o.limit) params.set('limit', String(o.limit));
  if (o.action) params.set('action', o.action);

  return useQuery<{ logs: AuditLogEntry[]; count: number }>({
    queryKey: ['/api/audit-logs', o.limit, o.action],
    queryFn: () => getJson(`/api/audit-logs?${params.toString()}`),
  });
}
