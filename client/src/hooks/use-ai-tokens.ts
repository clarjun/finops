import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  inferenceCalls: number;
  inputCost: number;
  outputCost: number;
  cacheCost: number;
  totalCost: number;
  /** Null when there were no calls — never Infinity. */
  costPerCall: number | null;
  costPerMillionTokens: number | null;
  /** Rows whose model has no price, so the cost shown is understated. */
  unpricedRows: number;
}

export interface GroupedSpend extends TokenTotals {
  key: string;
  label: string;
  share: number;
}

export interface TrendPoint {
  day: string;
  inputTokens: number;
  outputTokens: number;
  inferenceCalls: number;
  totalCost: number;
  costPerCall: number | null;
}

export interface AiTokenDashboard {
  windowStart: string;
  windowEnd: string;
  totals: TokenTotals;
  byProvider: GroupedSpend[];
  byModel: GroupedSpend[];
  byApplication: GroupedSpend[];
  byEnvironment: GroupedSpend[];
  trend: TrendPoint[];
  unpriced: Array<{ providerKey: string; modelId: string; tokens: number; calls: number; firstSeen: string }>;
  filters: {
    providers: string[];
    models: Array<{ providerKey: string; modelId: string }>;
    applications: string[];
    environments: string[];
  };
}

export interface AiProviderInfo {
  key: string;
  displayName: string;
  billingMode: string;
  usageSource: string;
  docsUrl: string | null;
  /** False when the provider is declared but no adapter exists yet. */
  implemented: boolean;
}

export interface TokenFilterState {
  days: number;
  providers: string[];
  models: string[];
  applications: string[];
  environments: string[];
}

export function useAiTokens(f: TokenFilterState) {
  const params = new URLSearchParams({ days: String(f.days) });
  if (f.providers.length) params.set('providers', f.providers.join(','));
  if (f.models.length) params.set('models', f.models.join(','));
  if (f.applications.length) params.set('applications', f.applications.join(','));
  if (f.environments.length) params.set('environments', f.environments.join(','));
  const qs = params.toString();

  return useQuery<AiTokenDashboard>({
    queryKey: ['/api/ai-economics/tokens', qs],
    queryFn: () => api(`/api/ai-economics/tokens?${qs}`, { what: 'Loading AI token economics' }),
    staleTime: 2 * 60 * 1000,
  });
}

export function useAiProviders() {
  return useQuery<{ providers: AiProviderInfo[] }>({
    queryKey: ['/api/ai-economics/providers'],
    queryFn: () => api('/api/ai-economics/providers', { what: 'Loading providers' }),
    staleTime: 30 * 60 * 1000,
  });
}

export interface IngestSummary {
  providers: Array<{
    providerKey: string; configured: boolean; buckets: number; apiCalls: number;
    tokensIngested: number; callsIngested: number; warning?: string; error?: string;
  }>;
  repriced: { priced: number; unpriced: number; totalCost: number };
}

export function useIngestAiUsage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (lookbackHours: number) =>
      api<IngestSummary>('/api/ai-economics/ingest', {
        method: 'POST', body: { lookbackHours }, what: 'Collecting AI usage',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['/api/ai-economics/tokens'] }),
  });
}

export interface ModelPriceInput {
  providerKey: string;
  modelId: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion?: number | null;
  cacheWritePerMillion?: number | null;
  effectiveFrom: string;
  source: 'customer' | 'contract';
  notes?: string;
}

export function useSaveModelPrice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ModelPriceInput) =>
      api('/api/ai-economics/pricing', { method: 'PUT', body: input, what: 'Saving the price' }),
    onSuccess: () => {
      // The dashboard's costs are derived from pricing, so both must refresh.
      qc.invalidateQueries({ queryKey: ['/api/ai-economics/tokens'] });
      qc.invalidateQueries({ queryKey: ['/api/ai-economics/pricing'] });
    },
  });
}

export interface RefreshRatesResult {
  providerKey: string;
  ratesFetched: number;
  modelsMatched: number;
  modelsUnmatched: string[];
  pricesWritten: number;
  warning?: string;
  error?: string;
  repriced: { priced: number; unpriced: number; totalCost: number };
}

/**
 * Fetches published rates from the vendors instead of asking a human to type
 * them in. LiteLLM's catalogue carries ~4,300 models keyed by the exact id the
 * runtime reports; the vendor price lists are the fallback.
 */
export function useRefreshRates() {
  const qc = useQueryClient();
  return useMutation({
    // Typed explicitly: a default parameter makes react-query infer the
    // mutation variable as void, and the call site then cannot pass a provider.
    mutationFn: (provider: string) =>
      api<RefreshRatesResult>('/api/ai-economics/pricing/refresh', {
        method: 'POST', body: { provider, days: 90 }, what: 'Fetching published rates',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/ai-economics/tokens'] });
      qc.invalidateQueries({ queryKey: ['/api/ai-economics/pricing'] });
    },
  });
}

export type CoverageStatus = 'metered' | 'marketplace' | 'platform' | 'no_telemetry';

export interface CoverageRow {
  provider: string;
  serviceName: string;
  cost: number;
  status: CoverageStatus;
  reason: string;
  remedy: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  inferenceCalls: number | null;
  calculatedCost: number | null;
}

export interface CoverageSummary {
  windowStart: string;
  windowEnd: string;
  totalAiCost: number;
  meteredCost: number;
  unmeteredCost: number;
  coveragePercent: number;
  rows: CoverageRow[];
}

/**
 * Every billed AI service and whether token data exists for it.
 *
 * Kept separate from the token dashboard on purpose: this query reads billing,
 * not metrics, so it still answers when no usage has ever been collected —
 * which is exactly the moment someone needs to be told why.
 */
export function useAiCoverage(startDate: string, endDate: string) {
  return useQuery<CoverageSummary>({
    queryKey: ['/api/ai-economics/coverage', startDate, endDate],
    queryFn: () => api(
      `/api/ai-economics/coverage?startDate=${startDate}&endDate=${endDate}`,
      { what: 'Loading AI spend coverage' },
    ),
    staleTime: 5 * 60 * 1000,
  });
}
