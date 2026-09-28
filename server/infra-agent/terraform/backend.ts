/**
 * Remote state backends.
 *
 * Terraform's state file is its memory: it records that the `web_server` block
 * in the configuration IS instance i-0abc123 in the real account. Without it
 * Terraform has amnesia — it believes nothing exists, so a second apply creates
 * duplicates and a destroy reports "nothing to do" while the infrastructure
 * keeps running and billing.
 *
 * Until this module existed the generated configuration declared no backend at
 * all, which means Terraform defaulted to a LOCAL state file inside
 * tmpdir()/cloudwise-infra/run-<id>/. On Azure Container Apps that directory is
 * ephemeral container storage, and the deployment runs with --max-replicas 3.
 * Two consequences, both of which orphan live infrastructure:
 *
 *   - a container restart, redeploy or scale-in destroys the state, after which
 *     teardown finds nothing to destroy and reports success while the resources
 *     keep costing money;
 *   - a teardown routed to replica B cannot see state written by replica A.
 *
 * A remote backend fixes both, and puts the state in the CUSTOMER's own cloud
 * account, which is also the correct answer for data ownership.
 *
 * ── The constraint that shapes this file ────────────────────────────────────
 *
 * Terraform does not allow variables, locals or interpolation inside a backend
 * block. It is read before the rest of the configuration is evaluated. Every
 * value here must therefore be a literal, which is why nothing in this module
 * accepts an HclRef and why the values are validated rather than parameterised.
 */
import type { HclBlock } from './hcl';

/** Where a deployment's Terraform state is kept. */
export type BackendKind = 's3' | 'azurerm' | 'gcs' | 'local';

export interface S3Backend {
  kind: 's3';
  bucket: string;
  region: string;
  /**
   * DynamoDB table used for state locking. Optional because S3 native locking
   * (use_lockfile) exists on newer Terraform, but strongly recommended: without
   * a lock, two concurrent applies can corrupt state irrecoverably.
   */
  dynamodbTable?: string;
  /** KMS key for state encryption. State contains resource attributes and can contain secrets. */
  kmsKeyId?: string;
}

export interface AzurermBackend {
  kind: 'azurerm';
  resourceGroupName: string;
  storageAccountName: string;
  containerName: string;
}

export interface GcsBackend {
  kind: 'gcs';
  bucket: string;
}

/**
 * No remote backend. Retained deliberately and named honestly rather than
 * being the silent default: a caller that wants local state has to ask for it,
 * and describeBackend() says out loud what that costs.
 */
export interface LocalBackend {
  kind: 'local';
}

export type BackendSettings = S3Backend | AzurermBackend | GcsBackend | LocalBackend;

/** Settings plus the per-deployment path, which is the part that varies per run. */
export interface BackendConfig {
  settings: BackendSettings;
  /**
   * Unique path for THIS deployment's state within the shared bucket.
   * Two deployments sharing a key would have each overwrite the other's record
   * of what exists, so this must be unique and stable for the deployment's life.
   */
  stateKey: string;
}

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Bucket, account and table names are pasted in by an operator and end up in a
 * file that Terraform reads before anything else. hclValue() already escapes
 * them, so this is not the injection guard — it is a configuration guard, so a
 * typo fails here with a clear message instead of inside `terraform init` with
 * a provider error nobody can act on.
 */
const S3_BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const AZURE_STORAGE_ACCOUNT = /^[a-z0-9]{3,24}$/;
const AZURE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,88}$/;
const GCS_BUCKET = /^[a-z0-9][a-z0-9._-]{1,220}$/;
const AWS_REGION = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
const DDB_TABLE = /^[A-Za-z0-9._-]{3,255}$/;

/**
 * State keys become object paths. A key containing `..` or a leading slash
 * could escape the intended prefix and collide with another tenant's state,
 * which is the one failure here that crosses a tenant boundary.
 */
const STATE_KEY = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,255}$/;

export function validateBackend(config: BackendConfig): string[] {
  const errors: string[] = [];
  const { settings, stateKey } = config;

  if (!STATE_KEY.test(stateKey) || stateKey.includes('..') || stateKey.includes('//')) {
    errors.push(
      `State key "${stateKey}" is not a safe object path. Use letters, digits, dot, dash, underscore and slash, with no "..".`,
    );
  }

  switch (settings.kind) {
    case 's3':
      if (!S3_BUCKET.test(settings.bucket)) {
        errors.push(`"${settings.bucket}" is not a valid S3 bucket name.`);
      }
      if (!AWS_REGION.test(settings.region)) {
        errors.push(`"${settings.region}" is not a valid AWS region.`);
      }
      if (settings.dynamodbTable && !DDB_TABLE.test(settings.dynamodbTable)) {
        errors.push(`"${settings.dynamodbTable}" is not a valid DynamoDB table name.`);
      }
      if (!settings.dynamodbTable) {
        errors.push(
          'No DynamoDB lock table configured. Two concurrent applies can corrupt state irrecoverably; ' +
          'create a table with a "LockID" string partition key and set it here.',
        );
      }
      break;

    case 'azurerm':
      if (!AZURE_STORAGE_ACCOUNT.test(settings.storageAccountName)) {
        errors.push(
          `"${settings.storageAccountName}" is not a valid Azure storage account name (3-24 lowercase letters and digits).`,
        );
      }
      if (!AZURE_NAME.test(settings.resourceGroupName)) {
        errors.push(`"${settings.resourceGroupName}" is not a valid resource group name.`);
      }
      if (!AZURE_NAME.test(settings.containerName)) {
        errors.push(`"${settings.containerName}" is not a valid container name.`);
      }
      break;

    case 'gcs':
      if (!GCS_BUCKET.test(settings.bucket)) {
        errors.push(`"${settings.bucket}" is not a valid GCS bucket name.`);
      }
      break;

    case 'local':
      // Not an error — a deliberate choice for sandbox runs. The warning that
      // belongs with it is in describeBackend(), which the UI shows.
      break;
  }

  return errors;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

/**
 * The `backend` block to nest inside `terraform { ... }`.
 *
 * Returns null for a local backend: emitting `backend "local" {}` would pin the
 * state path into the configuration, and the whole point of the local mode is
 * that Terraform's own default handles it.
 */
export function backendBlock(config: BackendConfig): HclBlock | null {
  const errors = validateBackend(config);
  if (errors.length > 0) {
    // Refusing beats emitting a file that fails at `terraform init` with a
    // message pointing at a generated file the user cannot edit.
    throw new Error(`Invalid Terraform backend configuration:\n  - ${errors.join('\n  - ')}`);
  }

  const { settings, stateKey } = config;

  switch (settings.kind) {
    case 'local':
      return null;

    case 's3':
      return {
        type: 'backend',
        labels: ['s3'],
        body: {
          bucket: settings.bucket,
          key: stateKey,
          region: settings.region,
          // State holds resource attributes and can hold generated passwords.
          // Encrypting it is not optional.
          encrypt: true,
          dynamodb_table: settings.dynamodbTable,
          kms_key_id: settings.kmsKeyId,
        },
      };

    case 'azurerm':
      return {
        type: 'backend',
        labels: ['azurerm'],
        body: {
          resource_group_name: settings.resourceGroupName,
          storage_account_name: settings.storageAccountName,
          container_name: settings.containerName,
          key: stateKey,
        },
      };

    case 'gcs':
      return {
        type: 'backend',
        labels: ['gcs'],
        body: {
          bucket: settings.bucket,
          prefix: stateKey,
        },
      };
  }
}

/** One line for the UI and for the pull request body. */
export function describeBackend(config: BackendConfig): string {
  const { settings, stateKey } = config;
  switch (settings.kind) {
    case 's3':
      return `AWS S3 · s3://${settings.bucket}/${stateKey} (${settings.region})` +
        (settings.dynamodbTable ? ` · locked via ${settings.dynamodbTable}` : ' · UNLOCKED');
    case 'azurerm':
      return `Azure Storage · ${settings.storageAccountName}/${settings.containerName}/${stateKey}`;
    case 'gcs':
      return `Google Cloud Storage · gs://${settings.bucket}/${stateKey}`;
    case 'local':
      return 'Local state — NOT durable. The state is lost if the container restarts, which orphans any infrastructure this run creates.';
  }
}

/** True when state survives a container restart. Drives the UI warning. */
export function isDurable(config: BackendConfig): boolean {
  return config.settings.kind !== 'local';
}

/**
 * The state key for a deployment.
 *
 * Includes the organization id so two tenants sharing a bucket — which happens
 * when a partner hosts several customers — cannot collide. Stable for the life
 * of the deployment: deriving it from anything that changes between runs would
 * hide the previous state and cause Terraform to recreate everything.
 */
export function stateKeyFor(organizationId: number, planId: number, name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'deployment';
  return `cloudwise/org-${organizationId}/plan-${planId}-${slug}/terraform.tfstate`;
}

/** The default sandbox backend: explicit, so nothing falls into it silently. */
export const LOCAL_BACKEND: BackendSettings = { kind: 'local' };
