/**
 * Where am I in the AWS cross-account setup, and what is next?
 *
 *   npx tsx server/aws/setup-check.ts
 *
 * Checks each prerequisite in the order it is needed and stops at the first
 * thing that is not done, with the specific action to take. Written because the
 * failure modes here are all "something in a cloud console does not match
 * something else in a different cloud console", and the AWS errors name neither
 * side.
 *
 * Read-only. Creates nothing, changes nothing.
 */
import 'dotenv/config';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { db } from '../db';
import { cloudAccounts } from '@shared/schema';
import { and, eq } from 'drizzle-orm';
import { runAsSystem } from '../tenant-context';
import { parseRoleArn } from './identity';
import { isFederationAvailable, federationDiagnostics } from './entra-federation';

const ok = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const no = (s: string) => console.log(`  \x1b[31m✗\x1b[0m ${s}`);
const info = (s: string) => console.log(`    ${s}`);
const head = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);

let blocked = false;

function next(action: string, detail?: string) {
  if (blocked) return;
  blocked = true;
  console.log(`\n\x1b[33m➜ NEXT STEP\x1b[0m  ${action}`);
  if (detail) console.log(`\n${detail}`);
}

(async () => {
  const ORG = Number(process.env.SETUP_CHECK_ORG_ID) || 1;
  console.log('\nCloudwise AWS setup check');
  console.log('═'.repeat(60));

  /* ── 1. Cloudwise's own identity ───────────────────────────────────────── */
  head('1. Cloudwise principal (the identity that calls AssumeRole)');

  const principalArn = process.env.CLOUDWISE_AWS_PRINCIPAL_ARN;
  const hasEnvKeys = !!process.env.AWS_ACCESS_KEY_ID && !!process.env.AWS_SECRET_ACCESS_KEY;
  const federated = isFederationAvailable();

  if (federated) {
    ok('Entra workload identity federation is configured');
    const diag = await federationDiagnostics();
    if (diag.awsSetup) {
      info(`issuer  : ${diag.claims?.issuer}`);
      info(`audience: ${diag.claims?.audience}`);
      info(`subject : ${diag.claims?.subject}`);
      ok('No long-lived AWS secret is needed by this deployment');
    } else {
      no(`Federation configured but not working: ${diag.error}`);
    }
  } else if (hasEnvKeys) {
    ok('Bootstrap credentials present in the environment');
  } else {
    no('No way to authenticate to AWS');
    next(
      'Create the Cloudwise principal, then set 3 environment variables.',
      [
        '  AWS Console → CloudFormation → Create stack → "Upload a template file"',
        '  File: docs/aws-iam-policies/cloudwise-bootstrap-principal.yaml',
        '  Stack name: cloudwise-bootstrap',
        '  (tick the IAM resource-creation acknowledgement)',
        '',
        '  Then copy the stack Outputs into .env:',
        '    CLOUDWISE_AWS_PRINCIPAL_ARN=<CloudwisePrincipalArn>',
        '    AWS_ACCESS_KEY_ID=<AccessKeyId>',
        '    AWS_SECRET_ACCESS_KEY=<SecretAccessKey>',
      ].join('\n'),
    );
  }

  if (principalArn) {
    ok(`CLOUDWISE_AWS_PRINCIPAL_ARN is set`);
    info(principalArn);
  } else {
    no('CLOUDWISE_AWS_PRINCIPAL_ARN is not set');
    info('The wizard cannot show a customer what to put in their trust policy without it.');
    next('Set CLOUDWISE_AWS_PRINCIPAL_ARN in .env to the bootstrap stack\'s CloudwisePrincipalArn output.');
  }

  /* ── 2. Can we actually reach STS? ─────────────────────────────────────── */
  head('2. STS reachability');
  let callerAccount: string | null = null;
  try {
    const sts = new STSClient({ region: process.env.AWS_STS_REGION || 'us-east-1', maxAttempts: 1 });
    const id = await sts.send(new GetCallerIdentityCommand({}));
    callerAccount = id.Account ?? null;
    ok(`Authenticated to AWS as ${id.Arn}`);
  } catch (err: any) {
    no(`Cannot call STS: ${err?.name ?? 'error'}`);
    info((err?.message ?? '').slice(0, 140));
    next('Fix step 1 before continuing — nothing else can work without an identity.');
  }

  /* ── 3. The connection in Cloudwise ────────────────────────────────────── */
  head('3. AWS connection in Cloudwise');
  const rows = await runAsSystem(ORG, () =>
    db.select().from(cloudAccounts).where(and(
      eq(cloudAccounts.organizationId, ORG),
      eq(cloudAccounts.provider, 'aws'),
    )),
  );

  if (rows.length === 0) {
    no('No AWS connection exists');
    next('Configuration → Add Cloud Account → AWS. Enter your 12-digit account ID and copy the External ID.');
  }

  for (const r of rows) {
    const label = `#${r.id} "${r.accountName}" (${r.accountId})`;

    if (r.authType === 'access_keys') {
      no(`${label} — LEGACY access keys${r.isActive ? ', active' : ', inactive'}`);
      info('This is the connection to replace. Leave it active until the new one validates.');
      continue;
    }

    ok(`${label} — auth_type=assume_role`);
    info(`external ID stored : ${r.externalId ? 'yes' : 'NO'}`);
    info(`read-only role     : ${r.roleArn ?? 'not set'}`);
    info(`remediation role   : ${r.remediationRoleArn ?? 'not set (read-only connection)'}`);
    info(`validated          : ${r.lastValidatedAt ? r.lastValidatedAt.toISOString() : 'never'}`);
    if (r.lastValidationError) info(`last error         : ${r.lastValidationError.slice(0, 120)}`);

    if (!r.roleArn) {
      next(
        `Create the IAM roles in AWS account ${r.accountId}, then paste the role ARN into the wizard.`,
        [
          '  AWS Console → CloudFormation → Create stack → "Upload a template file"',
          '  File: docs/aws-iam-policies/cloudwise-customer-roles.yaml',
          '  Stack name: cloudwise-finops',
          '  Parameters:',
          `    CloudwisePrincipalArn = ${principalArn ?? '<set it in .env first>'}`,
          '    ExternalId            = <the value the wizard showed you>',
          '    EnableRemediation     = false',
        ].join('\n'),
      );
      continue;
    }

    const parsed = parseRoleArn(r.roleArn);
    if (!parsed) no('The stored role ARN is not a valid IAM role ARN');
    else if (parsed.accountId !== r.accountId) {
      no(`Role ARN is for account ${parsed.accountId} but the connection says ${r.accountId}`);
    } else ok('Role ARN account matches the connection');

    if (!r.lastValidatedAt) {
      next('Click "Validate Connection" in the wizard — that performs the real AssumeRole.');
    } else if (!r.isActive) {
      no('Validated but inactive');
    } else {
      ok('Connection is validated and active');
    }
  }

  /* ── 4. What is left ───────────────────────────────────────────────────── */
  head('4. Remaining to reach zero stored secrets');
  const legacy = rows.filter((r) => r.authType === 'access_keys' && r.isActive);
  const roleBased = rows.filter((r) => r.authType === 'assume_role' && r.isActive && r.lastValidatedAt);

  if (roleBased.length > 0 && legacy.length > 0) {
    info(`${roleBased.length} role-based connection(s) working; ${legacy.length} legacy still active.`);
    info('Deactivate the legacy connection, confirm the dashboard, then DELETE the IAM user in AWS.');
  } else if (roleBased.length > 0 && legacy.length === 0) {
    ok('No customer access keys in use');
    if (!federated && hasEnvKeys) {
      info('One bootstrap key remains in the environment.');
      info('Deploy to Azure and configure Entra federation to remove it (docs/aws-security-model.md §8).');
    } else if (federated) {
      ok('No long-lived AWS secret anywhere. This is the end state.');
    }
  } else if (legacy.length > 0) {
    info('Still running entirely on legacy access keys.');
  }

  if (!blocked) console.log('\n\x1b[32m➜ Nothing blocking. Setup looks complete for this stage.\x1b[0m');
  console.log();
  process.exit(0);
})().catch((e) => {
  console.error('\nsetup-check failed:', e?.message ?? e);
  process.exit(1);
});
