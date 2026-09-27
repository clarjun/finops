-- GitHub App authentication, alongside the existing personal access token.
--
-- A PAT carries a PERSON'S access: every repository that human can reach, no
-- expiry, and it dies when they are deprovisioned — at which point pull
-- requests stop with an auth error that reads like a product fault. An App
-- installation is granted per repository by the organization, mints tokens that
-- live one hour, and commits as itself so the history says which system opened
-- the change.
--
-- The App id and private key belong to the DEPLOYMENT (environment), not to a
-- tenant. Only the installation id is per tenant, and on its own it is useless
-- without the private key — so it is stored in the clear rather than encrypted,
-- which keeps it readable for support without pretending it is a secret.
ALTER TABLE infra_git_connections
  ADD COLUMN IF NOT EXISTS auth_method varchar(20) NOT NULL DEFAULT 'pat',
  ADD COLUMN IF NOT EXISTS app_installation_id varchar(64);

-- App connections have no token to store. Existing rows are PAT rows and keep
-- theirs, so this only relaxes the constraint for what comes next.
ALTER TABLE infra_git_connections
  ALTER COLUMN access_token DROP NOT NULL;

-- A row must carry the credential its method needs. Without this a connection
-- could be saved as 'app' with no installation id and fail only at the first
-- pull request, long after the settings screen said it was connected.
ALTER TABLE infra_git_connections
  DROP CONSTRAINT IF EXISTS infra_git_connections_auth_complete;
ALTER TABLE infra_git_connections
  ADD CONSTRAINT infra_git_connections_auth_complete CHECK (
    (auth_method = 'pat' AND access_token IS NOT NULL)
    OR (auth_method = 'app' AND app_installation_id IS NOT NULL)
  );

COMMENT ON COLUMN infra_git_connections.auth_method IS
  'pat = stored personal access token; app = GitHub App installation, token minted per request.';
COMMENT ON COLUMN infra_git_connections.app_installation_id IS
  'GitHub App installation id for this tenant. Not a secret on its own: useless without the deployment private key.';
