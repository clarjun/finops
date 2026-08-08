/**
 * Tenant isolation, against a real database.
 *
 * This cannot be a unit test. The claim being made is about what SQL returns,
 * so mocking the database would only assert that the mock behaves as written.
 *
 * Requires a local DATABASE_URL with migrations applied:
 *   npm run db:migrate && npm run test:integration
 */
import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db, pool } from './db';
import {
  organizations, cloudAccounts, budgets, costFacts, optimizationActions, users,
} from '@shared/schema';
import { runAsSystem, currentOrgId, getTenantContext } from './tenant-context';
import { storage } from './storage';
import { getActiveCloudAccounts } from './cloud-config-manager';

const SLUG_A = 'itest-tenant-a';
const SLUG_B = 'itest-tenant-b';

let orgA: number;
let orgB: number;

async function createOrg(slug: string): Promise<number> {
  const [row] = await db.insert(organizations)
    .values({ name: `Integration ${slug}`, slug, plan: 'standard' })
    .onConflictDoNothing()
    .returning({ id: organizations.id });
  if (row) return row.id;
  const [existing] = await db.select().from(organizations).where(eq(organizations.slug, slug));
  return existing.id;
}

async function destroyOrg(slug: string) {
  const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug));
  if (!org) return;
  // audit_logs deliberately has no FK and is append-only, so it is not cascaded.
  await db.delete(organizations).where(eq(organizations.id, org.id));
}

beforeAll(async () => {
  orgA = await createOrg(SLUG_A);
  orgB = await createOrg(SLUG_B);

  await runAsSystem(orgA, async () => {
    await storage.createCloudAccount({
      provider: 'aws', accountName: 'A-account', accountId: '111111111111',
      credentials: { accessKeyId: 'AKIA_A', secretAccessKey: 'secret-A', region: 'us-east-1' } as any,
      refreshInterval: 86400, isActive: true,
    });
    await storage.createBudget({
      budgetName: 'A-budget', amount: '1000', period: 'monthly',
      startDate: new Date(), isActive: true,
    } as any);
  });

  await runAsSystem(orgB, async () => {
    await storage.createCloudAccount({
      provider: 'aws', accountName: 'B-account', accountId: '222222222222',
      credentials: { accessKeyId: 'AKIA_B', secretAccessKey: 'secret-B', region: 'eu-west-1' } as any,
      refreshInterval: 86400, isActive: true,
    });
  });
});

afterAll(async () => {
  await destroyOrg(SLUG_A);
  await destroyOrg(SLUG_B);
  await pool.end();
});

describe('tenant context', () => {
  it('refuses database access with no tenant, instead of guessing one', () => {
    // The property that makes the whole design safe: a query that cannot name
    // its tenant fails loudly rather than reading across all of them.
    expect(() => currentOrgId()).toThrow(/No tenant context/);
  });

  it('scopes the context to the callback and restores it afterwards', async () => {
    expect(getTenantContext()).toBeUndefined();
    await runAsSystem(orgA, async () => {
      expect(currentOrgId()).toBe(orgA);
      await runAsSystem(orgB, async () => {
        expect(currentOrgId()).toBe(orgB);
      });
      expect(currentOrgId()).toBe(orgA);
    });
    expect(getTenantContext()).toBeUndefined();
  });

  it('survives async boundaries', async () => {
    await runAsSystem(orgA, async () => {
      await new Promise(r => setTimeout(r, 5));
      const results = await Promise.all([
        Promise.resolve().then(() => currentOrgId()),
        new Promise<number>(r => setImmediate(() => r(currentOrgId()))),
      ]);
      expect(results).toEqual([orgA, orgA]);
    });
  });
});

describe('cloud credentials are isolated', () => {
  it('returns only the calling tenant’s accounts', async () => {
    const a = await runAsSystem(orgA, () => getActiveCloudAccounts('aws'));
    const b = await runAsSystem(orgB, () => getActiveCloudAccounts('aws'));

    expect(a.map(x => x.accountId)).toEqual(['111111111111']);
    expect(b.map(x => x.accountId)).toEqual(['222222222222']);
  });

  it('never exposes another tenant’s secret key', async () => {
    // The single worst failure this system could have.
    const a = await runAsSystem(orgA, () => getActiveCloudAccounts('aws'));
    const serialized = JSON.stringify(a);
    expect(serialized).toContain('secret-A');
    expect(serialized).not.toContain('secret-B');
    expect(serialized).not.toContain('AKIA_B');
  });

  it('throws rather than returning everything when there is no tenant', async () => {
    // getActiveCloudAccounts catches errors and returns [], so the observable
    // behaviour must be "no credentials", never "all credentials".
    const result = await getActiveCloudAccounts('aws');
    expect(result).toEqual([]);
  });
});

describe('storage is scoped on read, update and delete', () => {
  it('does not list another tenant’s budgets', async () => {
    const a = await runAsSystem(orgA, () => storage.getAllBudgets());
    const b = await runAsSystem(orgB, () => storage.getAllBudgets());

    expect(a.map(x => x.budgetName)).toContain('A-budget');
    expect(b.map(x => x.budgetName)).not.toContain('A-budget');
  });

  it('reports another tenant’s row as not found rather than returning it', async () => {
    const [aBudget] = await runAsSystem(orgA, () => storage.getAllBudgets());
    const fromB = await runAsSystem(orgB, () => storage.getBudget(aBudget.id));
    expect(fromB).toBeUndefined();
  });

  it('cannot update another tenant’s row', async () => {
    const [aBudget] = await runAsSystem(orgA, () => storage.getAllBudgets());

    const updated = await runAsSystem(orgB, () =>
      storage.updateBudget(aBudget.id, { budgetName: 'HIJACKED' } as any));
    expect(updated).toBeUndefined();

    const [after] = await runAsSystem(orgA, () => storage.getAllBudgets());
    expect(after.budgetName).toBe('A-budget');
  });

  it('cannot delete another tenant’s row', async () => {
    const [aAccount] = await runAsSystem(orgA, () => storage.getAllCloudAccounts());

    const deleted = await runAsSystem(orgB, () => storage.deleteCloudAccount(aAccount.id));
    expect(deleted).toBe(false);

    const still = await runAsSystem(orgA, () => storage.getCloudAccount(aAccount.id));
    expect(still).toBeDefined();
  });
});

describe('writes are stamped with the acting tenant', () => {
  it('stamps organization_id on insert without the caller passing it', async () => {
    const [created] = await runAsSystem(orgB, async () => {
      await storage.createBudget({
        budgetName: 'B-budget', amount: '50', period: 'monthly',
        startDate: new Date(), isActive: true,
      } as any);
      return storage.getAllBudgets();
    });
    expect(created.organizationId).toBe(orgB);
  });

  it('ignores an organizationId supplied by the caller on update', async () => {
    // A row must not be able to change tenant, even if a request body says so.
    const [aBudget] = await runAsSystem(orgA, () => storage.getAllBudgets());
    await runAsSystem(orgA, () =>
      storage.updateBudget(aBudget.id, { organizationId: orgB, budgetName: 'A-budget-2' } as any));

    const [after] = await runAsSystem(orgA, () => storage.getAllBudgets());
    expect(after.organizationId).toBe(orgA);
    expect(after.budgetName).toBe('A-budget-2');
  });
});

describe('deleting a tenant', () => {
  it('cascades its data but leaves the other tenant untouched', async () => {
    const temp = await createOrg('itest-tenant-temp');
    await runAsSystem(temp, () => storage.createBudget({
      budgetName: 'temp', amount: '1', period: 'monthly', startDate: new Date(), isActive: true,
    } as any));

    await db.delete(organizations).where(eq(organizations.id, temp));

    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` })
      .from(budgets).where(eq(budgets.organizationId, temp));
    expect(n).toBe(0);

    const survivors = await runAsSystem(orgA, () => storage.getAllBudgets());
    expect(survivors.length).toBeGreaterThan(0);
  });
});
