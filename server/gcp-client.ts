import { BigQuery } from "@google-cloud/bigquery";

let bigQueryClient: BigQuery | null = null;

export function initializeGCPClient() {
  const GCP_SERVICE_ACCOUNT_KEY = process.env.GCP_SERVICE_ACCOUNT_KEY;
  const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;

  if (!GCP_SERVICE_ACCOUNT_KEY || !GCP_PROJECT_ID) {
    console.log("GCP credentials not configured. Using sample data for GCP costs.");
    return null;
  }

  try {
    let credentials;
    try {
      credentials = JSON.parse(GCP_SERVICE_ACCOUNT_KEY);
    } catch (parseError) {
      console.error("Failed to parse GCP_SERVICE_ACCOUNT_KEY as JSON:", parseError);
      return null;
    }

    bigQueryClient = new BigQuery({
      projectId: GCP_PROJECT_ID,
      credentials,
    });

    console.log(`GCP BigQuery client initialized for project: ${GCP_PROJECT_ID}`);
    return bigQueryClient;
  } catch (error) {
    console.error("Failed to initialize GCP BigQuery client:", error);
    return null;
  }
}

export interface GCPCostData {
  date: string;
  provider: "gcp";
  service: string;
  cost: number;
  region?: string;
  tags?: Record<string, string>;
}

export async function fetchGCPCostData(
  startDate: string,
  endDate: string
): Promise<GCPCostData[]> {
  if (!bigQueryClient) {
    const client = initializeGCPClient();
    if (!client) {
      throw new Error("GCP BigQuery client not configured");
    }
    bigQueryClient = client;
  }

  const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;
  const GCP_BILLING_DATASET = process.env.GCP_BILLING_DATASET || "cloud_billing_data";
  const GCP_BILLING_TABLE = process.env.GCP_BILLING_TABLE;

  if (!GCP_BILLING_TABLE) {
    throw new Error("GCP_BILLING_TABLE environment variable not set");
  }

  try {
    const query = `
      SELECT 
        DATE(usage_start_time) as usage_date,
        service.description as service_name,
        location.region as region,
        SUM(cost) as total_cost,
        TO_JSON_STRING(labels) as labels_json
      FROM 
        \`${GCP_PROJECT_ID}.${GCP_BILLING_DATASET}.${GCP_BILLING_TABLE}\`
      WHERE 
        DATE(usage_start_time) >= @startDate
        AND DATE(usage_start_time) < @endDate
        AND cost > 0
      GROUP BY 
        usage_date,
        service_name,
        region,
        labels_json
      ORDER BY 
        usage_date DESC,
        total_cost DESC
    `;

    const options = {
      query,
      params: {
        startDate,
        endDate,
      },
    };

    const [rows] = await bigQueryClient.query(options);

    const costData: GCPCostData[] = rows.map((row: any) => {
      let tags: Record<string, string> | undefined;
      if (row.labels_json) {
        try {
          const labelsArray = JSON.parse(row.labels_json);
          if (Array.isArray(labelsArray) && labelsArray.length > 0) {
            tags = labelsArray.reduce((acc: Record<string, string>, label: any) => {
              if (label.key && label.value) {
                acc[label.key] = label.value;
              }
              return acc;
            }, {});
          }
        } catch (e) {
          // Ignore label parsing errors
        }
      }

      return {
        date: row.usage_date.value,
        provider: "gcp",
        service: row.service_name || "Unknown",
        cost: parseFloat(row.total_cost) || 0,
        region: row.region || undefined,
        tags,
      };
    });

    console.log(`Fetched ${costData.length} GCP cost records from BigQuery`);
    return costData;
  } catch (error: any) {
    console.error("Error fetching GCP cost data from BigQuery:", error);
    throw new Error(`GCP BigQuery error: ${error.message}`);
  }
}

export async function isGCPConfigured(): Promise<boolean> {
  const GCP_SERVICE_ACCOUNT_KEY = process.env.GCP_SERVICE_ACCOUNT_KEY;
  const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;
  const GCP_BILLING_TABLE = process.env.GCP_BILLING_TABLE;

  if (!GCP_SERVICE_ACCOUNT_KEY || !GCP_PROJECT_ID || !GCP_BILLING_TABLE) {
    return false;
  }

  try {
    if (!bigQueryClient) {
      const client = initializeGCPClient();
      if (!client) {
        return false;
      }
    }

    const GCP_BILLING_DATASET = process.env.GCP_BILLING_DATASET || "cloud_billing_data";

    const query = `
      SELECT 
        DATE(usage_start_time) as usage_date,
        SUM(cost) as total_cost
      FROM 
        \`${GCP_PROJECT_ID}.${GCP_BILLING_DATASET}.${GCP_BILLING_TABLE}\`
      WHERE 
        DATE(usage_start_time) >= DATE_SUB(CURRENT_DATE(), INTERVAL 2 DAY)
      GROUP BY 
        usage_date
      LIMIT 1
    `;

    await bigQueryClient!.query(query);
    return true;
  } catch (error) {
    console.error("GCP BigQuery test query failed:", error);
    return false;
  }
}
