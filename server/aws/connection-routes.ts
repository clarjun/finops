/**
 * AWS cross-account connection API.
 *
 *   POST   /api/aws/connections              begin onboarding, mint an External ID
 *   POST   /api/aws/connections/:id/validate prove the role can be assumed
 *   GET    /api/aws/connections              list (metadata only)
 *   GET    /api/aws/connections/:id          one connection (metadata only)
 *   PATCH  /api/aws/connections/:id          set or change role ARNs
 *   DELETE /api/aws/connections/:id          revoke
 *
 * The invariant across all of them: **no response ever contains a credential.**
 * Not the External ID after creation, not temporary STS credentials, not the
 * legacy access keys. The External ID is returned exactly once, at creation,
 * because the customer must paste it into their trust policy — after that it is
 * write-only from the API's point of view.
 */
import type { Express, Response } from 'express';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db';
import { cloudAccounts } from '@shared/schema';
import { encrypt } from '../encryption';
import { currentOrgId, currentUserId } from '../tenant-context';
import { recordAudit } from '../audit';
import { generateExternalId, isValidRoleArn, parseRoleArn } from './identity';
import {
  loadAwsConnection,
  resolveAwsCredentials,
  verifyAssumedIdentity,
  invalidateAwsSessions,
  AwsAuthError,
} from './credential-provider';
import { federationDiagnostics } from './entra-federation';

/** 12 digits, exactly. */
const accountIdSchema = z.string().regex(/^\d{12}$/, 'AWS account ID must be 12 digits');

const roleArnSchema = z.string().refine(isValidRoleArn, {
  message: 'Must be a valid IAM role ARN, e.g. arn:aws:iam::123456789012:role/RoleName',
});

/**
 * What a client is allowed to see.
 *
 * Built by explicit allow-list rather than by deleting fields from the row: a
 * column added later is then invisible by default instead of leaking until
 * someone notices. `externalId` and `credentials` are deliberately absent.
 */
function publicConnection(row: typeof cloudAccounts.$inferSelect) {
  return {
    id: row.id,
    provider: row.provider,
    accountName: row.accountName,
    accountId: row.accountId,
    authType: row.authType,
    roleArn: row.roleArn,
    remediationRoleArn: row.remediationRoleArn,
    deployRoleArn: row.deployRoleArn,
    /** Read-only until a remediation role exists — surfaced so the UI can say so. */
    capabilities: {
      read: !!row.roleArn || row.authType === 'access_keys',
      remediate: !!row.remediationRoleArn,
      deploy: !!row.deployRoleArn,
    },
    isActive: row.isActive,
    lastValidatedAt: row.lastValidatedAt,
    lastValidationError: row.lastValidationError,
    lastSyncAt: row.lastSyncAt,
    createdAt: row.createdAt,
  };
}

function fail(res: Response, err: unknown, what: string) {
  if (err instanceof z.ZodError) {
    return res.status(400).json({ error: 'Invalid request', details: err.errors });
  }
  if (err instanceof AwsAuthError) {
    // Already written for a human and carries no credential material.
    return res.status(400).json({ error: err.message, code: err.code, retryable: err.retryable });
  }
  console.error(`[AWS Connections] ${what}:`, (err as Error)?.message ?? err);
  return res.status(500).json({ error: `Failed to ${what}` });
}

export function registerAwsConnectionRoutes(app: Express) {

  /**
   * Step 1 of onboarding: register the account and mint the External ID.
   *
   * Created before the role exists, deliberately. The customer cannot write the
   * trust policy until they have the External ID, and they cannot give us a role
   * ARN until the role exists — so the connection starts in a pending state and
   * the role ARN arrives later via PATCH.
   */
  app.post('/api/aws/connections', async (req, res) => {
    try {
      const body = z.object({
        accountId: accountIdSchema,
        accountName: z.string().min(1).max(255),
      }).parse(req.body);

      const organizationId = currentOrgId();

      const [existing] = await db.select({ id: cloudAccounts.id }).from(cloudAccounts).where(and(
        eq(cloudAccounts.organizationId, organizationId),
        eq(cloudAccounts.provider, 'aws'),
        eq(cloudAccounts.accountId, body.accountId),
        eq(cloudAccounts.isActive, true),
      )).limit(1);

      if (existing) {
        // Two active connections to one account would double-count spend in the
        // fact store, which is the hardest kind of error to notice.
        return res.status(409).json({
          error: `AWS account ${body.accountId} is already connected to this organization.`,
          connectionId: existing.id,
        });
      }

      const externalId = generateExternalId();

      const [created] = await db.insert(cloudAccounts).values({
        organizationId,
        provider: 'aws',
        accountName: body.accountName,
        accountId: body.accountId,
        // No static credentials exist for a role-based connection. The column is
        // NOT NULL for the legacy path, so an encrypted empty object stands in.
        credentials: encrypt(JSON.stringify({})) as never,
        authType: 'assume_role',
        externalId: encrypt(externalId),
        // Inactive until validation succeeds, so a half-configured connection is
        // never picked up by ingestion.
        isActive: false,
      }).returning();

      await recordAudit({
        action: 'aws.connection.created',
        outcome: 'success',
        resourceType: 'cloud_account',
        resourceId: String(created.id),
        // Metadata records WHAT was configured, never the External ID itself.
        metadata: { awsAccountId: body.accountId, authType: 'assume_role' },
      });

      res.json({
        connection: publicConnection(created),
        // Returned exactly once. The customer needs it for the trust policy, and
        // it is never readable again through any endpoint.
        externalId,
        cloudwisePrincipal: process.env.CLOUDWISE_AWS_PRINCIPAL_ARN ?? null,
        nextStep: 'Create the IAM role in your AWS account using the External ID above, then submit the role ARN.',
      });
    } catch (err) { fail(res, err, 'create the AWS connection'); }
  });

  /** Step 2: record the role ARNs the customer created. */
  app.patch('/api/aws/connections/:id', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const body = z.object({
        roleArn: roleArnSchema.optional(),
        remediationRoleArn: roleArnSchema.nullable().optional(),
        deployRoleArn: roleArnSchema.nullable().optional(),
        accountName: z.string().min(1).max(255).optional(),
      }).parse(req.body);

      const organizationId = currentOrgId();
      const [row] = await db.select().from(cloudAccounts).where(and(
        eq(cloudAccounts.id, id),
        eq(cloudAccounts.organizationId, organizationId),
        eq(cloudAccounts.provider, 'aws'),
      ));
      if (!row) return res.status(404).json({ error: 'AWS connection not found' });

      // Every supplied ARN must name the account this connection is registered
      // for. Checked here as well as at assume time, so a mismatch is rejected
      // at configuration rather than surfacing later as a confusing AWS error.
      for (const [field, arn] of Object.entries(body)) {
        if (field === 'accountName' || !arn) continue;
        const parsed = parseRoleArn(arn as string);
        if (parsed && parsed.accountId !== row.accountId) {
          return res.status(400).json({
            error: `The ${field} belongs to AWS account ${parsed.accountId}, but this connection ` +
                   `is registered for ${row.accountId}.`,
          });
        }
      }

      const [updated] = await db.update(cloudAccounts).set({
        ...(body.roleArn !== undefined ? { roleArn: body.roleArn } : {}),
        ...(body.remediationRoleArn !== undefined ? { remediationRoleArn: body.remediationRoleArn } : {}),
        ...(body.deployRoleArn !== undefined ? { deployRoleArn: body.deployRoleArn } : {}),
        ...(body.accountName !== undefined ? { accountName: body.accountName } : {}),
        updatedAt: new Date(),
      }).where(and(
        eq(cloudAccounts.id, id),
        eq(cloudAccounts.organizationId, organizationId),
      )).returning();

      // Cached sessions were minted against the previous roles.
      invalidateAwsSessions(id);

      await recordAudit({
        action: 'aws.connection.updated',
        outcome: 'success',
        resourceType: 'cloud_account',
        resourceId: String(id),
        metadata: { changed: Object.keys(body) },
      });

      res.json({ connection: publicConnection(updated) });
    } catch (err) { fail(res, err, 'update the AWS connection'); }
  });

  /**
   * Step 3: prove it works.
   *
   * Assumes the role, then asks AWS who we became and checks it against the
   * account this connection claims. The role ARN arrives from a form, so the
   * account inside it is an assertion until GetCallerIdentity confirms it —
   * without that check a customer could register an ARN for an account they do
   * not own and Cloudwise would read a third party's costs.
   */
  app.post('/api/aws/connections/:id/validate', async (req, res) => {
    const id = Number(req.params.id);
    const organizationId = currentOrgId();

    try {
      const conn = await loadAwsConnection(id)
        ?? (await db.select().from(cloudAccounts).where(and(
              eq(cloudAccounts.id, id),
              eq(cloudAccounts.organizationId, organizationId),
              eq(cloudAccounts.provider, 'aws'),
            )).limit(1)).map((r) => ({
              id: r.id, organizationId: r.organizationId, accountId: r.accountId,
              accountName: r.accountName, authType: r.authType, roleArn: r.roleArn,
              remediationRoleArn: r.remediationRoleArn, deployRoleArn: r.deployRoleArn,
              externalId: r.externalId, credentials: r.credentials,
            }))[0];

      if (!conn) return res.status(404).json({ error: 'AWS connection not found' });

      if (!conn.roleArn && conn.authType === 'assume_role') {
        return res.status(400).json({
          error: 'No role ARN has been configured yet. Submit the read-only role ARN first.',
          code: 'no_role_for_tier',
        });
      }

      invalidateAwsSessions(id);

      const provider = await resolveAwsCredentials('readonly', id);
      const credentials = await provider();
      const identity = await verifyAssumedIdentity(credentials, conn.accountId);

      // Activated only now. A connection that cannot be assumed must never be
      // visible to ingestion, or it produces a stream of failed runs.
      await db.update(cloudAccounts).set({
        isActive: true,
        lastValidatedAt: new Date(),
        lastValidationError: null,
        updatedAt: new Date(),
      }).where(and(eq(cloudAccounts.id, id), eq(cloudAccounts.organizationId, organizationId)));

      await recordAudit({
        action: 'aws.connection.validated',
        outcome: 'success',
        resourceType: 'cloud_account',
        resourceId: String(id),
        metadata: { awsAccountId: identity.accountId, assumedArn: identity.arn },
      });

      res.json({
        status: 'connected',
        account: identity.accountId,
        // The assumed-role ARN, which names the role but contains no secret.
        role: identity.arn,
        authentication: 'AWS STS AssumeRole',
        permissions: conn.remediationRoleArn ? 'read-only + remediation' : 'read-only',
        capabilities: {
          read: true,
          remediate: !!conn.remediationRoleArn,
          deploy: !!conn.deployRoleArn,
        },
        validatedAt: new Date().toISOString(),
      });
    } catch (err) {
      // Recorded on the row so the UI can show why without re-running a
      // potentially throttled AWS call.
      const message = err instanceof AwsAuthError
        ? err.message
        : 'Validation failed for an unexpected reason.';

      await db.update(cloudAccounts).set({
        isActive: false,
        lastValidationError: message,
        updatedAt: new Date(),
      }).where(and(eq(cloudAccounts.id, id), eq(cloudAccounts.organizationId, organizationId)))
        .catch(() => undefined);

      await recordAudit({
        action: 'aws.connection.validation_failed',
        outcome: 'failure',
        resourceType: 'cloud_account',
        resourceId: String(id),
        metadata: { reason: err instanceof AwsAuthError ? err.code : 'unknown' },
      }).catch(() => undefined);

      fail(res, err, 'validate the AWS connection');
    }
  });

  /**
   * GET /api/aws/federation — how Cloudwise itself authenticates to AWS.
   *
   * Returns the CLAIMS of a real Entra token and the exact AWS IAM values to
   * configure against them. Configuring the OIDC provider from documentation
   * rather than from an actual token is the main way this setup fails: Azure's
   * managed-identity endpoint issues an issuer of the form
   * `https://sts.windows.net/<tenant>/`, not the v2.0 URL most guides show, and
   * AWS compares it as an exact string.
   *
   * Exposes no token and no credential — only iss, aud, sub and expiry.
   */
  app.get('/api/aws/federation', async (_req, res) => {
    try {
      const diag = await federationDiagnostics();
      res.json({
        mode: diag.available ? 'entra_workload_identity' : 'default_credential_chain',
        ...diag,
        note: diag.available
          ? 'No long-lived AWS secret is used by this deployment.'
          : 'Falling back to the AWS SDK default chain (environment keys, or an AWS instance role).',
      });
    } catch (err) { fail(res, err, 'read federation diagnostics'); }
  });

  app.get('/api/aws/connections', async (_req, res) => {
    try {
      const rows = await db.select().from(cloudAccounts).where(and(
        eq(cloudAccounts.organizationId, currentOrgId()),
        eq(cloudAccounts.provider, 'aws'),
      )).orderBy(desc(cloudAccounts.createdAt));

      res.json({ connections: rows.map(publicConnection) });
    } catch (err) { fail(res, err, 'list AWS connections'); }
  });

  app.get('/api/aws/connections/:id', async (req, res) => {
    try {
      const [row] = await db.select().from(cloudAccounts).where(and(
        eq(cloudAccounts.id, Number(req.params.id)),
        eq(cloudAccounts.organizationId, currentOrgId()),
        eq(cloudAccounts.provider, 'aws'),
      ));
      if (!row) return res.status(404).json({ error: 'AWS connection not found' });
      res.json({ connection: publicConnection(row) });
    } catch (err) { fail(res, err, 'load the AWS connection'); }
  });

  /**
   * Revoke.
   *
   * Deactivates rather than deletes: cost facts reference the connection, and
   * the audit trail of what it did must outlive it. The customer should also
   * delete the IAM role on their side — the response says so, because a
   * connection removed here with the role left in place leaves a trust
   * relationship pointing at Cloudwise forever.
   */
  app.delete('/api/aws/connections/:id', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const organizationId = currentOrgId();

      const [row] = await db.update(cloudAccounts).set({
        isActive: false,
        updatedAt: new Date(),
      }).where(and(
        eq(cloudAccounts.id, id),
        eq(cloudAccounts.organizationId, organizationId),
        eq(cloudAccounts.provider, 'aws'),
      )).returning();

      if (!row) return res.status(404).json({ error: 'AWS connection not found' });

      invalidateAwsSessions(id);

      await recordAudit({
        action: 'aws.connection.revoked',
        outcome: 'success',
        resourceType: 'cloud_account',
        resourceId: String(id),
        metadata: { awsAccountId: row.accountId, revokedBy: currentUserId() ?? null },
      });

      res.json({
        success: true,
        message:
          `Connection to AWS account ${row.accountId} revoked. Cloudwise will no longer assume the role. ` +
          `Delete the Cloudwise IAM roles in your AWS account to remove the trust relationship entirely.`,
      });
    } catch (err) { fail(res, err, 'revoke the AWS connection'); }
  });
}
