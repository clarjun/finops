/**
 * AWS cost connector.
 *
 * A thin shim over server/cloud/adapters/aws.ts. The pagination loop, retry and
 * error handling that used to live here now belong to the shared fetch runtime,
 * so AWS, Azure and GCP behave identically under failure — and AWS joins the
 * per-provider request budget, which matters because Cost Explorer bills per
 * request.
 *
 * The CostConnector shape is preserved exactly, so the ingester, the fact store
 * and every read path are untouched.
 */
import { runAdapter } from "../../cloud/fetch-runtime";
import { awsCostAdapter } from "../../cloud/adapters/aws";
import { getActiveCloudAccounts } from "../../cloud-config-manager";
import type { CostConnector, ConnectorResult, DateRange } from "../types";

export class AwsCostConnector implements CostConnector {
  readonly provider = 'aws' as const;

  async isConfigured(): Promise<boolean> {
    const accounts = await getActiveCloudAccounts('aws');
    return accounts.length > 0;
  }

  async fetchCosts(range: DateRange): Promise<ConnectorResult> {
    const result = await runAdapter(awsCostAdapter, range);
    return {
      records: result.records,
      apiCalls: result.apiCalls,
      warnings: result.warnings,
    };
  }
}
