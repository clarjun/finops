/**
 * Tenant isolation for AWS credential resolution.
 *
 * Every test here corresponds to a way one customer could end up holding
 * another customer's cloud access. They run against the real database because
 * the isolation being tested is the SQL predicate itself.
 */
import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { cloudAccounts, organizations } from '@shared/schema';
import { encrypt } from '../encryption';
import { runAsSystem } from '../tenant-context';
import { generateExternalId } from './identity';
import {
  loadAwsConnection,
  resolveAwsCredentials,
  invalidateAwsSessions,
  AwsAuthError,
} from './credential-provider';

/** High ids, so a failed cleanup cannot collide with real tenants. */
const ORG_A = 990001;
const ORG_B = 990002;
const created: number[] = [];

async function seedOrg(id: number, slug: string) {
  await db.insert(organizations)
    .values({ id, name: `Test Org ${id}`, slug, plan: 'enterprise' })
    .onConflictDoNothing();
}

async function seedConnection(orgId: number, accountId: string, suffix: string) {
  const [row] = await db.insert(cloudAccounts).values({
    organizationId: orgId,
    provider: 'aws',
    accountName: `acct-${orgId}`,
    accountId,
    credentials: encrypt(JSON.stringify({})) as never,
    authType: 'assume_role',
    roleArn: `arn:aws:iam::${accountId}:role/CloudwiseReadOnly${suffix}`,
    remediationRoleArn: `arn:aws:iam::${accountId}:role/CloudwiseRemediation${suffix}`,
    externalId: encrypt(generateExternalId()),
    isActive: true,
  }).returning({ id: cloudAccounts.id });
  created.push(row.id);
  return row.id;
}

let connA = 0;
let connB = 0;

beforeAll(async () => {
  await seedOrg(ORG_A, 'test-org-aws-a');
  await seedOrg(ORG_B, 'test-org-aws-b');
  connA = await seedConnection(ORG_A, '111111111111', 'A');
  connB = await seedConnection(ORG_B, '222222222222', 'B');
});

afterAll(async () => {
  invalidateAwsSessions();
  if (created.length > 0) {
    await db.delete(cloudAccounts).where(inArray(cloudAccounts.id, created));
  }
  await db.delete(organizations).where(inArray(organizations.id, [ORG_A, ORG_B]));
});

describe('tenant isolation', () => {
  it('loads only the calling tenant\'s connection', async () => {
    const a = await runAsSystem(ORG_A, () => loadAwsConnection());
    const b = await runAsSystem(ORG_B, () => loadAwsConnection());

    expect(a?.accountId).toBe('111111111111');
    expect(b?.accountId).toBe('222222222222');
  });

  it('refuses to load another tenant\'s connection by id', async () => {
    // The attack: tenant A supplies tenant B's connection id explicitly.
    expect(await runAsSystem(ORG_A, () => loadAwsConnection(connB))).toBeNull();
    expect(await runAsSystem(ORG_B, () => loadAwsConnection(connA))).toBeNull();
  });

  it('refuses to resolve credentials for another tenant\'s connection', async () => {
    await expect(
      runAsSystem(ORG_A, () => resolveAwsCredentials('readonly', connB)),
    ).rejects.toThrow(AwsAuthError);
  });

  it('throws rather than falling back when there is no tenant context', async () => {
    // The important property is that it does NOT quietly return some tenant's
    // connection when the caller forgot to establish context.
    await expect(loadAwsConnection()).rejects.toThrow();
  });
});

describe('credential hygiene', () => {
  it('keeps the External ID encrypted at the connection layer', async () => {
    const c = await runAsSystem(ORG_A, () => loadAwsConnection(connA));
    expect(c?.externalId).toBeTruthy();
    // Only the credential provider decrypts it, and only to hand to STS.
    expect(c!.externalId).not.toMatch(/^cloudwise-/);
  });

  it('returns a provider function rather than a resolved credential', async () => {
    // The SDK must be able to re-invoke it near expiry; handing back a plain
    // object is how a 45-minute operation dies holding a 60-minute credential.
    const provider = await runAsSystem(ORG_A, () => resolveAwsCredentials('readonly', connA));
    expect(typeof provider).toBe('function');
  });

  it('refuses remediation when the connection has no remediation role', async () => {
    await db.update(cloudAccounts)
      .set({ remediationRoleArn: null })
      .where(and(eq(cloudAccounts.id, connA), eq(cloudAccounts.organizationId, ORG_A)));
    invalidateAwsSessions(connA);

    const provider = await runAsSystem(ORG_A, () => resolveAwsCredentials('remediation', connA));
    // Resolution is lazy; the refusal surfaces when credentials are demanded.
    await expect(provider()).rejects.toThrow(/no remediation role/i);
  });
});
