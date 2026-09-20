-- Governance & compliance.
--
-- The product could already tell you what you spent and could already stop the
-- agent from doing something reckless. It could not tell you whether the estate
-- conformed to any rule an organization had actually agreed on — no required
-- tags, no residency boundary, no commitment floor, no privilege ceiling — and
-- it had no way to hand an auditor evidence against a named control.
--
-- Four tables, all tenant-scoped:
--
--   governance_policy_assignments  per-tenant configuration of a catalog policy
--   governance_runs                one evaluation sweep, with its score
--   governance_violations          findings, keyed by fingerprint, not by run
--   governance_exemptions          justified, time-boxed, expiring suppressions
--
-- Policy *definitions* stay in code (server/governance/catalog.ts). Storing
-- them would mean either a rules DSL nobody can debug or executable content in
-- the database; neither is a good trade for configurability that assignments
-- already provide.

-- ── Assignments ──────────────────────────────────────────────────────────────
--
-- A row exists only once a tenant has changed something. No row means the
-- catalog defaults apply, so a new organization has a working baseline on day
-- one and this table never grows to policies x tenants.

CREATE TABLE IF NOT EXISTS governance_policy_assignments (
  id              SERIAL PRIMARY KEY,
  organization_id INTEGER      NOT NULL DEFAULT 1 REFERENCES organizations(id) ON DELETE CASCADE,
  policy_key      VARCHAR(100) NOT NULL,
  enabled         BOOLEAN      NOT NULL DEFAULT TRUE,
  -- NULL = inherit the catalog severity. An explicit value is a deliberate
  -- decision by the tenant that this control matters more, or less, to them.
  severity        VARCHAR(20),
  -- 'audit' | 'warn' | 'block'. 'block' is read by the agent guardrails.
  enforcement     VARCHAR(20)  NOT NULL DEFAULT 'audit',
  parameters      JSONB        NOT NULL DEFAULT '{}'::jsonb,
  scope           JSONB        NOT NULL DEFAULT '{}'::jsonb,
  updated_by      INTEGER,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- One assignment per policy per tenant. The upsert in the API depends on this.
CREATE UNIQUE INDEX IF NOT EXISTS governance_assignments_org_policy_idx
  ON governance_policy_assignments (organization_id, policy_key);

-- ── Runs ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS governance_runs (
  id                 BIGSERIAL PRIMARY KEY,
  organization_id    INTEGER     NOT NULL DEFAULT 1 REFERENCES organizations(id) ON DELETE CASCADE,
  trigger            VARCHAR(20) NOT NULL DEFAULT 'scheduled',
  status             VARCHAR(20) NOT NULL DEFAULT 'running',
  policies_evaluated INTEGER     NOT NULL DEFAULT 0,
  -- Policies whose own evaluation threw. Distinct from policies that found
  -- violations: an engine error must never read as a clean result.
  policies_failed    INTEGER     NOT NULL DEFAULT 0,
  violations_opened  INTEGER     NOT NULL DEFAULT 0,
  violations_resolved INTEGER    NOT NULL DEFAULT 0,
  open_violations    INTEGER     NOT NULL DEFAULT 0,
  score              NUMERIC(5,2),
  domain_scores      JSONB,
  -- Policies that reached no verdict this run: no ingested data, an
  -- unconfigured allow-list, an evaluation error. Stored rather than recomputed
  -- because the dashboard must be able to say "these questions went unanswered"
  -- without re-running the sweep. Reporting them as compliant is the specific
  -- lie that makes a posture score worthless.
  not_assessed       JSONB,
  cost_at_risk       NUMERIC(20,2),
  error              TEXT,
  started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS governance_runs_org_started_idx
  ON governance_runs (organization_id, started_at DESC);

-- ── Violations ───────────────────────────────────────────────────────────────
--
-- Keyed by fingerprint so a re-run updates a finding instead of duplicating it.
-- first_seen_at therefore survives every sweep, which is what makes an ageing
-- report and a remediation SLA possible.

CREATE TABLE IF NOT EXISTS governance_violations (
  id                  BIGSERIAL PRIMARY KEY,
  organization_id     INTEGER      NOT NULL DEFAULT 1 REFERENCES organizations(id) ON DELETE CASCADE,
  policy_key          VARCHAR(100) NOT NULL,
  fingerprint         VARCHAR(64)  NOT NULL,
  severity            VARCHAR(20)  NOT NULL,
  status              VARCHAR(20)  NOT NULL DEFAULT 'open',

  provider            VARCHAR(20),
  account_id          VARCHAR(255),
  region              VARCHAR(100),
  resource_id         VARCHAR(500),
  resource_type       VARCHAR(100),
  resource_name       VARCHAR(255),

  title               VARCHAR(500) NOT NULL,
  detail              TEXT         NOT NULL,
  evidence            JSONB,
  monthly_cost_impact NUMERIC(20,2),

  first_seen_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_seen_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  resolved_at         TIMESTAMPTZ,
  last_run_id         INTEGER,
  acknowledged_by     INTEGER,
  acknowledged_at     TIMESTAMPTZ,
  acknowledge_note    TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS governance_violations_org_fingerprint_idx
  ON governance_violations (organization_id, fingerprint);

-- The dashboard's default view: open findings for this tenant, worst first.
CREATE INDEX IF NOT EXISTS governance_violations_org_status_idx
  ON governance_violations (organization_id, status, severity);

CREATE INDEX IF NOT EXISTS governance_violations_org_policy_idx
  ON governance_violations (organization_id, policy_key, status);

-- ── Exemptions ───────────────────────────────────────────────────────────────
--
-- reason and expires_at are NOT NULL on purpose. An exemption without a stated
-- reason is undocumented risk acceptance, and one without an expiry is a policy
-- change that nobody signed off on.

CREATE TABLE IF NOT EXISTS governance_exemptions (
  id              SERIAL PRIMARY KEY,
  organization_id INTEGER      NOT NULL DEFAULT 1 REFERENCES organizations(id) ON DELETE CASCADE,
  policy_key      VARCHAR(100) NOT NULL,
  resource_id     VARCHAR(500),
  scope           JSONB        NOT NULL DEFAULT '{}'::jsonb,
  reason          TEXT         NOT NULL,
  requested_by    INTEGER,
  approved_by     INTEGER,
  expires_at      TIMESTAMPTZ  NOT NULL,
  revoked_at      TIMESTAMPTZ,
  revoked_by      INTEGER,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS governance_exemptions_org_policy_idx
  ON governance_exemptions (organization_id, policy_key);

-- A blank reason satisfies NOT NULL but documents nothing.
ALTER TABLE governance_exemptions
  DROP CONSTRAINT IF EXISTS governance_exemptions_reason_not_blank;
ALTER TABLE governance_exemptions
  ADD CONSTRAINT governance_exemptions_reason_not_blank
  CHECK (LENGTH(TRIM(reason)) >= 10);
