/**
 * The provider-neutral utilisation contract, and which providers can supply it.
 *
 * `ResourceMetrics` previously lived in `server/utils/aws-metrics-fetcher.ts`,
 * and the Azure fetcher imported it from there:
 *
 *     import type { ResourceMetrics } from './aws-metrics-fetcher';
 *
 * A shared contract owned by one provider's file is a contract nobody owns. It
 * also reads as though Azure metrics are a special case of AWS metrics, which
 * they are not.
 *
 * The more consequential problem this file addresses is the second export.
 * Utilisation metrics drive idle detection, which drives every rightsizing and
 * shutdown recommendation. There is no GCP metrics fetcher — so GCP resources
 * could never be flagged idle, and nothing anywhere said so. A GCP customer saw
 * a recommendations page that looked complete and simply omitted a whole class
 * of finding.
 *
 * Declaring the capability makes the gap a statement rather than an absence.
 * Silence is the failure mode this codebase keeps producing: zero cost for an
 * unreachable provider, no anomalies for a provider with no metrics, an empty
 * inventory for a provider whose credentials expired.
 */
import type { CloudProvider } from '@shared/schema';

/**
 * Utilisation for one resource over a window.
 *
 * Deliberately narrow. It holds only what idle detection actually needs, rather
 * than trying to model every metric each provider exposes — a wider union would
 * be mostly-undefined fields and no consumer for them.
 */
export interface ResourceMetrics {
  resourceId: string;
  resourceType: string;
  avgCpuUtilization?: number;
  maxCpuUtilization?: number;
  avgNetworkIn?: number;
  avgNetworkOut?: number;
  /** Human-readable window, e.g. "30 days". */
  period: string;
  isIdle: boolean;
  idleReason?: string;
}

export interface MetricsCapability {
  /** Whether utilisation metrics can be collected for this provider at all. */
  supported: boolean;
  /** Resource kinds covered, for reporting what was and was not assessed. */
  resourceTypes: readonly string[];
  /** Shown to the user when unsupported, so the gap is explained not hidden. */
  reason?: string;
}

/**
 * What utilisation data each provider can currently supply.
 *
 * `Record<CloudProvider, …>` so adding a provider to the union forces a decision
 * here rather than defaulting to silent absence.
 */
export const METRICS_CAPABILITY: Record<CloudProvider, MetricsCapability> = {
  aws: {
    supported: true,
    resourceTypes: ['ec2', 'rds'],
  },
  azure: {
    supported: true,
    resourceTypes: ['virtualMachine'],
  },
  gcp: {
    supported: false,
    resourceTypes: [],
    reason:
      'Utilisation metrics for GCP are not collected yet. Cloud Monitoring access ' +
      'requires the @google-cloud/monitoring client and the roles/monitoring.viewer ' +
      'permission on the connected service account. Until then, GCP idle-resource ' +
      'detection is unavailable — GCP resources are neither assessed nor reported as idle.',
  },
};

export function metricsSupported(provider: CloudProvider): boolean {
  return METRICS_CAPABILITY[provider]?.supported ?? false;
}

/**
 * Providers excluded from an idle-resource assessment, with the reason.
 *
 * Callers should surface this alongside their results. A recommendations page
 * that silently covers two of three providers is worse than one that says which
 * provider it could not assess, because the reader cannot tell the difference
 * between "nothing idle" and "not looked at".
 */
export function unsupportedMetricsProviders(
  providers: readonly CloudProvider[],
): Array<{ provider: CloudProvider; reason: string }> {
  return providers
    .filter((p) => !metricsSupported(p))
    .map((p) => ({ provider: p, reason: METRICS_CAPABILITY[p].reason ?? 'not supported' }));
}
