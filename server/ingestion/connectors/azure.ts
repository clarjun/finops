/**
 * Azure cost connector.
 *
 * A thin shim over server/cloud/adapters/azure.ts. Everything that used to live
 * here — a pagination loop, a hand-written throttle-retry, error strings, and a
 * Promise.all that made the connector throttle itself — now belongs to the
 * shared fetch runtime, so Azure, AWS and GCP behave identically under failure
 * and a resilience fix lands once rather than per provider.
 *
 * The CostConnector shape is preserved exactly, so the ingester, the fact store
 * and every read path are untouched.
 */
import { runAdapter } from "../../cloud/fetch-runtime";
import { azureCostAdapter } from "../../cloud/adapters/azure";
import { getActiveCloudAccounts } from "../../cloud-config-manager";
import type { CostConnector, ConnectorResult, DateRange } from "../types";

export class AzureCostConnector implements CostConnector {
  readonly provider = 'azure' as const;

  async isConfigured(): Promise<boolean> {
    const accounts = await getActiveCloudAccounts('azure');
    return accounts.some(a => a.credentials?.subscriptionId || a.credentials?.billingAccountId);
  }

  async fetchCosts(range: DateRange): Promise<ConnectorResult> {
    const result = await runAdapter(azureCostAdapter, range);
    return {
      records: result.records,
      apiCalls: result.apiCalls,
      warnings: result.warnings,
    };
  }
}
