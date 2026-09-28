import { z } from "zod";
import { pgTable, text, varchar, timestamp, numeric, integer, jsonb, serial, bigserial, boolean, date, bigint } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

// Cloud Provider Types
export type CloudProvider = 'azure' | 'aws' | 'gcp';

export const cloudProviderSchema = z.enum(['azure', 'aws', 'gcp']);

// Multi-Cloud Provider Configuration
export interface ProviderConfig {
  provider: CloudProvider;
  accountName: string;
  isActive: boolean;
  credentials: AzureConfig | AwsConfig | GcpConfig;
}

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
  subscriptionBreakdown: Array<{
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

// One turn of the conversation, so follow-ups like "yes" or "break that down"
// resolve against what was said before instead of being answered in isolation.
export const aiTurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

export type AiTurn = z.infer<typeof aiTurnSchema>;

export const aiQueryRequestSchema = z.object({
  query: z.string().min(1, "Query cannot be empty"),
  costData: z.any().optional(), // The processed cost data to analyze
  history: z.array(aiTurnSchema).max(20).optional(), // prior turns for context
  // Explicit cloud scope from the UI selector. "all" (or omitted) keeps the
  // keyword-based detection; a specific cloud overrides it and scopes the
  // answer to that provider only.
  provider: z.enum(["all", "aws", "azure", "gcp"]).optional(),
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

// AWS Configuration for Cost Explorer API
export const awsConfigSchema = z.object({
  accessKeyId: z.string().min(1, "AWS Access Key ID is required"),
  secretAccessKey: z.string().min(1, "AWS Secret Access Key is required"),
  region: z.string().default('us-east-1'),
  accountId: z.string().optional(),
  refreshInterval: z.number().min(3600).default(86400),
});

export type AwsConfig = z.infer<typeof awsConfigSchema>;

// GCP Configuration for Cloud Billing API
export const gcpConfigSchema = z.object({
  projectId: z.string().min(1, "GCP Project ID is required"),
  clientEmail: z.string().email("Valid service account email required"),
  privateKey: z.string().min(1, "GCP Private Key is required"),
  billingAccountId: z.string().optional(),
  refreshInterval: z.number().min(3600).default(86400),
});

export type GcpConfig = z.infer<typeof gcpConfigSchema>;

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

// ==================== TENANCY ====================

// An organization is the tenant boundary. Every tenant-scoped row below carries
// an organizationId; a single-tenant / on-prem install is simply a database with
// one organization, so the same code serves both deployment models.
export const organizations = pgTable("organizations", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 100 }).notNull().unique(),
  plan: varchar("plan", { length: 50 }).notNull().default('standard'),
  status: varchar("status", { length: 20 }).notNull().default('active'), // 'active' | 'suspended'
  settings: jsonb("settings").notNull().default({}),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertOrganizationSchema = createInsertSchema(organizations).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertOrganization = z.infer<typeof insertOrganizationSchema>;
export type Organization = typeof organizations.$inferSelect;

// The tenant key, declared once. `.default(1)` mirrors the migration and keeps
// legacy writers that predate tenancy from failing hard; server/tenant-context.ts
// is the real enforcement point and always sets it explicitly.
const organizationId = () =>
  integer("organization_id").notNull().default(1).references(() => organizations.id, { onDelete: 'cascade' });

// Tables that are NOT tenant-scoped (deliberately global):
//   organizations, schema_migrations, user_sessions

// Historical Cost Data - stores daily cost records for ML training and analysis (Multi-Cloud)
export const costHistory = pgTable("cost_history", {
  id: serial("id").primaryKey(),
  organizationId: organizationId(),
  provider: varchar("provider", { length: 20 }).notNull(), // 'azure', 'aws', 'gcp'
  date: timestamp("date").notNull(),
  accountId: varchar("account_id", { length: 255 }).notNull(), // AWS Account ID, Azure Subscription ID, GCP Project ID
  accountName: varchar("account_name", { length: 255 }).notNull(),
  resourceGroup: varchar("resource_group", { length: 255 }), // Azure: Resource Group, AWS: Tag-based, GCP: Label-based
  serviceName: varchar("service_name", { length: 255 }).notNull(), // EC2, S3, Lambda, Compute Engine, etc.
  region: varchar("region", { length: 100 }), // us-east-1, eastus, us-central1, etc.
  cost: numeric("cost", { precision: 10, scale: 2 }).notNull(),
  currency: varchar("currency", { length: 10 }).notNull().default('USD'),
  tags: jsonb("tags"), // Key-value tags/labels for cost allocation
  metadata: jsonb("metadata"), // Additional provider-specific data
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertCostHistorySchema = createInsertSchema(costHistory).omit({ id: true, createdAt: true });
export type InsertCostHistory = z.infer<typeof insertCostHistorySchema>;
export type CostHistory = typeof costHistory.$inferSelect;

// Multi-Cloud Account Configurations - stores credentials for Azure, AWS, and GCP
// NOTE: This table stores sensitive credentials. In production:
// 1. Encrypt all credentials before storage using AES-256-GCM or similar
// 2. Use environment variables or cloud-specific secret management (Azure Key Vault, AWS Secrets Manager, GCP Secret Manager)
// 3. Implement row-level security and access controls
// 4. Audit all access to this table
export const cloudAccounts = pgTable("cloud_accounts", {
  id: serial("id").primaryKey(),
  organizationId: organizationId(),
  provider: varchar("provider", { length: 20 }).notNull(), // 'azure', 'aws', 'gcp'
  accountName: varchar("account_name", { length: 255 }).notNull(),
  accountId: varchar("account_id", { length: 255 }).notNull(), // AWS Account ID, Azure Subscription ID, GCP Project ID
  credentials: jsonb("credentials").notNull(), // Encrypted provider-specific credentials
  refreshInterval: integer("refresh_interval").notNull().default(86400),
  isActive: boolean("is_active").notNull().default(true),
  lastSyncAt: timestamp("last_sync_at"),

  // ── Cross-account role authentication (migration 0018) ────────────────────
  // `credentials` stays for the legacy access-key path, selected by authType,
  // so existing connections keep working while customers migrate.
  authType: varchar("auth_type", { length: 32 }).notNull().default('access_keys'),
  roleArn: varchar("role_arn", { length: 2048 }),
  remediationRoleArn: varchar("remediation_role_arn", { length: 2048 }),
  deployRoleArn: varchar("deploy_role_arn", { length: 2048 }),
  /** Encrypted. Meaningless without control of the Cloudwise AWS principal. */
  externalId: text("external_id"),
  lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
  lastValidationError: text("last_validation_error"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/** How Cloudwise authenticates to a customer cloud. */
export const CLOUD_AUTH_TYPES = ['access_keys', 'assume_role', 'workload_identity'] as const;
export type CloudAuthType = (typeof CLOUD_AUTH_TYPES)[number];

/**
 * Privilege tiers. Each maps to a distinct customer IAM role, so a read path
 * physically cannot mutate infrastructure — the separation is enforced by AWS,
 * not by our own code being careful.
 */
export const AWS_ROLE_TIERS = ['readonly', 'remediation', 'deploy'] as const;
export type AwsRoleTier = (typeof AWS_ROLE_TIERS)[number];

export const insertCloudAccountSchema = createInsertSchema(cloudAccounts).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCloudAccount = z.infer<typeof insertCloudAccountSchema>;
export type CloudAccount = typeof cloudAccounts.$inferSelect;

// Legacy Azure Accounts table (deprecated - migrate to cloudAccounts)
export const azureAccounts = pgTable("azure_accounts", {
  id: serial("id").primaryKey(),
  organizationId: organizationId(),
  accountName: varchar("account_name", { length: 255 }).notNull(),
  tenantId: varchar("tenant_id", { length: 255 }).notNull(),
  clientId: varchar("client_id", { length: 255 }).notNull(),
  clientSecret: text("client_secret").notNull(),
  subscriptionId: varchar("subscription_id", { length: 255 }).notNull(),
  scope: varchar("scope", { length: 50 }).notNull().default('subscription'),
  resourceGroupName: varchar("resource_group_name", { length: 255 }),
  billingAccountId: varchar("billing_account_id", { length: 255 }),
  refreshInterval: integer("refresh_interval").notNull().default(86400),
  isActive: integer("is_active").notNull().default(1),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertAzureAccountSchema = createInsertSchema(azureAccounts).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertAzureAccount = z.infer<typeof insertAzureAccountSchema>;
export type AzureAccount = typeof azureAccounts.$inferSelect;

// Budgets - for tracking spending limits across cloud providers
export const budgets = pgTable("budgets", {
  id: serial("id").primaryKey(),
  organizationId: organizationId(),
  budgetName: varchar("budget_name", { length: 255 }).notNull(),
  provider: varchar("provider", { length: 20 }), // null = all providers
  accountId: varchar("account_id", { length: 255 }), // null = all accounts
  serviceName: varchar("service_name", { length: 255 }), // null = all services
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  period: varchar("period", { length: 20 }).notNull(), // 'daily', 'weekly', 'monthly', 'quarterly', 'yearly'
  startDate: timestamp("start_date").notNull(),
  endDate: timestamp("end_date"),
  alertThresholds: jsonb("alert_thresholds"), // { 50: true, 75: true, 90: true, 100: true }
  emailRecipients: text("email_recipients"), // Comma-separated email addresses for notifications
  webhookUrl: text("webhook_url"), // Webhook URL for Teams/Slack notifications
  lastAlertedAt: timestamp("last_alerted_at"), // Track when last alert was sent to prevent spam
  lastAlertedThreshold: integer("last_alerted_threshold"), // Track which threshold triggered last alert
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertBudgetSchema = createInsertSchema(budgets).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertBudget = z.infer<typeof insertBudgetSchema>;
export type Budget = typeof budgets.$inferSelect;

// Alert Rules - for budget threshold notifications (multi-cloud)
export const alertRules = pgTable("alert_rules", {
  id: serial("id").primaryKey(),
  organizationId: organizationId(),
  ruleName: varchar("rule_name", { length: 255 }).notNull(),
  provider: varchar("provider", { length: 20 }), // null = all providers
  accountId: varchar("account_id", { length: 255 }), // null = all accounts
  serviceName: varchar("service_name", { length: 255 }),
  thresholdAmount: numeric("threshold_amount", { precision: 10, scale: 2 }).notNull(),
  thresholdType: varchar("threshold_type", { length: 50 }).notNull(), // 'daily', 'weekly', 'monthly'
  comparisonOperator: varchar("comparison_operator", { length: 20 }).notNull().default('gt'),
  emailRecipients: text("email_recipients").notNull(), // Comma-separated emails
  webhookUrl: varchar("webhook_url", { length: 500 }), // For Slack/Teams integration
  isEnabled: integer("is_enabled").notNull().default(1), // 1 = enabled, 0 = disabled
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertAlertRuleSchema = createInsertSchema(alertRules).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertAlertRule = z.infer<typeof insertAlertRuleSchema>;
export type AlertRule = typeof alertRules.$inferSelect;

// Report Schedules - for automated report generation
export const reportSchedules = pgTable("report_schedules", {
  id: serial("id").primaryKey(),
  organizationId: organizationId(),
  scheduleName: varchar("schedule_name", { length: 255 }).notNull(),
  reportType: varchar("report_type", { length: 50 }).notNull(), // 'cost_summary', 'detailed', 'forecast'
  frequency: varchar("frequency", { length: 50 }).notNull(), // 'daily', 'weekly', 'monthly'
  format: varchar("format", { length: 20 }).notNull(), // 'pdf', 'csv', 'both'
  emailRecipients: text("email_recipients").notNull(),
  subscriptionIds: text("subscription_ids"), // Comma-separated IDs, null = all
  nextRunAt: timestamp("next_run_at").notNull(),
  isEnabled: integer("is_enabled").notNull().default(1),
  // Outcome of the most recent delivery attempt. Without these, a schedule that
  // fails every week looks exactly like one that is working. See migration 0011.
  lastRunAt: timestamp("last_run_at"),
  lastRunStatus: varchar("last_run_status", { length: 20 }), // success | failed | skipped
  lastRunError: text("last_run_error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertReportScheduleSchema = createInsertSchema(reportSchedules).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertReportSchedule = z.infer<typeof insertReportScheduleSchema>;
export type ReportSchedule = typeof reportSchedules.$inferSelect;

// Resource Inventory - tracks cloud resources across providers
export const resourceInventory = pgTable("resource_inventory", {
  id: serial("id").primaryKey(),
  organizationId: organizationId(),
  provider: varchar("provider", { length: 20 }).notNull(),
  accountId: varchar("account_id", { length: 255 }).notNull(),
  resourceId: varchar("resource_id", { length: 500 }).notNull(), // Unique resource identifier
  resourceType: varchar("resource_type", { length: 100 }).notNull(), // EC2, S3, Lambda, RDS, Compute Engine, etc.
  resourceName: varchar("resource_name", { length: 255 }),
  region: varchar("region", { length: 100 }),
  state: varchar("state", { length: 50 }), // running, stopped, idle, etc.
  size: varchar("size", { length: 100 }), // Instance type/size
  monthlyCost: numeric("monthly_cost", { precision: 10, scale: 2 }),
  utilizationPercent: numeric("utilization_percent", { precision: 5, scale: 2 }), // CPU/memory utilization
  tags: jsonb("tags"),
  metadata: jsonb("metadata"), // Provider-specific details
  lastSeenAt: timestamp("last_seen_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertResourceInventorySchema = createInsertSchema(resourceInventory).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertResourceInventory = z.infer<typeof insertResourceInventorySchema>;
export type ResourceInventory = typeof resourceInventory.$inferSelect;

// Tag Analysis - for cost allocation and governance
export const tagAnalysis = pgTable("tag_analysis", {
  id: serial("id").primaryKey(),
  organizationId: organizationId(),
  provider: varchar("provider", { length: 20 }).notNull(),
  accountId: varchar("account_id", { length: 255 }).notNull(),
  tagKey: varchar("tag_key", { length: 255 }).notNull(),
  tagValue: varchar("tag_value", { length: 500 }),
  resourceCount: integer("resource_count").notNull().default(0),
  totalCost: numeric("total_cost", { precision: 10, scale: 2 }).notNull().default('0'),
  period: varchar("period", { length: 20 }).notNull(), // 'daily', 'weekly', 'monthly'
  periodDate: timestamp("period_date").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertTagAnalysisSchema = createInsertSchema(tagAnalysis).omit({ id: true, createdAt: true });
export type InsertTagAnalysis = z.infer<typeof insertTagAnalysisSchema>;
export type TagAnalysis = typeof tagAnalysis.$inferSelect;

// ML Forecast Data - stores prediction results (multi-cloud)
export const forecastData = pgTable("forecast_data", {
  id: serial("id").primaryKey(),
  organizationId: organizationId(),
  provider: varchar("provider", { length: 20 }).notNull(),
  accountId: varchar("account_id", { length: 255 }).notNull(),
  serviceName: varchar("service_name", { length: 255 }),
  forecastDate: timestamp("forecast_date").notNull(),
  predictedCost: numeric("predicted_cost", { precision: 10, scale: 2 }).notNull(),
  confidenceInterval: jsonb("confidence_interval"), // { lower: number, upper: number }
  modelVersion: varchar("model_version", { length: 50 }).notNull(),
  modelType: varchar("model_type", { length: 50 }), // 'arima', 'prophet', 'lstm', etc.
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertForecastDataSchema = createInsertSchema(forecastData).omit({ id: true, createdAt: true });
export type InsertForecastData = z.infer<typeof insertForecastDataSchema>;
export type ForecastData = typeof forecastData.$inferSelect;

// Cost Optimization Recommendations (multi-cloud)
export const optimizationRecommendations = pgTable("optimization_recommendations", {
  id: serial("id").primaryKey(),
  organizationId: organizationId(),
  provider: varchar("provider", { length: 20 }).notNull(),
  accountId: varchar("account_id", { length: 255 }).notNull(),
  resourceId: varchar("resource_id", { length: 500 }),
  serviceName: varchar("service_name", { length: 255 }).notNull(),
  recommendationType: varchar("recommendation_type", { length: 100 }).notNull(), // 'reserved_instance', 'savings_plan', 'right_sizing', 'idle_resource', 'spot_instance'
  currentCost: numeric("current_cost", { precision: 10, scale: 2 }).notNull(),
  optimizedCost: numeric("optimized_cost", { precision: 10, scale: 2 }).notNull(),
  potentialSavings: numeric("potential_savings", { precision: 10, scale: 2 }).notNull(),
  savingsPercent: numeric("savings_percent", { precision: 5, scale: 2 }),
  priority: varchar("priority", { length: 20 }).default('medium'), // 'low', 'medium', 'high', 'critical'
  description: text("description").notNull(),
  actionRequired: text("action_required"),
  impactScore: numeric("impact_score", { precision: 5, scale: 2 }), // ML-calculated impact
  status: varchar("status", { length: 50 }).notNull().default('active'), // 'active', 'implemented', 'dismissed', 'expired'
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertOptimizationRecommendationSchema = createInsertSchema(optimizationRecommendations).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertOptimizationRecommendation = z.infer<typeof insertOptimizationRecommendationSchema>;
export type OptimizationRecommendation = typeof optimizationRecommendations.$inferSelect;

// Savings Plans / Reserved Instances Analysis
export const savingsPlans = pgTable("savings_plans", {
  id: serial("id").primaryKey(),
  organizationId: organizationId(),
  provider: varchar("provider", { length: 20 }).notNull(), // 'aws', 'azure', 'gcp'
  accountId: varchar("account_id", { length: 255 }).notNull(),
  planType: varchar("plan_type", { length: 100 }).notNull(), // 'compute_savings_plan', 'ec2_ri', 'azure_ri', 'gcp_cud'
  serviceName: varchar("service_name", { length: 255 }),
  term: varchar("term", { length: 50 }), // '1_year', '3_year'
  paymentOption: varchar("payment_option", { length: 50 }), // 'all_upfront', 'partial_upfront', 'no_upfront'
  commitmentAmount: numeric("commitment_amount", { precision: 10, scale: 2 }),
  utilizationPercent: numeric("utilization_percent", { precision: 5, scale: 2 }),
  coveragePercent: numeric("coverage_percent", { precision: 5, scale: 2 }),
  netSavings: numeric("net_savings", { precision: 10, scale: 2 }),
  startDate: timestamp("start_date"),
  endDate: timestamp("end_date"),
  recommendedAction: text("recommended_action"),
  status: varchar("status", { length: 50 }).default('active'), // 'active', 'expired', 'recommended'
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertSavingsPlanSchema = createInsertSchema(savingsPlans).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertSavingsPlan = z.infer<typeof insertSavingsPlanSchema>;
export type SavingsPlan = typeof savingsPlans.$inferSelect;

// Anomaly Events - for root cause analysis
export const anomalyEvents = pgTable("anomaly_events", {
  id: serial("id").primaryKey(),
  organizationId: organizationId(),
  provider: varchar("provider", { length: 20 }).notNull(),
  accountId: varchar("account_id", { length: 255 }).notNull(),
  detectedAt: timestamp("detected_at").notNull(),
  anomalyDate: timestamp("anomaly_date").notNull(),
  serviceName: varchar("service_name", { length: 255 }),
  anomalyType: varchar("anomaly_type", { length: 50 }).notNull(), // 'spike', 'drop', 'trend_change'
  severity: varchar("severity", { length: 20 }).notNull(), // 'low', 'medium', 'high'
  expectedCost: numeric("expected_cost", { precision: 10, scale: 2 }).notNull(),
  actualCost: numeric("actual_cost", { precision: 10, scale: 2 }).notNull(),
  deviation: numeric("deviation", { precision: 5, scale: 2 }), // Percentage deviation
  rootCause: text("root_cause"), // AI-generated explanation
  correlatedEvents: jsonb("correlated_events"), // Deployment events, scaling events, etc.
  resolvedAt: timestamp("resolved_at"),
  status: varchar("status", { length: 50 }).default('active'), // 'active', 'investigating', 'resolved'
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertAnomalyEventSchema = createInsertSchema(anomalyEvents).omit({ id: true, createdAt: true });
export type InsertAnomalyEvent = z.infer<typeof insertAnomalyEventSchema>;
export type AnomalyEvent = typeof anomalyEvents.$inferSelect;

// ==================== AGENTIC AI SYSTEM ====================

// Optimization Actions - Track AI-proposed and executed optimizations
export const optimizationActions = pgTable("optimization_actions", {
  id: serial("id").primaryKey(),
  organizationId: organizationId(),
  planId: integer("plan_id"), // Foreign key to optimization_plans
  actionType: varchar("action_type", { length: 100 }).notNull(), // 'ec2_downsize', 's3_lifecycle', 'ri_purchase', 'delete_snapshot', etc.
  provider: varchar("provider", { length: 20 }).notNull(),
  accountId: varchar("account_id", { length: 255 }).notNull(),
  resourceId: varchar("resource_id", { length: 500 }), // EC2 instance ID, S3 bucket name, etc.
  resourceType: varchar("resource_type", { length: 100 }), // 'ec2_instance', 's3_bucket', 'ebs_volume'
  currentState: jsonb("current_state"), // Current configuration
  proposedState: jsonb("proposed_state"), // Proposed configuration
  estimatedSavings: numeric("estimated_savings", { precision: 10, scale: 2 }),
  estimatedCostImpact: numeric("estimated_cost_impact", { precision: 10, scale: 2 }), // One-time cost (negative = savings)
  riskLevel: varchar("risk_level", { length: 20 }).default('low'), // 'low', 'medium', 'high'
  status: varchar("status", { length: 50 }).default('proposed'), // 'proposed', 'approved', 'executing', 'completed', 'failed', 'rolled_back', 'rejected'
  aiReasoning: text("ai_reasoning"), // Why the AI proposed this action
  executionDetails: jsonb("execution_details"), // API calls made, responses received
  executionError: text("execution_error"),
  rollbackDetails: jsonb("rollback_details"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  approvedAt: timestamp("approved_at"),
  executedAt: timestamp("executed_at"),
  completedAt: timestamp("completed_at"),
  approvedBy: varchar("approved_by", { length: 255 }), // User who approved
});

export const insertOptimizationActionSchema = createInsertSchema(optimizationActions).omit({ id: true, createdAt: true });
export type InsertOptimizationAction = z.infer<typeof insertOptimizationActionSchema>;
export type OptimizationAction = typeof optimizationActions.$inferSelect;

// Optimization Plans - Multi-step AI-generated plans
export const optimizationPlans = pgTable("optimization_plans", {
  id: serial("id").primaryKey(),
  organizationId: organizationId(),
  goal: text("goal").notNull(), // "Reduce AWS costs by 30%", "Optimize idle resources"
  provider: varchar("provider", { length: 20 }), // Specific provider or 'all' for multi-cloud
  targetSavings: numeric("target_savings", { precision: 10, scale: 2 }),
  actualSavings: numeric("actual_savings", { precision: 10, scale: 2 }),
  status: varchar("status", { length: 50 }).default('planning'), // 'planning', 'approved', 'executing', 'completed', 'failed', 'cancelled'
  aiStrategy: text("ai_strategy"), // The AI's overall strategy
  steps: jsonb("steps"), // Array of step definitions [{stepIndex, actionType, dependencies, status}]
  currentStepIndex: integer("current_step_index").default(0),
  totalSteps: integer("total_steps"),
  completedSteps: integer("completed_steps").default(0),
  failedSteps: integer("failed_steps").default(0),
  position: integer("position").default(999), // Display order (lower = first)
  createdAt: timestamp("created_at").notNull().defaultNow(),
  approvedAt: timestamp("approved_at"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  approvedBy: varchar("approved_by", { length: 255 }),
});

export const insertOptimizationPlanSchema = createInsertSchema(optimizationPlans).omit({ id: true, createdAt: true });
export type InsertOptimizationPlan = z.infer<typeof insertOptimizationPlanSchema>;
export type OptimizationPlan = typeof optimizationPlans.$inferSelect;

// Action Feedback - Learning from outcomes
export const actionFeedback = pgTable("action_feedback", {
  id: serial("id").primaryKey(),
  organizationId: organizationId(),
  actionId: integer("action_id").notNull(), // Foreign key to optimization_actions
  actualSavings: numeric("actual_savings", { precision: 10, scale: 2 }),
  savingsVariance: numeric("savings_variance", { precision: 5, scale: 2 }), // % difference from estimate
  performanceImpact: varchar("performance_impact", { length: 50 }), // 'none', 'minor', 'moderate', 'severe'
  performanceDetails: text("performance_details"),
  userSatisfaction: integer("user_satisfaction"), // 1-5 rating
  issuesEncountered: jsonb("issues_encountered"),
  lessonsLearned: text("lessons_learned"), // AI-generated insights
  wouldRecommendAgain: integer("would_recommend_again").default(1), // 1 = yes, 0 = no
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertActionFeedbackSchema = createInsertSchema(actionFeedback).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertActionFeedback = z.infer<typeof insertActionFeedbackSchema>;
export type ActionFeedback = typeof actionFeedback.$inferSelect;

// Agent Configuration - Control AI behavior
export const agentConfig = pgTable("agent_config", {
  id: serial("id").primaryKey(),
  organizationId: organizationId(), // exactly one config row per tenant (unique index in 0006)
  autoExecuteEnabled: integer("auto_execute_enabled").default(0), // 0 = require approval, 1 = auto-execute
  requireApprovalFor: jsonb("require_approval_for"), // Array of action types that always need approval
  maxCostImpactWithoutApproval: numeric("max_cost_impact_without_approval", { precision: 10, scale: 2 }).default('100.00'),
  aggressiveness: varchar("aggressiveness", { length: 20 }).default('medium'), // 'low', 'medium', 'high'
  learningEnabled: integer("learning_enabled").default(1), // 0 = disabled, 1 = enabled
  enabledProviders: jsonb("enabled_providers"), // ['aws', 'gcp', 'azure']
  enabledActionTypes: jsonb("enabled_action_types"), // Which optimization types are allowed
  safetyMode: integer("safety_mode").default(1), // 1 = enabled (prevents destructive actions)
  dryRunMode: integer("dry_run_mode").default(1), // 1 = simulate only, 0 = execute
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertAgentConfigSchema = createInsertSchema(agentConfig).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertAgentConfig = z.infer<typeof insertAgentConfigSchema>;
export type AgentConfig = typeof agentConfig.$inferSelect;

// Report Cache - persists generated FinOps reports in DB for fast retrieval
export const reportCache = pgTable("report_cache", {
  id: serial("id").primaryKey(),
  organizationId: organizationId(),
  // Unique per tenant, not globally — see idx_report_cache_org_key in 0006.
  cacheKey: varchar("cache_key", { length: 500 }).notNull(), // e.g. finops-report:aws:2026-04-01:2026-04-09
  provider: varchar("provider", { length: 20 }).notNull(),
  startDate: varchar("start_date", { length: 20 }).notNull(),
  endDate: varchar("end_date", { length: 20 }).notNull(),
  reportData: jsonb("report_data").notNull(), // Full FinOps report JSON
  fetchedAt: timestamp("fetched_at").notNull().defaultNow(), // When data was last fetched from APIs
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertReportCacheSchema = createInsertSchema(reportCache).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertReportCache = z.infer<typeof insertReportCacheSchema>;
export type ReportCache = typeof reportCache.$inferSelect;

// ==================== USER MANAGEMENT ====================

// Role vocabulary, least- to most-privileged. See server/rbac.ts for the
// permission each one grants.
export const USER_ROLES = ['viewer', 'engineer', 'finops', 'admin', 'owner'] as const;
export type UserRole = typeof USER_ROLES[number];
export const userRoleSchema = z.enum(USER_ROLES);

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  // A user's home tenant. Username stays globally unique so login needs no org
  // selector — the tenant is derived from the authenticated user's row.
  organizationId: organizationId(),
  username: varchar("username", { length: 100 }).notNull().unique(),
  email: varchar("email", { length: 255 }),
  fullName: varchar("full_name", { length: 255 }),
  passwordHash: text("password_hash").notNull(),
  role: varchar("role", { length: 20 }).notNull().default('viewer'),
  // Cross-tenant support access. Lets CirrusLabs staff switch active org;
  // every switch is audit-logged.
  isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: integer("created_by"), // admin user id who created this user
  lastLoginAt: timestamp("last_login_at"),

  // Per-account brute-force protection (migration 0020). Counted here rather
  // than only in the per-IP rate limiter because credential stuffing arrives
  // from thousands of addresses, each staying comfortably under an IP limit.
  failedLoginAttempts: integer("failed_login_attempts").notNull().default(0),
  /** Null when not locked. A past timestamp is an expired lock, not a live one. */
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  lastLoginIp: varchar("last_login_ip", { length: 64 }),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

// ==================== COST FACT STORE ====================

// FOCUS 1.x charge categories. A report that sums Usage alongside Credit and Tax
// without distinguishing them will not reconcile with the invoice.
export const CHARGE_CATEGORIES = ['Usage', 'Purchase', 'Tax', 'Credit', 'Refund', 'Adjustment'] as const;
export type ChargeCategory = typeof CHARGE_CATEGORIES[number];

export const SERVICE_CATEGORIES = [
  'Compute', 'Storage', 'Databases', 'Networking', 'Analytics',
  'AI and Machine Learning', 'Security', 'Management and Governance',
  'Developer Tools', 'Web', 'Other',
] as const;
export type ServiceCategory = typeof SERVICE_CATEGORIES[number];

// One row per connector execution: the ingestion watermark, a record of API
// spend, and what is needed to re-run a failed window.
export const ingestionRuns = pgTable("ingestion_runs", {
  id: bigserial("id", { mode: 'number' }).primaryKey(),
  organizationId: organizationId(),
  provider: varchar("provider", { length: 20 }).notNull(),
  cloudAccountId: integer("cloud_account_id"),
  periodStart: timestamp("period_start", { mode: 'string' }).notNull(),
  periodEnd: timestamp("period_end", { mode: 'string' }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default('running'), // running|success|failed|partial
  trigger: varchar("trigger", { length: 20 }).notNull().default('scheduled'), // scheduled|manual|backfill
  recordsIngested: integer("records_ingested").notNull().default(0),
  recordsUpdated: integer("records_updated").notNull().default(0),
  apiCalls: integer("api_calls").notNull().default(0),
  error: text("error"),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  finishedAt: timestamp("finished_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertIngestionRunSchema = createInsertSchema(ingestionRuns).omit({ id: true, createdAt: true });
export type InsertIngestionRun = z.infer<typeof insertIngestionRunSchema>;
export type IngestionRun = typeof ingestionRuns.$inferSelect;

// The canonical cost store. Every read path queries this rather than calling a
// provider billing API. Column names follow FOCUS 1.x — see migration 0008.
export const costFacts = pgTable("cost_facts", {
  id: bigserial("id", { mode: 'number' }).primaryKey(),
  organizationId: organizationId(),
  provider: varchar("provider", { length: 20 }).notNull(),

  billingAccountId: varchar("billing_account_id", { length: 255 }),
  billingAccountName: varchar("billing_account_name", { length: 255 }),
  subAccountId: varchar("sub_account_id", { length: 255 }).notNull(),
  subAccountName: varchar("sub_account_name", { length: 255 }),

  chargePeriodStart: timestamp("charge_period_start").notNull(),
  chargePeriodEnd: timestamp("charge_period_end").notNull(),
  billingPeriodStart: timestamp("billing_period_start"),

  serviceName: varchar("service_name", { length: 255 }).notNull(),
  serviceCategory: varchar("service_category", { length: 100 }),
  chargeCategory: varchar("charge_category", { length: 50 }).notNull().default('Usage'),
  chargeDescription: text("charge_description"),
  resourceId: varchar("resource_id", { length: 500 }),
  resourceName: varchar("resource_name", { length: 255 }),
  regionId: varchar("region_id", { length: 100 }),

  // numeric() maps to string in drizzle to avoid float precision loss.
  billedCost: numeric("billed_cost", { precision: 20, scale: 10 }).notNull().default('0'),
  effectiveCost: numeric("effective_cost", { precision: 20, scale: 10 }),
  listCost: numeric("list_cost", { precision: 20, scale: 10 }),
  billingCurrency: varchar("billing_currency", { length: 10 }).notNull().default('USD'),

  // Unconstrained precision — GCP reports storage in byte-seconds, which
  // overflows any reasonable fixed precision. See migration 0009.
  pricingQuantity: numeric("pricing_quantity"),
  pricingUnit: varchar("pricing_unit", { length: 100 }),

  tags: jsonb("tags"),
  commitmentDiscountId: varchar("commitment_discount_id", { length: 255 }),

  ingestionRunId: integer("ingestion_run_id"),
  sourceHash: varchar("source_hash", { length: 64 }).notNull(),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertCostFactSchema = createInsertSchema(costFacts).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCostFact = z.infer<typeof insertCostFactSchema>;
export type CostFact = typeof costFacts.$inferSelect;

// ==================== MEASURED SAVINGS ====================

// A real before/after comparison of an executed optimization against ingested
// cost data, replacing the previous behaviour of recording the estimate as
// though it were the outcome. See migration 0010.
export const savingsMeasurements = pgTable("savings_measurements", {
  id: bigserial("id", { mode: 'number' }).primaryKey(),
  organizationId: organizationId(),
  actionId: integer("action_id").notNull(),

  provider: varchar("provider", { length: 20 }).notNull(),
  subAccountId: varchar("sub_account_id", { length: 255 }),
  serviceName: varchar("service_name", { length: 255 }),
  regionId: varchar("region_id", { length: 100 }),
  resourceId: varchar("resource_id", { length: 500 }),
  granularity: varchar("granularity", { length: 20 }).notNull().default('service'),

  baselineStart: timestamp("baseline_start", { mode: 'string' }),
  baselineEnd: timestamp("baseline_end", { mode: 'string' }),
  baselineDays: integer("baseline_days"),
  baselineDailyCost: numeric("baseline_daily_cost", { precision: 20, scale: 10 }),
  controlBaselineDailyCost: numeric("control_baseline_daily_cost", { precision: 20, scale: 10 }),

  measureAfter: timestamp("measure_after").notNull(),
  measurementStart: timestamp("measurement_start", { mode: 'string' }),
  measurementEnd: timestamp("measurement_end", { mode: 'string' }),
  measurementDays: integer("measurement_days"),
  observedDailyCost: numeric("observed_daily_cost", { precision: 20, scale: 10 }),
  controlObservedDailyCost: numeric("control_observed_daily_cost", { precision: 20, scale: 10 }),

  expectedDailyCost: numeric("expected_daily_cost", { precision: 20, scale: 10 }),
  realizedDailySavings: numeric("realized_daily_savings", { precision: 20, scale: 10 }),
  realizedMonthlySavings: numeric("realized_monthly_savings", { precision: 20, scale: 10 }),
  estimatedMonthlySavings: numeric("estimated_monthly_savings", { precision: 20, scale: 10 }),
  variancePercent: numeric("variance_percent", { precision: 10, scale: 2 }),

  confidence: varchar("confidence", { length: 20 }), // high | medium | low
  status: varchar("status", { length: 20 }).notNull().default('pending'), // pending | measured | inconclusive | failed
  notes: text("notes"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  measuredAt: timestamp("measured_at"),
});

export const insertSavingsMeasurementSchema = createInsertSchema(savingsMeasurements).omit({ id: true, createdAt: true });
export type InsertSavingsMeasurement = z.infer<typeof insertSavingsMeasurementSchema>;
export type SavingsMeasurement = typeof savingsMeasurements.$inferSelect;

// ==================== INFRASTRUCTURE DEPLOYMENT AGENT ====================
// Mirrors migration 0012. See that file for the design rationale.

// Instants on the agent tables are timestamptz (migration 0017). A
// timezone-less column stores wall-clock time, which compares wrongly against
// now() in SQL — the fault that put the run lease five and a half hours out.
export const infraPlans = pgTable("infra_plans", {
  id: bigserial("id", { mode: 'number' }).primaryKey(),
  organizationId: organizationId(),
  name: varchar("name", { length: 255 }).notNull(),
  requirements: text("requirements").notNull(),
  estimatorOutput: jsonb("estimator_output"),
  clarifications: jsonb("clarifications").notNull().default({}),
  provider: varchar("provider", { length: 20 }),
  cloudAccountId: integer("cloud_account_id"),
  region: varchar("region", { length: 64 }),
  environment: varchar("environment", { length: 32 }),
  logicalModel: jsonb("logical_model"),
  estimatedMonthlyCost: numeric("estimated_monthly_cost", { precision: 14, scale: 2 }),
  version: integer("version").notNull().default(1),
  supersedesPlanId: integer("supersedes_plan_id"),
  status: varchar("status", { length: 32 }).notNull().default('draft'),
  // A saved blueprint: a compiled topology kept to seed future deployments.
  // A flag rather than a status because a template has no lifecycle. See 0016.
  isTemplate: boolean("is_template").notNull().default(false),
  templateDescription: text("template_description"),
  templateSourceRunId: integer("template_source_run_id"),
  templateUseCount: integer("template_use_count").notNull().default(0),
  createdByUserId: integer("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const infraPlanNodes = pgTable("infra_plan_nodes", {
  id: bigserial("id", { mode: 'number' }).primaryKey(),
  organizationId: organizationId(),
  planId: integer("plan_id").notNull(),
  nodeKey: varchar("node_key", { length: 128 }).notNull(),
  label: varchar("label", { length: 255 }).notNull(),
  logicalType: varchar("logical_type", { length: 64 }).notNull(),
  providerType: varchar("provider_type", { length: 128 }),
  resourceAddress: varchar("resource_address", { length: 255 }),
  config: jsonb("config").notNull().default({}),
  dependsOn: jsonb("depends_on").notNull().default([]),
  riskLevel: varchar("risk_level", { length: 20 }).notNull().default('low'),
  riskReasons: jsonb("risk_reasons").notNull().default([]),
  requiresApproval: boolean("requires_approval").notNull().default(false),
  estimatedMonthlyCost: numeric("estimated_monthly_cost", { precision: 14, scale: 2 }),
  standardStepId: integer("standard_step_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const infraRuns = pgTable("infra_runs", {
  id: bigserial("id", { mode: 'number' }).primaryKey(),
  organizationId: organizationId(),
  planId: integer("plan_id").notNull(),
  mode: varchar("mode", { length: 20 }).notNull().default('plan'),
  executionMode: varchar("execution_mode", { length: 20 }).notNull().default('live'),
  status: varchar("status", { length: 32 }).notNull().default('queued'),
  workspacePath: text("workspace_path"),
  terraformVersion: varchar("terraform_version", { length: 32 }),
  planSummary: jsonb("plan_summary"),
  resourcesToAdd: integer("resources_to_add"),
  resourcesToChange: integer("resources_to_change"),
  resourcesToDestroy: integer("resources_to_destroy"),
  resourcesCreated: integer("resources_created").notNull().default(0),
  approvalsRequired: integer("approvals_required").notNull().default(0),
  approvalsGranted: integer("approvals_granted").notNull().default(0),
  error: text("error"),
  leaseOwner: varchar("lease_owner", { length: 128 }),
  // timestamptz: a lease is an instant, and comparing a timezone-less column
  // against now() was off by the session offset. See migration 0013.
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  startedByUserId: integer("started_by_user_id"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const infraRunNodes = pgTable("infra_run_nodes", {
  id: bigserial("id", { mode: 'number' }).primaryKey(),
  organizationId: organizationId(),
  runId: integer("run_id").notNull(),
  nodeKey: varchar("node_key", { length: 128 }).notNull(),
  status: varchar("status", { length: 32 }).notNull().default('pending'),
  attempts: integer("attempts").notNull().default(0),
  error: text("error"),
  outputs: jsonb("outputs"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const infraEvents = pgTable("infra_events", {
  id: bigserial("id", { mode: 'number' }).primaryKey(),
  // Deliberately not a foreign key: deployment history outlives the tenant, and
  // an append-only table cannot be the target of a cascading delete. Same
  // correction as audit_logs. See migration 0014.
  organizationId: integer("organization_id").notNull(),
  runId: integer("run_id").notNull(),
  eventType: varchar("event_type", { length: 64 }).notNull(),
  nodeKey: varchar("node_key", { length: 128 }),
  level: varchar("level", { length: 16 }).notNull().default('info'),
  message: text("message").notNull(),
  data: jsonb("data"),
  sequence: integer("sequence").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const infraApprovals = pgTable("infra_approvals", {
  id: bigserial("id", { mode: 'number' }).primaryKey(),
  organizationId: organizationId(),
  runId: integer("run_id").notNull(),
  nodeKey: varchar("node_key", { length: 128 }),
  ref: varchar("ref", { length: 64 }).notNull().unique(),
  summary: text("summary").notNull(),
  details: text("details"),
  riskLevel: varchar("risk_level", { length: 20 }).notNull().default('medium'),
  riskReasons: jsonb("risk_reasons").notNull().default([]),
  proposedAction: jsonb("proposed_action"),
  /** Per-resource actions from `terraform show -json`. Addresses only, no attribute values. */
  plannedChanges: jsonb("planned_changes").notNull().default([]),
  /** Attribute-level risks read out of the plan. See server/infra-agent/terraform/plan-risk.ts. */
  planFindings: jsonb("plan_findings").notNull().default([]),
  estimatedCostImpact: numeric("estimated_cost_impact", { precision: 14, scale: 2 }),
  status: varchar("status", { length: 20 }).notNull().default('pending'),
  decidedByUserId: integer("decided_by_user_id"),
  decidedBy: varchar("decided_by", { length: 255 }),
  decisionReason: text("decision_reason"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const standardSteps = pgTable("standard_steps", {
  id: bigserial("id", { mode: 'number' }).primaryKey(),
  // Nullable: platform-wide knowledge by default, tenant-private when set.
  organizationId: integer("organization_id"),
  slug: varchar("slug", { length: 160 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  provider: varchar("provider", { length: 20 }).notNull(),
  service: varchar("service", { length: 128 }).notNull(),
  logicalType: varchar("logical_type", { length: 64 }).notNull(),
  resourceType: varchar("resource_type", { length: 128 }),
  description: text("description"),
  inputs: jsonb("inputs").notNull().default({}),
  outputs: jsonb("outputs").notNull().default({}),
  dependencies: jsonb("dependencies").notNull().default([]),
  implementation: text("implementation"),
  requiredPermissions: jsonb("required_permissions").notNull().default([]),
  securityRequirements: jsonb("security_requirements").notNull().default([]),
  approvalLevel: varchar("approval_level", { length: 20 }).notNull().default('none'),
  version: integer("version").notNull().default(1),
  validationStatus: varchar("validation_status", { length: 20 }).notNull().default('draft'),
  usageCount: integer("usage_count").notNull().default(0),
  successCount: integer("success_count").notNull().default(0),
  lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const docSources = pgTable("doc_sources", {
  id: bigserial("id", { mode: 'number' }).primaryKey(),
  standardStepId: integer("standard_step_id"),
  provider: varchar("provider", { length: 20 }).notNull(),
  service: varchar("service", { length: 128 }),
  title: varchar("title", { length: 500 }),
  url: text("url").notNull(),
  docVersion: varchar("doc_version", { length: 64 }),
  excerpt: text("excerpt"),
  retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull().defaultNow(),
  runId: integer("run_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const infraDeployments = pgTable("infra_deployments", {
  id: bigserial("id", { mode: 'number' }).primaryKey(),
  organizationId: organizationId(),
  planId: integer("plan_id"),
  runId: integer("run_id"),
  name: varchar("name", { length: 255 }).notNull(),
  provider: varchar("provider", { length: 20 }).notNull(),
  accountId: varchar("account_id", { length: 255 }),
  region: varchar("region", { length: 64 }),
  environment: varchar("environment", { length: 32 }),
  executionMode: varchar("execution_mode", { length: 20 }).notNull().default('live'),
  resources: jsonb("resources").notNull().default([]),
  resourceCount: integer("resource_count").notNull().default(0),
  estimatedMonthlyCost: numeric("estimated_monthly_cost", { precision: 14, scale: 2 }),
  stateRef: text("state_ref"),
  durationSeconds: integer("duration_seconds"),
  status: varchar("status", { length: 32 }).notNull().default('active'),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type InfraPlan = typeof infraPlans.$inferSelect;
export type InfraPlanNode = typeof infraPlanNodes.$inferSelect;
export type InfraRun = typeof infraRuns.$inferSelect;
export type InfraRunNode = typeof infraRunNodes.$inferSelect;
export type InfraEvent = typeof infraEvents.$inferSelect;
export type InfraApproval = typeof infraApprovals.$inferSelect;
export type StandardStep = typeof standardSteps.$inferSelect;
export type DocSource = typeof docSources.$inferSelect;
export type InfraDeployment = typeof infraDeployments.$inferSelect;

// ==================== AUDIT LOG ====================

// Append-only record of every state-changing request and every privileged
// action. A database trigger (migration 0006) rejects UPDATE and DELETE, so an
// application bug cannot rewrite history.
export const auditLogs = pgTable("audit_logs", {
  id: bigserial("id", { mode: 'number' }).primaryKey(),
  // Deliberately not a foreign key: audit history is retained after a tenant is
  // deleted, and a cascading delete would be blocked by the append-only trigger
  // anyway. See migration 0007.
  organizationId: integer("organization_id").notNull(),
  actorUserId: integer("actor_user_id"),
  actorUsername: varchar("actor_username", { length: 100 }),
  actorIp: varchar("actor_ip", { length: 64 }),
  action: varchar("action", { length: 100 }).notNull(), // 'cloud_account.create', 'agent.action.execute', ...
  resourceType: varchar("resource_type", { length: 100 }),
  resourceId: varchar("resource_id", { length: 255 }),
  method: varchar("method", { length: 10 }),
  path: varchar("path", { length: 500 }),
  statusCode: integer("status_code"),
  outcome: varchar("outcome", { length: 20 }).notNull().default('success'), // 'success' | 'failure' | 'denied'
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertAuditLogSchema = createInsertSchema(auditLogs).omit({ id: true, createdAt: true });
export type InsertAuditLog = z.infer<typeof insertAuditLogSchema>;
export type AuditLog = typeof auditLogs.$inferSelect;

// ==================== GOVERNANCE & COMPLIANCE ====================

// Policy definitions are code (server/governance/catalog.ts), not rows. What a
// tenant owns is the assignment: whether a policy runs, how loudly, with which
// thresholds, over which slice of the estate. Everything below is per-tenant
// configuration and per-tenant results — nothing here is a shared catalog.
//
// See migration 0019.

/**
 * One row per policy a tenant has customised. Absence means "catalog defaults",
 * so a fresh tenant gets a working governance baseline with zero configuration
 * and the table stays small.
 */
export const governancePolicyAssignments = pgTable("governance_policy_assignments", {
  id: serial("id").primaryKey(),
  organizationId: organizationId(),
  policyKey: varchar("policy_key", { length: 100 }).notNull(),
  enabled: boolean("enabled").notNull().default(true),
  /** Overrides the catalog severity. Null keeps whatever the catalog says. */
  severity: varchar("severity", { length: 20 }),
  enforcement: varchar("enforcement", { length: 20 }).notNull().default('audit'),
  parameters: jsonb("parameters").notNull().default({}),
  scope: jsonb("scope").notNull().default({}),
  updatedBy: integer("updated_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertGovernancePolicyAssignmentSchema =
  createInsertSchema(governancePolicyAssignments).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertGovernancePolicyAssignment = z.infer<typeof insertGovernancePolicyAssignmentSchema>;
export type GovernancePolicyAssignment = typeof governancePolicyAssignments.$inferSelect;

/** One row per evaluation sweep. Keeps the score history that shows a trend. */
export const governanceRuns = pgTable("governance_runs", {
  id: bigserial("id", { mode: 'number' }).primaryKey(),
  organizationId: organizationId(),
  trigger: varchar("trigger", { length: 20 }).notNull().default('scheduled'), // scheduled|manual
  status: varchar("status", { length: 20 }).notNull().default('running'),     // running|success|failed
  policiesEvaluated: integer("policies_evaluated").notNull().default(0),
  policiesFailed: integer("policies_failed").notNull().default(0),
  violationsOpened: integer("violations_opened").notNull().default(0),
  violationsResolved: integer("violations_resolved").notNull().default(0),
  openViolations: integer("open_violations").notNull().default(0),
  score: numeric("score", { precision: 5, scale: 2 }),
  /** Per-domain scores, so the trend can be broken down without re-evaluating. */
  domainScores: jsonb("domain_scores"),
  /** Policy keys that reached no verdict. Never the same thing as passing. */
  notAssessed: jsonb("not_assessed"),
  /**
   * Per-policy score impact: what each policy examined, how much failed, and
   * the points fixing it would recover. Stored because `checked` — the
   * denominator that makes a finding count meaningful — exists only while the
   * policy runs and cannot be reconstructed afterwards.
   */
  policyImpacts: jsonb("policy_impacts"),
  costAtRisk: numeric("cost_at_risk", { precision: 20, scale: 2 }),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const insertGovernanceRunSchema = createInsertSchema(governanceRuns).omit({ id: true });
export type InsertGovernanceRun = z.infer<typeof insertGovernanceRunSchema>;
export type GovernanceRun = typeof governanceRuns.$inferSelect;

/**
 * A finding, identified by a fingerprint rather than by row id.
 *
 * Re-running the engine must not produce a second copy of a violation that was
 * already there, and must not lose the date it was first seen — that date is
 * what an ageing report and an SLA are computed from. So findings are upserted
 * on (organization_id, fingerprint) and anything not seen in the latest run is
 * closed rather than deleted.
 */
export const governanceViolations = pgTable("governance_violations", {
  id: bigserial("id", { mode: 'number' }).primaryKey(),
  organizationId: organizationId(),
  policyKey: varchar("policy_key", { length: 100 }).notNull(),
  /** Stable hash of policy + resource identity. Unique per tenant. */
  fingerprint: varchar("fingerprint", { length: 64 }).notNull(),
  severity: varchar("severity", { length: 20 }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default('open'), // open|acknowledged|exempt|resolved

  provider: varchar("provider", { length: 20 }),
  accountId: varchar("account_id", { length: 255 }),
  region: varchar("region", { length: 100 }),
  resourceId: varchar("resource_id", { length: 500 }),
  resourceType: varchar("resource_type", { length: 100 }),
  resourceName: varchar("resource_name", { length: 255 }),

  title: varchar("title", { length: 500 }).notNull(),
  detail: text("detail").notNull(),
  /** The numbers the finding was derived from, so it can be argued with. */
  evidence: jsonb("evidence"),
  monthlyCostImpact: numeric("monthly_cost_impact", { precision: 20, scale: 2 }),

  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  /** Run that most recently observed it. */
  lastRunId: integer("last_run_id"),
  acknowledgedBy: integer("acknowledged_by"),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  acknowledgeNote: text("acknowledge_note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertGovernanceViolationSchema =
  createInsertSchema(governanceViolations).omit({ id: true, createdAt: true });
export type InsertGovernanceViolation = z.infer<typeof insertGovernanceViolationSchema>;
export type GovernanceViolation = typeof governanceViolations.$inferSelect;

/**
 * A time-boxed, justified suppression.
 *
 * Three properties make this an exemption rather than a mute button: the reason
 * is mandatory, the expiry is mandatory and capped, and the grant is written to
 * the audit log. An exemption that never expires is a policy change made
 * without anyone agreeing to change the policy.
 */
export const governanceExemptions = pgTable("governance_exemptions", {
  id: serial("id").primaryKey(),
  organizationId: organizationId(),
  policyKey: varchar("policy_key", { length: 100 }).notNull(),
  /** Null means "the whole scope below"; set for a single-resource exemption. */
  resourceId: varchar("resource_id", { length: 500 }),
  scope: jsonb("scope").notNull().default({}),
  reason: text("reason").notNull(),
  requestedBy: integer("requested_by"),
  approvedBy: integer("approved_by"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedBy: integer("revoked_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertGovernanceExemptionSchema =
  createInsertSchema(governanceExemptions).omit({ id: true, createdAt: true });
export type InsertGovernanceExemption = z.infer<typeof insertGovernanceExemptionSchema>;
export type GovernanceExemption = typeof governanceExemptions.$inferSelect;

// ==================== GITOPS DELIVERY (migration 0022) ====================

/** Where a tenant's Terraform state lives, per provider. See server/infra-agent/terraform/backend.ts. */
export const infraStateBackends = pgTable("infra_state_backends", {
  id: serial("id").primaryKey(),
  organizationId: organizationId(),
  provider: varchar("provider", { length: 20 }).notNull(),
  kind: varchar("kind", { length: 20 }).notNull(),   // s3 | azurerm | gcs | local
  settings: jsonb("settings").notNull().default({}),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  verificationError: text("verification_error"),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type InfraStateBackend = typeof infraStateBackends.$inferSelect;

/**
 * Where pull requests are raised. `accessToken` is encrypted at rest with the
 * same key as cloud credentials: a token that can open a PR can usually read
 * every repository its owner can.
 */
/**
 * A GitHub App registered through the App Manifest flow.
 *
 * Deliberately per-organization rather than deployment-wide. GitHub's model is
 * one App per product, but a shared row in a multi-tenant deployment would let
 * one customer's administrator replace the App everyone else authenticates
 * through. Registration is three clicks, so the isolation is free.
 *
 * There is no environment fallback. An unregistered tenant gets an error that
 * says so, rather than silently borrowing credentials from a file.
 */
export const githubAppCredentials = pgTable("github_app_credentials", {
  id: serial("id").primaryKey(),
  organizationId: organizationId(),
  /** Numeric App id, held as a string: an identifier, never arithmetic. */
  appId: varchar("app_id", { length: 32 }).notNull(),
  /** RSA private key, encrypted at rest. */
  privateKey: text("private_key").notNull(),
  slug: varchar("slug", { length: 255 }),
  clientId: varchar("client_id", { length: 255 }),
  /** Encrypted: GitHub issues one whether or not webhooks are used. */
  webhookSecret: text("webhook_secret"),
  lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type GithubAppCredentials = typeof githubAppCredentials.$inferSelect;

export const infraGitConnections = pgTable("infra_git_connections", {
  id: serial("id").primaryKey(),
  organizationId: organizationId(),
  provider: varchar("provider", { length: 20 }).notNull().default('github'),
  repoOwner: varchar("repo_owner", { length: 255 }).notNull(),
  repoName: varchar("repo_name", { length: 255 }).notNull(),
  /** Null = read the repository's live default branch at PR time. */
  baseBranch: varchar("base_branch", { length: 255 }),
  /**
   * 'pat' = a stored personal access token. 'app' = a GitHub App installation,
   * whose token is minted per request and never stored.
   */
  authMethod: varchar("auth_method", { length: 20 }).notNull().default('pat'),
  /** Null for App connections — there is no long-lived token to keep. */
  accessToken: text("access_token"),
  /** Per-tenant App installation. Useless without the deployment private key. */
  appInstallationId: varchar("app_installation_id", { length: 64 }),
  basePath: varchar("base_path", { length: 255 }).notNull().default('infrastructure'),
  emitPipeline: boolean("emit_pipeline").notNull().default(true),
  lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type InfraGitConnection = typeof infraGitConnections.$inferSelect;

/** A raised pull request. Distinct from infra_runs: this is a handoff, not an execution. */
export const infraPullRequests = pgTable("infra_pull_requests", {
  id: bigserial("id", { mode: 'number' }).primaryKey(),
  organizationId: organizationId(),
  planId: integer("plan_id").notNull(),
  connectionId: integer("connection_id"),

  provider: varchar("provider", { length: 20 }).notNull().default('github'),
  repoOwner: varchar("repo_owner", { length: 255 }).notNull(),
  repoName: varchar("repo_name", { length: 255 }).notNull(),
  baseBranch: varchar("base_branch", { length: 255 }).notNull(),
  headBranch: varchar("head_branch", { length: 255 }).notNull(),

  number: integer("number"),
  url: text("url"),
  headSha: varchar("head_sha", { length: 64 }),

  status: varchar("status", { length: 20 }).notNull().default('open'), // open|merged|closed|failed
  error: text("error"),

  filePaths: jsonb("file_paths").notNull().default([]),
  resourceCount: integer("resource_count").notNull().default(0),
  estimatedMonthlyCost: numeric("estimated_monthly_cost", { precision: 14, scale: 2 }),
  stateBackend: text("state_backend"),

  createdBy: integer("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type InfraPullRequest = typeof infraPullRequests.$inferSelect;

// ==================== AI UNIT ECONOMICS (migration 0024) ====================

/**
 * The business denominator for AI cost-per-unit.
 *
 * Cannot be derived from billing: only the customer knows how many active
 * users or documents a period had. Stored per period rather than as one
 * mutable number, because the trend is the point — a cost per user that falls
 * as usage grows is the signal, and a single overwritten value destroys it.
 */
export const aiUnitMetrics = pgTable("ai_unit_metrics", {
  id: serial("id").primaryKey(),
  organizationId: organizationId(),
  /** The customer's own words: "Monthly active users", "Documents processed". */
  name: varchar("name", { length: 120 }).notNull(),
  /** Singular noun, so the UI can render "$0.37 per user". */
  unitLabel: varchar("unit_label", { length: 60 }).notNull().default('unit'),
  /** First day of the month this value describes. A date, not an instant. */
  periodStart: date("period_start").notNull(),
  /** Numeric because some denominators are genuinely fractional. */
  value: numeric("value", { precision: 20, scale: 4 }).notNull(),
  notes: text("notes"),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AiUnitMetric = typeof aiUnitMetrics.$inferSelect;

// ==================== AI TOKEN ECONOMICS (migration 0025) ====================
//
// Usage ingested from provider APIs and priced by us, because billing does not
// carry tokens or call counts. See db/migrations/0025 for why this is separate
// from cost_facts and how the two differ.

export const AI_PROVIDER_KEYS = ['bedrock', 'azure_openai', 'vertex', 'openai', 'anthropic'] as const;
export type AiProviderKey = (typeof AI_PROVIDER_KEYS)[number];

export const aiProviders = pgTable("ai_providers", {
  key: varchar("key", { length: 40 }).primaryKey(),
  displayName: varchar("display_name", { length: 120 }).notNull(),
  /** 'cloud' = billed through a connected cloud account; 'direct' = vendor-billed. */
  billingMode: varchar("billing_mode", { length: 20 }).notNull(),
  usageSource: varchar("usage_source", { length: 120 }).notNull(),
  docsUrl: text("docs_url"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type AiProvider = typeof aiProviders.$inferSelect;

/** Null organizationId is the global catalog; a row with one is a tenant addition. */
export const aiModels = pgTable("ai_models", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id"),
  providerKey: varchar("provider_key", { length: 40 }).notNull(),
  /** The provider's own identifier, exactly as it appears in usage data. */
  modelId: varchar("model_id", { length: 200 }).notNull(),
  displayName: varchar("display_name", { length: 200 }).notNull(),
  family: varchar("family", { length: 120 }),
  modality: varchar("modality", { length: 30 }).notNull().default('text'),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type AiModel = typeof aiModels.$inferSelect;

/**
 * Effective-dated pricing. Without the dates, a vendor price change would
 * retroactively rewrite every historical figure.
 */
export const aiModelPricing = pgTable("ai_model_pricing", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id"),
  providerKey: varchar("provider_key", { length: 40 }).notNull(),
  modelId: varchar("model_id", { length: 200 }).notNull(),
  inputPerMillion: numeric("input_per_million", { precision: 14, scale: 6 }).notNull(),
  outputPerMillion: numeric("output_per_million", { precision: 14, scale: 6 }).notNull(),
  cacheReadPerMillion: numeric("cache_read_per_million", { precision: 14, scale: 6 }),
  cacheWritePerMillion: numeric("cache_write_per_million", { precision: 14, scale: 6 }),
  perCallCost: numeric("per_call_cost", { precision: 14, scale: 8 }),
  currency: varchar("currency", { length: 10 }).notNull().default('USD'),
  effectiveFrom: date("effective_from").notNull(),
  /** Null = still current. Inclusive when set. */
  effectiveTo: date("effective_to"),
  /** catalog | customer | contract — a negotiated rate is a different claim from list. */
  source: varchar("source", { length: 20 }).notNull().default('catalog'),
  sourceUrl: text("source_url"),
  notes: text("notes"),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type AiModelPricing = typeof aiModelPricing.$inferSelect;

/** Metered usage, aggregated to a period. One row per model per period per attribution. */
export const aiUsageRecords = pgTable("ai_usage_records", {
  id: bigserial("id", { mode: 'number' }).primaryKey(),
  organizationId: organizationId(),
  providerKey: varchar("provider_key", { length: 40 }).notNull(),
  modelId: varchar("model_id", { length: 200 }).notNull(),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  inputTokens: bigint("input_tokens", { mode: 'number' }).notNull().default(0),
  outputTokens: bigint("output_tokens", { mode: 'number' }).notNull().default(0),
  /** Separate from input: cache reads are priced at a fraction of the input rate. */
  cacheReadTokens: bigint("cache_read_tokens", { mode: 'number' }).notNull().default(0),
  cacheWriteTokens: bigint("cache_write_tokens", { mode: 'number' }).notNull().default(0),
  inferenceCalls: bigint("inference_calls", { mode: 'number' }).notNull().default(0),
  accountId: varchar("account_id", { length: 255 }),
  region: varchar("region", { length: 64 }),
  application: varchar("application", { length: 160 }),
  environment: varchar("environment", { length: 60 }),
  source: varchar("source", { length: 40 }).notNull(),
  sourceRef: varchar("source_ref", { length: 255 }),
  ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
});
export type AiUsageRecord = typeof aiUsageRecords.$inferSelect;

/** Priced usage, pinned to the pricing row used so history cannot silently move. */
export const aiSpendRecords = pgTable("ai_spend_records", {
  id: bigserial("id", { mode: 'number' }).primaryKey(),
  organizationId: organizationId(),
  usageRecordId: bigint("usage_record_id", { mode: 'number' }).notNull(),
  providerKey: varchar("provider_key", { length: 40 }).notNull(),
  modelId: varchar("model_id", { length: 200 }).notNull(),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  inputCost: numeric("input_cost", { precision: 20, scale: 10 }).notNull().default('0'),
  outputCost: numeric("output_cost", { precision: 20, scale: 10 }).notNull().default('0'),
  cacheCost: numeric("cache_cost", { precision: 20, scale: 10 }).notNull().default('0'),
  callCost: numeric("call_cost", { precision: 20, scale: 10 }).notNull().default('0'),
  totalCost: numeric("total_cost", { precision: 20, scale: 10 }).notNull().default('0'),
  currency: varchar("currency", { length: 10 }).notNull().default('USD'),
  pricingId: integer("pricing_id"),
  pricingSource: varchar("pricing_source", { length: 20 }),
  /** Set when no price covered the period. Retained as unpriced, never costed at zero. */
  unpricedReason: text("unpriced_reason"),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
});
export type AiSpendRecord = typeof aiSpendRecords.$inferSelect;
