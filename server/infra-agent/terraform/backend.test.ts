import { describe, it, expect } from 'vitest';
import {
  backendBlock,
  validateBackend,
  describeBackend,
  isDurable,
  stateKeyFor,
  type BackendConfig,
} from './backend';
import { renderBlock } from './hcl';

const s3 = (over: Partial<Extract<BackendConfig['settings'], { kind: 's3' }>> = {}): BackendConfig => ({
  settings: { kind: 's3', bucket: 'cloudwise-tfstate-acme', region: 'us-east-1', dynamodbTable: 'cloudwise-locks', ...over },
  stateKey: 'cloudwise/org-1/plan-7-web/terraform.tfstate',
});

describe('backend validation', () => {
  it('accepts a complete S3 backend', () => {
    expect(validateBackend(s3())).toEqual([]);
  });

  it('demands a lock table', () => {
    // Without a lock two concurrent applies corrupt state irrecoverably, and
    // the damage is not reversible from the Terraform side.
    const errors = validateBackend(s3({ dynamodbTable: undefined }));
    expect(errors.some(e => /lock/i.test(e))).toBe(true);
  });

  it('rejects a malformed bucket, region and table', () => {
    expect(validateBackend(s3({ bucket: 'Not_A_Bucket' }))).not.toEqual([]);
    expect(validateBackend(s3({ region: 'nowhere' }))).not.toEqual([]);
    expect(validateBackend(s3({ dynamodbTable: 'no spaces allowed' }))).not.toEqual([]);
  });

  it('rejects a state key that could escape its prefix', () => {
    // The one validation failure here that crosses a tenant boundary: a key
    // containing ".." could resolve into another tenant's state path.
    const traversal = { ...s3(), stateKey: 'cloudwise/org-1/../org-2/terraform.tfstate' };
    expect(validateBackend(traversal)).not.toEqual([]);

    const absolute = { ...s3(), stateKey: '/etc/terraform.tfstate' };
    expect(validateBackend(absolute)).not.toEqual([]);

    const doubleSlash = { ...s3(), stateKey: 'cloudwise//terraform.tfstate' };
    expect(validateBackend(doubleSlash)).not.toEqual([]);
  });

  it('validates Azure and GCS shapes', () => {
    const azure: BackendConfig = {
      settings: { kind: 'azurerm', resourceGroupName: 'rg-cloudwise', storageAccountName: 'cwstate001', containerName: 'tfstate' },
      stateKey: 'org-1/plan-2.tfstate',
    };
    expect(validateBackend(azure)).toEqual([]);

    // Azure storage account names are 3-24 lowercase alphanumerics; uppercase
    // is a common and confusing failure at `terraform init`.
    expect(validateBackend({ ...azure, settings: { ...azure.settings, storageAccountName: 'CWState' } as never })).not.toEqual([]);

    const gcs: BackendConfig = { settings: { kind: 'gcs', bucket: 'cloudwise-state' }, stateKey: 'org-1/plan-2' };
    expect(validateBackend(gcs)).toEqual([]);
  });

  it('treats local state as valid but not durable', () => {
    const local: BackendConfig = { settings: { kind: 'local' }, stateKey: 'unused' };
    expect(validateBackend(local)).toEqual([]);
    expect(isDurable(local)).toBe(false);
    expect(describeBackend(local)).toMatch(/orphan/i);
  });
});

describe('backend rendering', () => {
  it('emits a complete, encrypted, locked S3 backend', () => {
    const hcl = renderBlock(backendBlock(s3())!);
    expect(hcl).toContain('backend "s3"');
    expect(hcl).toContain('bucket = "cloudwise-tfstate-acme"');
    expect(hcl).toContain('key = "cloudwise/org-1/plan-7-web/terraform.tfstate"');
    expect(hcl).toContain('dynamodb_table = "cloudwise-locks"');
    // State holds resource attributes and can hold generated passwords.
    expect(hcl).toContain('encrypt = true');
  });

  it('omits optional keys rather than emitting empty strings', () => {
    const hcl = renderBlock(backendBlock(s3({ kmsKeyId: undefined }))!);
    expect(hcl).not.toContain('kms_key_id');
  });

  it('emits nothing for local state', () => {
    // Emitting backend "local" would pin a path into a generated file; the
    // point of local mode is that Terraform's own default handles it.
    expect(backendBlock({ settings: { kind: 'local' }, stateKey: 'x' })).toBeNull();
  });

  it('refuses to render an invalid configuration', () => {
    // Failing here beats failing inside `terraform init`, where the error points
    // at a generated file the user cannot edit.
    expect(() => backendBlock(s3({ bucket: 'BAD BUCKET' }))).toThrow(/Invalid Terraform backend/);
  });

  it('renders azurerm and gcs', () => {
    const azure = renderBlock(backendBlock({
      settings: { kind: 'azurerm', resourceGroupName: 'rg-cw', storageAccountName: 'cwstate001', containerName: 'tfstate' },
      stateKey: 'org-1/plan-2.tfstate',
    })!);
    expect(azure).toContain('backend "azurerm"');
    expect(azure).toContain('storage_account_name = "cwstate001"');

    const gcs = renderBlock(backendBlock({
      settings: { kind: 'gcs', bucket: 'cw-state' }, stateKey: 'org-1/plan-2',
    })!);
    expect(gcs).toContain('backend "gcs"');
    expect(gcs).toContain('prefix = "org-1/plan-2"');
  });
});

describe('stateKeyFor', () => {
  it('separates tenants sharing one bucket', () => {
    // Partners host several customers in one account; identical keys would mean
    // each tenant's state overwrote the other's record of what exists.
    expect(stateKeyFor(1, 7, 'web')).not.toBe(stateKeyFor(2, 7, 'web'));
    expect(stateKeyFor(1, 7, 'web')).toContain('org-1');
  });

  it('separates plans within a tenant', () => {
    expect(stateKeyFor(1, 7, 'web')).not.toBe(stateKeyFor(1, 8, 'web'));
  });

  it('is stable for the same inputs', () => {
    // A key that changed between runs would hide the previous state and make
    // Terraform recreate everything it had already built.
    expect(stateKeyFor(3, 9, 'Payments API')).toBe(stateKeyFor(3, 9, 'Payments API'));
  });

  it('produces a safe path from an arbitrary name', () => {
    const key = stateKeyFor(1, 2, '../../etc/passwd & friends!!');
    expect(key).not.toContain('..');
    expect(validateBackend({ settings: { kind: 'gcs', bucket: 'cw-state' }, stateKey: key })).toEqual([]);
  });

  it('survives a name with no usable characters', () => {
    const key = stateKeyFor(1, 2, '!!!');
    expect(key).toContain('deployment');
    expect(validateBackend({ settings: { kind: 'gcs', bucket: 'cw-state' }, stateKey: key })).toEqual([]);
  });
});
