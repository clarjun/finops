import { CostExplorerClient, GetCostAndUsageCommand, GetCostAndUsageCommandInput, GetCostForecastCommand } from "@aws-sdk/client-cost-explorer";
import { BudgetsClient, DescribeBudgetsCommand } from "@aws-sdk/client-budgets";
import { getProviderCredentials, getActiveCloudAccounts } from "./cloud-config-manager";

let costExplorerClient: CostExplorerClient | null = null;
let budgetsClient: BudgetsClient | null = null;
let currentCredentials: any = null;

export async function initializeAWSClient() {
  // Get credentials from database or environment
  // test
  const accountConfig = await getProviderCredentials('aws');
  
  if (!accountConfig) {
    console.log("[AWS] No credentials configured in database.");
    return null;
  }

  const credentials = accountConfig.credentials;
  
  console.log(`[AWS] Initializing client for account: ${accountConfig.accountName}`);
  //console.log(`[AWS] Credentials keys present:`, Object.keys(credentials));
  
  if (!credentials.accessKeyId || !credentials.secretAccessKey) {
    console.error('[AWS] Missing required credentials: accessKeyId or secretAccessKey');
    return null;
  }
  
  // Check if credentials have changed
  const credentialsChanged = !currentCredentials || 
    currentCredentials.accessKeyId !== credentials.accessKeyId ||
    currentCredentials.secretAccessKey !== credentials.secretAccessKey;

  if (credentialsChanged || !costExplorerClient) {
    try {
      costExplorerClient = new CostExplorerClient({
        region: credentials.region || "us-east-1",
        credentials: {
          accessKeyId: credentials.accessKeyId,
          secretAccessKey: credentials.secretAccessKey,
        },
      });
      currentCredentials = credentials;
      console.log(`[AWS] Cost Explorer client initialized successfully for: ${accountConfig.accountName}`);
      return costExplorerClient;
    } catch (error) {
      console.error("[AWS] Failed to initialize Cost Explorer client:", error);
      return null;
    }
  }

  return costExplorerClient;
}

export interface AWSCostData {
  date: string;
  provider: "aws";
  service: string;
  cost: number;
  region?: string;
  tags?: Record<string, string>;
  accountId?: string;
  accountName?: string;
}

export async function fetchAWSCostData(
  startDate: string,
  endDate: string
): Promise<AWSCostData[]> {
  const client = await initializeAWSClient();
  if (!client) {
    throw new Error("AWS Cost Explorer client not configured");
  }
  costExplorerClient = client;

  try {
    const params: GetCostAndUsageCommandInput = {
      TimePeriod: {
        Start: startDate,
        End: endDate,
      },
      Granularity: "DAILY",
      Metrics: ["UnblendedCost"],
      GroupBy: [
        {
          Type: "DIMENSION",
          Key: "SERVICE",
        },
      ],
    };

    const command = new GetCostAndUsageCommand(params);
    const response = await costExplorerClient.send(command);

    const costData: AWSCostData[] = [];

    if (response.ResultsByTime) {
      for (const result of response.ResultsByTime) {
        const date = result.TimePeriod?.Start || "";
        
        if (result.Groups) {
          for (const group of result.Groups) {
            const service = group.Keys?.[0] || "Unknown";
            const cost = parseFloat(group.Metrics?.UnblendedCost?.Amount || "0");

            // Non-zero rather than positive. Cost Explorer returns credits,
            // refunds and RI/SP discounts as negative amounts under their own
            // record types; dropping them reports the list price instead of the
            // invoice. This account happened to have none in August, so the
            // filter was harmless there and would silently overstate the first
            // month a credit landed.
            if (cost !== 0) {
              costData.push({
                date,
                provider: "aws",
                service,
                cost,
              });
            }
          }
        }
      }
    }

    console.log(`Fetched ${costData.length} AWS cost records from Cost Explorer API`);
    return costData;
  } catch (error: any) {
    console.error("Error fetching AWS cost data:", error);
    throw new Error(`AWS Cost Explorer API error: ${error.message}`);
  }
}

/**
 * Fetch AWS cost data for a SPECIFIC account's credentials, tagging each record
 * with that account's id/name. Uses its own client (does not touch the module
 * singleton) so multiple accounts can be queried independently.
 */
export async function fetchAWSCostDataForAccount(
  credentials: any,
  accountName: string,
  accountId: string,
  startDate: string,
  endDate: string
): Promise<AWSCostData[]> {
  if (!credentials?.accessKeyId || !credentials?.secretAccessKey) {
    console.error(`[AWS] Account "${accountName}" missing accessKeyId/secretAccessKey`);
    return [];
  }

  const client = new CostExplorerClient({
    region: credentials.region || "us-east-1",
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
  });

  const params: GetCostAndUsageCommandInput = {
    TimePeriod: { Start: startDate, End: endDate },
    Granularity: "DAILY",
    Metrics: ["UnblendedCost"],
    GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
  };

  const response = await client.send(new GetCostAndUsageCommand(params));
  const costData: AWSCostData[] = [];

  for (const result of response.ResultsByTime || []) {
    const date = result.TimePeriod?.Start || "";
    for (const group of result.Groups || []) {
      const service = group.Keys?.[0] || "Unknown";
      const cost = parseFloat(group.Metrics?.UnblendedCost?.Amount || "0");
      // Non-zero, not positive — see fetchAWSCostData. This is the path the
      // dashboard actually uses, via fetchAllAWSAccountsCostData.
      if (cost !== 0) {
        costData.push({ date, provider: "aws", service, cost, accountId, accountName });
      }
    }
  }

  console.log(`[AWS] Fetched ${costData.length} records for account "${accountName}"`);
  return costData;
}

/**
 * Fetch AWS cost data across ALL active AWS accounts, tagged per account.
 * Failures on one account don't block the others.
 */
export async function fetchAllAWSAccountsCostData(
  startDate: string,
  endDate: string
): Promise<AWSCostData[]> {
  const accounts = await getActiveCloudAccounts('aws');
  if (accounts.length === 0) return [];

  const perAccount = await Promise.all(
    accounts.map(acc =>
      fetchAWSCostDataForAccount(acc.credentials, acc.accountName, acc.accountId, startDate, endDate)
        .catch(err => {
          console.error(`[AWS] Failed to fetch costs for account "${acc.accountName}":`, err?.message || err);
          return [] as AWSCostData[];
        })
    )
  );

  return perAccount.flat();
}

export async function isAWSConfigured(): Promise<boolean> {
  // Check if credentials exist in database or environment
  const accountConfig = await getProviderCredentials('aws');
  
  if (!accountConfig) {
    return false;
  }

  try {
    const client = await initializeAWSClient();
    if (!client) {
      return false;
    }
    
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    
    const params: GetCostAndUsageCommandInput = {
      TimePeriod: {
        Start: startDate,
        End: endDate,
      },
      Granularity: "DAILY",
      Metrics: ["UnblendedCost"],
    };

    const command = new GetCostAndUsageCommand(params);
    await client.send(command);
    
    return true;
  } catch (error) {
    console.error("AWS Cost Explorer API test failed:", error);
    return false;
  }
}

/**
 * Look up the account's total monthly AWS budget.
 *
 * Returns a discriminated result rather than a number, because the three
 * outcomes are genuinely different and used to be indistinguishable — all of
 * them returned 0:
 *
 *   - a budget exists  -> 'found'
 *   - no budget is configured in AWS Budgets -> 'none'
 *   - we could not ask (missing budgets:DescribeBudgets, bad credentials,
 *     throttling) -> 'unavailable', with the reason
 *
 * Collapsing the last two into 0 told the user they had no budget when in fact
 * we could not read it. It also crashed the reports page: the caller assigned
 * that 0 to `budget` (defined, so the UI rendered the budget card) while
 * leaving `budgetUtilization` undefined, and the card called .toFixed() on it.
 */
export type AwsBudgetLookup =
  | { status: 'found'; monthlyBudget: number }
  | { status: 'none' }
  | { status: 'unavailable'; reason: string };

export async function fetchAWSBudgets(): Promise<AwsBudgetLookup> {
  try {
    const { BudgetsClient, DescribeBudgetsCommand } = await import("@aws-sdk/client-budgets");

    const client = await initializeAWSClient();
    if (!client) {
      return { status: 'unavailable', reason: 'AWS is not connected' };
    }

    // Get account ID from STS
    const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
    const stsClient = new STSClient({
      region: "us-east-1",
      credentials: {
        accessKeyId: currentCredentials.accessKeyId,
        secretAccessKey: currentCredentials.secretAccessKey,
      },
    });

    const identity = await stsClient.send(new GetCallerIdentityCommand({}));
    const accountId = identity.Account;

    if (!accountId) {
      return { status: 'unavailable', reason: 'Could not determine the AWS account ID' };
    }

    const budgetsClient = new BudgetsClient({
      region: "us-east-1",
      credentials: {
        accessKeyId: currentCredentials.accessKeyId,
        secretAccessKey: currentCredentials.secretAccessKey,
      },
    });

    const response = await budgetsClient.send(new DescribeBudgetsCommand({ AccountId: accountId }));

    if (!response.Budgets || response.Budgets.length === 0) {
      console.log("[AWS Budgets] No budgets configured");
      return { status: 'none' };
    }

    // Sum the MONTHLY budgets. Other time units (daily, quarterly, annual)
    // are not comparable to month-to-date spend, so they are excluded.
    let totalBudget = 0;
    let monthlyCount = 0;
    for (const budget of response.Budgets) {
      if (budget.TimeUnit === "MONTHLY" && budget.BudgetLimit?.Amount) {
        const amount = parseFloat(budget.BudgetLimit.Amount);
        if (Number.isFinite(amount)) {
          totalBudget += amount;
          monthlyCount++;
        }
      }
    }

    if (monthlyCount === 0) {
      // Budgets exist, but none are monthly. Saying 'no budget' would be wrong,
      // so name the actual situation.
      console.log(`[AWS Budgets] ${response.Budgets.length} budget(s), none MONTHLY`);
      return {
        status: 'unavailable',
        reason: `${response.Budgets.length} AWS budget(s) found, but none use a MONTHLY period, ` +
          `so none can be compared against month-to-date spend`,
      };
    }

    console.log(`[AWS Budgets] ${monthlyCount} monthly budget(s), total $${totalBudget.toFixed(2)}`);
    return { status: 'found', monthlyBudget: totalBudget };
  } catch (error: any) {
    console.error("[AWS Budgets] Error fetching budgets:", error?.message ?? error);
    return {
      status: 'unavailable',
      reason: `Could not read AWS Budgets: ${error?.message ?? 'unknown error'}`,
    };
  }
}

/**
 * Fetch the REAL AWS budget for an arbitrary date range by summing the actual
 * per-period budgeted amounts AWS recorded (via DescribeBudgetPerformanceHistory).
 * This reflects each month's true limit (including months where the limit
 * differed) — no monthly×N extrapolation. Returns null if AWS has no real
 * budget data covering the range.
 */
export async function fetchAWSBudgetForRange(
  startDate: string,
  endDate: string
): Promise<{ amount: number; monthsCovered: number; basis: string } | null> {
  try {
    const { BudgetsClient, DescribeBudgetsCommand, DescribeBudgetPerformanceHistoryCommand } = await import("@aws-sdk/client-budgets");
    const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");

    const client = await initializeAWSClient();
    if (!client || !currentCredentials) {
      throw new Error("AWS client not configured");
    }
    const credentials = {
      accessKeyId: currentCredentials.accessKeyId,
      secretAccessKey: currentCredentials.secretAccessKey,
    };

    const sts = new STSClient({ region: "us-east-1", credentials });
    const accountId = (await sts.send(new GetCallerIdentityCommand({}))).Account;
    if (!accountId) throw new Error("Could not determine AWS account ID");

    const budgetsClient = new BudgetsClient({ region: "us-east-1", credentials });
    const budgetsResp = await budgetsClient.send(new DescribeBudgetsCommand({ AccountId: accountId }));
    const budgets = budgetsResp.Budgets || [];
    if (budgets.length === 0) return null;

    const rangeStart = new Date(startDate);
    const rangeEnd = new Date(endDate);
    // First day of the range's starting month, used to decide which periods count.
    const firstOfStartMonth = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), 1);

    // DescribeBudgetPerformanceHistory only accepts a window within the last
    // ~12 months and not in the future, so clamp the requested window to
    // [now-12mo, now]. We still only COUNT periods inside the requested range.
    const now = new Date();
    const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    const histStart = firstOfStartMonth < twelveMonthsAgo ? twelveMonthsAgo : firstOfStartMonth;
    const histEnd = rangeEnd > now ? now : rangeEnd;
    if (histStart > histEnd) {
      console.log(`[AWS Budgets] Range ${startDate}..${endDate} is outside the available 12-month budget-history window`);
      return null;
    }

    let total = 0;
    const monthsSet = new Set<string>();

    for (const b of budgets) {
      if (!b.BudgetName) continue;
      try {
        const hist = await budgetsClient.send(new DescribeBudgetPerformanceHistoryCommand({
          AccountId: accountId,
          BudgetName: b.BudgetName,
          TimePeriod: { Start: histStart, End: histEnd },
        }));
        const list = hist.BudgetPerformanceHistory?.BudgetedAndActualAmountsList || [];
        for (const entry of list) {
          const periodStart = entry.TimePeriod?.Start ? new Date(entry.TimePeriod.Start) : null;
          if (!periodStart) continue;
          // Count the period only if its month falls within the requested range.
          if (periodStart >= firstOfStartMonth && periodStart <= rangeEnd) {
            const amt = parseFloat(entry.BudgetedAmount?.Amount || "0");
            if (amt > 0) {
              total += amt;
              monthsSet.add(`${periodStart.getFullYear()}-${periodStart.getMonth()}`);
            }
          }
        }
      } catch (e: any) {
        console.warn(`[AWS Budgets] No performance history for budget "${b.BudgetName}": ${e.message}`);
      }
    }

    if (total <= 0 || monthsSet.size === 0) {
      console.log(`[AWS Budgets] No real budget history found for ${startDate}..${endDate}`);
      return null;
    }

    console.log(`[AWS Budgets] Real budget for ${startDate}..${endDate}: $${total.toFixed(2)} across ${monthsSet.size} month(s)`);
    return {
      amount: total,
      monthsCovered: monthsSet.size,
      basis: `Sum of actual AWS monthly budget limits for ${monthsSet.size} month(s) in range`,
    };
  } catch (error: any) {
    console.error("[AWS Budgets] Error fetching budget for range:", error.message);
    return null;
  }
}

/**
 * Fetch AWS Cost Forecast for the current month
 * Uses GetCostForecast API
 */
export async function fetchAWSCostForecast(startDate: string, endDate: string): Promise<number> {
  try {
    const { GetCostForecastCommand } = await import("@aws-sdk/client-cost-explorer");
    
    const client = await initializeAWSClient();
    if (!client) {
      throw new Error("AWS Cost Explorer client not configured");
    }

    const command = new GetCostForecastCommand({
      TimePeriod: {
        Start: startDate,
        End: endDate,
      },
      Metric: "UNBLENDED_COST",
      Granularity: "MONTHLY",
    });

    const response = await costExplorerClient!.send(command);
    
    if (!response.Total?.Amount) {
      console.log("[AWS Forecast] No forecast data available");
      return 0;
    }

    const forecast = parseFloat(response.Total.Amount);
    console.log(`[AWS Forecast] Forecast for ${startDate} to ${endDate}: $${forecast.toFixed(2)}`);
    return forecast;
  } catch (error: any) {
    console.error("[AWS Forecast] Error fetching forecast:", error.message);
    // Fallback to linear projection if API fails
    return 0;
  }
}
