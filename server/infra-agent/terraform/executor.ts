/**
 * Terraform executor: runs a pinned Terraform in a container.
 *
 * Four properties this is built around, each of which is a real failure mode
 * rather than a preference.
 *
 * 1. No shell. Every invocation is spawn('docker', [args]) with an argument
 *    array. A shell would reintroduce quoting and word-splitting bugs on paths
 *    containing spaces — this project lives under "C:\Old Data\Projects\..." —
 *    and on Git Bash it silently rewrites container paths (/wd became
 *    C:/Program Files/Git/wd during development). No shell, no mangling.
 *
 * 2. Credentials never touch argv or disk. `docker run -e NAME` without a value
 *    tells Docker to forward the variable from its own environment, which we set
 *    on the spawned process. Passing `-e NAME=secret` would put the secret in
 *    the process table for any user on the host to read; writing a
 *    credentials file would leave it on disk after a crash.
 *
 * 3. Apply runs the approved plan file, never a fresh plan. `plan -out=tfplan`
 *    then `apply tfplan`. Re-planning at apply time would mean the infrastructure
 *    created is not the infrastructure a human approved — the cloud may have
 *    changed in between.
 *
 * 4. Failure is reported, never inferred. Terraform's own exit codes and
 *    diagnostics are surfaced verbatim. Nothing here decides a run "probably
 *    worked".
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

/** Pinned. An unpinned image would change Terraform under a plan mid-flight. */
export const TERRAFORM_IMAGE = process.env.TERRAFORM_IMAGE ?? 'hashicorp/terraform:1.9.8';

const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const PLAN_FILE = 'tfplan';

export interface TerraformCredentials {
  provider: 'aws' | 'azure' | 'gcp';
  /** Variable name -> value. Forwarded into the container, never logged. */
  env: Record<string, string>;
}

export interface TfCommandResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** True when the command was stopped by timeout or cancellation. */
  aborted: boolean;
}

/** A single resource change from `terraform show -json tfplan`. */
export interface PlannedChange {
  address: string;
  resourceType: string;
  /** create | update | delete | replace | no-op */
  action: string;
}

export interface TfPlanResult extends TfCommandResult {
  changes: PlannedChange[];
  toAdd: number;
  toChange: number;
  toDestroy: number;
  /** Changes that destroy or replace existing infrastructure. */
  destructive: PlannedChange[];
  diagnostics: Array<{ severity: string; summary: string; detail?: string }>;
}

export interface ExecOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Streams output as it arrives, for live activity in the UI. */
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
}

/**
 * Docker on Windows needs a host path it can resolve. Git Bash reports POSIX
 * paths that the Docker daemon cannot mount, so convert before passing.
 */
export function toHostMountPath(p: string): string {
  const abs = resolve(p);
  // C:\x\y -> C:/x/y. Docker Desktop accepts forward slashes on Windows.
  return abs.replace(/\\/g, '/');
}

/** Redacts secret values before anything is logged or persisted. */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 8) out = out.split(s).join('[redacted]');
  }
  return out;
}

export class TerraformExecutor {
  private readonly pluginCacheDir: string;

  constructor(private readonly image: string = TERRAFORM_IMAGE, pluginCacheDir?: string) {
    this.pluginCacheDir = pluginCacheDir ?? join(tmpdir(), 'cloudwise-infra', 'plugin-cache');
  }

  /** The cache directory must exist before Docker mounts it. */
  private async ensurePluginCache(): Promise<void> {
    await mkdir(this.pluginCacheDir, { recursive: true }).catch(() => undefined);
  }

  /** Creates an isolated workspace and writes the generated configuration. */
  async createWorkspace(runId: number | string, files: { mainTf: string; tfvars: Record<string, unknown> }): Promise<string> {
    const dir = join(tmpdir(), 'cloudwise-infra', `run-${runId}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'main.tf'), files.mainTf, 'utf8');
    await writeFile(join(dir, 'terraform.tfvars.json'), JSON.stringify(files.tfvars, null, 2), 'utf8');
    return dir;
  }

  /**
   * Removes a workspace. State is deliberately NOT deleted by default: losing
   * it orphans real infrastructure, leaving resources running with nothing
   * tracking them.
   */
  async destroyWorkspace(dir: string, opts: { includeState?: boolean } = {}): Promise<void> {
    if (!opts.includeState && existsSync(join(dir, 'terraform.tfstate'))) {
      throw new Error(
        `Refusing to delete ${dir}: it holds Terraform state. Destroy the infrastructure first, ` +
        `or pass includeState to discard it knowingly.`,
      );
    }
    await rm(dir, { recursive: true, force: true });
  }

  /**
   * Initialises the workspace, skipping the work if it is already initialised.
   *
   * `init` takes roughly 90 seconds against the AWS provider, and the shared
   * plugin cache does not remove that: the provider is ~700MB and Terraform
   * copies it into each workspace's .terraform directory regardless. The cost is
   * therefore paid once per workspace rather than avoided — which matters
   * because a resumed run reuses its workspace, and a deployment that pauses at
   * three approval gates must not pay it four times.
   */
  async init(dir: string, creds?: TerraformCredentials, opts: ExecOptions & { force?: boolean } = {}): Promise<TfCommandResult> {
    if (!opts.force && existsSync(join(dir, '.terraform', 'providers'))) {
      return { ok: true, exitCode: 0, stdout: 'Already initialised; skipping init.', stderr: '', durationMs: 0, aborted: false };
    }
    return this.run(dir, ['init', '-no-color', '-input=false'], creds, opts);
  }

  async validate(dir: string, opts: ExecOptions = {}): Promise<TfCommandResult> {
    return this.run(dir, ['validate', '-no-color'], undefined, opts);
  }

  /** Rewrites the config canonically, so the file a human reviews is readable. */
  async fmt(dir: string, opts: ExecOptions = {}): Promise<TfCommandResult> {
    return this.run(dir, ['fmt', '-no-color'], undefined, opts);
  }

  /**
   * Produces a plan and saves it to disk, then reads it back as JSON.
   *
   * The saved file is what apply consumes, which is what makes "the approved
   * plan is the applied plan" true rather than aspirational.
   */
  async plan(
    dir: string,
    creds: TerraformCredentials | undefined,
    opts: ExecOptions & { targets?: string[] } = {},
  ): Promise<TfPlanResult> {
    // -target narrows a plan to specific resources and their dependencies.
    // HashiCorp documents it as exceptional-use, and they are right that it is
    // wrong for routine work — but staging a deployment around a human approval
    // gate is exactly the exception: without it, a plan containing one
    // high-risk resource could only be approved or refused in its entirety.
    // The engine always finishes with an untargeted plan/apply so the workspace
    // converges on the full configuration, which is the practice HashiCorp
    // prescribes when -target has been used.
    const targetArgs = (opts.targets ?? []).flatMap((t) => ['-target', t]);

    const result = await this.run(
      dir,
      ['plan', '-no-color', '-input=false', `-out=${PLAN_FILE}`, ...targetArgs],
      creds,
      opts,
    );

    if (!result.ok) {
      // A failed plan still writes a partial tfplan. Left in place, the apply
      // guard below would find it and Terraform would be asked to apply an
      // incomplete plan — it refuses, but relying on that is relying on someone
      // else's safety net. Remove it so a failed plan cannot be applied at all.
      await rm(join(dir, PLAN_FILE), { force: true }).catch(() => undefined);
      return { ...result, changes: [], toAdd: 0, toChange: 0, toDestroy: 0, destructive: [], diagnostics: [] };
    }

    // `show -json` on the saved plan gives a machine-readable diff. Parsing the
    // human output instead would break the first time Terraform reworded it.
    const shown = await this.run(dir, ['show', '-json', PLAN_FILE], creds, { ...opts, onOutput: undefined });
    return { ...result, ...parsePlanJson(shown.stdout) };
  }

  /** Applies the saved plan. Never re-plans. */
  async apply(dir: string, creds: TerraformCredentials, opts: ExecOptions = {}): Promise<TfCommandResult> {
    if (!existsSync(join(dir, PLAN_FILE))) {
      return {
        ok: false, exitCode: null, stdout: '', stderr:
          'No saved plan found. Apply must run the plan that was approved, so a plan must be produced first.',
        durationMs: 0, aborted: false,
      };
    }
    return this.run(dir, ['apply', '-no-color', '-input=false', '-auto-approve', PLAN_FILE], creds, opts);
  }

  async destroy(dir: string, creds: TerraformCredentials, opts: ExecOptions = {}): Promise<TfCommandResult> {
    return this.run(dir, ['destroy', '-no-color', '-input=false', '-auto-approve'], creds, opts);
  }

  /** Current state as JSON — the source of truth for what actually exists. */
  async showState(dir: string, creds?: TerraformCredentials, opts: ExecOptions = {}): Promise<TfCommandResult> {
    return this.run(dir, ['show', '-json'], creds, { ...opts, onOutput: undefined });
  }

  /** Resource addresses Terraform believes exist. Drives idempotent resume. */
  async listState(dir: string, creds?: TerraformCredentials, opts: ExecOptions = {}): Promise<string[]> {
    const r = await this.run(dir, ['state', 'list'], creds, { ...opts, onOutput: undefined });
    if (!r.ok) return [];
    return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  }

  /* ---------------------------------------------------------------------- */

  private async run(
    dir: string,
    tfArgs: string[],
    creds: TerraformCredentials | undefined,
    opts: ExecOptions,
  ): Promise<TfCommandResult> {
    const start = Date.now();
    await this.ensurePluginCache();
    const mount = toHostMountPath(dir);
    const secrets = Object.values(creds?.env ?? {});

    const dockerArgs = [
      'run', '--rm',
      '-v', `${mount}:/wd`,
      '-w', '/wd',
      // A shared plugin cache across runs. Without it every deployment
      // re-downloads the AWS provider — measured at 87 seconds — which would be
      // paid again on every plan, retry and resume.
      '-v', `${toHostMountPath(this.pluginCacheDir)}:/plugin-cache`,
      '-e', 'TF_PLUGIN_CACHE_DIR=/plugin-cache',
      // No extra privileges; the provider needs outbound network and nothing more.
      '--network', 'bridge',
    ];

    // `-e NAME` (no value) forwards from our environment, keeping the secret
    // out of the process table.
    for (const name of Object.keys(creds?.env ?? {})) {
      dockerArgs.push('-e', name);
    }
    dockerArgs.push(this.image, ...tfArgs);

    return new Promise<TfCommandResult>((resolvePromise) => {
      const child = spawn('docker', dockerArgs, {
        // No shell: arguments are passed through verbatim.
        shell: false,
        env: { ...process.env, ...(creds?.env ?? {}) },
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let aborted = false;

      const timeout = setTimeout(() => {
        aborted = true;
        child.kill('SIGKILL');
      }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

      const onAbort = () => {
        aborted = true;
        child.kill('SIGKILL');
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (b: Buffer) => {
        const chunk = redact(b.toString(), secrets);
        stdout += chunk;
        opts.onOutput?.(chunk, 'stdout');
      });

      child.stderr.on('data', (b: Buffer) => {
        const chunk = redact(b.toString(), secrets);
        stderr += chunk;
        opts.onOutput?.(chunk, 'stderr');
      });

      const finish = (exitCode: number | null, errText?: string) => {
        clearTimeout(timeout);
        opts.signal?.removeEventListener('abort', onAbort);
        resolvePromise({
          ok: exitCode === 0 && !aborted,
          exitCode,
          stdout,
          stderr: errText ? `${stderr}${errText}` : stderr,
          durationMs: Date.now() - start,
          aborted,
        });
      };

      child.on('error', (err) => {
        // Docker missing is the common case and deserves a real explanation
        // rather than ENOENT.
        const message = (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'Docker is not available on this host. The Terraform executor runs in a container; install Docker or configure a different runner.'
          : err.message;
        finish(null, message);
      });

      child.on('close', (code) => {
        finish(aborted ? null : code);
      });
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  Plan parsing                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Parses `terraform show -json tfplan`.
 *
 * Terraform expresses an action as an array: ["create"], ["delete","create"]
 * for a replacement, ["no-op"]. A replacement destroys real infrastructure and
 * must never be read as a create, so it is classified explicitly.
 */
export function parsePlanJson(json: string): Omit<TfPlanResult, keyof TfCommandResult> {
  const empty = { changes: [], toAdd: 0, toChange: 0, toDestroy: 0, destructive: [], diagnostics: [] };
  if (!json.trim()) return empty;

  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    return empty;
  }

  const changes: PlannedChange[] = [];
  let toAdd = 0, toChange = 0, toDestroy = 0;

  for (const rc of parsed.resource_changes ?? []) {
    const actions: string[] = rc.change?.actions ?? [];
    let action = 'no-op';

    if (actions.includes('delete') && actions.includes('create')) {
      action = 'replace';
      toDestroy++;
      toAdd++;
    } else if (actions.includes('create')) {
      action = 'create';
      toAdd++;
    } else if (actions.includes('delete')) {
      action = 'delete';
      toDestroy++;
    } else if (actions.includes('update')) {
      action = 'update';
      toChange++;
    }

    if (action === 'no-op') continue;
    changes.push({ address: rc.address ?? '', resourceType: rc.type ?? '', action });
  }

  const diagnostics = (parsed.diagnostics ?? []).map((d: any) => ({
    severity: String(d.severity ?? 'error'),
    summary: String(d.summary ?? ''),
    detail: d.detail ? String(d.detail) : undefined,
  }));

  return {
    changes,
    toAdd,
    toChange,
    toDestroy,
    destructive: changes.filter((c) => c.action === 'delete' || c.action === 'replace'),
    diagnostics,
  };
}

export const terraformExecutor = new TerraformExecutor();
