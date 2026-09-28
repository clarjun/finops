import { describe, it, expect } from 'vitest';
import { buildDeploymentFiles, buildPullRequestBody, type DeploymentFilesInput } from './files';
import type { GeneratedConfig } from '../terraform/generator';

const generated = (over: Partial<GeneratedConfig> = {}): GeneratedConfig => ({
  mainTf: 'terraform {\n  backend "s3" {}\n}\n',
  tfvars: { region: 'us-east-1', name_prefix: 'web-prod' },
  addressByNode: {},
  nodeByAddress: {},
  unsupported: [],
  resourceCount: 12,
  backendDescription: 'AWS S3 · s3://cw-state/org-1/x/terraform.tfstate (us-east-1) · locked via cw-locks',
  ...over,
});

const input = (over: Partial<DeploymentFilesInput> = {}): DeploymentFilesInput => ({
  basePath: 'infrastructure',
  slug: 'payments-api-7',
  planName: 'Payments API',
  environment: 'production',
  region: 'us-east-1',
  provider: 'aws',
  generated: generated(),
  estimatedMonthlyCost: 430.5,
  backendDescription: generated().backendDescription,
  emitPipeline: true,
  ...over,
});

const find = (files: ReturnType<typeof buildDeploymentFiles>, suffix: string) =>
  files.find(f => f.path.endsWith(suffix));

describe('deployment file set', () => {
  it('writes terraform, vars, readme and pipeline under the configured path', () => {
    const files = buildDeploymentFiles(input());
    const paths = files.map(f => f.path);

    expect(paths).toContain('infrastructure/payments-api-7/main.tf');
    expect(paths).toContain('infrastructure/payments-api-7/terraform.tfvars.json');
    expect(paths).toContain('infrastructure/payments-api-7/README.md');
    expect(paths).toContain('.github/workflows/cloudwise-payments-api-7.yml');
  });

  it('omits the pipeline when the tenant does not want one', () => {
    const files = buildDeploymentFiles(input({ emitPipeline: false }));
    expect(files.some(f => f.path.startsWith('.github/'))).toBe(false);
    // And the README must then say how to apply it by hand, or the change is
    // unactionable for whoever merges it.
    expect(find(files, 'README.md')!.content).toContain('terraform apply tfplan');
  });

  it('normalises a base path given with slashes', () => {
    const files = buildDeploymentFiles(input({ basePath: '/infra/' }));
    expect(files[0].path).toBe('infra/payments-api-7/main.tf');
  });

  it('commits the generated terraform verbatim', () => {
    // The file a reviewer reads must be byte-identical to the one that runs.
    const cfg = generated({ mainTf: 'resource "aws_s3_bucket" "b" {}\n' });
    const files = buildDeploymentFiles(input({ generated: cfg }));
    expect(find(files, 'main.tf')!.content).toBe('resource "aws_s3_bucket" "b" {}\n');
  });

  it('writes tfvars as valid JSON', () => {
    const files = buildDeploymentFiles(input());
    expect(JSON.parse(find(files, 'terraform.tfvars.json')!.content)).toEqual({
      region: 'us-east-1', name_prefix: 'web-prod',
    });
  });
});

describe('README', () => {
  it('leads with cost, resource count and state location', () => {
    const readme = find(buildDeploymentFiles(input()), 'README.md')!.content;
    expect(readme).toContain('$430.50/month');
    expect(readme).toContain('| Resources | 12 |');
    expect(readme).toContain('s3://cw-state');
  });

  it('warns loudly when there is no remote state', () => {
    // The failure this guards against is silent: merge, create real resources,
    // lose the state with the runner, and they become untracked and unkillable
    // by Terraform while still billing.
    const readme = find(
      buildDeploymentFiles(input({ backendDescription: null, generated: generated({ backendDescription: null }) })),
      'README.md',
    )!.content;

    expect(readme).toContain('local — not durable');
    expect(readme).toMatch(/orphan/i);
    expect(readme).toMatch(/billing/i);
  });

  it('names what the agent could not build', () => {
    const cfg = generated({ unsupported: [{ nodeKey: 'cache.redis', reason: 'no mapper' }] as never });
    const readme = find(buildDeploymentFiles(input({ generated: cfg })), 'README.md')!.content;
    expect(readme).toContain('Not included');
    expect(readme).toContain('cache.redis');
  });
});

describe('generated pipeline', () => {
  const yml = (over: Partial<DeploymentFilesInput> = {}) =>
    find(buildDeploymentFiles(input(over)), '.yml')!.content;

  it('plans on the pull request and applies only after merge', () => {
    const content = yml();
    expect(content).toContain("if: github.event_name == 'pull_request'");
    expect(content).toContain("if: github.event_name == 'push'");
  });

  it('never applies from a pull request', () => {
    // A fork's PR must not be able to trigger an apply into the customer's
    // account. The apply job is gated on push, which forks cannot cause.
    const content = yml();
    const applyJob = content.slice(content.indexOf('  apply:'));
    expect(applyJob).toContain("if: github.event_name == 'push'");
    expect(applyJob).not.toContain('pull_request');
  });

  it('applies a saved plan file rather than re-planning', () => {
    // `terraform apply` with no plan file re-plans at apply time, so what is
    // built is not what was reviewed.
    const content = yml();
    expect(content).toContain('terraform plan -out=tfplan');
    expect(content).toContain('terraform apply -input=false -auto-approve tfplan');
  });

  it('serialises applies so two runs cannot corrupt one state file', () => {
    expect(yml()).toContain('concurrency:');
    expect(yml()).toContain('cancel-in-progress: false');
  });

  it('uses OIDC and requests id-token when a role is available', () => {
    const content = yml({ awsRoleArn: 'arn:aws:iam::111122223333:role/cloudwise-deploy' });
    expect(content).toContain('role-to-assume: arn:aws:iam::111122223333:role/cloudwise-deploy');
    expect(content).toContain('id-token: write');
    // No long-lived credential should appear at all on this path.
    expect(content).not.toContain('AWS_SECRET_ACCESS_KEY');
  });

  it('falls back to repository secrets when no role is configured', () => {
    const content = yml();
    expect(content).toContain('secrets.AWS_ACCESS_KEY_ID');
    expect(content).not.toContain('id-token: write');
  });

  it('grants least privilege by default', () => {
    expect(yml()).toContain('contents: read');
  });
});

describe('pull request body', () => {
  const body = (over: Partial<DeploymentFilesInput> = {}) =>
    buildPullRequestBody({
      ...input(over),
      requirements: 'A payments API for 500 concurrent users with a managed database.',
      riskLevel: 'high',
      riskReasons: ['creates an IAM role', 'creates a publicly routable load balancer'],
      raisedBy: 'arjun',
    });

  it('leads with the numbers a reviewer decides on', () => {
    const content = body();
    expect(content).toContain('**12**');
    expect(content).toContain('**$430.50/month**');
    expect(content).toContain('`high`');
  });

  it('quotes the original requirement', () => {
    expect(body()).toContain('> A payments API for 500 concurrent users');
  });

  it('lists why the change needs a careful read', () => {
    expect(body()).toContain('creates an IAM role');
  });

  it('warns about missing remote state', () => {
    const content = body({ backendDescription: null, generated: generated({ backendDescription: null }) });
    expect(content).toContain('No remote state');
    expect(content).toMatch(/untracked/i);
  });

  it('states who applies it, so nobody assumes CloudWise does', () => {
    expect(body()).toMatch(/CloudWise does not run the apply/);
    expect(body({ emitPipeline: false })).toMatch(/Apply the configuration manually/);
  });

  it('attributes the request', () => {
    expect(body()).toContain('arjun');
  });
});
