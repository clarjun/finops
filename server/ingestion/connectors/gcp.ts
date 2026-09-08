/**
 * GCP cost connector.
 *
 * A thin shim over server/cloud/adapters/gcp.ts. This connector previously had
 * NO retry at all — a single BigQuery hiccup or transient network drop lost the
 * whole run with one warning. On the runtime it inherits the same
 * classification, backoff and budget as the other providers.
 *
 * The CostConnector shape is preserved exactly.
 */
import { runAdapter } from "../../cloud/fetch-runtime";
import { gcpCostAdapter } from "../../cloud/adapters/gcp";
import { getActiveCloudAccounts } from "../../cloud-config-manager";
import type { CostConnector, ConnectorResult, DateRange } from "../types";

export class GcpCostConnector implements CostConnector {
  readonly provider = 'gcp' as const;

  async isConfigured(): Promise<boolean> {
    const accounts = await getActiveCloudAccounts('gcp');
    return accounts.some(a => a.credentials?.billingTable);
  }

  async fetchCosts(range: DateRange): Promise<ConnectorResult> {
    const result = await runAdapter(gcpCostAdapter, range);
    return {
      records: result.records,
      apiCalls: result.apiCalls,
      warnings: result.warnings,
    };
  }
}
