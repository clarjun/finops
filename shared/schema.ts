import { z } from "zod";
import { pgTable, text, varchar, timestamp, numeric, integer, jsonb, serial } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

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

// Azure Configuration for API Integration
export const azureConfigSchema = z.object({
  tenantId: z.string().min(1, "Tenant ID is required"),
  clientId: z.string().min(1, "Client ID is required"),
  clientSecret: z.string().min(1, "Client Secret is required"),
  subscriptionId: z.string().min(1, "Subscription ID is required"),
  scope: z.enum(['subscription', 'resourceGroup', 'billingAccount']).default('subscription'),
  resourceGroupName: z.string().optional(),
  billingAccountId: z.string().optional(),
  refreshInterval: z.number().min(3600).default(86400), // Default: daily (in seconds)
});

export type AzureConfig = z.infer<typeof azureConfigSchema>;

// Azure Query Request Body
export interface AzureQueryBody {
  type: 'Usage' | 'ActualCost';
  timeframe: 'MonthToDate' | 'WeekToDate' | 'Custom';
  timePeriod?: {
    from: string;
    to: string;
  };
  dataset: {
    granularity: 'Daily' | 'Monthly';
    aggregation?: Record<string, { name: string; function: string }>;
    grouping?: Array<{ type: string; name: string }>;
    filter?: any;
  };
}

// ==================== DATABASE SCHEMA ====================

// Historical Cost Data - stores daily cost records for ML training and analysis
export const costHistory = pgTable("cost_history", {
  id: serial("id").primaryKey(),
  date: timestamp("date").notNull(),
  subscriptionId: varchar("subscription_id", { length: 255 }).notNull(),
  subscriptionName: varchar("subscription_name", { length: 255 }).notNull(),
  resourceGroup: varchar("resource_group", { length: 255 }).notNull(),
  serviceName: varchar("service_name", { length: 255 }).notNull(),
  cost: numeric("cost", { precision: 10, scale: 2 }).notNull(),
  currency: varchar("currency", { length: 10 }).notNull().default('USD'),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertCostHistorySchema = createInsertSchema(costHistory).omit({ id: true, createdAt: true });
export type InsertCostHistory = z.infer<typeof insertCostHistorySchema>;
export type CostHistory = typeof costHistory.$inferSelect;

// Azure Account Configurations - stores multiple Azure account credentials
// NOTE: This table stores sensitive credentials. In production:
// 1. Encrypt clientSecret, tenantId, and clientId before storage using a secret management service
// 2. Use environment variables or Azure Key Vault for credential management
// 3. Implement row-level security and access controls
// 4. Audit all access to this table
export const azureAccounts = pgTable("azure_accounts", {
  id: serial("id").primaryKey(),
  accountName: varchar("account_name", { length: 255 }).notNull(),
  tenantId: varchar("tenant_id", { length: 255 }).notNull(), // TODO: Encrypt in production
  clientId: varchar("client_id", { length: 255 }).notNull(), // TODO: Encrypt in production
  clientSecret: text("client_secret").notNull(), // TODO: Encrypt in production
  subscriptionId: varchar("subscription_id", { length: 255 }).notNull(),
  scope: varchar("scope", { length: 50 }).notNull().default('subscription'),
  resourceGroupName: varchar("resource_group_name", { length: 255 }),
  billingAccountId: varchar("billing_account_id", { length: 255 }),
  refreshInterval: integer("refresh_interval").notNull().default(86400),
  isActive: integer("is_active").notNull().default(1), // 1 = active, 0 = inactive
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertAzureAccountSchema = createInsertSchema(azureAccounts).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertAzureAccount = z.infer<typeof insertAzureAccountSchema>;
export type AzureAccount = typeof azureAccounts.$inferSelect;

// Alert Rules - for budget threshold notifications
export const alertRules = pgTable("alert_rules", {
  id: serial("id").primaryKey(),
  ruleName: varchar("rule_name", { length: 255 }).notNull(),
  subscriptionId: varchar("subscription_id", { length: 255 }),
  serviceName: varchar("service_name", { length: 255 }),
  thresholdAmount: numeric("threshold_amount", { precision: 10, scale: 2 }).notNull(),
  thresholdType: varchar("threshold_type", { length: 50 }).notNull(), // 'daily', 'weekly', 'monthly'
  comparisonOperator: varchar("comparison_operator", { length: 20 }).notNull().default('gt'),
  emailRecipients: text("email_recipients").notNull(), // Comma-separated emails
  isEnabled: integer("is_enabled").notNull().default(1),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertAlertRuleSchema = createInsertSchema(alertRules).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertAlertRule = z.infer<typeof insertAlertRuleSchema>;
export type AlertRule = typeof alertRules.$inferSelect;

// Report Schedules - for automated report generation
export const reportSchedules = pgTable("report_schedules", {
  id: serial("id").primaryKey(),
  scheduleName: varchar("schedule_name", { length: 255 }).notNull(),
  reportType: varchar("report_type", { length: 50 }).notNull(), // 'cost_summary', 'detailed', 'forecast'
  frequency: varchar("frequency", { length: 50 }).notNull(), // 'daily', 'weekly', 'monthly'
  format: varchar("format", { length: 20 }).notNull(), // 'pdf', 'csv', 'both'
  emailRecipients: text("email_recipients").notNull(),
  subscriptionIds: text("subscription_ids"), // Comma-separated IDs, null = all
  nextRunAt: timestamp("next_run_at").notNull(),
  isEnabled: integer("is_enabled").notNull().default(1),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertReportScheduleSchema = createInsertSchema(reportSchedules).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertReportSchedule = z.infer<typeof insertReportScheduleSchema>;
export type ReportSchedule = typeof reportSchedules.$inferSelect;

// ML Forecast Data - stores prediction results
export const forecastData = pgTable("forecast_data", {
  id: serial("id").primaryKey(),
  subscriptionId: varchar("subscription_id", { length: 255 }).notNull(),
  serviceName: varchar("service_name", { length: 255 }),
  forecastDate: timestamp("forecast_date").notNull(),
  predictedCost: numeric("predicted_cost", { precision: 10, scale: 2 }).notNull(),
  confidenceInterval: jsonb("confidence_interval"), // { lower: number, upper: number }
  modelVersion: varchar("model_version", { length: 50 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertForecastDataSchema = createInsertSchema(forecastData).omit({ id: true, createdAt: true });
export type InsertForecastData = z.infer<typeof insertForecastDataSchema>;
export type ForecastData = typeof forecastData.$inferSelect;

// Cost Optimization Recommendations
export const optimizationRecommendations = pgTable("optimization_recommendations", {
  id: serial("id").primaryKey(),
  subscriptionId: varchar("subscription_id", { length: 255 }).notNull(),
  serviceName: varchar("service_name", { length: 255 }).notNull(),
  recommendationType: varchar("recommendation_type", { length: 100 }).notNull(), // 'reserved_instance', 'right_sizing', 'idle_resource'
  currentCost: numeric("current_cost", { precision: 10, scale: 2 }).notNull(),
  potentialSavings: numeric("potential_savings", { precision: 10, scale: 2 }).notNull(),
  description: text("description").notNull(),
  actionRequired: text("action_required"),
  status: varchar("status", { length: 50 }).notNull().default('active'), // 'active', 'implemented', 'dismissed'
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertOptimizationRecommendationSchema = createInsertSchema(optimizationRecommendations).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertOptimizationRecommendation = z.infer<typeof insertOptimizationRecommendationSchema>;
export type OptimizationRecommendation = typeof optimizationRecommendations.$inferSelect;
