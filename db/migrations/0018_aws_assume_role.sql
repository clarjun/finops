-- Cross-account IAM role authentication for AWS.
--
-- Replaces long-lived access key + secret storage with an STS AssumeRole flow:
-- Cloudwise holds a role ARN and an External ID, and mints temporary
-- credentials per operation. A breach of this table no longer yields usable
-- cloud access, because the External ID is worthless without control of the
-- Cloudwise AWS principal named in the customer's trust policy.
--
-- Deliberately ADDITIVE. `credentials` and the existing access-key flow keep
-- working, gated by auth_type, so every currently-connected account continues
-- to function while customers migrate. Dropping the column is a later,
-- separate migration once auth_type = 'access_keys' returns no rows.

ALTER TABLE cloud_accounts
  -- 'access_keys' (legacy, deprecated) | 'assume_role' (AWS) | 'workload_identity' (reserved for Azure/GCP phase 2)
  ADD COLUMN IF NOT EXISTS auth_type VARCHAR(32) NOT NULL DEFAULT 'access_keys',

  -- The role Cloudwise assumes for normal FinOps reads. Not a secret.
  ADD COLUMN IF NOT EXISTS role_arn VARCHAR(2048),

  -- Separate role for approved remediation (stop/start/resize/lifecycle) and a
  -- third for Terraform deployment. Nullable: a read-only connection is a valid
  -- and expected configuration, and most customers should start there.
  ADD COLUMN IF NOT EXISTS remediation_role_arn VARCHAR(2048),
  ADD COLUMN IF NOT EXISTS deploy_role_arn VARCHAR(2048),

  -- Encrypted like `credentials`, via server/encryption.ts. Stored rather than
  -- derived because it must stay stable: it is written into the customer's
  -- trust policy, and regenerating it would silently break the connection.
  ADD COLUMN IF NOT EXISTS external_id TEXT,

  -- When the connection was last proved to work end to end (AssumeRole +
  -- GetCallerIdentity). Distinct from last_sync_at, which only says data moved.
  ADD COLUMN IF NOT EXISTS last_validated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_validation_error TEXT;

-- Only one connection per (org, provider, account) may be active. Two rows for
-- the same AWS account would double-count spend in the fact store, which is the
-- failure mode that is hardest to notice.
CREATE UNIQUE INDEX IF NOT EXISTS cloud_accounts_org_provider_account_active_idx
  ON cloud_accounts (organization_id, provider, account_id)
  WHERE is_active;

-- The validation and credential-resolution paths look up by org + provider on
-- every AWS call, so this is a hot path.
CREATE INDEX IF NOT EXISTS cloud_accounts_org_provider_idx
  ON cloud_accounts (organization_id, provider)
  WHERE is_active;

COMMENT ON COLUMN cloud_accounts.auth_type IS
  'access_keys = legacy long-lived credentials (deprecated); assume_role = AWS STS cross-account role';
COMMENT ON COLUMN cloud_accounts.external_id IS
  'Encrypted. Confused-deputy protection for sts:AssumeRole; must match the customer trust policy.';
