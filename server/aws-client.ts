import { CostExplorerClient, GetCostAndUsageCommand, GetCostAndUsageCommandInput } from "@aws-sdk/client-cost-explorer";

let costExplorerClient: CostExplorerClient | null = null;

export function initializeAWSClient() {
  // Read credentials fresh from environment each time (supports dynamic credential updates)
  const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
  const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
  const AWS_REGION = process.env.AWS_REGION || "us-east-1";

  if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
    console.log("AWS credentials not configured. Using sample data for AWS costs.");
    return null;
  }

  try {
    costExplorerClient = new CostExplorerClient({
      region: AWS_REGION,
      credentials: {
        accessKeyId: AWS_ACCESS_KEY_ID,
        secretAccessKey: AWS_SECRET_ACCESS_KEY,
      },
    });
    console.log(`AWS Cost Explorer client initialized for region: ${AWS_REGION}`);
    return costExplorerClient;
  } catch (error) {
    console.error("Failed to initialize AWS Cost Explorer client:", error);
    return null;
  }
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
  if (!costExplorerClient) {
    const client = initializeAWSClient();
    if (!client) {
      throw new Error("AWS Cost Explorer client not configured");
    }
    costExplorerClient = client;
  }

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
  // Read credentials fresh from environment
  const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
  const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
  
  if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
    return false;
  }

  try {
    if (!costExplorerClient) {
      initializeAWSClient();
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
    await costExplorerClient!.send(command);
    
    return true;
  } catch (error) {
    console.error("AWS Cost Explorer API test failed:", error);
    return false;
  }
}
