/**
 * Re-encrypt stored credentials under the current ENCRYPTION_KEY.
 *
 *   npm run db:rotate-key -- --dry    report what would change
 *   npm run db:rotate-key             re-encrypt
 *
 * Two situations this handles:
 *
 *   Migrating off the old default. Records written while ENCRYPTION_KEY was
 *   unset are protected by a key literal in the repository. They decrypt with
 *   the legacy default and are rewritten under the real key.
 *
 *   Rotating a real key. Set ENCRYPTION_KEY to the new value and
 *   ENCRYPTION_KEY_PREVIOUS to the old one, then run this. Once it reports zero
 *   remaining, remove ENCRYPTION_KEY_PREVIOUS.
 *
 * Each account is rewritten in its own transaction. A failure part-way leaves
 * earlier accounts migrated and later ones untouched, and both are readable —
 * decryption accepts old and new formats — so a partial run is safe to repeat.
 */
import "dotenv/config";

import { eq } from "drizzle-orm";
import { db } from "./db";
import { cloudAccounts, azureAccounts } from "@shared/schema";
import { encrypt, decrypt, isLegacyFormat } from "./encryption";

interface Outcome {
  table: string;
  id: number;
  label: string;
  status: 'rotated' | 'already-current' | 'failed';
  detail?: string;
}

async function rotateCloudAccounts(dryRun: boolean): Promise<Outcome[]> {
  const rows = await db.select().from(cloudAccounts);
  const outcomes: Outcome[] = [];

  for (const row of rows) {
    const label = `${row.provider}/${row.accountName}`;
    const stored = row.credentials as unknown;

    if (typeof stored !== 'string') {
      outcomes.push({ table: 'cloud_accounts', id: row.id, label, status: 'failed', detail: 'credentials are not an encrypted string' });
      continue;
    }

    if (!isLegacyFormat(stored)) {
      outcomes.push({ table: 'cloud_accounts', id: row.id, label, status: 'already-current' });
      continue;
    }

    try {
      // Decrypt with whatever key works, re-encrypt under the current one.
      const plaintext = decrypt(stored);
      // Sanity check: credentials are JSON. Re-encrypting corrupted plaintext
      // would destroy the only copy.
      JSON.parse(plaintext);

      if (!dryRun) {
        await db.update(cloudAccounts)
          .set({ credentials: encrypt(plaintext) as any, updatedAt: new Date() })
          .where(eq(cloudAccounts.id, row.id));
      }

      outcomes.push({ table: 'cloud_accounts', id: row.id, label, status: 'rotated' });
    } catch (err: any) {
      outcomes.push({ table: 'cloud_accounts', id: row.id, label, status: 'failed', detail: err?.message ?? String(err) });
    }
  }

  return outcomes;
}

async function rotateAzureAccounts(dryRun: boolean): Promise<Outcome[]> {
  const rows = await db.select().from(azureAccounts);
  const outcomes: Outcome[] = [];

  for (const row of rows) {
    const label = row.accountName;
    const fields: Array<'tenantId' | 'clientId' | 'clientSecret'> = ['tenantId', 'clientId', 'clientSecret'];

    if (!fields.some(f => isLegacyFormat(row[f]))) {
      outcomes.push({ table: 'azure_accounts', id: row.id, label, status: 'already-current' });
      continue;
    }

    try {
      const updates: Record<string, string> = {};
      for (const field of fields) {
        const value = row[field];
        if (typeof value === 'string' && isLegacyFormat(value)) {
          updates[field] = encrypt(decrypt(value));
        }
      }

      if (!dryRun && Object.keys(updates).length > 0) {
        await db.update(azureAccounts)
          .set({ ...updates, updatedAt: new Date() } as any)
          .where(eq(azureAccounts.id, row.id));
      }

      outcomes.push({ table: 'azure_accounts', id: row.id, label, status: 'rotated' });
    } catch (err: any) {
      outcomes.push({ table: 'azure_accounts', id: row.id, label, status: 'failed', detail: err?.message ?? String(err) });
    }
  }

  return outcomes;
}

async function main() {
  const dryRun = process.argv.includes('--dry');

  if (!process.env.ENCRYPTION_KEY) {
    console.error('ENCRYPTION_KEY is not set. Nothing to rotate to.');
    process.exit(1);
  }

  console.log(dryRun ? 'Dry run — nothing will be written.\n' : 'Rotating credentials to the current ENCRYPTION_KEY.\n');

  const outcomes = [
    ...(await rotateCloudAccounts(dryRun)),
    ...(await rotateAzureAccounts(dryRun)),
  ];

  for (const o of outcomes) {
    const mark = o.status === 'rotated' ? (dryRun ? 'would rotate' : 'rotated')
      : o.status === 'already-current' ? 'already current'
      : 'FAILED';
    console.log(`  [${o.table}#${o.id}] ${o.label.padEnd(34)} ${mark}${o.detail ? ` — ${o.detail}` : ''}`);
  }

  const rotated = outcomes.filter(o => o.status === 'rotated').length;
  const failed = outcomes.filter(o => o.status === 'failed').length;
  const current = outcomes.filter(o => o.status === 'already-current').length;

  console.log(`\n${rotated} ${dryRun ? 'to rotate' : 'rotated'}, ${current} already current, ${failed} failed.`);

  if (failed > 0) {
    console.error(
      '\nSome records could not be decrypted. If the key was changed, set ENCRYPTION_KEY_PREVIOUS ' +
      'to the previous value and run again. Nothing was overwritten for those records.'
    );
    process.exit(1);
  }

  if (!dryRun && rotated > 0 && process.env.ENCRYPTION_KEY_PREVIOUS) {
    console.log('\nAll records now use the current key. ENCRYPTION_KEY_PREVIOUS can be removed.');
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
