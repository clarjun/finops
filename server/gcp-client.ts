import { BigQuery } from "@google-cloud/bigquery";
import { getProviderCredentials } from "./cloud-config-manager";

let bigQueryClient: BigQuery | null = null;
let currentCredentials: any = null;

export async function initializeGCPClient() {
  // Get credentials from database only
  const accountConfig = await getProviderCredentials('gcp');
  
  if (!accountConfig) {
    console.log("GCP credentials not configured. No GCP cost data available.");
    return null;
  }

  const credentials = accountConfig.credentials;
  
  // Parse service account key if it's a string
  let serviceAccountKey;
  if (typeof credentials.serviceAccountKey === 'string') {
    try {
      serviceAccountKey = JSON.parse(credentials.serviceAccountKey);
    } catch (error) {
      console.error("Failed to parse GCP service account key:", error);
      return null;
    }
  } else {
    serviceAccountKey = credentials.serviceAccountKey || credentials;
  }

  // Check if credentials have changed
  const credentialsChanged = !currentCredentials || 
    JSON.stringify(currentCredentials) !== JSON.stringify(serviceAccountKey);

  if (credentialsChanged || !bigQueryClient) {
    try {
      const projectId = credentials.projectId || serviceAccountKey.project_id;
      
      bigQueryClient = new BigQuery({
        projectId,
        credentials: serviceAccountKey,
      });

      currentCredentials = serviceAccountKey;
      console.log(`GCP BigQuery client initialized for account: ${accountConfig.accountName} (${projectId})`);
      return bigQueryClient;
    } catch (error) {
      console.error("Failed to initialize GCP BigQuery client:", error);
      return null;
    }
  }

  return bigQueryClient;
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
  const client = await initializeGCPClient();
  if (!client) {
    throw new Error("GCP BigQuery client not configured");
  }
  bigQueryClient = client;

  // Get account config for billing table info
  const accountConfig = await getProviderCredentials('gcp');
  if (!accountConfig) {
    throw new Error("GCP account configuration not found");
  }

  const credentials = accountConfig.credentials;
  const projectId = credentials.projectId || (typeof credentials.serviceAccountKey === 'string' 
    ? JSON.parse(credentials.serviceAccountKey).project_id 
    : credentials.serviceAccountKey?.project_id);
  const billingDataset = credentials.billingDataset || "cloud_billing_data";
  const billingTable = credentials.billingTable;

  if (!billingTable) {
    throw new Error("GCP billing table not configured. Please set billingTable in account configuration.");
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
        \`${projectId}.${billingDataset}.${billingTable}\`
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
  // Check if credentials exist in database
  const accountConfig = await getProviderCredentials('gcp');
  
  if (!accountConfig) {
    return false;
  }

  try {
    const client = await initializeGCPClient();
    if (!client) {
      return false;
    }

    const credentials = accountConfig.credentials;
    const projectId = credentials.projectId || (typeof credentials.serviceAccountKey === 'string' 
      ? JSON.parse(credentials.serviceAccountKey).project_id 
      : credentials.serviceAccountKey?.project_id);
    const billingDataset = credentials.billingDataset || "cloud_billing_data";
    const billingTable = credentials.billingTable;

    if (!billingTable) {
      console.error("GCP billing table not configured");
      return false;
    }

    const query = `
      SELECT 
        DATE(usage_start_time) as usage_date,
        SUM(cost) as total_cost
      FROM 
        \`${projectId}.${billingDataset}.${billingTable}\`
      WHERE 
        DATE(usage_start_time) >= DATE_SUB(CURRENT_DATE(), INTERVAL 2 DAY)
      GROUP BY 
        usage_date
      LIMIT 1
    `;

    await client.query(query);
    return true;
  } catch (error) {
    console.error("GCP BigQuery test query failed:", error);
    return false;
  }
}
