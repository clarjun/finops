/**
 * The one place that knows which adapters exist.
 *
 * Adding a cloud should mean writing an adapter and adding a line here — not
 * hunting for every `switch (provider)` in the codebase. There were three such
 * switches for cost fetching alone (the live fetcher, the ingestion runner, and
 * the connector list), which is how Azure's missing pagination came to exist
 * twice in two files: each site was fixed on its own schedule, and one was
 * forgotten.
 *
 * Deliberately NOT a dynamic string-keyed map with a loose type. `CloudProvider`
 * stays a union, so adding a provider produces compile errors at every place
 * that must be considered — the frontend tabs, the service categoriser, the
 * credential resolver. That is a feature: the compiler enumerating the work is
 * better than discovering it in production, and a `Record<CloudProvider, …>`
 * below means a new provider cannot be registered without an adapter existing.
 */
import type { CloudProvider } from '@shared/schema';
import type { CloudCostAdapter } from './fetch-runtime';
import { awsCostAdapter } from './adapters/aws';
import { azureCostAdapter } from './adapters/azure';
import { gcpCostAdapter } from './adapters/gcp';

/**
 * Every provider's cost adapter.
 *
 * `Record<CloudProvider, …>` rather than a partial map: TypeScript then refuses
 * to compile if a provider is added to the union without an adapter, instead of
 * failing at runtime with an undefined lookup on whichever page happened to ask
 * for it first.
 */
export const COST_ADAPTERS: Record<CloudProvider, CloudCostAdapter<any>> = {
  aws: awsCostAdapter,
  azure: azureCostAdapter,
  gcp: gcpCostAdapter,
};

export const ALL_PROVIDERS: readonly CloudProvider[] = ['aws', 'azure', 'gcp'] as const;

export function adapterFor(provider: CloudProvider): CloudCostAdapter<any> {
  const adapter = COST_ADAPTERS[provider];
  if (!adapter) {
    // Unreachable while the Record type holds, but a clear error beats
    // `undefined.fetchPage is not a function` if the type is ever widened.
    throw new Error(`No cost adapter registered for provider "${provider}".`);
  }
  return adapter;
}
