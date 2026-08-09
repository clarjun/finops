/**
 * Client for the Infrastructure Deployment Agent.
 *
 * The live deployment view is driven by the run's event stream rather than by
 * polling. Events are durable and sequenced server-side, so `useRunStream`
 * reconnects with a cursor and replays what it missed — during a ten-minute
 * deployment, a dropped connection would otherwise lose exactly the part someone
 * was watching for.
 */
import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export type NodeStatus =
  | 'pending' | 'ready' | 'running' | 'awaiting_approval'
  | 'applied' | 'failed' | 'skipped' | 'rolled_back'
  /** The provider mapper cannot build this resource; it was excluded. */
  | 'unsupported';

export type RunStatus =
  | 'queued' | 'initializing' | 'planning' | 'awaiting_approval'
  | 'applying' | 'verifying' | 'succeeded' | 'failed' | 'cancelled' | 'paused';

export interface ClarificationQuestion {
  id: string;
  question: string;
  rationale: string;
  type: 'choice' | 'account';
  required: boolean;
  options?: Array<{ value: string; label: string; description?: string; recommended?: boolean }>;
  inferred?: { value: string; because: string };
}

export interface PlanNode {
  key: string;
  label: string;
  logicalType: string;
  dependsOn: string[];
  requiresApproval: boolean;
  source: 'estimator' | 'synthesized';
  estimatedMonthlyCost?: number;
  risk: { level: 'low' | 'medium' | 'high' | 'critical'; reasons: string[]; explanation: string };
}

export interface Stage {
  index: number;
  nodeKeys: string[];
  requiresApproval: boolean;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  riskReasons: string[];
  estimatedMonthlyCost: number;
}

export interface CompileResult {
  planId: number;
  nodes: PlanNode[];
  stages: Stage[];
  warnings: string[];
  waves: string[][];
  summary: { total: number; fromEstimate: number; synthesized: number; approvalGates: number };
}

export interface InfraEvent {
  id: number;
  runId: number;
  eventType: string;
  nodeKey: string | null;
  level: 'info' | 'warn' | 'error';
  message: string;
  data: unknown;
  sequence: number;
  createdAt: string;
}

export interface RunDetail {
  run: {
    id: number; planId: number; status: RunStatus; executionMode: 'live' | 'simulate';
    resourcesToAdd: number | null; resourcesToChange: number | null; resourcesToDestroy: number | null;
    resourcesCreated: number; approvalsRequired: number; approvalsGranted: number;
    error: string | null; startedAt: string | null; finishedAt: string | null;
  };
  // startedAt/finishedAt are recorded by the engine, so the graph can show a
  // real duration after a reload rather than timing from when the page opened.
  nodes: Array<{
    nodeKey: string; status: NodeStatus; error: string | null;
    startedAt: string | null; finishedAt: string | null;
  }>;
  approvals: Array<{
    id: number; ref: string; nodeKey: string | null; summary: string; details: string | null;
    riskLevel: string; riskReasons: string[]; status: string; estimatedCostImpact: string | null;
    decidedBy: string | null; decisionReason: string | null;
  }>;
  /** Provider and region live on the plan; the run carries neither. */
  plan: { name: string; provider: string | null; region: string | null } | null;
  planNodes: Array<{
    nodeKey: string; label: string; logicalType: string; dependsOn: string[];
    riskLevel: string; requiresApproval: boolean;
    /** Numeric in the database; Postgres returns it as a string. */
    estimatedMonthlyCost: string | null;
  }>;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || body.details || `Request failed (${res.status})`);
  return body as T;
}

const post = <T,>(url: string, body: unknown) =>
  json<T>(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

/* -------------------------------------------------------------------------- */

export function useCreateAgent() {
  return useMutation<
    { plan: { id: number; name: string; status: string }; questions: ClarificationQuestion[] },
    Error,
    { name: string; requirements: string; estimate: unknown[]; estimatedMonthlyCost?: number }
  >({
    mutationFn: (body) => post('/api/infra/plans', body),
  });
}

export function useCompilePlan() {
  const qc = useQueryClient();
  return useMutation<CompileResult, Error, { planId: number; answers: Record<string, unknown> }>({
    mutationFn: ({ planId, answers }) => post(`/api/infra/plans/${planId}/compile`, answers),
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: ['/api/infra/plans', v.planId] }),
  });
}

export function useStartRun() {
  return useMutation<
    { runId: number; executionMode: string; streamUrl: string },
    Error,
    { planId: number; executionMode: 'live' | 'simulate' }
  >({
    mutationFn: ({ planId, executionMode }) => post(`/api/infra/plans/${planId}/runs`, { executionMode }),
  });
}

export function useCloudAccounts() {
  return useQuery<{ accounts: Array<{ id: number; provider: string; accountName: string; accountId: string }> }>({
    queryKey: ['/api/infra/accounts'],
    queryFn: () => json('/api/infra/accounts'),
  });
}

export function useRun(runId: number | null) {
  return useQuery<RunDetail>({
    queryKey: ['/api/infra/runs', runId],
    queryFn: () => json(`/api/infra/runs/${runId}`),
    enabled: runId != null,
    // A slow poll as a safety net only. The event stream is the live channel;
    // this exists so a run that finishes while the stream is reconnecting still
    // settles in the UI.
    refetchInterval: (q) => {
      const status = (q.state.data as RunDetail | undefined)?.run?.status;
      return status && ['succeeded', 'failed', 'cancelled'].includes(status) ? false : 5000;
    },
  });
}

export function useDecideApproval() {
  const qc = useQueryClient();
  return useMutation<
    { runId: number; status: string },
    Error,
    { ref: string; decision: 'approved' | 'rejected'; reason?: string }
  >({
    mutationFn: ({ ref, decision, reason }) => post(`/api/infra/approvals/${ref}/decide`, { decision, reason }),
    onSuccess: (d) => qc.invalidateQueries({ queryKey: ['/api/infra/runs', d.runId] }),
  });
}

/* -------------------------------------------------------------------------- */

/**
 * Subscribes to a run's event stream.
 *
 * Keeps its own cursor so a reconnect asks only for what it has not seen.
 * EventSource retries automatically, but without the cursor it would replay from
 * the beginning and duplicate every line already on screen.
 */
export function useRunStream(runId: number | null): { events: InfraEvent[]; connected: boolean } {
  const [events, setEvents] = useState<InfraEvent[]>([]);
  const cursor = useRef(0);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (runId == null) return;

    // A new run starts a new stream; drop anything from the previous one.
    setEvents([]);
    cursor.current = 0;

    let source: EventSource | null = null;
    let closed = false;

    const connect = () => {
      if (closed) return;
      source = new EventSource(`/api/infra/runs/${runId}/stream?after=${cursor.current}`, { withCredentials: true });

      source.onopen = () => setConnected(true);

      source.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data) as InfraEvent;
          if (event.sequence <= cursor.current) return;   // already shown
          cursor.current = event.sequence;
          setEvents((prev) => [...prev, event]);
        } catch {
          /* a malformed frame must not kill the stream */
        }
      };

      source.onerror = () => {
        setConnected(false);
        source?.close();
        // Reconnect from the cursor rather than from zero.
        if (!closed) setTimeout(connect, 2000);
      };
    };

    connect();

    return () => {
      closed = true;
      source?.close();
      setConnected(false);
    };
  }, [runId]);

  return { events, connected };
}

/* -------------------------------------------------------------------------- */
/*  Knowledge: standard steps and blueprints                                   */
/* -------------------------------------------------------------------------- */

export interface LibraryStep {
  id: number;
  slug: string;
  name: string;
  provider: string;
  logicalType: string;
  resourceType: string | null;
  version: number;
  validationStatus: string;
  usageCount: number;
  successCount: number;
  successRate: number;
  lastValidatedAt: string | null;
  /** Older than the freshness window — a prompt to re-check, not an error. */
  stale: boolean;
  implementation: string | null;
}

export interface Blueprint {
  id: number;
  name: string;
  templateDescription: string | null;
  provider: string | null;
  region: string | null;
  requirements: string;
  estimatedMonthlyCost: string | null;
  templateUseCount: number;
  templateSourceRunId: number | null;
  createdAt: string;
}

export function useSteps(provider?: string) {
  return useQuery<{ steps: LibraryStep[] }>({
    queryKey: ['/api/infra/steps', provider],
    queryFn: () => json(`/api/infra/steps${provider ? `?provider=${provider}` : ''}`),
  });
}

export function useStepDetail(slug: string | null) {
  return useQuery<{
    versions: Array<{ id: number; version: number; implementation: string | null; validationStatus: string; usageCount: number; successCount: number; lastValidatedAt: string | null }>;
    provenance: Array<{ id: number; url: string; title: string | null; service: string | null; retrievedAt: string }>;
  }>({
    queryKey: ['/api/infra/steps', slug],
    queryFn: () => json(`/api/infra/steps/${slug}`),
    enabled: !!slug,
  });
}

export function useBlueprints() {
  return useQuery<{ templates: Blueprint[] }>({
    queryKey: ['/api/infra/templates'],
    queryFn: () => json('/api/infra/templates'),
  });
}

export function useInstantiateBlueprint() {
  const qc = useQueryClient();
  return useMutation<{ planId: number }, Error, { templateId: number; name?: string }>({
    mutationFn: ({ templateId, name }) => post(`/api/infra/templates/${templateId}/instantiate`, { name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['/api/infra/templates'] }),
  });
}

export interface ResearchResult {
  researched: number;
  recorded: number;
  /** Steps whose documentation could not be retrieved — reported, not hidden. */
  unavailable: string[];
  drift: Array<{ resourceType: string; version: string; url: string; undocumented: string[] }>;
}

export function useResearchDocs() {
  const qc = useQueryClient();
  return useMutation<ResearchResult, Error, void>({
    mutationFn: () => post('/api/infra/steps/research', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['/api/infra/steps'] }),
  });
}

/**
 * Starts a teardown of what a run deployed.
 *
 * Destroys nothing by itself: it creates a teardown run that plans the destroy
 * and stops for an approval listing every resource by address.
 */
export function useStartTeardown() {
  const qc = useQueryClient();
  return useMutation<{ teardownRunId: number; streamUrl: string }, Error, { runId: number }>({
    mutationFn: ({ runId }) => post(`/api/infra/runs/${runId}/teardown`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['/api/infra/deployments'] }),
  });
}

/**
 * Nudges a run forward.
 *
 * The worker does this on its own for a run that is still working. It is
 * exposed because a paused run deliberately is not swept: it stopped for a
 * person, and it resumes when that person says the cause is dealt with.
 */
export function useResumeRun() {
  const qc = useQueryClient();
  return useMutation<{ runId: number; scheduled: boolean }, Error, { runId: number }>({
    mutationFn: ({ runId }) => post(`/api/infra/runs/${runId}/advance`, {}),
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: ['/api/infra/runs', v.runId] }),
  });
}

export interface Remedy {
  code: string;
  title: string;
  explanation: string;
  docUrl?: string;
  change?: { field: string; to: string; describes: string };
  manualSteps?: string[];
}

export interface Diagnosis {
  status: RunStatus;
  error?: string;
  classification: { kind: string; reason: string; retryable: boolean } | null;
  /** Null when the failure is not one we can explain better than the raw text. */
  remedy: Remedy | null;
  currentAnswers?: Record<string, unknown>;
}

export function useDiagnosis(runId: number | null, enabled: boolean) {
  return useQuery<Diagnosis>({
    queryKey: ['/api/infra/runs', runId, 'diagnosis'],
    queryFn: () => json(`/api/infra/runs/${runId}/diagnosis`),
    enabled: runId != null && enabled,
  });
}

export interface PlanDetail {
  plan: {
    id: number;
    name: string;
    requirements: string | null;
    /** The Cost Estimator's priced line items, as handed over. */
    estimatorOutput: Array<Record<string, unknown>> | null;
    estimatedMonthlyCost: string | null;
    provider: string | null;
    region: string | null;
    environment: string | null;
  };
}

/** The plan behind a run, including what the estimator originally produced. */
export function usePlan(planId: number | null) {
  return useQuery<PlanDetail>({
    queryKey: ['/api/infra/plans', planId],
    queryFn: () => json(`/api/infra/plans/${planId}`),
    enabled: planId != null,
    // The requirement and the estimate do not change once the plan exists.
    staleTime: Infinity,
  });
}
