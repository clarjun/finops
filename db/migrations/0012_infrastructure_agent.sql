-- Migration: Infrastructure Deployment Agent
--
-- The agent turns a Cost Estimator requirement into real cloud infrastructure,
-- through: clarify -> compile a logical architecture -> map to a provider ->
-- generate Terraform -> plan -> human approval -> apply -> verify -> learn.
--
-- Two design decisions are visible in these tables and are worth stating.
--
-- Durable execution. A deployment runs for tens of minutes, must suspend at an
-- approval gate and resume afterwards, and must survive a process restart or a
-- failover between replicas. Run state therefore lives in Postgres rather than
-- in a Map in one process — the mistake we are deliberately not repeating from
-- the platform this is modelled on, whose runner keeps live runs in memory with
-- a five-minute retention and cannot pause at all.
--
-- Provider neutrality at the planning layer. infra_plan_nodes stores a LOGICAL
-- resource (COMPUTE, MANAGED_POSTGRES, OBJECT_STORAGE) plus the provider
-- mapping chosen for it. Adding Azure means adding a mapper, not a second copy
-- of the agent.
--
-- Everything is organization-scoped, so the tenancy, RBAC and audit already in
-- this codebase apply without further work.

BEGIN;

-- ==================== PLANS ====================

-- One row per generated architecture. Versioned: re-planning after a rejected
-- approval or a changed answer produces a new version rather than mutating the
-- plan a human already looked at.
CREATE TABLE IF NOT EXISTS infra_plans (
  id                  BIGSERIAL PRIMARY KEY,
  organization_id     INTEGER      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  name                VARCHAR(255) NOT NULL,
  -- The verbatim Cost Estimator input. Kept as written so a deployment can
  -- always be traced back to what the user actually asked for.
  requirements        TEXT         NOT NULL,
  -- The estimator's priced architecture, as returned.
  estimator_output    JSONB,
  -- Answers to the clarification questions (cloud, account, environment, ...).
  clarifications      JSONB        NOT NULL DEFAULT '{}'::jsonb,

  provider            VARCHAR(20),                       -- aws | azure | gcp
  cloud_account_id    INTEGER,                           -- cloud_accounts.id
  region              VARCHAR(64),
  environment         VARCHAR(32),                       -- development | staging | production

  -- The provider-neutral topology: nodes + edges. The contract between the
  -- estimator and every provider mapper.
  logical_model       JSONB,
  estimated_monthly_cost NUMERIC(14, 2),

  version             INTEGER      NOT NULL DEFAULT 1,
  supersedes_plan_id  BIGINT,
  status              VARCHAR(32)  NOT NULL DEFAULT 'draft',  -- draft|clarifying|compiled|planned|approved|deploying|deployed|failed|abandoned

  created_by_user_id  INTEGER,
  created_at          TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_infra_plans_org ON infra_plans (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_infra_plans_status ON infra_plans (organization_id, status);

-- ==================== PLAN NODES (the DAG) ====================

CREATE TABLE IF NOT EXISTS infra_plan_nodes (
  id                  BIGSERIAL PRIMARY KEY,
  organization_id     INTEGER      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id             BIGINT       NOT NULL REFERENCES infra_plans(id) ON DELETE CASCADE,

  -- Stable within a plan (e.g. 'network.vpc'); edges reference these, not row ids,
  -- so a re-planned version keeps recognisable identity for the UI.
  node_key            VARCHAR(128) NOT NULL,
  label               VARCHAR(255) NOT NULL,

  -- Provider-neutral type: NETWORK, SUBNET, COMPUTE, MANAGED_POSTGRES,
  -- OBJECT_STORAGE, LOAD_BALANCER, IAM, SECRETS, OBSERVABILITY, CACHE.
  logical_type        VARCHAR(64)  NOT NULL,
  -- What the mapper chose, e.g. 'aws_vpc'. Null until a provider is selected.
  provider_type       VARCHAR(128),
  -- Terraform address, e.g. 'aws_vpc.main'. The join to plan/state output.
  resource_address    VARCHAR(255),

  config              JSONB        NOT NULL DEFAULT '{}'::jsonb,
  -- node_keys this depends on. Drives execution order and the UI's edges.
  depends_on          JSONB        NOT NULL DEFAULT '[]'::jsonb,

  -- Why a node may need a human: iam, public_exposure, destructive, expensive,
  -- production, network_change, secrets. Empty means it can run unattended.
  risk_level          VARCHAR(20)  NOT NULL DEFAULT 'low',   -- low|medium|high|critical
  risk_reasons        JSONB        NOT NULL DEFAULT '[]'::jsonb,
  requires_approval   BOOLEAN      NOT NULL DEFAULT false,

  estimated_monthly_cost NUMERIC(14, 2),
  -- The step library entry this node was composed from, when reused.
  standard_step_id    BIGINT,

  created_at          TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_infra_plan_nodes_key ON infra_plan_nodes (plan_id, node_key);
CREATE INDEX IF NOT EXISTS idx_infra_plan_nodes_org ON infra_plan_nodes (organization_id, plan_id);

-- ==================== RUNS ====================

-- One execution attempt of a plan. A run that is resumed continues in the same
-- row: node progress lives in infra_run_nodes, so resuming never restarts work
-- that already succeeded.
CREATE TABLE IF NOT EXISTS infra_runs (
  id                  BIGSERIAL PRIMARY KEY,
  organization_id     INTEGER      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id             BIGINT       NOT NULL REFERENCES infra_plans(id) ON DELETE CASCADE,

  mode                VARCHAR(20)  NOT NULL DEFAULT 'plan',  -- plan | apply | destroy
  -- simulate: Terraform runs for real but stops at plan; no credentials needed
  -- and nothing is created. Recorded explicitly so a simulated run can never be
  -- mistaken for a deployment.
  execution_mode      VARCHAR(20)  NOT NULL DEFAULT 'live',  -- live | simulate

  status              VARCHAR(32)  NOT NULL DEFAULT 'queued',
  -- queued|initializing|planning|awaiting_approval|applying|verifying|succeeded|failed|cancelled|paused

  -- Terraform working directory + state location for this run.
  workspace_path      TEXT,
  terraform_version   VARCHAR(32),

  -- Machine-readable `terraform plan -json` summary.
  plan_summary        JSONB,
  resources_to_add    INTEGER,
  resources_to_change INTEGER,
  resources_to_destroy INTEGER,

  resources_created   INTEGER      NOT NULL DEFAULT 0,
  approvals_required  INTEGER      NOT NULL DEFAULT 0,
  approvals_granted   INTEGER      NOT NULL DEFAULT 0,

  error               TEXT,
  -- Set while a worker holds the run, so two replicas cannot advance it at once.
  lease_owner         VARCHAR(128),
  lease_expires_at    TIMESTAMP,

  started_by_user_id  INTEGER,
  started_at          TIMESTAMP,
  finished_at         TIMESTAMP,
  created_at          TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_infra_runs_org ON infra_runs (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_infra_runs_active ON infra_runs (status) WHERE status NOT IN ('succeeded','failed','cancelled');

-- Per-node progress within a run. This is what makes resume possible: on
-- restart the engine reads these rows, skips what is already applied, and
-- continues from the first node that is not.
CREATE TABLE IF NOT EXISTS infra_run_nodes (
  id                  BIGSERIAL PRIMARY KEY,
  organization_id     INTEGER      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id              BIGINT       NOT NULL REFERENCES infra_runs(id) ON DELETE CASCADE,
  node_key            VARCHAR(128) NOT NULL,

  status              VARCHAR(32)  NOT NULL DEFAULT 'pending',
  -- pending|ready|running|awaiting_approval|applied|failed|skipped|rolled_back

  attempts            INTEGER      NOT NULL DEFAULT 0,
  error               TEXT,
  -- Terraform's reported attributes for the created resource.
  outputs             JSONB,
  started_at          TIMESTAMP,
  finished_at         TIMESTAMP,
  updated_at          TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_infra_run_nodes_key ON infra_run_nodes (run_id, node_key);
CREATE INDEX IF NOT EXISTS idx_infra_run_nodes_status ON infra_run_nodes (run_id, status);

-- ==================== EVENTS ====================

-- Append-only narration of a run. This is simultaneously the audit record, the
-- UI feed and the replay source: a browser that reconnects re-reads the events
-- rather than losing everything that happened while it was away.
CREATE TABLE IF NOT EXISTS infra_events (
  id                  BIGSERIAL PRIMARY KEY,
  organization_id     INTEGER      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id              BIGINT       NOT NULL REFERENCES infra_runs(id) ON DELETE CASCADE,

  -- AGENT_STARTED, REQUIREMENT_ANALYZED, QUESTION_ASKED, ARCHITECTURE_GENERATED,
  -- DOCUMENTATION_RETRIEVED, PLAN_CREATED, PLAN_VALIDATED, APPROVAL_REQUIRED,
  -- APPROVED, REJECTED, RESOURCE_CREATING, RESOURCE_CREATED, RESOURCE_FAILED,
  -- RETRY_STARTED, DEPLOYMENT_COMPLETED, DEPLOYMENT_FAILED, KNOWLEDGE_SAVED
  event_type          VARCHAR(64)  NOT NULL,
  node_key            VARCHAR(128),
  level               VARCHAR(16)  NOT NULL DEFAULT 'info',   -- info|warn|error
  message             TEXT         NOT NULL,
  data                JSONB,
  -- Monotonic per run; the SSE cursor, so a reconnect resumes exactly.
  sequence            INTEGER      NOT NULL,
  created_at          TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_infra_events_seq ON infra_events (run_id, sequence);
CREATE INDEX IF NOT EXISTS idx_infra_events_run ON infra_events (run_id, id);

-- Events describe what happened and must not be rewritten, for the same reason
-- audit_logs must not.
CREATE OR REPLACE FUNCTION infra_events_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'infra_events is append-only (attempted %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_infra_events_append_only ON infra_events;
CREATE TRIGGER trg_infra_events_append_only
  BEFORE UPDATE OR DELETE ON infra_events
  FOR EACH ROW EXECUTE FUNCTION infra_events_append_only();

-- ==================== APPROVAL GATES ====================

-- A held step. Distinct from the agent's optimization approvals: this pauses a
-- running DAG rather than holding one tool call, and the run cannot proceed
-- past the node until it is decided.
CREATE TABLE IF NOT EXISTS infra_approvals (
  id                  BIGSERIAL PRIMARY KEY,
  organization_id     INTEGER      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id              BIGINT       NOT NULL REFERENCES infra_runs(id) ON DELETE CASCADE,
  node_key            VARCHAR(128),

  -- Unguessable, for out-of-band approve/reject links.
  ref                 VARCHAR(64)  NOT NULL UNIQUE,

  summary             TEXT         NOT NULL,
  details             TEXT,
  risk_level          VARCHAR(20)  NOT NULL DEFAULT 'medium',
  risk_reasons        JSONB        NOT NULL DEFAULT '[]'::jsonb,
  -- What will actually run if approved, so the approver sees the real thing.
  proposed_action     JSONB,
  estimated_cost_impact NUMERIC(14, 2),

  status              VARCHAR(20)  NOT NULL DEFAULT 'pending',  -- pending|approved|rejected|expired
  decided_by_user_id  INTEGER,
  decided_by          VARCHAR(255),
  decision_reason     TEXT,
  decided_at          TIMESTAMP,
  expires_at          TIMESTAMP,
  created_at          TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_infra_approvals_run ON infra_approvals (run_id, status);
CREATE INDEX IF NOT EXISTS idx_infra_approvals_pending ON infra_approvals (organization_id, status) WHERE status = 'pending';

-- ==================== KNOWLEDGE: STANDARD STEP LIBRARY ====================

-- Reusable, provenance-bearing implementation knowledge. Deliberately a
-- structured table rather than embedding chunks: a step must be revalidated
-- against current documentation, versioned when a provider changes its
-- recommendation, and scored by how often it actually worked. None of that is
-- expressible as a vector blob.
CREATE TABLE IF NOT EXISTS standard_steps (
  id                  BIGSERIAL PRIMARY KEY,
  -- Steps are platform knowledge, not tenant data: what AWS recommends for a
  -- Multi-AZ database is not one customer's secret. Nullable organization_id
  -- allows a tenant-private step without forcing every step to be private.
  organization_id     INTEGER      REFERENCES organizations(id) ON DELETE CASCADE,

  slug                VARCHAR(160) NOT NULL,
  name                VARCHAR(255) NOT NULL,
  provider            VARCHAR(20)  NOT NULL,
  service             VARCHAR(128) NOT NULL,
  logical_type        VARCHAR(64)  NOT NULL,
  resource_type       VARCHAR(128),
  description         TEXT,

  inputs              JSONB        NOT NULL DEFAULT '{}'::jsonb,
  outputs             JSONB        NOT NULL DEFAULT '{}'::jsonb,
  dependencies        JSONB        NOT NULL DEFAULT '[]'::jsonb,
  -- The Terraform module/HCL fragment this step contributes.
  implementation      TEXT,
  required_permissions JSONB       NOT NULL DEFAULT '[]'::jsonb,
  security_requirements JSONB      NOT NULL DEFAULT '[]'::jsonb,
  approval_level      VARCHAR(20)  NOT NULL DEFAULT 'none',   -- none|low|medium|high|critical

  version             INTEGER      NOT NULL DEFAULT 1,
  -- draft: never used successfully. validated: applied at least once.
  -- stale: documentation moved on and it needs revalidation.
  validation_status   VARCHAR(20)  NOT NULL DEFAULT 'draft',
  usage_count         INTEGER      NOT NULL DEFAULT 0,
  success_count       INTEGER      NOT NULL DEFAULT 0,
  last_validated_at   TIMESTAMP,

  created_at          TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_standard_steps_slug_ver
  ON standard_steps (COALESCE(organization_id, 0), slug, version);
CREATE INDEX IF NOT EXISTS idx_standard_steps_lookup
  ON standard_steps (provider, logical_type, validation_status);

-- Where a step's knowledge came from. Required by the provenance rule: a step
-- with no source cannot be trusted, and one whose source has moved on must be
-- revalidated rather than reused.
CREATE TABLE IF NOT EXISTS doc_sources (
  id                  BIGSERIAL PRIMARY KEY,
  standard_step_id    BIGINT       REFERENCES standard_steps(id) ON DELETE CASCADE,
  provider            VARCHAR(20)  NOT NULL,
  service             VARCHAR(128),
  title               VARCHAR(500),
  url                 TEXT         NOT NULL,
  doc_version         VARCHAR(64),
  excerpt             TEXT,
  retrieved_at        TIMESTAMP    NOT NULL DEFAULT NOW(),
  -- Which run consumed it, so a deployment can show exactly what it read.
  run_id              BIGINT,
  created_at          TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_doc_sources_step ON doc_sources (standard_step_id);
CREATE INDEX IF NOT EXISTS idx_doc_sources_lookup ON doc_sources (provider, service);

-- ==================== DEPLOYMENTS ====================

-- The completed result: what exists in the cloud, what it cost, and how to
-- reproduce it. Retained after a plan is superseded, so history survives.
CREATE TABLE IF NOT EXISTS infra_deployments (
  id                  BIGSERIAL PRIMARY KEY,
  organization_id     INTEGER      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id             BIGINT       REFERENCES infra_plans(id) ON DELETE SET NULL,
  run_id              BIGINT       REFERENCES infra_runs(id) ON DELETE SET NULL,

  name                VARCHAR(255) NOT NULL,
  provider            VARCHAR(20)  NOT NULL,
  account_id          VARCHAR(255),
  region              VARCHAR(64),
  environment         VARCHAR(32),

  execution_mode      VARCHAR(20)  NOT NULL DEFAULT 'live',
  resources           JSONB        NOT NULL DEFAULT '[]'::jsonb,
  resource_count      INTEGER      NOT NULL DEFAULT 0,
  estimated_monthly_cost NUMERIC(14, 2),
  -- Terraform state is the source of truth for what exists; stored by
  -- reference, never inline, because it contains resource secrets.
  state_ref           TEXT,
  duration_seconds    INTEGER,

  status              VARCHAR(32)  NOT NULL DEFAULT 'active',   -- active|destroyed|drifted|failed
  created_at          TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_infra_deployments_org ON infra_deployments (organization_id, created_at DESC);

COMMIT;
