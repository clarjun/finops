/**
 * Set the password of an existing account, for bootstrapping a fresh database.
 *
 *   ADMIN_PASSWORD=... node dist/set-admin-password.js
 *   ADMIN_PASSWORD=... node dist/set-admin-password.js --username=someone
 *
 * Why this exists separately from db:seed-admin:
 *
 * Migration 0005 inserts an `admin` row carrying a bcrypt hash that was written
 * by hand, and nobody knows which password produced it. So a freshly migrated
 * database has an administrator no one can log in as. `db:seed-admin` fixes
 * that locally but deliberately refuses to touch a non-local database, because
 * it can GENERATE a password — and a generated credential written into a hosted
 * environment, printed to a build log, is how a dev convenience becomes a
 * breach.
 *
 * This tool makes the opposite trade. It never generates anything: the password
 * must be supplied by the operator, through the environment, and is never
 * printed. That makes it safe to run against a hosted database — which matters
 * here, because the production database has no public endpoint, so the only way
 * to reach it is a container running inside the VNet.
 *
 * It updates an existing account and will not create one. Bootstrapping is
 * recovering access to the account migrations already made, not a side door for
 * minting new administrators.
 */
import "dotenv/config";

import bcrypt from "bcryptjs";
import pkg from "pg";
import { validatePassword, BCRYPT_ROUNDS } from "@shared/password-policy";

const { Client } = pkg;

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=").slice(1).join("=");
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }

  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    console.error(
      "ADMIN_PASSWORD is not set.\n\n" +
        "Pass the password through the environment rather than the command line:\n" +
        "argv is visible to anything that can list processes, and ends up in shell\n" +
        "history and CI logs.",
    );
    process.exit(1);
  }

  // The same rules the application enforces. A bootstrap path that accepted a
  // weaker password than the signup form would quietly become the weakest way
  // in, and it is the one account that matters most.
  const verdict = validatePassword(password);
  if (!verdict.valid) {
    console.error(`ADMIN_PASSWORD rejected: ${verdict.error}`);
    process.exit(1);
  }

  const username = arg("username") ?? "admin";
  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // UPDATE, never INSERT: see the note above. is_active is set because an
    // account disabled earlier would otherwise take the new password and still
    // refuse the login, which reads as "the tool did not work".
    const result = await client.query(
      `UPDATE users
          SET password_hash = $1,
              is_active     = true
        WHERE username = $2
        RETURNING id, username, role`,
      [hash, username],
    );

    if (result.rowCount === 0) {
      console.error(
        `No account named '${username}'.\n\n` +
          "This tool only resets an existing account. Run the migrations first —\n" +
          "0005_add_users.sql creates the 'admin' account this is meant to recover.",
      );
      process.exit(1);
    }

    const user = result.rows[0];
    console.log(`Password set for '${user.username}' (id ${user.id}, role ${user.role}).`);
    console.log("The password itself was not logged. Store it in your password manager now.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  // The message only: a pg error can carry the host, port and user from the
  // connection string, and this runs in CI where the output is retained.
  console.error("Failed to set the password:", err?.message ?? err);
  process.exit(1);
});
