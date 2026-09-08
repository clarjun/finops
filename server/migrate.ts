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
