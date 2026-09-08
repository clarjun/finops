-- Migration: Multi-tenancy foundation
--
-- Introduces `organizations` as the tenant boundary and stamps every
-- tenant-scoped table with `organization_id`. Existing rows are backfilled into
-- a single "Default Organization" (id = 1) so this migration is non-breaking for
-- the current single-tenant deployment.
--
-- Design notes:
--   * organization_id is NOT NULL with DEFAULT 1. The default keeps legacy code
--     paths that forget to stamp a row from failing hard; the application layer
--     (server/tenant-context.ts) is the real enforcement point and always sets
--     it explicitly. Drop the default once every writer is migrated.
--   * `users.username` stays globally unique so login needs no org selector.
--     A user's home tenant is derived from their row.
--   * report_cache's UNIQUE(cache_key) becomes UNIQUE(organization_id, cache_key)
--     or tenants would evict each other's cached reports.

BEGIN;

-- ==================== ORGANIZATIONS ====================

CREATE TABLE IF NOT EXISTS organizations (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(255) NOT NULL,
  slug         VARCHAR(100) NOT NULL UNIQUE,
  plan         VARCHAR(50)  NOT NULL DEFAULT 'standard',
  status       VARCHAR(20)  NOT NULL DEFAULT 'active',   -- active | suspended
  settings     JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMP    NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE organizations IS 'Tenant boundary. Every tenant-scoped row references exactly one organization.';

-- The default tenant that inherits all pre-existing data.
INSERT INTO organizations (id, name, slug, plan)
VALUES (1, 'Default Organization', 'default', 'enterprise')
ON CONFLICT (id) DO NOTHING;

-- Keep the sequence ahead of the explicitly-inserted id.
SELECT setval('organizations_id_seq', GREATEST((SELECT MAX(id) FROM organizations), 1));

-- ==================== TENANT STAMPING ====================

DO $$
DECLARE
  t TEXT;
  tenant_tables TEXT[] := ARRAY[
    'cost_history',
    'cloud_accounts',
    'azure_accounts',
    'budgets',
    'alert_rules',
    'report_schedules',
    'resource_inventory',
    'tag_analysis',
    'forecast_data',
    'optimization_recommendations',
    'savings_plans',
    'anomaly_events',
    'optimization_actions',
    'optimization_plans',
    'action_feedback',
    'agent_config',
    'report_cache',
    'users'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    -- Skip tables that do not exist in this deployment.
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                   WHERE table_schema = 'public' AND table_name = t) THEN
      RAISE NOTICE 'Skipping % (table not present)', t;
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS organization_id INTEGER NOT NULL DEFAULT 1', t);

    -- Any row predating this migration belongs to the default org.
    EXECUTE format('UPDATE %I SET organization_id = 1 WHERE organization_id IS NULL', t);

    -- Foreign key (added separately so re-runs do not error on duplicates).
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_schema = 'public'
        AND table_name = t
        AND constraint_name = t || '_organization_id_fkey'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE',
        t, t || '_organization_id_fkey');
    END IF;

    -- Every tenant-scoped read filters on organization_id, so index it.
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (organization_id)',
                   'idx_' || t || '_org', t);
  END LOOP;
END $$;

-- ==================== PER-TENANT UNIQUENESS FIXES ====================

-- report_cache: cache keys are only unique within a tenant.
ALTER TABLE report_cache DROP CONSTRAINT IF EXISTS report_cache_cache_key_key;
DROP INDEX IF EXISTS idx_report_cache_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_report_cache_org_key
  ON report_cache (organization_id, cache_key);

-- Hot composite indexes for the highest-volume tenant-scoped reads.
CREATE INDEX IF NOT EXISTS idx_cost_history_org_date
  ON cost_history (organization_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_cost_history_org_provider_account
  ON cost_history (organization_id, provider, account_id);
CREATE INDEX IF NOT EXISTS idx_cloud_accounts_org_provider_active
  ON cloud_accounts (organization_id, provider, is_active);
CREATE INDEX IF NOT EXISTS idx_resource_inventory_org_provider_state
  ON resource_inventory (organization_id, provider, state);
CREATE INDEX IF NOT EXISTS idx_optimization_actions_org_status
  ON optimization_actions (organization_id, status);

-- agent_config is one row per tenant, not one row globally.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_config_org
  ON agent_config (organization_id);

-- ==================== USER MODEL ====================

ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_admin BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP;

COMMENT ON COLUMN users.is_platform_admin IS
  'Cross-tenant support access. Platform admins may switch active organization; every switch is audit-logged.';

-- Role vocabulary widens from (admin|user) to
-- (owner|admin|finops|engineer|viewer).
--
-- Legacy mapping is behaviour-preserving rather than least-privilege:
-- a legacy 'user' could reach every screen except user management, which is
-- closest to 'finops'. Review and downgrade to 'viewer'/'engineer' per person
-- after this deploys.
UPDATE users SET role = 'owner'  WHERE role = 'admin';
UPDATE users SET role = 'finops' WHERE role = 'user';

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('owner', 'admin', 'finops', 'engineer', 'viewer'));

-- The seeded bootstrap admin owns the default org.
UPDATE users SET is_platform_admin = true
  WHERE username = 'admin' AND organization_id = 1;

-- ==================== AUDIT LOG ====================

CREATE TABLE IF NOT EXISTS audit_logs (
  id               BIGSERIAL PRIMARY KEY,
  organization_id  INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id    INTEGER,
  actor_username   VARCHAR(100),
  actor_ip         VARCHAR(64),
  action           VARCHAR(100) NOT NULL,   -- 'cloud_account.create', 'agent.action.execute', ...
  resource_type    VARCHAR(100),
  resource_id      VARCHAR(255),
  method           VARCHAR(10),
  path             VARCHAR(500),
  status_code      INTEGER,
  outcome          VARCHAR(20)  NOT NULL DEFAULT 'success',  -- success | failure | denied
  metadata         JSONB,
  created_at       TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_org_created
  ON audit_logs (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_org_action
  ON audit_logs (organization_id, action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor
  ON audit_logs (actor_user_id);

-- Audit rows are append-only. Enforced in the database so an application bug
-- (or a compromised app credential) cannot quietly rewrite history.
CREATE OR REPLACE FUNCTION audit_logs_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only (attempted %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_logs_append_only ON audit_logs;
CREATE TRIGGER trg_audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();

COMMIT;
