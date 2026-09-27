/**
 * GitHub implementation of GitProvider.
 *
 * Uses the Git Data API (blobs -> tree -> commit -> ref) rather than the much
 * simpler Contents API. The Contents API writes one file per request and
 * therefore one COMMIT per file: a four-file deployment would appear in review
 * as four commits, and a failure after the second would leave a branch holding
 * half a deployment. The Git Data API builds the whole tree first and moves the
 * branch once, so the branch either exists complete or does not exist.
 *
 * No SDK. @octokit/rest is a large dependency for six endpoints, and the
 * interesting behaviour here is error translation, which an SDK would hide
 * behind its own error types anyway.
 */
import {
  GitProviderError,
  type CommitInput,
  type FileChange,
  type GitProvider,
  type OpenedPullRequest,
  type PullRequestInput,
  type RepoRef,
} from './types';

const API = 'https://api.github.com';
/** Pinned. GitHub dates its REST API and an unpinned client drifts silently. */
const API_VERSION = '2022-11-28';
const TIMEOUT_MS = 30_000;

/**
 * How to authenticate.
 *
 * A string is a personal access token, which never changes. A function is a
 * GitHub App installation, whose token expires every hour and is re-minted on
 * demand — so the credential has to be resolved per request, not captured once
 * at construction. Holding a string there would work for the first hour and
 * then start failing with a 401 that looks like a revoked token.
 */
export type GitHubAuth = string | (() => Promise<string>);

export interface GitHubOptions {
  repo: RepoRef;
  token: GitHubAuth;
  /** For GitHub Enterprise Server. Defaults to github.com. */
  baseUrl?: string;
}

export class GitHubProvider implements GitProvider {
  readonly kind = 'github' as const;
  readonly repo: RepoRef;
  private readonly auth: GitHubAuth;
  private readonly baseUrl: string;

  constructor(opts: GitHubOptions) {
    this.repo = opts.repo;
    this.auth = opts.token;
    this.baseUrl = (opts.baseUrl ?? API).replace(/\/+$/, '');
  }

  describe(): string {
    const host = this.baseUrl === API ? 'github.com' : new URL(this.baseUrl).host;
    return `${host}/${this.repo.owner}/${this.repo.repo}`;
  }

  // ── HTTP ────────────────────────────────────────────────────────────────────

  /** Resolved per request: an App token is only valid for an hour. */
  private async bearer(): Promise<string> {
    return typeof this.auth === 'string' ? this.auth : this.auth();
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const token = await this.bearer();

    // AbortSignal.timeout rather than a manual setTimeout: a hung socket to
    // api.github.com would otherwise stall the request handler indefinitely.
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': API_VERSION,
          'User-Agent': 'cloudwise-infra-agent',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err: any) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw new GitProviderError(
        timedOut
          ? `GitHub did not respond within ${TIMEOUT_MS / 1000}s`
          : `Could not reach GitHub: ${err?.message ?? err}`,
        null,
        undefined,
        true,
      );
    }

    if (res.status === 204) return undefined as T;

    const text = await res.text();
    const payload = text ? safeJson(text) : null;

    if (!res.ok) throw this.translate(res, payload, method, path);
    return payload as T;
  }

  /**
   * Turns a GitHub error response into something an operator can act on.
   *
   * The generic "request failed" is useless here: the three failures that
   * actually happen — token lacks scope, repo name wrong, branch already
   * exists — each have a specific fix, and GitHub already says which it is.
   */
  private translate(res: Response, payload: any, method: string, path: string): GitProviderError {
    const detail: string | undefined =
      payload?.message ??
      (Array.isArray(payload?.errors) ? payload.errors.map((e: any) => e.message ?? e.code).join('; ') : undefined);

    const remaining = res.headers.get('x-ratelimit-remaining');

    if (res.status === 401) {
      return new GitProviderError(
        'GitHub rejected the access token. It is invalid, expired, or revoked.',
        401, detail,
      );
    }

    if (res.status === 403 && remaining === '0') {
      const reset = res.headers.get('x-ratelimit-reset');
      const when = reset ? new Date(Number(reset) * 1000).toISOString() : 'shortly';
      return new GitProviderError(`GitHub rate limit exhausted. Resets at ${when}.`, 403, detail, true);
    }

    if (res.status === 403) {
      return new GitProviderError(
        `The token cannot perform this action on ${this.describe()}. It needs repository "Contents: write" ` +
        'and "Pull requests: write" permission.',
        403, detail,
      );
    }

    if (res.status === 404) {
      // 404 is also what GitHub returns for a private repo the token cannot
      // see, so saying only "not found" sends people hunting for a typo that
      // is not there.
      return new GitProviderError(
        `${this.describe()} was not found, or the token cannot see it. Check the owner and repository ` +
        'name, and that the token has access to private repositories if this one is private.',
        404, detail,
      );
    }

    if (res.status === 422) {
      return new GitProviderError(`GitHub rejected the request: ${detail ?? 'validation failed'}`, 422, detail);
    }

    if (res.status >= 500) {
      return new GitProviderError(`GitHub returned ${res.status}. This is usually transient.`, res.status, detail, true);
    }

    return new GitProviderError(
      `GitHub ${method} ${path} failed with ${res.status}${detail ? `: ${detail}` : ''}`,
      res.status, detail,
    );
  }

  private get repoPath(): string {
    return `/repos/${encodeURIComponent(this.repo.owner)}/${encodeURIComponent(this.repo.repo)}`;
  }

  // ── GitProvider ─────────────────────────────────────────────────────────────

  async verify(): Promise<{ defaultBranch: string; canWrite: boolean }> {
    const repo = await this.request<{ default_branch: string; permissions?: { push?: boolean; admin?: boolean } }>(
      'GET', this.repoPath,
    );

    // `permissions` is absent for some token types rather than false. Treating
    // absent as "cannot write" would reject working setups, so absence is
    // optimistic and the real proof is the commit attempt.
    const canWrite = repo.permissions === undefined
      ? true
      : Boolean(repo.permissions.push || repo.permissions.admin);

    return { defaultBranch: repo.default_branch, canWrite };
  }

  async branchExists(name: string): Promise<boolean> {
    try {
      await this.request('GET', `${this.repoPath}/git/ref/heads/${encodeURIComponent(name)}`);
      return true;
    } catch (err) {
      if (err instanceof GitProviderError && err.status === 404) return false;
      throw err;
    }
  }

  async commit(input: CommitInput): Promise<string> {
    const { branch, baseBranch, files, message } = input;

    if (files.length === 0) {
      throw new GitProviderError('Refusing to create an empty commit.', null);
    }

    // 1. Where the base branch currently points.
    const baseRef = await this.request<{ object: { sha: string } }>(
      'GET', `${this.repoPath}/git/ref/heads/${encodeURIComponent(baseBranch)}`,
    );
    const baseSha = baseRef.object.sha;

    const baseCommit = await this.request<{ tree: { sha: string } }>(
      'GET', `${this.repoPath}/git/commits/${baseSha}`,
    );

    // 2. Upload contents as blobs. Sequential on purpose: a parallel burst of
    //    blob writes is the fastest way to hit GitHub's secondary rate limit,
    //    and a deployment is a handful of files, not hundreds.
    const blobs: Array<{ path: string; sha: string }> = [];
    for (const file of files) {
      const blob = await this.request<{ sha: string }>('POST', `${this.repoPath}/git/blobs`, {
        content: Buffer.from(file.content, 'utf8').toString('base64'),
        encoding: 'base64',
      });
      blobs.push({ path: file.path, sha: blob.sha });
    }

    // 3. A tree layered over the base, so untouched files are preserved.
    //    Without base_tree the commit would delete the entire repository.
    const tree = await this.request<{ sha: string }>('POST', `${this.repoPath}/git/trees`, {
      base_tree: baseCommit.tree.sha,
      tree: blobs.map((b) => ({ path: b.path, mode: '100644', type: 'blob', sha: b.sha })),
    });

    // 4. The commit.
    const commit = await this.request<{ sha: string }>('POST', `${this.repoPath}/git/commits`, {
      message,
      tree: tree.sha,
      parents: [baseSha],
    });

    // 5. Point the new branch at it. Until this call the repository is
    //    unchanged — everything above is content-addressed and unreferenced,
    //    so a failure before here leaves nothing behind.
    await this.request('POST', `${this.repoPath}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: commit.sha,
    });

    return commit.sha;
  }

  async openPullRequest(input: PullRequestInput): Promise<OpenedPullRequest> {
    const pr = await this.request<{ number: number; html_url: string; head: { sha: string; ref: string } }>(
      'POST', `${this.repoPath}/pulls`,
      {
        title: input.title,
        body: input.body,
        head: input.branch,
        base: input.baseBranch,
        draft: input.draft ?? false,
        maintainer_can_modify: true,
      },
    );

    return {
      number: pr.number,
      url: pr.html_url,
      headBranch: pr.head.ref,
      headSha: pr.head.sha,
    };
  }

  async deleteBranch(name: string): Promise<void> {
    try {
      await this.request('DELETE', `${this.repoPath}/git/refs/heads/${encodeURIComponent(name)}`);
    } catch (err) {
      // Cleanup is best-effort by definition: it runs on a path that is
      // already failing, and turning a cleanup failure into the reported error
      // would hide the original cause.
      if (err instanceof GitProviderError && err.status === 404) return;
      console.warn(`[GitHub] Could not delete branch ${name}:`, (err as Error).message);
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // GitHub returns HTML for some proxy and maintenance errors. Carrying the
    // first line beats discarding the only evidence of what happened.
    return { message: text.slice(0, 300) };
  }
}
