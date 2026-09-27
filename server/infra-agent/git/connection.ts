/**
 * Resolving which repository a tenant's pull requests go to.
 *
 * Two sources, in order:
 *
 *   1. infra_git_connections — the real, per-tenant, encrypted configuration.
 *   2. GITHUB_TOKEN + GITHUB_REPO environment variables — a DEVELOPMENT-ONLY
 *      fallback so the flow can be exercised on a laptop without first building
 *      a settings screen and storing a token.
 *
 * The fallback is refused when NODE_ENV=production, and that refusal is the
 * important line in this file. A shared environment variable in a multi-tenant
 * deployment would mean every tenant's infrastructure was proposed into ONE
 * repository — one customer able to read another customer's architecture, and
 * a merge in that repo applying against an account nobody intended. Convenient
 * locally, a data breach in production.
 */
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { infraGitConnections, type InfraGitConnection } from '@shared/schema';
import { currentOrgId } from '../../tenant-context';
import { decrypt } from '../../encryption';
import { GitHubProvider } from './github';
import { getInstallationToken, isAppConfigured } from './github-app';
import { GitProviderError, type GitProvider } from './types';

export interface ResolvedConnection {
  provider: GitProvider;
  /** Directory inside the repo the Terraform is written under. */
  basePath: string;
  /** Null means "use the repository's live default branch". */
  baseBranch: string | null;
  emitPipeline: boolean;
  /** How the connection authenticates. Shown in settings so it is never a guess. */
  authMethod: 'pat' | 'app';
  /** Null when the environment fallback supplied this. */
  connectionId: number | null;
  /** True when this came from environment variables rather than the database. */
  isDevFallback: boolean;
}

/** "owner/repo" -> {owner, repo}. Rejects anything else rather than guessing. */
export function parseRepo(value: string): { owner: string; repo: string } {
  const cleaned = value
    .trim()
    .replace(/^https?:\/\/[^/]+\//, '')   // tolerate a pasted URL
    .replace(/\.git$/, '')
    .replace(/^\/+|\/+$/g, '');

  const parts = cleaned.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new GitProviderError(
      `"${value}" is not a repository. Use the form owner/repo, for example cirruslabs/cloudwise-infra.`,
      null,
    );
  }

  const NAME = /^[A-Za-z0-9._-]+$/;
  if (!NAME.test(parts[0]) || !NAME.test(parts[1])) {
    throw new GitProviderError(`"${value}" contains characters that are not valid in a repository path.`, null);
  }

  return { owner: parts[0], repo: parts[1] };
}

function fromRow(row: InfraGitConnection): ResolvedConnection {
  if (row.provider !== 'github') {
    throw new GitProviderError(
      `Git provider "${row.provider}" is configured but not implemented yet. Only GitHub is supported today.`,
      null,
    );
  }

  const repo = { owner: row.repoOwner, repo: row.repoName };

  // A GitHub App installation holds no stored credential at all. The token is
  // minted per request and expires in an hour, so what goes to the provider is
  // a FUNCTION rather than a value — capturing a token here would work for the
  // first hour and then 401 in a way that looks like a revoked secret.
  if (row.authMethod === 'app') {
    if (!row.appInstallationId) {
      throw new GitProviderError(
        'This repository is connected through the GitHub App but has no installation recorded. Reconnect it.',
        null,
      );
    }
    if (!isAppConfigured()) {
      throw new GitProviderError(
        'This repository is connected through the GitHub App, but no App is registered for this ' +
        'organization. Register one in Settings, or reconnect using an access token.',
        null,
      );
    }

    const installationId = row.appInstallationId;
    return {
      // Scoped to this one repository even when the installation covers more,
      // so a bug in the delivery code cannot write somewhere unintended.
      provider: new GitHubProvider({
        repo,
        token: () => getInstallationToken(installationId, [row.repoName]),
      }),
      basePath: row.basePath,
      baseBranch: row.baseBranch,
      emitPipeline: row.emitPipeline,
      authMethod: 'app',
      connectionId: row.id,
      isDevFallback: false,
    };
  }

  if (!row.accessToken) {
    throw new GitProviderError(
      'This repository is connected with an access token, but no token is stored. Reconnect it.',
      null,
    );
  }

  let token: string;
  try {
    token = decrypt(row.accessToken);
  } catch (err: any) {
    throw new GitProviderError(
      'The stored access token could not be decrypted. If ENCRYPTION_KEY was rotated, re-enter the token.',
      null,
      err?.message,
    );
  }

  return {
    provider: new GitHubProvider({ repo, token }),
    basePath: row.basePath,
    baseBranch: row.baseBranch,
    emitPipeline: row.emitPipeline,
    authMethod: 'pat',
    connectionId: row.id,
    isDevFallback: false,
  };
}

/**
 * The laptop path.
 *
 * Deliberately narrow: it reads two variables, it never writes to the database,
 * and it refuses outright in production. The alternative — asking a developer
 * to build a settings UI before they can see the feature work once — is how
 * features get "finished" without ever being run end to end.
 */
function fromEnvironment(): ResolvedConnection | null {
  const token = process.env.GITHUB_TOKEN?.trim();
  const repo = process.env.GITHUB_REPO?.trim();
  if (!token || !repo) return null;

  if (process.env.NODE_ENV === 'production') {
    console.error(
      '[GitOps] GITHUB_TOKEN/GITHUB_REPO are set in production and are being IGNORED. ' +
      'A shared repository across tenants would expose one customer\'s architecture to another. ' +
      'Configure a per-tenant connection instead.',
    );
    return null;
  }

  const parsed = parseRepo(repo);
  console.warn(
    `[GitOps] Using the development fallback: pull requests go to ${parsed.owner}/${parsed.repo} ` +
    'from GITHUB_REPO. This is ignored in production.',
  );

  return {
    provider: new GitHubProvider({ repo: parsed, token }),
    basePath: process.env.GITHUB_BASE_PATH?.trim() || 'infrastructure',
    baseBranch: process.env.GITHUB_BASE_BRANCH?.trim() || null,
    emitPipeline: process.env.GITHUB_EMIT_PIPELINE !== 'false',
    authMethod: 'pat',
    connectionId: null,
    isDevFallback: true,
  };
}

/** Resolves the connection for the tenant in the ambient context, or null if none. */
export async function resolveGitConnection(): Promise<ResolvedConnection | null> {
  const [row] = await db
    .select()
    .from(infraGitConnections)
    .where(eq(infraGitConnections.organizationId, currentOrgId()))
    .limit(1);

  // The stored connection always wins. A developer with GITHUB_TOKEN exported
  // must not silently redirect a configured tenant's pull requests to their
  // own sandbox repository.
  if (row) return fromRow(row);

  return fromEnvironment();
}

/** Same, but with a message that says how to fix it rather than returning null. */
export async function requireGitConnection(): Promise<ResolvedConnection> {
  const resolved = await resolveGitConnection();
  if (resolved) return resolved;

  const hint = process.env.NODE_ENV === 'production'
    ? 'Connect a repository in Settings to raise pull requests.'
    : 'Connect a repository in Settings, or for local testing set GITHUB_TOKEN and GITHUB_REPO=owner/repo in .env and restart.';

  throw new GitProviderError(`No Git repository is connected for this organization. ${hint}`, null);
}
