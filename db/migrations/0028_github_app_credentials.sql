-- GitHub App credentials, registered through the UI rather than the environment.
--
-- Previously the App id and private key came from GITHUB_APP_ID and
-- GITHUB_APP_PRIVATE_KEY. That works, but it means the only way to set up the
-- integration is to shell into a deployment, download a .pem, base64 it and
-- restart — which is not something a customer can do, and not something anyone
-- should have to do twice.
--
-- GitHub's App Manifest flow removes the step entirely: the operator clicks
-- once, GitHub creates the App and hands back the id and private key, and they
-- land here encrypted. Nothing is ever pasted and nothing lives in a file.
--
-- ── Why this is per organization ────────────────────────────────────────────
--
-- GitHub's own model is one App per product, which would make this a single
-- deployment-wide row. It is scoped per tenant instead, because a shared row in
-- a multi-tenant deployment means one customer's administrator can replace the
-- App every other customer authenticates through. The manifest flow makes
-- registration cheap enough (three clicks, no file handling) that the isolation
-- costs nothing.
CREATE TABLE IF NOT EXISTS github_app_credentials (
  id                  serial PRIMARY KEY,
  organization_id     integer NOT NULL,

  -- Numeric App id, as a string: it is an identifier, never arithmetic.
  app_id              varchar(32)  NOT NULL,
  -- The RSA private key, encrypted at rest with ENCRYPTION_KEY.
  private_key         text         NOT NULL,
  -- Used to build the install link. GitHub derives it from the App name.
  slug                varchar(255),
  client_id           varchar(255),
  -- Stored because GitHub generates one whether or not we use webhooks.
  -- Encrypted for the same reason as the key: it authenticates callers to us.
  webhook_secret      text,

  -- Proved at registration, so a broken key is caught before the first PR.
  last_verified_at    timestamptz,
  last_error          text,

  created_by          integer,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- One App per tenant. The upsert in the setup callback targets this.
CREATE UNIQUE INDEX IF NOT EXISTS github_app_credentials_org_uidx
  ON github_app_credentials (organization_id);

COMMENT ON TABLE github_app_credentials IS
  'Per-tenant GitHub App registered via the App Manifest flow. Replaces GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY; there is no environment fallback.';
