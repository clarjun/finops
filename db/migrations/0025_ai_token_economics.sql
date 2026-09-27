-- AI token economics: usage ingested from provider APIs, priced by us.
--
-- ── Why this exists alongside cost_facts ────────────────────────────────────
--
-- The previous approach derived AI economics from cloud billing rows. It cannot
-- work, and the data proves it:
--
--   AWS Bedrock billing gives the model name and the dollar amount, but
--   pricing_unit is "N/A" and the quantity is a fractional number in an
--   undocumented unit. No token count, no call count.
--
--   OpenAI and Anthropic direct API spend never touches a cloud bill at all.
--
-- The information does exist — just not in billing. It is in CloudWatch
-- (AWS/Bedrock: Invocations, InputTokenCount, OutputTokenCount by ModelId), the
-- OpenAI organization usage API (input_tokens, output_tokens,
-- num_model_requests), the Anthropic usage report, and Azure Monitor
-- (ProcessedPromptTokens, GeneratedTokens). So we ingest USAGE from those and
-- apply pricing ourselves.
--
-- That inverts the trust model and it has to be said plainly: cost_facts is
-- what the provider charged, and is authoritative. This is what we calculate
-- from metered usage, and it will differ — by free tiers, committed-use
-- discounts, private pricing and rounding. Both numbers are useful; presenting
-- either as the other is not.

-- ── Providers ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_providers (
  -- Stable string key, not a serial: it appears in adapter code and API
  -- filters, and an integer id would make those unreadable and fragile.
  key           VARCHAR(40) PRIMARY KEY,
  display_name  VARCHAR(120) NOT NULL,
  -- 'cloud'  — billed through a cloud account we already connect to
  -- 'direct' — billed by the vendor, needs its own credential
  billing_mode  VARCHAR(20) NOT NULL,
  -- How usage is collected, for the UI to explain what a customer must set up.
  usage_source  VARCHAR(120) NOT NULL,
  docs_url      TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO ai_providers (key, display_name, billing_mode, usage_source, docs_url) VALUES
  ('bedrock',      'AWS Bedrock',      'cloud',  'CloudWatch AWS/Bedrock metrics (Invocations, InputTokenCount, OutputTokenCount by ModelId)', 'https://docs.aws.amazon.com/bedrock/latest/userguide/monitoring-runtime-metrics.html'),
  ('azure_openai', 'Azure OpenAI',     'cloud',  'Azure Monitor metrics (ProcessedPromptTokens, GeneratedTokens, TokenTransaction)',          'https://learn.microsoft.com/en-us/azure/foundry/openai/monitor-openai-reference'),
  ('vertex',       'Google Vertex AI', 'cloud',  'Cloud Monitoring token metrics, and billing export token counts',                            'https://cloud.google.com/vertex-ai/docs/general/monitoring'),
  ('openai',       'OpenAI',           'direct', 'Organization usage API /v1/organization/usage/completions (admin key)',                       'https://platform.openai.com/docs/api-reference/usage/completions'),
  ('anthropic',    'Anthropic',        'direct', 'Admin usage report /v1/organizations/usage_report/messages (admin key)',                      'https://platform.claude.com/docs/en/manage-claude/usage-cost-api')
ON CONFLICT (key) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      billing_mode = EXCLUDED.billing_mode,
      usage_source = EXCLUDED.usage_source,
      docs_url     = EXCLUDED.docs_url;

-- ── Model catalog ────────────────────────────────────────────────────────────
--
-- Global (organization_id NULL) plus per-tenant rows, because a customer using
-- a fine-tuned or provisioned model needs it to appear without waiting for us
-- to ship a catalog update.

CREATE TABLE IF NOT EXISTS ai_models (
  id              SERIAL PRIMARY KEY,
  organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  provider_key    VARCHAR(40)  NOT NULL REFERENCES ai_providers(key),
  -- The provider's own identifier, exactly as it appears in usage data:
  -- "anthropic.claude-sonnet-4-5-20250929-v1:0", "gpt-4o-mini", "gemini-2.5-flash".
  model_id        VARCHAR(200) NOT NULL,
  display_name    VARCHAR(200) NOT NULL,
  -- Coarse grouping for trends: "Claude Sonnet", "GPT-4o", "Gemini Flash".
  family          VARCHAR(120),
  modality        VARCHAR(30)  NOT NULL DEFAULT 'text',
  is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Two partial indexes rather than one: NULL organization_id is the global
-- catalog, and a UNIQUE over a nullable column would let duplicate global rows
-- through, because NULL never equals NULL.
CREATE UNIQUE INDEX IF NOT EXISTS ai_models_global_idx
  ON ai_models (provider_key, model_id) WHERE organization_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ai_models_tenant_idx
  ON ai_models (organization_id, provider_key, model_id) WHERE organization_id IS NOT NULL;

-- ── Pricing, effective-dated ─────────────────────────────────────────────────
--
-- Effective dates are the whole point. Model prices change, and a flat price
-- column would silently rewrite every historical figure the moment one did —
-- last quarter's cost per call would change after the fact, which makes the
-- data useless for exactly the trend analysis it exists to support.
--
-- organization_id NULL is our published catalog. A tenant row overrides it, so
-- a customer with an EDP, committed-use discount or private pricing agreement
-- gets their real rate rather than list.

CREATE TABLE IF NOT EXISTS ai_model_pricing (
  id                    SERIAL PRIMARY KEY,
  organization_id       INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  provider_key          VARCHAR(40)  NOT NULL REFERENCES ai_providers(key),
  model_id              VARCHAR(200) NOT NULL,

  -- Per MILLION tokens, which is how every vendor publishes. Storing per-token
  -- would need more decimal places than NUMERIC gives comfortably and would
  -- make every stored value unreadable against the published price list.
  input_per_million     NUMERIC(14,6) NOT NULL,
  output_per_million    NUMERIC(14,6) NOT NULL,
  -- Cache reads are typically ~10% of input; cache writes ~125%. Nullable
  -- because not every model or provider prices them separately.
  cache_read_per_million  NUMERIC(14,6),
  cache_write_per_million NUMERIC(14,6),
  -- Some providers bill per request on top of tokens.
  per_call_cost         NUMERIC(14,8),

  currency              VARCHAR(10)  NOT NULL DEFAULT 'USD',

  effective_from        DATE         NOT NULL,
  -- NULL means "still current". Closing a row is how a price change is
  -- recorded without destroying what the old figures were computed from.
  effective_to          DATE,

  -- Where this rate came from: 'catalog' (shipped by us), 'customer' (entered
  -- by the tenant), 'contract' (negotiated). Shown in the UI, because a figure
  -- computed from list price and one computed from a negotiated rate are
  -- different claims.
  source                VARCHAR(20)  NOT NULL DEFAULT 'catalog',
  source_url            TEXT,
  notes                 TEXT,
  created_by            INTEGER,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_model_pricing_lookup_idx
  ON ai_model_pricing (provider_key, model_id, effective_from DESC);
CREATE INDEX IF NOT EXISTS ai_model_pricing_org_idx
  ON ai_model_pricing (organization_id, provider_key, model_id, effective_from DESC);

-- A price cannot end before it starts.
ALTER TABLE ai_model_pricing DROP CONSTRAINT IF EXISTS ai_model_pricing_dates_ordered;
ALTER TABLE ai_model_pricing ADD CONSTRAINT ai_model_pricing_dates_ordered
  CHECK (effective_to IS NULL OR effective_to >= effective_from);

-- Negative rates would produce negative spend, which would be rendered as a
-- saving.
ALTER TABLE ai_model_pricing DROP CONSTRAINT IF EXISTS ai_model_pricing_non_negative;
ALTER TABLE ai_model_pricing ADD CONSTRAINT ai_model_pricing_non_negative
  CHECK (input_per_million >= 0 AND output_per_million >= 0);

-- ── Usage records ────────────────────────────────────────────────────────────
--
-- One row per (provider, model, period, attribution). Aggregated to an interval
-- rather than one row per inference: a busy tenant makes millions of calls a
-- day, and per-call rows would be a hundred times the volume of the entire cost
-- fact store for no analytical gain. Every source above already returns
-- time-bucketed aggregates anyway.

CREATE TABLE IF NOT EXISTS ai_usage_records (
  id               BIGSERIAL PRIMARY KEY,
  organization_id  INTEGER      NOT NULL DEFAULT 1 REFERENCES organizations(id) ON DELETE CASCADE,
  provider_key     VARCHAR(40)  NOT NULL REFERENCES ai_providers(key),
  model_id         VARCHAR(200) NOT NULL,

  period_start     TIMESTAMPTZ  NOT NULL,
  period_end       TIMESTAMPTZ  NOT NULL,

  input_tokens     BIGINT       NOT NULL DEFAULT 0,
  output_tokens    BIGINT       NOT NULL DEFAULT 0,
  -- Kept apart from input_tokens: cache reads are priced at a fraction of the
  -- input rate, so folding them together would overstate cost materially for
  -- any workload using prompt caching.
  cache_read_tokens  BIGINT     NOT NULL DEFAULT 0,
  cache_write_tokens BIGINT     NOT NULL DEFAULT 0,
  inference_calls  BIGINT       NOT NULL DEFAULT 0,

  -- Attribution. Nullable because not every source can supply them — the UI
  -- must show "unattributed" rather than inventing a value.
  account_id       VARCHAR(255),   -- AWS account / Azure subscription / GCP project
  region           VARCHAR(64),
  application      VARCHAR(160),   -- from a tag, an OpenAI project, or an Anthropic workspace
  environment      VARCHAR(60),

  -- Where this came from, and enough to re-fetch it.
  source           VARCHAR(40)  NOT NULL,
  source_ref       VARCHAR(255),
  ingested_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Re-ingesting a window must correct rows, not duplicate them. Every adapter
-- re-reads recent periods because providers restate: CloudWatch backfills and
-- usage APIs settle.
CREATE UNIQUE INDEX IF NOT EXISTS ai_usage_records_identity_idx
  ON ai_usage_records (
    organization_id, provider_key, model_id, period_start,
    COALESCE(account_id, ''), COALESCE(application, ''), COALESCE(environment, '')
  );

CREATE INDEX IF NOT EXISTS ai_usage_records_org_period_idx
  ON ai_usage_records (organization_id, period_start DESC);
CREATE INDEX IF NOT EXISTS ai_usage_records_org_provider_model_idx
  ON ai_usage_records (organization_id, provider_key, model_id, period_start DESC);

-- ── Spend records ────────────────────────────────────────────────────────────
--
-- Priced usage, stored rather than computed on read, and carrying the id of the
-- pricing row used. That pin is the point: without it, correcting a price
-- retroactively changes what last quarter cost, and nobody can explain why a
-- number moved.

CREATE TABLE IF NOT EXISTS ai_spend_records (
  id                BIGSERIAL PRIMARY KEY,
  organization_id   INTEGER      NOT NULL DEFAULT 1 REFERENCES organizations(id) ON DELETE CASCADE,
  usage_record_id   BIGINT       NOT NULL REFERENCES ai_usage_records(id) ON DELETE CASCADE,

  provider_key      VARCHAR(40)  NOT NULL,
  model_id          VARCHAR(200) NOT NULL,
  period_start      TIMESTAMPTZ  NOT NULL,

  input_cost        NUMERIC(20,10) NOT NULL DEFAULT 0,
  output_cost       NUMERIC(20,10) NOT NULL DEFAULT 0,
  cache_cost        NUMERIC(20,10) NOT NULL DEFAULT 0,
  call_cost         NUMERIC(20,10) NOT NULL DEFAULT 0,
  total_cost        NUMERIC(20,10) NOT NULL DEFAULT 0,
  currency          VARCHAR(10)  NOT NULL DEFAULT 'USD',

  -- Which price produced this. NULL means no pricing row covered the period,
  -- and the record is retained as unpriced rather than silently costed at zero.
  pricing_id        INTEGER REFERENCES ai_model_pricing(id) ON DELETE SET NULL,
  pricing_source    VARCHAR(20),
  unpriced_reason   TEXT,

  computed_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- One spend row per usage row. Re-pricing updates in place.
CREATE UNIQUE INDEX IF NOT EXISTS ai_spend_records_usage_idx
  ON ai_spend_records (usage_record_id);

CREATE INDEX IF NOT EXISTS ai_spend_records_org_period_idx
  ON ai_spend_records (organization_id, period_start DESC);
