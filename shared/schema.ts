import { z } from "zod";

// Azure Cost Data Row Schema
export const azureCostRowSchema = z.tuple([
  z.number(), // PreTaxCost
  z.number(), // UsageDate (YYYYMMDD format)
  z.string(), // SubscriptionName
  z.string(), // ResourceGroup
  z.string(), // ServiceName
  z.string(), // Currency
]);

export type AzureCostRow = z.infer<typeof azureCostRowSchema>;

// Azure Cost Response Schema
export const azureCostResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  properties: z.object({
    columns: z.array(z.object({
      name: z.string(),
      type: z.string(),
    })),
    rows: z.array(azureCostRowSchema),
  }),
});

export type AzureCostResponse = z.infer<typeof azureCostResponseSchema>;

// Processed Cost Data for Frontend
export interface ProcessedCostData {
  totalCost: number;
  avgDailyCost: number;
  topService: {
    name: string;
    cost: number;
  };
  serviceCount: number;
  dailyTrends: Array<{
    date: string;
    cost: number;
    services: Record<string, number>;
  }>;
  serviceBreakdown: Array<{
    name: string;
    cost: number;
    percentage: number;
  }>;
  subscriptions: string[];
  services: string[];
  peakDay: {
    date: string;
    cost: number;
  };
}

// AI Query Request/Response
export const aiQueryRequestSchema = z.object({
  query: z.string().min(1, "Query cannot be empty"),
  costData: z.any(), // The processed cost data to analyze
});

export type AiQueryRequest = z.infer<typeof aiQueryRequestSchema>;

export interface AiQueryResponse {
  answer: string;
  data?: any; // Optional structured data to visualize
  success: boolean;
}

// Anomaly Detection
export interface Anomaly {
  date: string;
  cost: number;
  service?: string;
  type: 'spike' | 'unusual' | 'trend_change';
  severity: 'low' | 'medium' | 'high';
  description: string;
}

export interface AnomalyDetectionResult {
  anomalies: Anomaly[];
  insights: string[];
  recommendations: string[];
}

// Cost Data Request (for fetching/refreshing)
export const costDataRequestSchema = z.object({
  azureResponse: azureCostResponseSchema,
});

export type CostDataRequest = z.infer<typeof costDataRequestSchema>;
