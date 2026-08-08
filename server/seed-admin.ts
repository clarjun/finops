/**
 * Bootstrap an owner account for local development.
 *
 *   npm run db:seed-admin                      generate a password and print it
 *   npm run db:seed-admin -- --password=...    set a specific password
 *   npm run db:seed-admin -- --username=me     seed a different account
 *
 * Replaces the hard-coded bcrypt hash in db/migrations/0005_add_users.sql. That
 * hash was written by hand and there is no way to confirm which password it
 * corresponds to, so a fresh database could end up with an admin nobody can log
 * in as. This hashes a password we actually know.
 *
 * Refuses to run against a non-local database — seeding a known credential into
 * a hosted environment is how a dev convenience becomes a breach.
 */
import "dotenv/config";

import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import pkg from "pg";

const { Client } = pkg;

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.split('=').slice(1).join('=');
}

function isLocal(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  if (!isLocal(url) && !process.argv.includes('--force-remote')) {
    console.error(
      `Refusing to seed a non-local database (${new URL(url).hostname}).\n` +
      `If you genuinely intend this, re-run with --force-remote and a --password you chose.`
    );
    process.exit(1);
  }

  const username = arg('username') ?? 'admin';
  const generated = !arg('password');
  // 24 base64url chars — comfortably above the 12-char minimum the API enforces.
  const password = arg('password') ?? randomBytes(18).toString('base64url');

  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    // The default organization is created by migration 0006; create it here too
    // so this script works on a database where only the schema exists.
    await client.query(`
      INSERT INTO organizations (id, name, slug, plan)
      VALUES (1, 'Default Organization', 'default', 'enterprise')
      ON CONFLICT (id) DO NOTHING
    `);
    await client.query(
      `SELECT setval('organizations_id_seq', GREATEST((SELECT MAX(id) FROM organizations), 1))`
    );

    const hash = await bcrypt.hash(password, 12);

    const { rows } = await client.query(
      `INSERT INTO users (organization_id, username, password_hash, role, is_platform_admin, is_active)
       VALUES (1, $1, $2, 'owner', true, true)
       ON CONFLICT (username) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             role = 'owner',
             is_platform_admin = true,
             is_active = true,
             organization_id = 1,
             updated_at = NOW()
       RETURNING id, username, role`,
      [username, hash]
    );

    const user = rows[0];
    console.log(`\nSeeded owner account in organization 1:`);
    console.log(`  username: ${user.username}`);
    console.log(`  role:     ${user.role} (platform admin)`);
    if (generated) {
      console.log(`  password: ${password}`);
      console.log(`\nThis password is shown once. Store it now.`);
    } else {
      console.log(`  password: (as supplied)`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
