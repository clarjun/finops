import { CostExplorerClient, GetCostAndUsageCommand, GetCostAndUsageCommandInput, GetCostForecastCommand } from "@aws-sdk/client-cost-explorer";
import { BudgetsClient, DescribeBudgetsCommand } from "@aws-sdk/client-budgets";
import { getProviderCredentials } from "./cloud-config-manager";

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

            if (cost > 0) {
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
 * Fetch AWS Budgets for the account
 * Returns the total monthly budget amount
 */
export async function fetchAWSBudgets(): Promise<number> {
  try {
    const { BudgetsClient, DescribeBudgetsCommand } = await import("@aws-sdk/client-budgets");
    
    const client = await initializeAWSClient();
    if (!client) {
      throw new Error("AWS client not configured");
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
      throw new Error("Could not determine AWS account ID");
    }

    // Create Budgets client
    const budgetsClient = new BudgetsClient({
      region: "us-east-1",
      credentials: {
        accessKeyId: currentCredentials.accessKeyId,
        secretAccessKey: currentCredentials.secretAccessKey,
      },
    });

    // Fetch budgets
    const command = new DescribeBudgetsCommand({
      AccountId: accountId,
    });

    const response = await budgetsClient.send(command);
    
    if (!response.Budgets || response.Budgets.length === 0) {
      console.log("[AWS Budgets] No budgets found");
      return 0;
    }

    // Sum all monthly budgets
    let totalBudget = 0;
    for (const budget of response.Budgets) {
      if (budget.TimeUnit === "MONTHLY" && budget.BudgetLimit?.Amount) {
        totalBudget += parseFloat(budget.BudgetLimit.Amount);
      }
    }

    console.log(`[AWS Budgets] Found ${response.Budgets.length} budgets, ${response.Budgets.filter(b => b.TimeUnit === "MONTHLY").length} monthly`);
    console.log(`[AWS Budgets] Total monthly budget: $${totalBudget.toFixed(2)}`);
    return totalBudget;
  } catch (error: any) {
    console.error("[AWS Budgets] Error fetching budgets:", error.message);
    return 0;
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
