# Azure Database for PostgreSQL — production setup

The application stores nothing about its own database in code. `server/db.ts`
reads one variable:

```js
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
```

So moving to Azure is a configuration and data-migration job, not a code change.
Verified as compatible before writing this:

- **No Postgres extensions are required.** None of the 16 migrations issue
  `CREATE EXTENSION`, so nothing needs allow-listing on the server.
- **No Neon-specific code remains on any live path.** The `@neondatabase/serverless`
  import in `server/db.ts` is commented out; the app uses plain `node-postgres`.
- **Advisory locks are used** (`server/utils/advisory-lock.ts`) — see the
  connection-pooling warning below, which is the one real trap.

---

## 1. Region: Central India (Pune), not Mumbai

**Mumbai cannot host this.** `westindia` (Mumbai) does not offer Azure Database
for PostgreSQL Flexible Server. Checked against the live API, which enumerates
its supported locations and omits it — the India regions that do support it are:

| Region | Slug | Physical | Paired with |
|---|---|---|---|
| **Central India** | `centralindia` | **Pune** | `southindia` (Chennai) |
| South India | `southindia` | Chennai | `centralindia` (Pune) |
| India South Central | `indiasouthcentral` | Hyderabad | — |
| Jio India West | `jioindiawest` | Jamnagar | `jioindiacentral` (Nagpur) |

**Use `centralindia` (Pune).** It is the closest supported region to Mumbai —
roughly 150 km, so latency from Mumbai users is negligible — and it is the only
India option that has everything this deployment wants. Verified capabilities:

```
zoneRedundantHaSupported : Enabled
geoBackupSupported       : Enabled
availability zones       : 1, 2, 3
PostgreSQL versions      : 11, 12, 13, 14, 15, 16, 17, 18
```

Data residency is satisfied without extra work: `centralindia` pairs with
`southindia` (Chennai), so even **geo-redundant backup keeps the data inside
India**. That is not true of every region — the pairing is what decides where a
geo-backup lands, and elsewhere it can cross a border.

The region is the hardest thing to change later; moving a Flexible Server across
regions means another dump-and-restore with another maintenance window. So if a
customer contract names a specific location, settle it here.

## 2. Provision the server

```bash
RG=cloudwise-prod
LOC=centralindia             # Pune. NOT westindia — Mumbai has no Flexible Server.
SERVER=cloudwise-pg          # becomes <SERVER>.postgres.database.azure.com
ADMIN=cwadmin

az group create --name "$RG" --location "$LOC"

az postgres flexible-server create \
  --resource-group "$RG" \
  --name "$SERVER" \
  --location "$LOC" \
  --admin-user "$ADMIN" \
  --admin-password '<strong-password>' \
  --tier GeneralPurpose \
  --sku-name Standard_D2ds_v5 \
  --version 17 \
  --storage-size 128 \
  --high-availability Disabled \
  --public-access None          # private access; see step 3

az postgres flexible-server db create \
  --resource-group "$RG" --server-name "$SERVER" --database-name cloudwise
```

Notes on the choices, all confirmed available in `centralindia`:

- **`Standard_D2ds_v5`** — current generation, 2 vCPU. `Standard_D2ds_v4` and the
  AMD `Standard_D2ads_v5` are also offered if you prefer; 31 GeneralPurpose SKUs
  are available in this region, so sizing up later is a scale operation rather
  than a migration.
- **Avoid `Burstable` (B1ms) for production.** Its `max_connections` is around
  50, which the pool ceiling has to be sized against — see step 6.
- **`--version 17`** — 11 through 18 are all offered. Nothing in the migrations
  depends on a specific major version.
- **High availability is off above** to keep the first deployment simple. Zone
  redundancy *is* supported here (zones 1–3), but enabling it later requires a
  restart, so decide before cutover if you can afford to.

To re-verify any of this yourself:

```bash
az postgres flexible-server list-skus --location centralindia -o json
```

## 3. Networking

Pick one, in order of preference:

1. **Private access (VNet integration)** — the server gets no public endpoint.
   Best posture; requires the app to run inside the same VNet (Container Apps
   with a VNet, App Service with integration, or a VM).
2. **Public access with firewall rules** — simpler, but the endpoint is on the
   internet and protected only by credentials plus an IP allow-list. If the app
   runs on Container Apps or App Service, its outbound IPs can change, so you
   may end up allow-listing broadly, which defeats much of the point.

For public access, add the rules explicitly rather than opening everything:

```bash
az postgres flexible-server firewall-rule create \
  --resource-group "$RG" --name "$SERVER" \
  --rule-name app-outbound --start-ip-address <ip> --end-ip-address <ip>
```

Do **not** create a `0.0.0.0`–`255.255.255.255` rule. Azure also offers an
"Allow public access from any Azure service" toggle, which permits every Azure
tenant, not just yours.

## 4. TLS is not optional, and it is not automatic

Azure requires TLS. **node-postgres does not enable it unless the URL asks.**
Verified against `pg-connection-string` 2.7.0:

| URL | resulting `ssl` | effect |
|---|---|---|
| no `sslmode` | `undefined` | plaintext |
| `?sslmode=require` | `{}` | TLS, certificate and hostname verified |
| `?sslmode=no-verify` | `{rejectUnauthorized:false}` | TLS, **not** verified |
| `?sslmode=disable` | `false` | plaintext |

So the connection string must end in `?sslmode=require`:

```
postgresql://cwadmin:<password>@cloudwise-pg.postgres.database.azure.com:5432/cloudwise?sslmode=require
```

No CA certificate file is needed — Azure's certificate chains to a root Node
already trusts. `sslmode=require` in node-postgres verifies both the chain and
the hostname, so it is equivalent to libpq's `verify-full`.

`sslmode=no-verify` encrypts but cannot detect an impostor server; the app logs a
warning if you use it. The app **refuses to start** if a non-local host is
configured without TLS (`server/db-url.ts`), because a server that comes up and
quietly sends credentials in plaintext is worse than one that does not come up.

## 5. Set the environment

```
DATABASE_URL=postgresql://cwadmin:<password>@cloudwise-pg.postgres.database.azure.com:5432/cloudwise?sslmode=require
SESSION_SECRET=<openssl rand -base64 32>
ENCRYPTION_KEY=<node -e "console.log(require('crypto').randomBytes(32).toString('base64'))">
NODE_ENV=production
```

> **Carry the existing `ENCRYPTION_KEY` across unchanged if you are migrating
> data.** Stored cloud credentials in `cloud_accounts` are encrypted with it.
> Restore a dump under a new key and every AWS/Azure/GCP credential becomes
> undecryptable — the rows survive, the secrets do not. Generate a *new* key only
> for a genuinely empty database. To change keys deliberately, set the old value
> as `ENCRYPTION_KEY_PREVIOUS` and run `npm run db:rotate-key`.

Keep these in Key Vault (or Container Apps secrets), not in a `.env` file on a
production host.

## 6. Size the connection pool against the server, not the process

Postgres counts connections per **server**. The pool defaults to 10 per process,
so N replicas open up to 10N, plus Azure reserves some for its own management.

```
PGPOOL_MAX=10        # per replica; PGPOOL_MAX x replicas must stay well under max_connections
```

Check the server's actual limit and leave headroom for migrations and manual
sessions:

```bash
az postgres flexible-server parameter show \
  --resource-group "$RG" --server-name "$SERVER" --name max_connections
```

### The pooling trap

If you enable Azure's built-in **PgBouncer** (port 6432) in *transaction*
pooling mode, session-scoped advisory locks break. The app uses
`pg_try_advisory_lock` in `server/utils/advisory-lock.ts` to stop two replicas
ingesting the same window at once; under transaction pooling the lock is not
tied to the client's session, so the mutual exclusion silently stops working and
you get duplicate ingestion instead of an error.

Connect on **5432** (direct), or use PgBouncer in *session* pooling mode.

## 7. Create the schema

`npm run db:migrate` alone is **not** enough, and neither is `npm run db:push`.

The migration files start at `0003` and several of them `ALTER` tables they never
create — `cloud_accounts`, `budgets`, `report_schedules`, `changes`. Those come
from the Drizzle schema. So on an empty database `db:migrate` fails on the first
`ALTER` against a table that does not exist yet. (An earlier draft of this
document said "use `db:migrate`, not `db:push`"; that was wrong.)

Two routes work. The second is what was actually used for the Pune server, and is
what I would repeat.

### Route A — build it from the repo

```bash
npm run db:push        # Drizzle schema: the base tables
npm run db:migrate     # the 16 ordered SQL migrations on top
```

Verify afterwards that `organizations` contains the row from
`0006_multi_tenancy.sql` — see step 10. Everything in the app is tenant-scoped
through `currentOrgId()`, so without it you get a complete set of tables and an
application that can read nothing.

### Route B — replicate a known-good database (used for the Pune migration)

If you already have a database the application is running correctly against,
copying its structure is more faithful than reconstructing it, because it is the
exact structure the code has been tested on:

```bash
pg_dump --schema-only --no-owner --no-privileges \
  --dbname="postgresql://postgres:<password>@localhost:5432/cloud_cost_agent" \
  --file=schema.sql

psql "host=<server>.postgres.database.azure.com port=5432 user=cwadmin \
      dbname=cloudwise sslmode=require" -v ON_ERROR_STOP=1 -f schema.sql
```

`ON_ERROR_STOP=1` matters: without it psql reports errors and keeps going,
leaving a half-built schema that looks like it worked.

This produced 34 tables and 100 indexes, and because the data dump in step 9
carries the `schema_migrations` rows with it, `npm run db:migrate -- --dry`
afterwards correctly reports *"Up to date — 16 migration(s) already applied."*

> If `psql` stops with `relation "schema_migrations" already exists`, something
> has already run against this database — `db:migrate --dry` creates that
> tracking table as a side effect. Recreate the database and load the schema in
> one clean pass rather than patching around the collision:
>
> ```bash
> az postgres flexible-server db delete -g <rg> -s <server> -d cloudwise --yes
> az postgres flexible-server db create -g <rg> -s <server> -d cloudwise
> ```

### A note on major versions

A PostgreSQL 18.3 source restored into a PostgreSQL 17.11 server worked without
incident, for both the schema and the data. Version skew is much less of a risk
here than it would be normally, because the schema is plain tables and indexes
with no extensions, and the data is `COPY` of ordinary column types.

## 8. Create the first login

`db/migrations/0005_add_users.sql` seeds an `admin` row with a hand-written
bcrypt hash whose password nobody knows, so migrating alone leaves you locked
out. Seed a real account:

```bash
npm run db:seed-admin -- --force-remote --username=<you> --password='<chosen-password>'
```

`--force-remote` is required by design: the script refuses non-local databases
unless you say you mean it, because seeding a *generated* credential into a
hosted environment is how a dev convenience becomes a breach. Supply a password
you chose; the password policy in `shared/password-policy.ts` is enforced (12+
characters, and it rejects values containing "admin").

## 9. Migrating existing data (optional)

Skip this for a fresh start. To carry history across — `cost_facts` is the one
that matters, since it is what the dashboard and reports read:

```bash
# From the current database
pg_dump --no-owner --no-privileges --format=custom \
  --dbname="postgresql://postgres:<password>@localhost:5432/cloud_cost_agent" \
  --file=cloudwise.dump

# Into Azure, AFTER step 7 has created the schema
pg_restore --no-owner --no-privileges --data-only --disable-triggers \
  --dbname="postgresql://cwadmin:<password>@cloudwise-pg.postgres.database.azure.com:5432/cloudwise?sslmode=require" \
  cloudwise.dump
```

Use a `pg_dump` whose version is >= the server's. Match `ENCRYPTION_KEY` to the
source database, per step 5.

Two things worth *not* copying:

- **`report_cache`** — regenerates on demand, and cached rows can carry stale or
  incorrect figures from before a fix. Leaving it empty costs one slow page load.
- **`sessions`** — everyone should re-authenticate after a cutover.

## 10. Verify before cutting over

```bash
# The app's own check: does it start, and how is it connecting?
npm run build && NODE_ENV=production node dist/index.js
# expect: [db] cloudwise-pg.postgres.database.azure.com (remote, sslmode=require)
```

Then confirm the parts that silently degrade rather than failing:

```sql
-- The row without which every tenant-scoped query returns nothing
SELECT id, name, slug FROM organizations;          -- expect id = 1

-- All 16 migrations recorded
SELECT count(*) FROM schema_migrations;

-- An account that can actually log in
SELECT username, role FROM users;

-- Data volume, if you restored
SELECT provider, count(*), max(charge_period_start) FROM cost_facts GROUP BY provider;
```

Finally, log in and confirm the dashboard shows figures — and that a stored cloud
credential still decrypts, which is the real test of whether `ENCRYPTION_KEY`
came across correctly. The startup log line `[CloudConfig] Parsed credentials
keys: [...]` appearing for each provider is the signal; a decryption failure
there means the key is wrong.

## 11. Backups and recovery

Flexible Server takes automatic backups; the retention window is what you choose,
and the default is short.

```bash
az postgres flexible-server update \
  --resource-group "$RG" --name "$SERVER" --backup-retention 35
```

Geo-redundant backup is safe to enable here: `centralindia` pairs with
`southindia` (Chennai), so the copy stays inside India. Confirm the pairing
again if you ever move region — it is what decides where the copy lands.

A backup nobody has restored is a hypothesis. Restore into a throwaway server
once and time it, so the recovery objective is a measured number.
