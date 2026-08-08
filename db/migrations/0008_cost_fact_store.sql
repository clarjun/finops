-- Migration: normalized cost fact store + ingestion tracking
--
-- Today every dashboard load calls AWS Cost Explorer / Azure Cost Management /
-- GCP BigQuery live. That is slow, billed per request (Cost Explorer charges
-- $0.01 per API call), rate-limit fragile, and it makes historical analysis
-- impossible because nothing is retained. It also means two users looking at the
-- same page can see different numbers.
--
-- cost_facts is the canonical store: providers are ingested on a schedule,
-- normalized once, and every read path queries this table instead.
--
-- Column names follow the FinOps Open Cost & Usage Specification (FOCUS 1.x) so
-- that the internal model is a published standard rather than an ad-hoc mapping
-- that each new connector has to reinvent. The important distinctions FOCUS
-- draws, which the current `cost_history` table cannot express at all:
--
--   billed_cost     what the invoice says for this period
--   effective_cost  after amortizing commitments and applying credits
--   list_cost       before any discount
--
-- Reporting "cost" without saying which of the three you mean is the usual
-- reason a FinOps tool's numbers do not reconcile with finance's.
--
-- cost_history is left in place and untouched; it is migrated off separately.

BEGIN;

-- ==================== INGESTION RUNS ====================

CREATE TABLE IF NOT EXISTS ingestion_runs (
  id                BIGSERIAL PRIMARY KEY,
  organization_id   INTEGER      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider          VARCHAR(20)  NOT NULL,
  cloud_account_id  INTEGER,                       -- cloud_accounts.id, null for legacy/manual runs
  period_start      DATE         NOT NULL,
  period_end        DATE         NOT NULL,
  status            VARCHAR(20)  NOT NULL DEFAULT 'running', -- running|success|failed|partial
  trigger           VARCHAR(20)  NOT NULL DEFAULT 'scheduled', -- scheduled|manual|backfill
  records_ingested  INTEGER      NOT NULL DEFAULT 0,
  records_updated   INTEGER      NOT NULL DEFAULT 0,
  api_calls         INTEGER      NOT NULL DEFAULT 0,
  error             TEXT,
  started_at        TIMESTAMP    NOT NULL DEFAULT NOW(),
  finished_at       TIMESTAMP,
  created_at        TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ingestion_runs_org_provider
  ON ingestion_runs (organization_id, provider, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ingestion_runs_status
  ON ingestion_runs (organization_id, status);

COMMENT ON TABLE ingestion_runs IS
  'One row per connector execution. Provides the ingestion watermark, an audit of API spend, and the record needed to re-run a failed window.';

-- ==================== COST FACTS ====================

CREATE TABLE IF NOT EXISTS cost_facts (
  id                     BIGSERIAL PRIMARY KEY,
  organization_id        INTEGER      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider               VARCHAR(20)  NOT NULL,   -- aws | azure | gcp

  -- Account hierarchy. FOCUS separates the billing account (what gets invoiced)
  -- from the sub-account (AWS linked account, Azure subscription, GCP project).
  billing_account_id     VARCHAR(255),
  billing_account_name   VARCHAR(255),
  sub_account_id         VARCHAR(255) NOT NULL,
  sub_account_name       VARCHAR(255),

  -- Time. Daily grain today; the columns are periods so hourly can land later
  -- without a schema change.
  charge_period_start    TIMESTAMP    NOT NULL,
  charge_period_end      TIMESTAMP    NOT NULL,
  billing_period_start   TIMESTAMP,

  -- What was charged
  service_name           VARCHAR(255) NOT NULL,
  service_category       VARCHAR(100),            -- Compute | Storage | Databases | Networking | AI and Machine Learning | ...
  charge_category        VARCHAR(50)  NOT NULL DEFAULT 'Usage', -- Usage|Purchase|Tax|Credit|Refund|Adjustment
  charge_description     TEXT,
  resource_id            VARCHAR(500),
  resource_name          VARCHAR(255),
  region_id              VARCHAR(100),

  -- Money. Kept at high precision: rounding per row and summing millions of
  -- rows is how a report ends up cents-off from the invoice.
  billed_cost            NUMERIC(20, 10) NOT NULL DEFAULT 0,
  effective_cost         NUMERIC(20, 10),
  list_cost              NUMERIC(20, 10),
  billing_currency       VARCHAR(10)  NOT NULL DEFAULT 'USD',

  -- Usage
  pricing_quantity       NUMERIC(24, 8),
  pricing_unit           VARCHAR(100),

  -- Allocation and commitments
  tags                   JSONB,
  commitment_discount_id VARCHAR(255),

  -- Lineage
  ingestion_run_id       BIGINT,
  -- SHA-256 of the natural key. Cloud providers restate past days, so ingestion
  -- must be idempotent: re-fetching a window updates rows in place instead of
  -- doubling the reported spend.
  source_hash            VARCHAR(64)  NOT NULL,

  created_at             TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMP    NOT NULL DEFAULT NOW()
);

-- The idempotency key. Scoped per tenant so hashes cannot collide across orgs.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cost_facts_org_source
  ON cost_facts (organization_id, source_hash);

-- Read paths: nearly every query is "this tenant, this date range", then
-- narrowed by provider/service/account.
CREATE INDEX IF NOT EXISTS idx_cost_facts_org_period
  ON cost_facts (organization_id, charge_period_start DESC);
CREATE INDEX IF NOT EXISTS idx_cost_facts_org_provider_period
  ON cost_facts (organization_id, provider, charge_period_start DESC);
CREATE INDEX IF NOT EXISTS idx_cost_facts_org_service
  ON cost_facts (organization_id, service_name, charge_period_start DESC);
CREATE INDEX IF NOT EXISTS idx_cost_facts_org_subaccount
  ON cost_facts (organization_id, sub_account_id, charge_period_start DESC);
CREATE INDEX IF NOT EXISTS idx_cost_facts_resource
  ON cost_facts (organization_id, resource_id)
  WHERE resource_id IS NOT NULL;
-- Tag-based allocation queries (cost centre, team, environment).
CREATE INDEX IF NOT EXISTS idx_cost_facts_tags
  ON cost_facts USING GIN (tags);

COMMENT ON COLUMN cost_facts.billed_cost IS 'What the provider invoices for this charge in the billing period.';
COMMENT ON COLUMN cost_facts.effective_cost IS 'Amortized commitment spend plus applied credits. The number to use for showback/chargeback.';
COMMENT ON COLUMN cost_facts.list_cost IS 'Cost at public on-demand rates, before any negotiated or commitment discount.';
COMMENT ON COLUMN cost_facts.source_hash IS 'SHA-256 of the natural key; makes re-ingesting a restated period idempotent.';

COMMIT;
