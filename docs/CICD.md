# CI/CD

How code reaches production, what protects it on the way, and what to do when a
deployment fails.

```
feature/*  ──PR──▶  dev  ──▶  DEV environment
                     │ PR (promote)
                     ▼
                    main ──▶  PRODUCTION   (required reviewer)
```

Two long-lived branches. A branch *is* an environment: pushing to `dev` deploys
dev, merging to `main` deploys production. Promotion is a pull request, so what
reaches production is always a reviewable diff.

## Why there is no staging

A staging environment is worth its cost when it genuinely differs from dev —
production-like data, real integrations, a team too large to share one dev.
A third identical environment for a small team is not that.

Every failure this pipeline has actually produced was **secret drift between
environments**: dev inheriting production's `DATABASE_URL`, `SESSION_SECRET`
present in one place and absent in another, two Container Apps environments with
nothing to say which was meant. Another environment triples that surface and
catches nothing dev would not.

The protection comes from the configuration gate, the commit-verifying smoke
test and the automatic rollback — and those run in *every* environment.
Production additionally waits for a human, which is the approval staging is
often used to simulate.

To reinstate it: add a `staging)` case to the branch mapping in `cd.yml`, add
the branch to the triggers in `cd.yml` and `ci.yml`, and create the GitHub
Environment. `deploy-environment.yml` takes the environment as an input and
needs no change.

## The trade this model makes

What runs in dev is commit X. Merging dev into main creates a **new** commit —
the merge — and production runs that. Production therefore runs a commit that
never existed in dev. Usually immaterial; occasionally it is where "but it
worked in dev" comes from.

Mitigation: merge `main` back down into `dev` after any hotfix, or dev stops
resembling the thing it is meant to rehearse.

## Azure topology

Everything lives in **`finops-rg`**, and the application tier is in **East US 2**.

| | |
|---|---|
| Container Apps env | `finops-env-us2` — VNet-integrated |
| VNet | `finops-vnet`, subnets `aca-infra` and `pg-subnet`, both delegated |
| Database | `cloudwise-pg-eastus2` — **`publicNetworkAccess: Disabled`**, injected into `pg-subnet` |
| Registry | `cloudwise.azurecr.io` (East US — cross-region pulls are fine) |

The database has **no public endpoint**. It is not a firewalled public server;
it is unreachable from outside the VNet, including from GitHub runners. That
single fact shapes the rest of this document.

Two constraints produced this layout, and both will resurface:

- **East US is offer-restricted for Postgres Flexible Server** on this
  subscription — `OfferRestricted: Enabled`, creation fails with "The location
  is restricted from performing this operation". Every other US region is fine.
  Lifting it needs an Azure support request under *Service and subscription
  limits*.
- **The CI service principal `finops-github-actions` is Contributor on
  `finops-rg` only.** It cannot see other resource groups, and granting a role
  requires Owner or User Access Administrator.

## Migrations run inside the VNet

Not on the runner — the runner cannot reach the database at all.

`deploy-environment.yml` creates a **Container Apps Job** on the same
environment as the app, so it runs inside the VNet, and executes
`node dist/migrate.js`. The job is deleted and recreated each deployment: it
holds no state, and recreating guarantees the image, arguments and database
secret belong to *this* deployment rather than a previous one. The connection
string is passed as a job secret, not a plain environment variable.

This requires the runtime image to carry its migrations, so the Dockerfile ships
`db/` and the build bundles `server/migrate.ts` to `dist/migrate.js`.

## A brand-new database

The migration chain starts at `0003`, which alters `budgets` — a table **no
migration creates**. The original schema came from `drizzle-kit push`, so every
database was bootstrapped out of band and had migrations layered on top. A
genuinely fresh database fails on the first migration.

`db/baseline.sql` is that missing starting point, generated from
`shared/schema.ts`. The runner applies it **only** when the database has no
tables *and* no ledger, then records every migration up to
`BASELINE_INCLUDES_THROUGH` as applied. Adding a new migration needs no
regeneration — the baseline covers history to a stated point and later
migrations apply on top.

Its seed rows are deliberately **not** in migration order: `0005` inserts the
admin before `0006` gives `users` an `organization_id`, so no foreign key
existed then. The baseline builds the finished schema in one go, so the
organization must be inserted first.

A fresh database's `admin` account carries `0005`'s hash, which corresponds to
no known password. Claim it by running `dist/set-admin-password.js` as a
Container Apps Job with `ADMIN_PASSWORD` set — again inside the VNet, because
the database has no public endpoint. The tool never generates a password and
never logs one.

## What protects a deployment

**The configuration gate** refuses to deploy an environment that is not set up,
and **fails** rather than passing green — "I deliberately deployed nothing" must
never be reported as "deployed successfully".

It also refuses when a non-production environment's `DATABASE_URL` is
byte-identical to the repository-level one. A missing environment secret falls
back to the repository value, so a non-empty check proves nothing; a job that
declares no `environment:` fingerprints the repository value and the gate
compares against that. This exists because a dev deployment once ran its
migrations against production's database.

**The revision check** asks Azure which revision is running before any HTTP
probe, and dumps the container's own logs when one never starts.

**The smoke test** compares the commit reported by `/api/ready` against the
commit being deployed. Container Apps keeps the previous revision serving until
the new one is healthy, so a 200 can come from the old revision and say nothing
about this deployment.

**Rollback** restores the previous image and verifies it against `/api/health`,
not `/api/ready` — the image being restored is by definition older and may
predate the readiness endpoint.

## Required configuration

**Repository secrets** — Settings → Secrets and variables → Actions:

| Secret | |
|---|---|
| `AZURE_CREDENTIALS` *or* `AZURE_CLIENT_ID`/`AZURE_TENANT_ID`/`AZURE_SUBSCRIPTION_ID` | service principal |
| `ACR_LOGIN_SERVER`, `ACR_USERNAME`, `ACR_PASSWORD` | registry |
| `RESOURCE_GROUP` | `finops-rg` |
| `CONTAINER_APP_NAME` | production's app |
| `DATABASE_URL` | production's database |
| `SESSION_SECRET` | 48 random bytes — the app **refuses to start** without one |
| `ENCRYPTION_KEY` | 48 random bytes |
| `OPENAI_API_KEY`, `RESEND_API_KEY` | |

**Repository variables** — the Variables tab:

| Variable | |
|---|---|
| `CONTAINERAPPS_ENVIRONMENT` | `finops-env-us2` |

`finops-rg` holds more than one Container Apps environment, and only the
VNet-integrated one can reach the database. Deploying into the wrong one
produces an app that starts cleanly and then cannot reach its database, so the
pipeline refuses to guess.

**Environments** — Settings → Environments:

| Environment | Variable | Secrets |
|---|---|---|
| `dev` | `ENVIRONMENT_NAME` = `dev` | `CONTAINER_APP_NAME`, `DATABASE_URL` |
| `production` | — | — (inherits; add a **required reviewer**) |

Set **only** what must differ per environment. Anything else inherits, so there
is one place to rotate it. The two that must differ are the app name and the
database; everything else should be identical and therefore inherited.

Generate the secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

## Branch protection

On `main`: require a pull request, require the `ci-passed` check, and do not
allow bypassing. Apply the same to `dev` so a promotion cannot skip CI. The
required reviewer on the `production` environment is what makes a deployment to
main wait for a human — that is GitHub's gate, not something the workflow can
fake.

## When a deployment fails

Read the failing step's output first; each failure mode below was reported
unhelpfully once and now names itself.

| Symptom | Cause |
|---|---|
| `Check the environment is configured` fails | the environment has no `ENVIRONMENT_NAME`, no `DATABASE_URL` of its own, or one identical to production's |
| `Resolve the Container Apps environment` fails | the principal has no role on `RESOURCE_GROUP`, or the group holds several environments and `CONTAINERAPPS_ENVIRONMENT` is unset |
| `Apply migrations` fails | the job's own container logs are dumped into the step output |
| `Wait for the new revision` fails | the container crashed on startup; its logs are dumped. A missing `SESSION_SECRET` looks exactly like this |
| Smoke test says "still the old revision" | the new revision never took over; Azure's revision state is the authority |
| `relation "..." does not exist` on a new database | the baseline did not run, or does not cover that table |

Container Apps keeps the previous revision serving while a new one starts, so a
failed deployment usually means the **old version is still up**. Check
`az containerapp revision list` before assuming an outage.
