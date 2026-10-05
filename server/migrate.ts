/**
 * SQL migration runner.
 *
 * Replaces `drizzle-kit push` for anything structural. `push` diffs the schema
 * and applies whatever it thinks is right — it cannot backfill data, reorder
 * constraint changes, or be reviewed before it touches production. Every
 * migration here is a reviewed, ordered, recorded SQL file.
 *
 *   npm run db:migrate           apply pending migrations
 *   npm run db:migrate -- --dry  list pending migrations without applying
 *
 * Each file manages its own transaction. Files must be idempotent
 * (IF NOT EXISTS / ON CONFLICT DO NOTHING) so a partially-applied deploy can be
 * safely re-run.
 */
import "dotenv/config";

import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "pg";

const { Client } = pkg;

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");
const BASELINE_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "baseline.sql");

/**
 * The newest migration whose effects db/baseline.sql already contains.
 *
 * The baseline is generated from the current schema, so applying it and then
 * replaying history on top would fail on everything that already exists.
 * Migrations up to and including this one are recorded as applied; anything
 * newer still runs normally, which is why adding a migration does not require
 * regenerating the baseline.
 */
const BASELINE_INCLUDES_THROUGH = "0028_github_app_credentials.sql";

interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

function loadMigrations(): MigrationFile[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort() // filenames are zero-padded and ordered: 0003_, 0004_, ...
    .map((name) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
      return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
    });
}

/** True when the database has no tables of ours at all. */
async function isEmptyDatabase(client: InstanceType<typeof Client>): Promise<boolean> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name <> 'schema_migrations'`
  );
  return rows[0]?.n === "0";
}

/**
 * Create the schema on a database that has none, and record the history it
 * already represents.
 *
 * Only ever reached when the database is genuinely empty, so this cannot
 * overwrite anything: an established database takes the normal path.
 */
async function applyBaseline(
  client: InstanceType<typeof Client>,
  migrations: MigrationFile[],
): Promise<void> {
  console.log("Empty database — applying db/baseline.sql");
  await client.query(readFileSync(BASELINE_FILE, "utf8"));

  // Zero-padded names sort lexicographically, so a string comparison is an
  // ordering comparison here.
  const covered = migrations.filter((m) => m.name <= BASELINE_INCLUDES_THROUGH);
  for (const m of covered) {
    await client.query(
      `INSERT INTO schema_migrations (name, checksum)
       VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`,
      [m.name, m.checksum],
    );
  }

  console.log(
    `Baseline applied. ${covered.length} migration(s) recorded as already present; ` +
      `${migrations.length - covered.length} will be applied normally.`,
  );
}

async function main() {
  const dryRun = process.argv.includes("--dry");

  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set — check your .env file.");
    process.exit(1);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        VARCHAR(255) PRIMARY KEY,
        checksum    VARCHAR(64)  NOT NULL,
        applied_at  TIMESTAMP    NOT NULL DEFAULT NOW()
      )
    `);

    const { rows } = await client.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM schema_migrations"
    );
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));
    const migrations = loadMigrations();

    // A database with no ledger AND no tables has never been set up. Replaying
    // history from 0003 would fail immediately, because 0003 alters a table the
    // migrations never create.
    if (applied.size === 0 && (await isEmptyDatabase(client))) {
      if (dryRun) {
        console.log("Empty database: baseline would be applied, then:");
      } else {
        await applyBaseline(client, migrations);
        const refreshed = await client.query<{ name: string; checksum: string }>(
          "SELECT name, checksum FROM schema_migrations",
        );
        for (const r of refreshed.rows) applied.set(r.name, r.checksum);
      }
    }

    const pending = migrations.filter((m) => !applied.has(m.name));

    // A changed file that was already applied means someone edited history.
    // Warn loudly rather than silently re-running or silently ignoring it.
    for (const m of migrations) {
      const prior = applied.get(m.name);
      if (prior && prior !== m.checksum) {
        console.warn(
          `WARNING: ${m.name} was modified after being applied. ` +
            `The database still reflects the original. Add a new migration instead of editing this one.`
        );
      }
    }

    if (pending.length === 0) {
      console.log(`Up to date — ${migrations.length} migration(s) already applied.`);
      return;
    }

    console.log(`${pending.length} pending migration(s):`);
    for (const m of pending) console.log(`  - ${m.name}`);

    if (dryRun) {
      console.log("\n--dry specified, nothing applied.");
      return;
    }

    for (const m of pending) {
      process.stdout.write(`\nApplying ${m.name} ... `);
      try {
        await client.query(m.sql);
        await client.query(
          "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET checksum = EXCLUDED.checksum",
          [m.name, m.checksum]
        );
        console.log("ok");
      } catch (err: any) {
        console.log("FAILED");
        console.error(`\n${m.name} failed: ${err.message}`);
        // Stop on first failure — later migrations may depend on this one.
        process.exit(1);
      }
    }

    console.log("\nAll migrations applied.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
