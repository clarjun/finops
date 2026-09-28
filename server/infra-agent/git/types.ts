/**
 * The contract a Git host must satisfy to receive a generated deployment.
 *
 * Abstract from the first commit, deliberately. CloudWise is hosted on Azure
 * and sells to enterprises, so Azure DevOps will be about as common as GitHub
 * in this customer base, with GitLab behind them. Writing straight against the
 * GitHub API and "abstracting it later" means the second provider arrives as a
 * rewrite of the orchestration rather than a new file.
 *
 * The interface is deliberately small. It describes the five things raising a
 * pull request actually needs, and nothing else — no issues, no reviews, no
 * webhooks. Each can be added when something needs it.
 */

export type GitProviderKind = 'github' | 'gitlab' | 'azure_devops' | 'bitbucket';

export interface RepoRef {
  owner: string;
  repo: string;
}

/** One file in a commit. Content is always UTF-8 text; this never ships binaries. */
export interface FileChange {
  path: string;
  content: string;
}

export interface OpenedPullRequest {
  number: number;
  url: string;
  headBranch: string;
  headSha: string;
}

export interface CommitInput {
  /** Branch to create and commit onto. Must not already exist. */
  branch: string;
  /** Branch the new one is cut from. */
  baseBranch: string;
  files: FileChange[];
  message: string;
}

export interface PullRequestInput {
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
  /**
   * Draft PRs cannot be merged until marked ready. Useful when the generated
   * plan has unsupported nodes, so an incomplete deployment cannot be merged by
   * someone skimming.
   */
  draft?: boolean;
}

export interface GitProvider {
  readonly kind: GitProviderKind;
  readonly repo: RepoRef;

  /** "github.com/acme/infra". For logs, errors and the UI. */
  describe(): string;

  /**
   * Proves the token works and the repository is writable, before anything is
   * generated. Returns the live default branch.
   *
   * Separate from the commit path because failing here costs nothing, whereas
   * discovering a bad token after creating a branch leaves debris in the
   * customer's repository.
   */
  verify(): Promise<{ defaultBranch: string; canWrite: boolean }>;

  branchExists(name: string): Promise<boolean>;

  /**
   * Writes every file in ONE commit.
   *
   * One commit, not one per file: a reviewer should see a single coherent
   * change, and a partially-written branch after a mid-way failure is worse
   * than no branch at all.
   */
  commit(input: CommitInput): Promise<string>;

  openPullRequest(input: PullRequestInput): Promise<OpenedPullRequest>;

  /** Deletes a branch. Used to clean up after a failure part-way through. */
  deleteBranch(name: string): Promise<void>;
}

/**
 * An error carrying what the host actually said.
 *
 * Git hosts return precise, actionable messages — "Resource not accessible by
 * personal access token", "Reference already exists" — and collapsing those
 * into "failed to create pull request" turns a 30-second fix into a support
 * ticket.
 */
export class GitProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly detail?: string,
    /** True when retrying later could plausibly succeed (rate limit, 5xx). */
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'GitProviderError';
  }
}
