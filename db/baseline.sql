-- Baseline schema, generated from shared/schema.ts with drizzle-kit.
--
-- Applied ONLY to a database with no tables at all. The migration chain starts
-- at 0003, which assumes tables that no migration creates -- the original base
-- schema came from `drizzle-kit push`, so a fresh database had no way to reach
-- the starting point of its own history.
--
-- server/migrate.ts applies this, then records every migration up to
-- BASELINE_INCLUDES_THROUGH as applied, because this file already contains
-- their effects. Later migrations run normally on top, so adding a new one does
-- NOT require regenerating this file.
--
-- To regenerate deliberately:
--   npx drizzle-kit generate --config drizzle.baseline.config.ts
-- and update BASELINE_INCLUDES_THROUGH in server/migrate.ts to the latest
-- migration at that moment.

CREATE TABLE "action_feedback" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer DEFAULT 1 NOT NULL,
	"action_id" integer NOT NULL,
	"actual_savings" numeric(10, 2),
	"savings_variance" numeric(5, 2),
	"performance_impact" varchar(50),
	"performance_details" text,
	"user_satisfaction" integer,
	"issues_encountered" jsonb,
	"lessons_learned" text,
	"would_recommend_again" integer DEFAULT 1,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer DEFAULT 1 NOT NULL,
	"auto_execute_enabled" integer DEFAULT 0,
	"require_approval_for" jsonb,
	"max_cost_impact_without_approval" numeric(10, 2) DEFAULT '100.00',
	"aggressiveness" varchar(20) DEFAULT 'medium',
	"learning_enabled" integer DEFAULT 1,
	"enabled_providers" jsonb,
	"enabled_action_types" jsonb,
	"safety_mode" integer DEFAULT 1,
	"dry_run_mode" integer DEFAULT 1,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_model_pricing" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer,
	"provider_key" varchar(40) NOT NULL,
	"model_id" varchar(200) NOT NULL,
	"input_per_million" numeric(14, 6) NOT NULL,
	"output_per_million" numeric(14, 6) NOT NULL,
	"cache_read_per_million" numeric(14, 6),
	"cache_write_per_million" numeric(14, 6),
	"per_call_cost" numeric(14, 8),
	"currency" varchar(10) DEFAULT 'USD' NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"source" varchar(20) DEFAULT 'catalog' NOT NULL,
	"source_url" text,
	"notes" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_models" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer,
	"provider_key" varchar(40) NOT NULL,
	"model_id" varchar(200) NOT NULL,
	"display_name" varchar(200) NOT NULL,
	"family" varchar(120),
	"modality" varchar(30) DEFAULT 'text' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_providers" (
	"key" varchar(40) PRIMARY KEY NOT NULL,
	"display_name" varchar(120) NOT NULL,
	"billing_mode" varchar(20) NOT NULL,
	"usage_source" varchar(120) NOT NULL,
	"docs_url" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_spend_records" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" integer DEFAULT 1 NOT NULL,
	"usage_record_id" bigint NOT NULL,
	"provider_key" varchar(40) NOT NULL,
	"model_id" varchar(200) NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"input_cost" numeric(20, 10) DEFAULT '0' NOT NULL,
	"output_cost" numeric(20, 10) DEFAULT '0' NOT NULL,
	"cache_cost" numeric(20, 10) DEFAULT '0' NOT NULL,
	"call_cost" numeric(20, 10) DEFAULT '0' NOT NULL,
	"total_cost" numeric(20, 10) DEFAULT '0' NOT NULL,
	"currency" varchar(10) DEFAULT 'USD' NOT NULL,
	"pricing_id" integer,
	"pricing_source" varchar(20),
	"unpriced_reason" text,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_unit_metrics" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer DEFAULT 1 NOT NULL,
	"name" varchar(120) NOT NULL,
	"unit_label" varchar(60) DEFAULT 'unit' NOT NULL,
	"period_start" date NOT NULL,
	"value" numeric(20, 4) NOT NULL,
	"notes" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_usage_records" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" integer DEFAULT 1 NOT NULL,
	"provider_key" varchar(40) NOT NULL,
	"model_id" varchar(200) NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"inference_calls" bigint DEFAULT 0 NOT NULL,
	"account_id" varchar(255),
	"region" varchar(64),
	"application" varchar(160),
	"environment" varchar(60),
	"source" varchar(40) NOT NULL,
	"source_ref" varchar(255),
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer DEFAULT 1 NOT NULL,
	"rule_name" varchar(255) NOT NULL,
	"provider" varchar(20),
	"account_id" varchar(255),
	"service_name" varchar(255),
	"threshold_amount" numeric(10, 2) NOT NULL,
	"threshold_type" varchar(50) NOT NULL,
	"comparison_operator" varchar(20) DEFAULT 'gt' NOT NULL,
	"email_recipients" text NOT NULL,
	"webhook_url" varchar(500),
	"is_enabled" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "anomaly_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer DEFAULT 1 NOT NULL,
	"provider" varchar(20) NOT NULL,
	"account_id" varchar(255) NOT NULL,
	"detected_at" timestamp NOT NULL,
	"anomaly_date" timestamp NOT NULL,
	"service_name" varchar(255),
	"anomaly_type" varchar(50) NOT NULL,
	"severity" varchar(20) NOT NULL,
	"expected_cost" numeric(10, 2) NOT NULL,
	"actual_cost" numeric(10, 2) NOT NULL,
	"deviation" numeric(5, 2),
	"root_cause" text,
	"correlated_events" jsonb,
	"resolved_at" timestamp,
	"status" varchar(50) DEFAULT 'active',
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"actor_user_id" integer,
	"actor_username" varchar(100),
	"actor_ip" varchar(64),
	"action" varchar(100) NOT NULL,
	"resource_type" varchar(100),
	"resource_id" varchar(255),
	"method" varchar(10),
	"path" varchar(500),
	"status_code" integer,
	"outcome" varchar(20) DEFAULT 'success' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "azure_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer DEFAULT 1 NOT NULL,
	"account_name" varchar(255) NOT NULL,
	"tenant_id" varchar(255) NOT NULL,
	"client_id" varchar(255) NOT NULL,
	"client_secret" text NOT NULL,
	"subscription_id" varchar(255) NOT NULL,
	"scope" varchar(50) DEFAULT 'subscription' NOT NULL,
	"resource_group_name" varchar(255),
	"billing_account_id" varchar(255),
	"refresh_interval" integer DEFAULT 86400 NOT NULL,
	"is_active" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer DEFAULT 1 NOT NULL,
	"budget_name" varchar(255) NOT NULL,
	"provider" varchar(20),
	"account_id" varchar(255),
	"service_name" varchar(255),
	"amount" numeric(10, 2) NOT NULL,
	"period" varchar(20) NOT NULL,
	"start_date" timestamp NOT NULL,
	"end_date" timestamp,
	"alert_thresholds" jsonb,
	"email_recipients" text,
	"webhook_url" text,
	"last_alerted_at" timestamp,
	"last_alerted_threshold" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer DEFAULT 1 NOT NULL,
	"provider" varchar(20) NOT NULL,
	"account_name" varchar(255) NOT NULL,
	"account_id" varchar(255) NOT NULL,
	"credentials" jsonb NOT NULL,
	"refresh_interval" integer DEFAULT 86400 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_sync_at" timestamp,
	"auth_type" varchar(32) DEFAULT 'access_keys' NOT NULL,
	"role_arn" varchar(2048),
	"remediation_role_arn" varchar(2048),
	"deploy_role_arn" varchar(2048),
	"external_id" text,
	"last_validated_at" timestamp with time zone,
	"last_validation_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_facts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" integer DEFAULT 1 NOT NULL,
	"provider" varchar(20) NOT NULL,
	"billing_account_id" varchar(255),
	"billing_account_name" varchar(255),
	"sub_account_id" varchar(255) NOT NULL,
	"sub_account_name" varchar(255),
	"charge_period_start" timestamp NOT NULL,
	"charge_period_end" timestamp NOT NULL,
	"billing_period_start" timestamp,
	"service_name" varchar(255) NOT NULL,
	"service_category" varchar(100),
	"charge_category" varchar(50) DEFAULT 'Usage' NOT NULL,
	"charge_description" text,
	"resource_id" varchar(500),
	"resource_name" varchar(255),
	"region_id" varchar(100),
	"billed_cost" numeric(20, 10) DEFAULT '0' NOT NULL,
	"effective_cost" numeric(20, 10),
	"list_cost" numeric(20, 10),
	"billing_currency" varchar(10) DEFAULT 'USD' NOT NULL,
	"pricing_quantity" numeric,
	"pricing_unit" varchar(100),
	"tags" jsonb,
	"commitment_discount_id" varchar(255),
	"ingestion_run_id" integer,
	"source_hash" varchar(64) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer DEFAULT 1 NOT NULL,
	"provider" varchar(20) NOT NULL,
	"date" timestamp NOT NULL,
	"account_id" varchar(255) NOT NULL,
	"account_name" varchar(255) NOT NULL,
	"resource_group" varchar(255),
	"service_name" varchar(255) NOT NULL,
	"region" varchar(100),
	"cost" numeric(10, 2) NOT NULL,
	"currency" varchar(10) DEFAULT 'USD' NOT NULL,
	"tags" jsonb,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doc_sources" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"standard_step_id" integer,
	"provider" varchar(20) NOT NULL,
	"service" varchar(128),
	"title" varchar(500),
	"url" text NOT NULL,
	"doc_version" varchar(64),
	"excerpt" text,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forecast_data" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer DEFAULT 1 NOT NULL,
	"provider" varchar(20) NOT NULL,
	"account_id" varchar(255) NOT NULL,
	"service_name" varchar(255),
	"forecast_date" timestamp NOT NULL,
	"predicted_cost" numeric(10, 2) NOT NULL,
	"confidence_interval" jsonb,
	"model_version" varchar(50) NOT NULL,
	"model_type" varchar(50),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_app_credentials" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer DEFAULT 1 NOT NULL,
	"app_id" varchar(32) NOT NULL,
	"private_key" text NOT NULL,
	"slug" varchar(255),
	"client_id" varchar(255),
	"webhook_secret" text,
	"last_verified_at" timestamp with time zone,
	"last_error" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "governance_exemptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer DEFAULT 1 NOT NULL,
	"policy_key" varchar(100) NOT NULL,
	"resource_id" varchar(500),
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reason" text NOT NULL,
	"requested_by" integer,
	"approved_by" integer,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "governance_policy_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer DEFAULT 1 NOT NULL,
	"policy_key" varchar(100) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"severity" varchar(20),
	"enforcement" varchar(20) DEFAULT 'audit' NOT NULL,
	"parameters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "governance_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" integer DEFAULT 1 NOT NULL,
	"trigger" varchar(20) DEFAULT 'scheduled' NOT NULL,
	"status" varchar(20) DEFAULT 'running' NOT NULL,
	"policies_evaluated" integer DEFAULT 0 NOT NULL,
	"policies_failed" integer DEFAULT 0 NOT NULL,
	"violations_opened" integer DEFAULT 0 NOT NULL,
	"violations_resolved" integer DEFAULT 0 NOT NULL,
	"open_violations" integer DEFAULT 0 NOT NULL,
	"score" numeric(5, 2),
	"domain_scores" jsonb,
	"not_assessed" jsonb,
	"policy_impacts" jsonb,
	"cost_at_risk" numeric(20, 2),
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "governance_violations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" integer DEFAULT 1 NOT NULL,
	"policy_key" varchar(100) NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"severity" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"provider" varchar(20),
	"account_id" varchar(255),
	"region" varchar(100),
	"resource_id" varchar(500),
	"resource_type" varchar(100),
	"resource_name" varchar(255),
	"title" varchar(500) NOT NULL,
	"detail" text NOT NULL,
	"evidence" jsonb,
	"monthly_cost_impact" numeric(20, 2),
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"last_run_id" integer,
	"acknowledged_by" integer,
	"acknowledged_at" timestamp with time zone,
	"acknowledge_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_approvals" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" integer DEFAULT 1 NOT NULL,
	"run_id" integer NOT NULL,
	"node_key" varchar(128),
	"ref" varchar(64) NOT NULL,
	"summary" text NOT NULL,
	"details" text,
	"risk_level" varchar(20) DEFAULT 'medium' NOT NULL,
	"risk_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"proposed_action" jsonb,
	"planned_changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"plan_findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"estimated_cost_impact" numeric(14, 2),
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"decided_by_user_id" integer,
	"decided_by" varchar(255),
	"decision_reason" text,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "infra_approvals_ref_unique" UNIQUE("ref")
);
--> statement-breakpoint
CREATE TABLE "infra_deployments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" integer DEFAULT 1 NOT NULL,
	"plan_id" integer,
	"run_id" integer,
	"name" varchar(255) NOT NULL,
	"provider" varchar(20) NOT NULL,
	"account_id" varchar(255),
	"region" varchar(64),
	"environment" varchar(32),
	"execution_mode" varchar(20) DEFAULT 'live' NOT NULL,
	"resources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resource_count" integer DEFAULT 0 NOT NULL,
	"estimated_monthly_cost" numeric(14, 2),
	"state_ref" text,
	"duration_seconds" integer,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"run_id" integer NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"node_key" varchar(128),
	"level" varchar(16) DEFAULT 'info' NOT NULL,
	"message" text NOT NULL,
	"data" jsonb,
	"sequence" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_git_connections" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer DEFAULT 1 NOT NULL,
	"provider" varchar(20) DEFAULT 'github' NOT NULL,
	"repo_owner" varchar(255) NOT NULL,
	"repo_name" varchar(255) NOT NULL,
	"base_branch" varchar(255),
	"auth_method" varchar(20) DEFAULT 'pat' NOT NULL,
	"access_token" text,
	"app_installation_id" varchar(64),
	"base_path" varchar(255) DEFAULT 'infrastructure' NOT NULL,
	"emit_pipeline" boolean DEFAULT true NOT NULL,
	"last_verified_at" timestamp with time zone,
	"last_error" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_plan_nodes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" integer DEFAULT 1 NOT NULL,
	"plan_id" integer NOT NULL,
	"node_key" varchar(128) NOT NULL,
	"label" varchar(255) NOT NULL,
	"logical_type" varchar(64) NOT NULL,
	"provider_type" varchar(128),
	"resource_address" varchar(255),
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"risk_level" varchar(20) DEFAULT 'low' NOT NULL,
	"risk_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"estimated_monthly_cost" numeric(14, 2),
	"standard_step_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_plans" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" integer DEFAULT 1 NOT NULL,
	"name" varchar(255) NOT NULL,
	"requirements" text NOT NULL,
	"estimator_output" jsonb,
	"clarifications" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provider" varchar(20),
	"cloud_account_id" integer,
	"region" varchar(64),
	"environment" varchar(32),
	"logical_model" jsonb,
	"estimated_monthly_cost" numeric(14, 2),
	"version" integer DEFAULT 1 NOT NULL,
	"supersedes_plan_id" integer,
	"status" varchar(32) DEFAULT 'draft' NOT NULL,
	"is_template" boolean DEFAULT false NOT NULL,
	"template_description" text,
	"template_source_run_id" integer,
	"template_use_count" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_pull_requests" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" integer DEFAULT 1 NOT NULL,
	"plan_id" integer NOT NULL,
	"connection_id" integer,
	"provider" varchar(20) DEFAULT 'github' NOT NULL,
	"repo_owner" varchar(255) NOT NULL,
	"repo_name" varchar(255) NOT NULL,
	"base_branch" varchar(255) NOT NULL,
	"head_branch" varchar(255) NOT NULL,
	"number" integer,
	"url" text,
	"head_sha" varchar(64),
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"error" text,
	"file_paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resource_count" integer DEFAULT 0 NOT NULL,
	"estimated_monthly_cost" numeric(14, 2),
	"state_backend" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_run_nodes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" integer DEFAULT 1 NOT NULL,
	"run_id" integer NOT NULL,
	"node_key" varchar(128) NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"outputs" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" integer DEFAULT 1 NOT NULL,
	"plan_id" integer NOT NULL,
	"mode" varchar(20) DEFAULT 'plan' NOT NULL,
	"execution_mode" varchar(20) DEFAULT 'live' NOT NULL,
	"status" varchar(32) DEFAULT 'queued' NOT NULL,
	"workspace_path" text,
	"terraform_version" varchar(32),
	"plan_summary" jsonb,
	"resources_to_add" integer,
	"resources_to_change" integer,
	"resources_to_destroy" integer,
	"resources_created" integer DEFAULT 0 NOT NULL,
	"approvals_required" integer DEFAULT 0 NOT NULL,
	"approvals_granted" integer DEFAULT 0 NOT NULL,
	"error" text,
	"lease_owner" varchar(128),
	"lease_expires_at" timestamp with time zone,
	"started_by_user_id" integer,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_state_backends" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer DEFAULT 1 NOT NULL,
	"provider" varchar(20) NOT NULL,
	"kind" varchar(20) NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"verified_at" timestamp with time zone,
	"verification_error" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingestion_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" integer DEFAULT 1 NOT NULL,
	"provider" varchar(20) NOT NULL,
	"cloud_account_id" integer,
	"period_start" timestamp NOT NULL,
	"period_end" timestamp NOT NULL,
	"status" varchar(20) DEFAULT 'running' NOT NULL,
	"trigger" varchar(20) DEFAULT 'scheduled' NOT NULL,
	"records_ingested" integer DEFAULT 0 NOT NULL,
	"records_updated" integer DEFAULT 0 NOT NULL,
	"api_calls" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "optimization_actions" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer DEFAULT 1 NOT NULL,
	"plan_id" integer,
	"action_type" varchar(100) NOT NULL,
	"provider" varchar(20) NOT NULL,
	"account_id" varchar(255) NOT NULL,
	"resource_id" varchar(500),
	"resource_type" varchar(100),
	"current_state" jsonb,
	"proposed_state" jsonb,
	"estimated_savings" numeric(10, 2),
	"estimated_cost_impact" numeric(10, 2),
	"risk_level" varchar(20) DEFAULT 'low',
	"status" varchar(50) DEFAULT 'proposed',
	"ai_reasoning" text,
	"execution_details" jsonb,
	"execution_error" text,
	"rollback_details" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"approved_at" timestamp,
	"executed_at" timestamp,
	"completed_at" timestamp,
	"approved_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "optimization_plans" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer DEFAULT 1 NOT NULL,
	"goal" text NOT NULL,
	"provider" varchar(20),
	"target_savings" numeric(10, 2),
	"actual_savings" numeric(10, 2),
	"status" varchar(50) DEFAULT 'planning',
	"ai_strategy" text,
	"steps" jsonb,
	"current_step_index" integer DEFAULT 0,
	"total_steps" integer,
	"completed_steps" integer DEFAULT 0,
	"failed_steps" integer DEFAULT 0,
	"position" integer DEFAULT 999,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"approved_at" timestamp,
	"started_at" timestamp,
	"completed_at" timestamp,
	"approved_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "optimization_recommendations" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer DEFAULT 1 NOT NULL,
	"provider" varchar(20) NOT NULL,
	"account_id" varchar(255) NOT NULL,
	"resource_id" varchar(500),
	"service_name" varchar(255) NOT NULL,
	"recommendation_type" varchar(100) NOT NULL,
	"current_cost" numeric(10, 2) NOT NULL,
	"optimized_cost" numeric(10, 2) NOT NULL,
	"potential_savings" numeric(10, 2) NOT NULL,
	"savings_percent" numeric(5, 2),
	"priority" varchar(20) DEFAULT 'medium',
	"description" text NOT NULL,
	"action_required" text,
	"impact_score" numeric(5, 2),
	"status" varchar(50) DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"plan" varchar(50) DEFAULT 'standard' NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "report_cache" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer DEFAULT 1 NOT NULL,
	"cache_key" varchar(500) NOT NULL,
	"provider" varchar(20) NOT NULL,
	"start_date" varchar(20) NOT NULL,
	"end_date" varchar(20) NOT NULL,
	"report_data" jsonb NOT NULL,
	"fetched_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_schedules" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer DEFAULT 1 NOT NULL,
	"schedule_name" varchar(255) NOT NULL,
	"report_type" varchar(50) NOT NULL,
	"frequency" varchar(50) NOT NULL,
	"format" varchar(20) NOT NULL,
	"email_recipients" text NOT NULL,
	"subscription_ids" text,
	"next_run_at" timestamp NOT NULL,
	"is_enabled" integer DEFAULT 1 NOT NULL,
	"last_run_at" timestamp,
	"last_run_status" varchar(20),
	"last_run_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_inventory" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer DEFAULT 1 NOT NULL,
	"provider" varchar(20) NOT NULL,
	"account_id" varchar(255) NOT NULL,
	"resource_id" varchar(500) NOT NULL,
	"resource_type" varchar(100) NOT NULL,
	"resource_name" varchar(255),
	"region" varchar(100),
	"state" varchar(50),
	"size" varchar(100),
	"monthly_cost" numeric(10, 2),
	"utilization_percent" numeric(5, 2),
	"tags" jsonb,
	"metadata" jsonb,
	"last_seen_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "savings_measurements" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" integer DEFAULT 1 NOT NULL,
	"action_id" integer NOT NULL,
	"provider" varchar(20) NOT NULL,
	"sub_account_id" varchar(255),
	"service_name" varchar(255),
	"region_id" varchar(100),
	"resource_id" varchar(500),
	"granularity" varchar(20) DEFAULT 'service' NOT NULL,
	"baseline_start" timestamp,
	"baseline_end" timestamp,
	"baseline_days" integer,
	"baseline_daily_cost" numeric(20, 10),
	"control_baseline_daily_cost" numeric(20, 10),
	"measure_after" timestamp NOT NULL,
	"measurement_start" timestamp,
	"measurement_end" timestamp,
	"measurement_days" integer,
	"observed_daily_cost" numeric(20, 10),
	"control_observed_daily_cost" numeric(20, 10),
	"expected_daily_cost" numeric(20, 10),
	"realized_daily_savings" numeric(20, 10),
	"realized_monthly_savings" numeric(20, 10),
	"estimated_monthly_savings" numeric(20, 10),
	"variance_percent" numeric(10, 2),
	"confidence" varchar(20),
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"measured_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "savings_plans" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer DEFAULT 1 NOT NULL,
	"provider" varchar(20) NOT NULL,
	"account_id" varchar(255) NOT NULL,
	"plan_type" varchar(100) NOT NULL,
	"service_name" varchar(255),
	"term" varchar(50),
	"payment_option" varchar(50),
	"commitment_amount" numeric(10, 2),
	"utilization_percent" numeric(5, 2),
	"coverage_percent" numeric(5, 2),
	"net_savings" numeric(10, 2),
	"start_date" timestamp,
	"end_date" timestamp,
	"recommended_action" text,
	"status" varchar(50) DEFAULT 'active',
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "standard_steps" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" integer,
	"slug" varchar(160) NOT NULL,
	"name" varchar(255) NOT NULL,
	"provider" varchar(20) NOT NULL,
	"service" varchar(128) NOT NULL,
	"logical_type" varchar(64) NOT NULL,
	"resource_type" varchar(128),
	"description" text,
	"inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dependencies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"implementation" text,
	"required_permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"security_requirements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approval_level" varchar(20) DEFAULT 'none' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"validation_status" varchar(20) DEFAULT 'draft' NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"last_validated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tag_analysis" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer DEFAULT 1 NOT NULL,
	"provider" varchar(20) NOT NULL,
	"account_id" varchar(255) NOT NULL,
	"tag_key" varchar(255) NOT NULL,
	"tag_value" varchar(500),
	"resource_count" integer DEFAULT 0 NOT NULL,
	"total_cost" numeric(10, 2) DEFAULT '0' NOT NULL,
	"period" varchar(20) NOT NULL,
	"period_date" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer DEFAULT 1 NOT NULL,
	"username" varchar(100) NOT NULL,
	"email" varchar(255),
	"full_name" varchar(255),
	"password_hash" text NOT NULL,
	"role" varchar(20) DEFAULT 'viewer' NOT NULL,
	"is_platform_admin" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" integer,
	"last_login_at" timestamp,
	"failed_login_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_ip" varchar(64),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "action_feedback" ADD CONSTRAINT "action_feedback_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_config" ADD CONSTRAINT "agent_config_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_spend_records" ADD CONSTRAINT "ai_spend_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_unit_metrics" ADD CONSTRAINT "ai_unit_metrics_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_records" ADD CONSTRAINT "ai_usage_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anomaly_events" ADD CONSTRAINT "anomaly_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "azure_accounts" ADD CONSTRAINT "azure_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_accounts" ADD CONSTRAINT "cloud_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_facts" ADD CONSTRAINT "cost_facts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_history" ADD CONSTRAINT "cost_history_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecast_data" ADD CONSTRAINT "forecast_data_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_app_credentials" ADD CONSTRAINT "github_app_credentials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_exemptions" ADD CONSTRAINT "governance_exemptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_policy_assignments" ADD CONSTRAINT "governance_policy_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_runs" ADD CONSTRAINT "governance_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_violations" ADD CONSTRAINT "governance_violations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_approvals" ADD CONSTRAINT "infra_approvals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_deployments" ADD CONSTRAINT "infra_deployments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_git_connections" ADD CONSTRAINT "infra_git_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_plan_nodes" ADD CONSTRAINT "infra_plan_nodes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_plans" ADD CONSTRAINT "infra_plans_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_pull_requests" ADD CONSTRAINT "infra_pull_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_run_nodes" ADD CONSTRAINT "infra_run_nodes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_runs" ADD CONSTRAINT "infra_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_state_backends" ADD CONSTRAINT "infra_state_backends_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optimization_actions" ADD CONSTRAINT "optimization_actions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optimization_plans" ADD CONSTRAINT "optimization_plans_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optimization_recommendations" ADD CONSTRAINT "optimization_recommendations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_cache" ADD CONSTRAINT "report_cache_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_inventory" ADD CONSTRAINT "resource_inventory_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_measurements" ADD CONSTRAINT "savings_measurements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_plans" ADD CONSTRAINT "savings_plans_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_analysis" ADD CONSTRAINT "tag_analysis_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;