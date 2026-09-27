import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export interface ModelSpend {
  model: string;
  family: string;
  vendor: string;
  provider: string;
  cost: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheTokens: number | null;
  totalTokens: number | null;
  costPerMillionTokens: number | null;
  outputCostPerMillion: number | null;
  /** 0-1. Below 1 means the rate covers only part of this model's spend. */
  tokenCoverage: number | null;
  share: number;
  isInference: boolean;
}

export interface UnitEconomics {
  name: string;
  unitLabel: string;
  value: number;
  periodStart: string;
  costPerUnit: number;
  previousCostPerUnit: number | null;
}

export interface AiEconomicsSummary {
  windowStart: string;
  windowEnd: string;
  totalCost: number;
  inferenceCost: number;
  platformCost: number;
  totalTokens: number | null;
  costWithoutTokenData: number;
  tokenGaps: Array<{ provider: string; cost: number; note: string }>;
  models: ModelSpend[];
  vendors: Array<{ vendor: string; cost: number; share: number }>;
  trend: Array<{ day: string; cost: number; tokens: number | null }>;
  unitEconomics: UnitEconomics | null;
}

export interface AiUnitMetric {
  id: number;
  name: string;
  unitLabel: string;
  periodStart: string;
  value: string;
  notes: string | null;
}

export function useAiEconomics(days: number) {
  return useQuery<AiEconomicsSummary>({
    queryKey: ['/api/ai-economics/summary', days],
    queryFn: () => api<AiEconomicsSummary>(`/api/ai-economics/summary?days=${days}`, {
      what: 'Loading AI economics',
    }),
    staleTime: 5 * 60 * 1000,
  });
}

export function useAiUnitMetrics() {
  return useQuery<{ metrics: AiUnitMetric[] }>({
    queryKey: ['/api/ai-economics/metrics'],
    queryFn: () => api('/api/ai-economics/metrics', { what: 'Loading unit metrics' }),
    staleTime: 5 * 60 * 1000,
  });
}

export interface SaveMetricInput {
  name: string;
  unitLabel: string;
  periodStart: string;
  value: number;
  notes?: string;
}

export function useSaveUnitMetric() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveMetricInput) =>
      api('/api/ai-economics/metrics', { method: 'PUT', body: input, what: 'Saving the metric' }),
    onSuccess: () => {
      // Both: the metric list AND every summary, whose cost-per-unit the new
      // denominator changes.
      qc.invalidateQueries({ queryKey: ['/api/ai-economics/metrics'] });
      qc.invalidateQueries({ queryKey: ['/api/ai-economics/summary'] });
    },
  });
}

export function useDeleteUnitMetric() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      api(`/api/ai-economics/metrics/${id}`, { method: 'DELETE', what: 'Deleting the metric' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/ai-economics/metrics'] });
      qc.invalidateQueries({ queryKey: ['/api/ai-economics/summary'] });
    },
  });
}
