/**
 * GitHub App authentication.
 *
 * The alternative this replaces is a personal access token: the customer
 * generates one, pastes it into a form, and we store it encrypted forever. That
 * works, and it has four problems a GitHub App does not.
 *
 *   1. A PAT carries the PERSON'S access, not the integration's. It can reach
 *      every repository that human can reach, including ones nobody intended to
 *      connect. An App installation is granted per repository, by the org.
 *   2. It never expires. A leak is permanent until somebody notices. An
 *      installation token lives one hour and is minted on demand.
 *   3. It dies with the employee. When the person who pasted it leaves and
 *      their account is deprovisioned, pull requests stop with an auth error
 *      that looks like a product bug.
 *   4. Nobody can audit it. Commits appear as that person; an App commits as
 *      itself, so the history says which system opened the change.
 *
 * ── How the credential chain works ──────────────────────────────────────────
 *
 *   private key (registered by the tenant, stored encrypted)
 *        └─ signs a JWT, valid ≤10 minutes, proving "I am this App"
 *              └─ exchanged for an INSTALLATION token, valid 1 hour,
 *                 scoped to the repositories that were granted
 *                    └─ used as a bearer token on the Git Data API
 *
 * Both halves live in the database, per organization. There is no environment
 * fallback: a shared GITHUB_APP_PRIVATE_KEY would mean one customer's pull
 * requests were opened by an App another customer registered, and a missing
 * registration would be papered over instead of reported.
 *
 * ── Why no library ──────────────────────────────────────────────────────────
 *
 * @octokit/auth-app would do this, but the whole of it is one RS256 signature
 * and one POST. Node signs RS256 natively. A dependency here would be more
 * supply-chain surface than code.
 */
import { createSign } from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { githubAppCredentials } from '@shared/schema';
import { currentOrgId } from '../../tenant-context';
import { decrypt } from '../../encryption';
import { GitProviderError } from './types';

const GITHUB_API = process.env.GITHUB_API_URL?.replace(/\/+$/, '') || 'https://api.github.com';

/**
 * GitHub rejects a JWT with exp more than 10 minutes out. Nine leaves room for
 * the clock skew allowance below without crossing the limit.
 */
const JWT_TTL_SECONDS = 9 * 60;

/**
 * GitHub's own guidance: backdate iat to tolerate a fast local clock. A server
 * 30 seconds ahead produces a token GitHub considers issued in the future and
 * rejects with a 401 that reads like a bad key.
 */
const CLOCK_SKEW_SECONDS = 60;

/** Renew this long before expiry, so a request never races the deadline. */
const RENEW_BEFORE_MS = 5 * 60 * 1000;

const b64url = (input: Buffer | string): string =>
  (Buffer.isBuffer(input) ? input : Buffer.from(input))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

export interface AppCredentials {
  appId: string;
  privateKey: string;
  /** Used to build the installation URL. Optional; only affects the UI link. */
  slug: string | null;
}

/**
 * Normalises a PEM that has been through storage or transport.
 *
 * A key arrives base64-encoded or with its newlines escaped depending on how it
 * was handled. Both are accepted because the alternative failure is an opaque
 * signing error at the first pull request, long after setup appeared to work.
 */
export function normalizePrivateKey(raw: string): string | null {
  let key = raw.trim();

  if (!key.includes('-----BEGIN')) {
    try {
      const decoded = Buffer.from(key, 'base64').toString('utf8');
      if (decoded.includes('-----BEGIN')) key = decoded;
    } catch { /* fall through */ }
  }

  key = key.replace(/\\n/g, '\n');
  return key.includes('-----BEGIN') ? key : null;
}

/**
 * The tenant's App credentials, from the database.
 *
 * There is NO environment fallback, by design. An environment variable would be
 * shared across every tenant in a deployment, so one customer's pull requests
 * would be opened by an App another customer registered — and the absence of a
 * registration would be silently papered over instead of reported. A tenant
 * that has not registered gets null, and the caller turns that into a message
 * telling them to register.
 */
export async function appCredentials(): Promise<AppCredentials | null> {
  const [row] = await db
    .select()
    .from(githubAppCredentials)
    .where(eq(githubAppCredentials.organizationId, currentOrgId()))
    .limit(1);

  if (!row) return null;

  let privateKey: string;
  try {
    privateKey = decrypt(row.privateKey);
  } catch (err: any) {
    throw new GitProviderError(
      'The stored GitHub App private key could not be decrypted. If ENCRYPTION_KEY was rotated, ' +
      're-register the GitHub App.',
      null,
      err?.message,
    );
  }

  const normalized = normalizePrivateKey(privateKey);
  if (!normalized) {
    throw new GitProviderError(
      'The stored GitHub App private key is not a usable PEM. Re-register the GitHub App.',
      null,
    );
  }

  return { appId: row.appId, privateKey: normalized, slug: row.slug };
}

/** Whether this tenant has registered an App. */
export async function isAppConfigured(): Promise<boolean> {
  try {
    return (await appCredentials()) !== null;
  } catch {
    // A key that exists but cannot be decrypted is "configured but broken".
    // Reporting it as unconfigured would send someone to register a second App
    // instead of fixing the key.
    return true;
  }
}

/**
 * A short-lived JWT proving we are the App.
 *
 * Signed with the App's private key; GitHub verifies against the public half it
 * holds. This token authenticates the APP, not an installation, so it can only
 * call the handful of /app endpoints — notably not the Git Data API.
 */
export function mintAppJwt(creds: AppCredentials, nowMs: number = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iat: now - CLOCK_SKEW_SECONDS,
    exp: now + JWT_TTL_SECONDS,
    iss: creds.appId,
  };

  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;

  try {
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    signer.end();
    return `${signingInput}.${b64url(signer.sign(creds.privateKey))}`;
  } catch (err: any) {
    throw new GitProviderError(
      'Could not sign the GitHub App token. The private key is not a usable RSA key — ' +
      're-download the .pem from the App settings page.',
      null,
      err?.message,
    );
  }
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

/**
 * Installation tokens, keyed by installation id.
 *
 * Worth caching: every pull request makes several Git Data calls, and minting a
 * token per call would triple the API traffic and the latency for no benefit.
 * Process-local on purpose — a token in a shared cache is a token in one more
 * place, and re-minting after a restart costs one request.
 */
const tokenCache = new Map<string, CachedToken>();

/** Exported for tests, and for the settings screen to force a fresh check. */
export function clearInstallationTokenCache(installationId?: string): void {
  if (installationId) tokenCache.delete(installationId);
  else tokenCache.clear();
}

async function githubJson(path: string, init: RequestInit): Promise<any> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'cloudwise-infra-agent',
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });

  const text = await res.text();
  let payload: any = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }

  if (!res.ok) {
    const detail = payload?.message ?? text.slice(0, 200);
    if (res.status === 401) {
      throw new GitProviderError(
        'GitHub rejected the App credentials. The App may have been deleted on GitHub, or this server\'s ' +
        'clock is wrong — a clock more than a minute fast makes a valid key look invalid. ' +
        'Re-register the App in Settings if it no longer exists.',
        401, detail,
      );
    }
    if (res.status === 404) {
      throw new GitProviderError(
        'The GitHub App installation no longer exists. It was probably uninstalled from the organization. ' +
        'Reconnect the repository to reinstall it.',
        404, detail,
      );
    }
    throw new GitProviderError(`GitHub returned ${res.status} for ${path}.`, res.status, detail);
  }

  return payload;
}

export interface InstallationToken {
  token: string;
  expiresAt: string;
  /** Repositories the token can reach, when the installation is repo-scoped. */
  repositorySelection: string | null;
}

/**
 * An installation access token, minted on demand and cached until it nears
 * expiry.
 *
 * @param repositories when given, the token is scoped to exactly these repos
 *   even if the installation covers more. Least privilege for free: a bug in
 *   the delivery code then cannot write to a repository this tenant did not
 *   nominate.
 */
export async function getInstallationToken(
  installationId: string,
  repositories?: string[],
): Promise<string> {
  const creds = await appCredentials();
  if (!creds) {
    throw new GitProviderError(
      'No GitHub App has been registered for this organization yet. Set it up in Settings before ' +
      'connecting a repository.',
      null,
    );
  }

  // Scoped tokens are cached separately: handing a caller a broader token than
  // it asked for would silently defeat the scoping above.
  // Namespaced by tenant: installation ids come from GitHub and are globally
  // unique, but a cache keyed only on them would be one rename away from
  // serving one organization a token minted for another.
  const cacheKey = [
    currentOrgId(),
    installationId,
    repositories?.length ? [...repositories].sort().join(',') : '*',
  ].join('|');

  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAtMs - RENEW_BEFORE_MS > Date.now()) return cached.token;

  const body = repositories?.length ? JSON.stringify({ repositories }) : undefined;

  const payload = await githubJson(`/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${mintAppJwt(creds)}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body,
  });

  if (!payload?.token || !payload?.expires_at) {
    throw new GitProviderError('GitHub did not return an installation token.', null, JSON.stringify(payload));
  }

  tokenCache.set(cacheKey, {
    token: payload.token,
    expiresAtMs: new Date(payload.expires_at).getTime(),
  });

  return payload.token;
}

export interface InstallationInfo {
  installationId: string;
  account: string | null;
  repositorySelection: string | null;
  /** What this installation granted, e.g. { contents: 'write' }. */
  permissions: Record<string, string>;
  /** True when contents AND pull_requests are both writable. */
  canWrite: boolean;
}

/**
 * Finds the installation covering a repository.
 *
 * Lets the customer paste "owner/repo" and have the installation discovered,
 * rather than asking them to find a numeric id in a GitHub settings URL.
 */
export async function findInstallationForRepo(owner: string, repo: string): Promise<InstallationInfo> {
  const creds = await appCredentials();
  if (!creds) {
    throw new GitProviderError(
      'No GitHub App has been registered for this organization yet. Set it up in Settings first.',
      null,
    );
  }

  let payload: any;
  try {
    payload = await githubJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`, {
      headers: { Authorization: `Bearer ${mintAppJwt(creds)}` },
    });
  } catch (err) {
    // 404 here means "not installed on this repo", which is a setup step the
    // customer can complete — not the broken-installation case the generic
    // handler describes.
    if (err instanceof GitProviderError && err.status === 404) {
      throw new GitProviderError(
        `The GitHub App is not installed on ${owner}/${repo}. Install it on that repository, then connect again.`,
        404,
      );
    }
    throw err;
  }

  if (!payload?.id) {
    throw new GitProviderError(`GitHub returned no installation for ${owner}/${repo}.`, null);
  }

  const permissions: Record<string, string> = payload.permissions ?? {};

  return {
    installationId: String(payload.id),
    account: payload.account?.login ?? null,
    repositorySelection: payload.repository_selection ?? null,
    permissions,
    canWrite: permissions.contents === 'write' && permissions.pull_requests === 'write',
  };
}

/** Where to send someone to install the App. Null until one is registered. */
export async function installationUrl(): Promise<string | null> {
  const creds = await appCredentials().catch(() => null);
  if (!creds?.slug) return null;
  return `https://github.com/apps/${creds.slug}/installations/new`;
}


// ── Registration, via GitHub's App Manifest flow ─────────────────────────────
//
// The flow exists so nobody has to create an App by hand, download a .pem, and
// paste it anywhere. GitHub creates the App from a manifest we supply, then
// hands back the id and private key exactly once.
//
//   1. the browser POSTs `manifest` to github.com/settings/apps/new
//   2. the operator clicks Create; GitHub redirects back with ?code=
//   3. we exchange the code here, and store what comes back
//
// All three steps must complete inside an hour — GitHub's limit on the code.

/** The permissions the App asks for. Deliberately the minimum that works. */
export function buildManifest(appName: string, baseUrl: string): Record<string, unknown> {
  const origin = baseUrl.replace(/\/+$/, '');

  return {
    name: appName,
    url: origin,
    // Where GitHub sends the temporary code in step 2.
    redirect_url: `${origin}/api/infra/git/app/setup`,
    // Where GitHub returns to after someone INSTALLS the app on their repos.
    setup_url: `${origin}/api/infra/git/app/installed`,
    // Installing is what grants repository access, so the customer must land
    // back here afterwards rather than being left on GitHub wondering.
    setup_on_update: true,
    public: false,
    // Nothing in this product listens for webhooks. Leaving them active would
    // mean GitHub retrying deliveries into a void and showing the customer a
    // page of red failures on their own App.
    hook_attributes: { active: false },
    default_events: [],
    default_permissions: {
      // Write the Terraform files and open the pull request. Nothing else.
      contents: 'write',
      pull_requests: 'write',
      // Separate from contents, and easy to miss: GitHub refuses to create or
      // update ANY file under .github/workflows/ without it, with a bare
      // "Resource not accessible by integration". Every pull request carries a
      // workflow file, so without this the very first one fails.
      workflows: 'write',
      // Read-only, so the branch protection state can be reported honestly
      // rather than guessed at.
      metadata: 'read',
    },
  };
}

export interface RegisteredApp {
  appId: string;
  privateKey: string;
  slug: string | null;
  clientId: string | null;
  webhookSecret: string | null;
}

/**
 * Exchanges the temporary manifest code for the App's permanent credentials.
 *
 * This is the only moment GitHub ever reveals the private key. If the response
 * is lost the App has to be deleted and re-registered, so the caller stores it
 * before doing anything else that can fail.
 */
export async function exchangeManifestCode(code: string): Promise<RegisteredApp> {
  const payload = await githubJson(`/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: 'POST',
  }).catch((err) => {
    if (err instanceof GitProviderError && (err.status === 404 || err.status === 422)) {
      throw new GitProviderError(
        'GitHub rejected the registration code. It is single-use and expires an hour after the App is ' +
        'created — start the setup again.',
        err.status,
      );
    }
    throw err;
  });

  const privateKey = typeof payload?.pem === 'string' ? normalizePrivateKey(payload.pem) : null;
  if (!payload?.id || !privateKey) {
    throw new GitProviderError(
      'GitHub created the App but did not return a usable private key. Delete the App on GitHub and ' +
      'run the setup again.',
      null,
    );
  }

  return {
    appId: String(payload.id),
    privateKey,
    slug: payload.slug ?? null,
    clientId: payload.client_id ?? null,
    webhookSecret: payload.webhook_secret ?? null,
  };
}

export interface InstallationRepo {
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string | null;
  /**
   * Whether the App may write here.
   *
   * Comes from the INSTALLATION's permissions, not from the repository's own
   * `permissions` object. That object is the collaborator model — admin /
   * maintain / push / triage / pull — and it does not apply to Apps: GitHub
   * returns every field as false for an installation token, because an App is
   * not a collaborator. Reading `push` from it marks every repository
   * read-only on an installation with full write access, which disables the
   * whole dropdown and looks exactly like a permissions problem on the
   * customer's side.
   */
  canWrite: boolean;
}

/**
 * The repositories an installation can reach.
 *
 * This is what fills the dropdown. Listing them rather than asking someone to
 * type "owner/repo" removes the entire class of "connected, but the App cannot
 * see that repository" failure: if it is in the list, access already exists.
 */
export async function listInstallationRepos(
  installationId: string,
  /** What the installation is allowed to do. Unknown defaults to writable, so a
   *  repository is never hidden on a guess; connect-time verification is the
   *  authoritative check. */
  canWrite = true,
): Promise<InstallationRepo[]> {
  const token = await getInstallationToken(installationId);
  const out: InstallationRepo[] = [];

  // Paginated: an installation granted "all repositories" on a large org can
  // return hundreds, and a silently truncated dropdown is worse than a slow one.
  for (let page = 1; page <= 20; page++) {
    const payload = await githubJson(`/installation/repositories?per_page=100&page=${page}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const batch = payload?.repositories ?? [];
    for (const r of batch) {
      out.push({
        fullName: r.full_name,
        owner: r.owner?.login ?? String(r.full_name ?? '').split('/')[0],
        name: r.name,
        private: !!r.private,
        defaultBranch: r.default_branch ?? null,
        // Set by the caller from the installation's permissions; the
        // repository's own `permissions` object is meaningless for an App.
        canWrite,
      });
    }

    if (batch.length < 100) break;
  }

  return out.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

// ── Manual registration ──────────────────────────────────────────────────────
//
// The manifest flow is the intended path: GitHub creates the App and returns
// its key without anyone handling it. But an operator who has already made an
// App by hand — or who was signed out when the manifest POST fired and finished
// the form GitHub showed them instead — is left holding a .pem with nowhere to
// put it. This is that somewhere.
//
// It is NOT the environment fallback that was deliberately removed: the key is
// stored encrypted in the database, per organization, exactly where the
// manifest exchange puts it.

export interface VerifiedApp {
  appId: string;
  slug: string | null;
  name: string | null;
  htmlUrl: string | null;
  permissions: Record<string, string>;
  /** Permissions the App is missing for the pull-request flow to work. */
  missing: string[];
  /**
   * Missing permissions that only affect the generated CI/CD workflow. The
   * pull request still succeeds without them; it just carries no pipeline.
   */
  missingForPipeline: string[];
}

/** What the App must be able to do before a pull request can be raised. */
const REQUIRED_PERMISSIONS: Record<string, string> = {
  contents: 'write',
  pull_requests: 'write',
};

/**
 * Needed to deliver the CI/CD workflow, but not to deliver Terraform.
 *
 * Reported rather than enforced. An App without it can still raise a pull
 * request containing the configuration; it just cannot include the workflow
 * that applies it. Refusing registration outright would strand anyone whose App
 * was created before this was asked for.
 */
const PIPELINE_PERMISSIONS: Record<string, string> = {
  workflows: 'write',
};

/**
 * Proves a hand-entered App id and private key actually work, and reports what
 * the App can do.
 *
 * Verified before anything is stored. A wrong id, a key belonging to a
 * different App, or an App created without "Contents: write" all produce the
 * same symptom otherwise — a 401 or 403 at the first pull request, days later,
 * with nothing pointing back at the setup screen.
 *
 * `GET /app` is the only endpoint a bare App JWT can call, which makes it both
 * the cheapest and the most direct proof that the pair is valid.
 */
export async function verifyAppCredentials(appId: string, privateKey: string): Promise<VerifiedApp> {
  const normalized = normalizePrivateKey(privateKey);
  if (!normalized) {
    throw new GitProviderError(
      'That does not look like a private key. Open the .pem file GitHub downloaded and paste its ' +
      'whole contents, including the BEGIN and END lines.',
      null,
    );
  }

  if (!/^\d+$/.test(appId.trim())) {
    throw new GitProviderError(
      `"${appId}" is not an App ID. The App ID is the number shown on the App's settings page — ` +
      'not its name and not the Client ID.',
      null,
    );
  }

  const creds: AppCredentials = { appId: appId.trim(), privateKey: normalized, slug: null };

  const app = await githubJson('/app', {
    headers: { Authorization: `Bearer ${mintAppJwt(creds)}` },
  });

  // GitHub answers for whichever App the JWT's `iss` names, so a mismatch here
  // means the id and the key belong to different Apps.
  if (app?.id != null && String(app.id) !== creds.appId) {
    throw new GitProviderError(
      `That private key belongs to App ${app.id}, not App ${creds.appId}. Check you copied the ID ` +
      'and the key from the same App.',
      null,
    );
  }

  const permissions: Record<string, string> = app?.permissions ?? {};
  const shortfall = (required: Record<string, string>) =>
    Object.entries(required)
      .filter(([key, needed]) => permissions[key] !== needed)
      .map(([key]) => key.replace('_', ' '));

  const missing = shortfall(REQUIRED_PERMISSIONS);
  const missingForPipeline = shortfall(PIPELINE_PERMISSIONS);

  return {
    appId: creds.appId,
    slug: app?.slug ?? null,
    name: app?.name ?? null,
    htmlUrl: app?.html_url ?? null,
    permissions,
    missing,
    missingForPipeline,
  };
}

/** One place this App has been installed. */
export interface AppInstallation {
  installationId: string;
  account: string | null;
  accountType: string | null;
  repositorySelection: string | null;
  /** What this installation actually granted, e.g. { contents: 'write' }. */
  permissions: Record<string, string>;
  /** True when contents AND pull_requests are both writable. */
  canWrite: boolean;
}

/**
 * Every installation of this App.
 *
 * Asked of GitHub rather than remembered from the install redirect. The
 * redirect only happens when the App has a Setup URL configured, which one
 * created by hand does not — so a customer could install the App correctly and
 * still be told to type a repository name, because we had simply never been
 * told the installation id.
 *
 * The App JWT can list its own installations, so there is no need to depend on
 * a browser round trip for something GitHub will answer directly.
 */
export async function listAppInstallations(): Promise<AppInstallation[]> {
  const creds = await appCredentials();
  if (!creds) {
    throw new GitProviderError(
      'No GitHub App has been registered for this organization yet. Set it up in Settings first.',
      null,
    );
  }

  const jwt = mintAppJwt(creds);
  const out: AppInstallation[] = [];

  for (let page = 1; page <= 10; page++) {
    const batch = await githubJson(`/app/installations?per_page=100&page=${page}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });

    if (!Array.isArray(batch)) break;

    for (const i of batch) {
      if (i?.id == null) continue;
      const permissions: Record<string, string> = i.permissions ?? {};
      out.push({
        installationId: String(i.id),
        account: i.account?.login ?? null,
        accountType: i.account?.type ?? null,
        repositorySelection: i.repository_selection ?? null,
        permissions,
        // An installation created before the App's permissions were widened
        // keeps the OLD set until the customer accepts the update, so this is
        // read per installation rather than assumed from the App.
        canWrite: permissions.contents === 'write' && permissions.pull_requests === 'write',
      });
    }

    if (batch.length < 100) break;
  }

  return out;
}

/** A repository, carrying the installation that can reach it. */
export interface SelectableRepo extends InstallationRepo {
  installationId: string;
  /** Which account it was installed under, for disambiguating same-named repos. */
  account: string | null;
}

/**
 * Every repository this App can reach, across every installation.
 *
 * What the repository dropdown is built from. One failed installation does not
 * lose the others: a customer with the App on two organizations, one of which
 * has been suspended, should still see the repositories from the other rather
 * than an error.
 */
export async function listAllAccessibleRepos(): Promise<{
  repositories: SelectableRepo[];
  installations: AppInstallation[];
  warning?: string;
}> {
  const installations = await listAppInstallations();
  if (installations.length === 0) {
    return { repositories: [], installations: [] };
  }

  const repositories: SelectableRepo[] = [];
  const failures: string[] = [];

  for (const installation of installations) {
    try {
      const repos = await listInstallationRepos(installation.installationId, installation.canWrite);
      for (const r of repos) {
        repositories.push({
          ...r,
          installationId: installation.installationId,
          account: installation.account,
        });
      }
    } catch (err: any) {
      failures.push(`${installation.account ?? installation.installationId}: ${err?.message ?? err}`);
    }
  }

  repositories.sort((a, b) => a.fullName.localeCompare(b.fullName));

  const stale = installations.filter(i => !i.canWrite).map(i => i.account ?? i.installationId);

  const notes: string[] = [];
  if (failures.length > 0) {
    notes.push(`Could not read repositories for ${failures.length} installation(s): ${failures.join('; ')}`);
  }
  if (stale.length > 0) {
    // Almost always an installation predating a permission change. GitHub
    // keeps it on the old permissions until someone accepts the new ones.
    notes.push(
      `The installation on ${stale.join(', ')} has not been granted write access. ` +
      'Open it on GitHub and accept the updated permissions, then refresh.',
    );
  }

  return {
    repositories,
    installations,
    warning: notes.length > 0 ? notes.join(' ') : undefined,
  };
}
