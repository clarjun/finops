import { z } from "zod";
import { pgTable, text, varchar, timestamp, numeric, integer, jsonb, serial, boolean } from "drizzle-orm/pg-core";
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

// Historical Cost Data - stores daily cost records for ML training and analysis (Multi-Cloud)
export const costHistory = pgTable("cost_history", {
  id: serial("id").primaryKey(),
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
  provider: varchar("provider", { length: 20 }).notNull(), // 'azure', 'aws', 'gcp'
  accountName: varchar("account_name", { length: 255 }).notNull(),
  accountId: varchar("account_id", { length: 255 }).notNull(), // AWS Account ID, Azure Subscription ID, GCP Project ID
  credentials: jsonb("credentials").notNull(), // Encrypted provider-specific credentials
  refreshInterval: integer("refresh_interval").notNull().default(86400),
  isActive: boolean("is_active").notNull().default(true),
  lastSyncAt: timestamp("last_sync_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertCloudAccountSchema = createInsertSchema(cloudAccounts).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCloudAccount = z.infer<typeof insertCloudAccountSchema>;
export type CloudAccount = typeof cloudAccounts.$inferSelect;

// Legacy Azure Accounts table (deprecated - migrate to cloudAccounts)
export const azureAccounts = pgTable("azure_accounts", {
  id: serial("id").primaryKey(),
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

// Resource Inventory - tracks cloud resources across providers
export const resourceInventory = pgTable("resource_inventory", {
  id: serial("id").primaryKey(),
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
  cacheKey: varchar("cache_key", { length: 500 }).notNull().unique(), // e.g. finops-report:aws:2026-04-01:2026-04-09
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

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: varchar("username", { length: 100 }).notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: varchar("role", { length: 20 }).notNull().default('user'), // 'admin' | 'user'
  isActive: boolean("is_active").notNull().default(true),
  createdBy: integer("created_by"), // admin user id who created this user
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
