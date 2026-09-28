-- GitOps delivery for the infrastructure agent.
--
-- Two problems, one migration, because they are the same problem seen from
-- either end.
--
-- 1. STATE. The generated Terraform declared no backend, so Terraform kept its
--    state in tmpdir()/cloudwise-infra/run-<id>/ inside the container. That
--    directory is ephemeral on Azure Container Apps and the app runs with
--    --max-replicas 3, so a restart, redeploy or scale-in destroys the state.
--    Teardown then finds nothing to destroy and reports success while the
--    infrastructure keeps running and billing. infra_state_backends records
--    where state should live instead: in the customer's own cloud storage.
--
-- 2. DELIVERY. The agent applied straight to the cloud. The only review surface
--    was an approval card describing a stage ("create database - risk: high"),
--    which cannot tell a reviewer that the storage is unencrypted. A pull
--    request can, because it shows the diff. infra_git_connections says where
--    to raise it and infra_pull_requests records what was raised.
--
-- These are related because the customer's CI pipeline runs the apply in the
-- GitOps flow, and a pipeline on GitHub's runners cannot reach a temp folder on
-- our container. Remote state is not an improvement to the PR flow; it is a
-- precondition for it.

-- ── Where Terraform state lives, per tenant ──────────────────────────────────
--
-- One row per (organization, provider). A tenant deploying to both AWS and
-- Azure needs a backend in each, because Terraform state for AWS resources
-- belongs in the AWS account the customer controls.

CREATE TABLE IF NOT EXISTS infra_state_backends (
  id               SERIAL PRIMARY KEY,
  organization_id  INTEGER     NOT NULL DEFAULT 1 REFERENCES organizations(id) ON DELETE CASCADE,
  provider         VARCHAR(20) NOT NULL,
  -- 's3' | 'azurerm' | 'gcs' | 'local'. 'local' is honest rather than absent:
  -- a sandbox may legitimately want it, but it must be chosen, never defaulted
  -- into, because it silently orphans infrastructure.
  kind             VARCHAR(20) NOT NULL,
  -- Bucket / storage account / container / lock table. Never a secret: access
  -- is by the same cloud credentials the connection already holds.
  settings         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- Set once the bucket has been proved reachable and writable.
  verified_at      TIMESTAMPTZ,
  verification_error TEXT,
  created_by       INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS infra_state_backends_org_provider_idx
  ON infra_state_backends (organization_id, provider);

-- ── Where pull requests are raised, per tenant ───────────────────────────────

CREATE TABLE IF NOT EXISTS infra_git_connections (
  id               SERIAL PRIMARY KEY,
  organization_id  INTEGER      NOT NULL DEFAULT 1 REFERENCES organizations(id) ON DELETE CASCADE,
  -- 'github' today. The column exists so gitlab / azure_devops / bitbucket can
  -- be added without a migration: the provider interface is already abstract,
  -- and Azure DevOps will be as common as GitHub in this customer base.
  provider         VARCHAR(20)  NOT NULL DEFAULT 'github',
  repo_owner       VARCHAR(255) NOT NULL,
  repo_name        VARCHAR(255) NOT NULL,
  -- Null means the repository's own default branch, read at PR time. Storing a
  -- stale default would silently target a branch the customer has since renamed.
  base_branch      VARCHAR(255),
  -- Encrypted with server/encryption.ts, exactly like cloud credentials. A PAT
  -- that can open a pull request can usually also read every repository the
  -- user can, so it is no less sensitive than a cloud key.
  access_token     TEXT         NOT NULL,
  -- Directory inside the repo that generated Terraform is written under.
  base_path        VARCHAR(255) NOT NULL DEFAULT 'infrastructure',
  -- Emit a CI workflow alongside the Terraform, so the customer's pipeline runs
  -- the apply and we never need their deploy credentials.
  emit_pipeline    BOOLEAN      NOT NULL DEFAULT TRUE,
  last_verified_at TIMESTAMPTZ,
  last_error       TEXT,
  created_by       INTEGER,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- One connection per tenant for now. Per-plan repository targeting is a later
-- change and would relax this index rather than replace the table.
CREATE UNIQUE INDEX IF NOT EXISTS infra_git_connections_org_idx
  ON infra_git_connections (organization_id);

-- ── What was raised ──────────────────────────────────────────────────────────
--
-- Separate from infra_runs on purpose. A run is a Terraform execution this
-- server drives; a pull request is a handoff to somebody else's review and
-- somebody else's pipeline. Forcing them into one table would mean a run row
-- that sits in 'pending' for days with no lease and no worker, which is exactly
-- the state the run machinery is built to treat as a stall.

CREATE TABLE IF NOT EXISTS infra_pull_requests (
  id                BIGSERIAL PRIMARY KEY,
  organization_id   INTEGER      NOT NULL DEFAULT 1 REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id           INTEGER      NOT NULL,
  connection_id     INTEGER,

  provider          VARCHAR(20)  NOT NULL DEFAULT 'github',
  repo_owner        VARCHAR(255) NOT NULL,
  repo_name         VARCHAR(255) NOT NULL,
  base_branch       VARCHAR(255) NOT NULL,
  head_branch       VARCHAR(255) NOT NULL,

  number            INTEGER,
  url               TEXT,
  head_sha          VARCHAR(64),

  -- 'open' | 'merged' | 'closed' | 'failed'. 'failed' means we could not raise
  -- it at all, and keeping that row is deliberate: a silent failure here looks
  -- identical to "nobody has reviewed it yet".
  status            VARCHAR(20)  NOT NULL DEFAULT 'open',
  error             TEXT,

  -- What went into the commit, so the PR can be explained after the fact
  -- without regenerating it and hoping the output still matches.
  file_paths        JSONB        NOT NULL DEFAULT '[]'::jsonb,
  resource_count    INTEGER      NOT NULL DEFAULT 0,
  estimated_monthly_cost NUMERIC(14,2),
  state_backend     TEXT,

  created_by        INTEGER,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS infra_pull_requests_org_plan_idx
  ON infra_pull_requests (organization_id, plan_id, created_at DESC);

-- Re-raising a PR for the same plan on the same branch must update, not
-- duplicate: a second open PR for one deployment is two competing sources of
-- truth for what that infrastructure should be.
CREATE UNIQUE INDEX IF NOT EXISTS infra_pull_requests_org_repo_branch_idx
  ON infra_pull_requests (organization_id, repo_owner, repo_name, head_branch);
