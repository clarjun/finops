/**
 * GitOps delivery API.
 *
 * Authorization is declared once in server/middleware/route-policy.ts, not
 * here. The split that matters:
 *
 *   raising a pull request   agent:propose  — it creates no infrastructure.
 *                            Merging does, and merging happens in the
 *                            customer's repository under their own review.
 *
 *   storing an access token  account:write  — a token that can open a pull
 *                            request can usually read every repository its
 *                            owner can, so it is a credential like any other.
 */
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { createHmac, timingSafeEqual } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { infraGitConnections, infraStateBackends } from '@shared/schema';
import { currentOrgId, currentUserId, runAsSystem } from '../../tenant-context';
import { encrypt } from '../../encryption';
import { recordAudit } from '../../audit';
import { deliverAsPullRequest, listPullRequests, listAllPullRequests } from './deliver';
import { resolveGitConnection, parseRepo } from './connection';
import {
  appCredentials, findInstallationForRepo, getInstallationToken,
  installationUrl, isAppConfigured, buildManifest, exchangeManifestCode,
  listInstallationRepos, clearInstallationTokenCache, verifyAppCredentials,
  listAllAccessibleRepos,
} from './github-app';
import { githubAppCredentials } from '@shared/schema';
import { GitHubProvider } from './github';
import { GitProviderError } from './types';
import { validateBackend, describeBackend, type BackendConfig, type BackendSettings } from '../terraform/backend';

function fail(res: Response, err: unknown, what: string) {
  if (err instanceof GitProviderError) {
    // The host's own message is the actionable part — "Resource not accessible
    // by personal access token" tells an operator exactly what to fix, and
    // flattening it into a 500 turns a 30-second fix into a support ticket.
    const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 400;
    return res.status(status).json({ error: err.message, detail: err.detail, retryable: err.retryable });
  }
  if (err instanceof z.ZodError) {
    return res.status(400).json({ error: 'Invalid request', details: err.errors });
  }
  console.error(`[GitOps] ${what}:`, err instanceof Error ? err.stack ?? err.message : err);
  res.status(500).json({ error: `Failed to ${what}` });
}

const planIdParam = (req: Request): number => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new GitProviderError('Invalid plan id', null);
  return id;
};

export function registerGitOpsRoutes(app: Express) {

  /* ---- Raise a deployment as a pull request ----------------------------- */

  app.post('/api/infra/plans/:id/pull-request', async (req: Request, res: Response) => {
    try {
      const result = await deliverAsPullRequest(planIdParam(req));
      res.status(result.reused ? 200 : 201).json({
        pullRequest: result.pullRequest,
        reused: result.reused,
        // Said explicitly rather than left for the user to notice: an unchanged
        // plan returning the same URL looks like a failure otherwise.
        message: result.reused
          ? 'This plan has already been raised and nothing has changed since. Returning the existing pull request.'
          : 'Pull request raised.',
      });
    } catch (err) {
      fail(res, err, 'raise pull request');
    }
  });

  app.get('/api/infra/plans/:id/pull-requests', async (req: Request, res: Response) => {
    try {
      res.json({ pullRequests: await listPullRequests(planIdParam(req)) });
    } catch (err) {
      fail(res, err, 'list pull requests');
    }
  });

  app.get('/api/infra/pull-requests', async (req: Request, res: Response) => {
    try {
      res.json({ pullRequests: await listAllPullRequests(Number(req.query.limit) || 50) });
    } catch (err) {
      fail(res, err, 'list pull requests');
    }
  });

  /* ---- Repository connection -------------------------------------------- */

  app.get('/api/infra/git-connection', async (_req: Request, res: Response) => {
    try {
      const resolved = await resolveGitConnection();
      if (!resolved) {
        return res.json({
          connected: false,
          // Only surfaced outside production, because the fallback is refused
          // in production and advertising it there would be misleading.
          devFallbackAvailable: process.env.NODE_ENV !== 'production',
          // Lets the UI offer "Install the GitHub App" instead of asking for a
          // token, but only when this deployment actually has an App.
          appAvailable: await isAppConfigured(),
          appInstallUrl: await installationUrl(),
        });
      }

      // The token is never returned, not even masked: a mask still confirms its
      // length and prefix, and nothing in the UI needs it.
      res.json({
        connected: true,
        provider: resolved.provider.kind,
        repository: resolved.provider.describe(),
        owner: resolved.provider.repo.owner,
        name: resolved.provider.repo.repo,
        basePath: resolved.basePath,
        baseBranch: resolved.baseBranch,
        emitPipeline: resolved.emitPipeline,
        authMethod: resolved.authMethod,
        isDevFallback: resolved.isDevFallback,
        appAvailable: await isAppConfigured(),
      });
    } catch (err) {
      fail(res, err, 'read repository connection');
    }
  });

  /**
   * A real page that carries the manifest form and submits itself to GitHub.
   *
   * The previous version built this form inside an `about:blank` popup from the
   * parent document. That fails in two ways that both end at GitHub's
   * "url wasn't supplied" — its response to a manifest it never received:
   *
   *   1. A just-opened about:blank window may have no document.body yet, so
   *      writing into it from the opener races the popup's own initialisation.
   *   2. If the operator is not signed in to GitHub, the POST is redirected
   *      through the login page and the body is discarded on the way back.
   *
   * Serving an ordinary same-origin page removes the first entirely and makes
   * the second recoverable: the form is still on screen, so signing in and
   * pressing the button again works.
   */
  app.get('/api/infra/git/app/register', async (req: Request, res: Response) => {
    try {
      const name = typeof req.query.name === 'string' && req.query.name.trim()
        ? req.query.name.trim().slice(0, 34)
        : 'CloudWise Infra';
      const organization = typeof req.query.organization === 'string' && req.query.organization.trim()
        ? req.query.organization.trim()
        : null;

      const { manifest, postUrl } = prepareManifest(req, name, organization);

      res.type('html').send(manifestFormPage(manifest, postUrl));
    } catch (err: any) {
      console.error('[GitOps] Could not render the App registration form:', err?.message ?? err);
      res.status(400).type('html').send(
        setupResultPage(false, err?.message ?? 'Could not prepare the GitHub App registration.'),
      );
    }
  });

  /**
   * The manifest the browser POSTs to GitHub to create the App.
   *
   * Returned rather than redirected to, because GitHub requires a form POST
   * with the manifest as a field — a redirect cannot carry it.
   *
   * `state` ties the eventual callback back to this organization. Without it,
   * anyone who obtained a registration code could bind an App they control to
   * someone else's tenant.
   */
  app.post('/api/infra/git/app/manifest', async (req: Request, res: Response) => {
    try {
      const body = z.object({
        name: z.string().min(1).max(34).default('CloudWise Infra'),
        organization: z.string().max(255).nullish(),
      }).parse(req.body ?? {});

      res.json(prepareManifest(req, body.name, body.organization ?? null));
    } catch (err) {
      fail(res, err, 'prepare the GitHub App registration');
    }
  });

  /**
   * GitHub's redirect after the App is created. Exchanges the code for the
   * credentials and stores them.
   *
   * A browser redirect, not an API call, so it answers with HTML that closes
   * the tab and tells the opener what happened — including on failure, which is
   * the whole reason there is no environment fallback to quietly mask it.
   */
  app.get('/api/infra/git/app/setup', async (req: Request, res: Response) => {
    const code = typeof req.query.code === 'string' ? req.query.code : null;
    const state = typeof req.query.state === 'string' ? req.query.state : null;

    try {
      if (!code) throw new GitProviderError('GitHub did not return a registration code.', null);

      const orgId = verifySetupState(state);
      await runAsSystem(orgId, async () => {
        const registered = await exchangeManifestCode(code);

        const stored = {
          appId: registered.appId,
          privateKey: encrypt(registered.privateKey),
          slug: registered.slug,
          clientId: registered.clientId,
          webhookSecret: registered.webhookSecret ? encrypt(registered.webhookSecret) : null,
          lastVerifiedAt: new Date(),
          lastError: null,
        };

        await db
          .insert(githubAppCredentials)
          .values({ organizationId: orgId, ...stored, createdBy: null })
          .onConflictDoUpdate({
            target: [githubAppCredentials.organizationId],
            set: { ...stored, updatedAt: new Date() },
          });

        // A stale token minted under a previous App would otherwise survive the
        // re-registration and fail confusingly an hour later.
        clearInstallationTokenCache();

        void recordAudit({
          action: 'infra.github_app.register',
          resourceType: 'github_app',
          resourceId: registered.appId,
          metadata: { slug: registered.slug },
        });
      });

      res.type('html').send(setupResultPage(true, 'GitHub App created. You can close this tab.'));
    } catch (err: any) {
      console.error('[GitOps] App setup failed:', err?.message ?? err);
      res.status(400).type('html').send(setupResultPage(false, err?.message ?? 'The GitHub App could not be registered.'));
    }
  });

  /** Where GitHub returns after someone installs the App on their repositories. */
  app.get('/api/infra/git/app/installed', async (req: Request, res: Response) => {
    const installationId = typeof req.query.installation_id === 'string' ? req.query.installation_id : null;
    if (!installationId) {
      return res.status(400).type('html').send(setupResultPage(false, 'GitHub did not return an installation.'));
    }
    // Deliberately not stored here: which repository to use has not been chosen
    // yet. The id is handed back to the opener, which then loads the dropdown.
    res.type('html').send(setupResultPage(true, 'Installed. You can close this tab.', { installationId }));
  });

  /**
   * Registers an App that was created by hand.
   *
   * The manifest flow is the intended path and needs none of this. But an
   * operator who was signed out when the manifest POST fired finished GitHub's
   * own form instead, and is now holding a .pem with nowhere to put it. Without
   * this they would have to delete the App and start again.
   *
   * The credentials are PROVED before they are stored — a wrong id, a key from
   * a different App, or an App created without "Contents: write" otherwise all
   * surface identically as a failure at the first pull request, days later.
   */
  app.post('/api/infra/git/app/manual', async (req: Request, res: Response) => {
    try {
      const body = z.object({
        appId: z.string().min(1),
        privateKey: z.string().min(40),
      }).parse(req.body ?? {});

      const verified = await verifyAppCredentials(body.appId, body.privateKey);

      if (verified.missing.length > 0) {
        throw new GitProviderError(
          `The App "${verified.name ?? verified.appId}" is missing ${verified.missing.join(' and ')} ` +
          'permission. Grant Contents: Read and write and Pull requests: Read and write under the ' +
          "App's Permissions, then try again.",
          403,
        );
      }

      const stored = {
        appId: verified.appId,
        // Normalised by verifyAppCredentials before it signed with it, so what
        // is stored is exactly what was proved to work.
        privateKey: encrypt(body.privateKey.trim()),
        slug: verified.slug,
        clientId: null,
        // A hand-made App has a webhook secret only if one was set, and we
        // never receive it. Nothing here consumes webhooks, so nothing is lost.
        webhookSecret: null,
        lastVerifiedAt: new Date(),
        lastError: null,
      };

      await db
        .insert(githubAppCredentials)
        .values({ organizationId: currentOrgId(), ...stored, createdBy: currentUserId() ?? null })
        .onConflictDoUpdate({
          target: [githubAppCredentials.organizationId],
          set: { ...stored, updatedAt: new Date() },
        });

      clearInstallationTokenCache();

      void recordAudit({
        action: 'infra.github_app.register',
        resourceType: 'github_app',
        resourceId: verified.appId,
        metadata: { slug: verified.slug, name: verified.name, method: 'manual' },
      });

      res.json({
        registered: true,
        appId: verified.appId,
        slug: verified.slug,
        name: verified.name,
        installUrl: verified.slug
          ? `https://github.com/apps/${verified.slug}/installations/new`
          : null,
      });
    } catch (err) {
      fail(res, err, 'register the GitHub App');
    }
  });

  /** Registration status, for the settings screen. */
  app.get('/api/infra/git/app', async (_req: Request, res: Response) => {
    try {
      const creds = await appCredentials().catch(() => null);
      res.json({
        registered: creds !== null,
        appId: creds?.appId ?? null,
        slug: creds?.slug ?? null,
        installUrl: await installationUrl(),
      });
    } catch (err) {
      fail(res, err, 'read GitHub App registration');
    }
  });

  /** Removes the registration. The App itself is deleted on GitHub by hand. */
  app.delete('/api/infra/git/app', async (_req: Request, res: Response) => {
    try {
      await db.delete(githubAppCredentials)
        .where(eq(githubAppCredentials.organizationId, currentOrgId()));
      clearInstallationTokenCache();
      void recordAudit({ action: 'infra.github_app.remove', resourceType: 'github_app' });
      res.json({ registered: false });
    } catch (err) {
      fail(res, err, 'remove the GitHub App registration');
    }
  });

  /**
   * The repositories the dropdown offers.
   *
   * Listed from the installation rather than typed by hand, which removes the
   * "connected but the App cannot see that repository" failure entirely: if it
   * is in this list, access already exists.
   */
  app.get('/api/infra/git/repositories', async (req: Request, res: Response) => {
    try {
      const installationId = typeof req.query.installationId === 'string'
        ? req.query.installationId
        : null;

      // Narrowed to one installation when the browser knows which — it does
      // after an install redirect. Otherwise the installations are DISCOVERED.
      //
      // That discovery is the point. Requiring an installation id meant the
      // dropdown only worked when GitHub had redirected back, which only
      // happens when the App has a Setup URL — something an App created by hand
      // does not. A customer could install correctly and still be told to type
      // a repository name, because nobody had told us an id we could have
      // simply asked GitHub for.
      if (installationId) {
        const repositories = (await listInstallationRepos(installationId))
          .map(r => ({ ...r, installationId, account: r.owner }));
        // canWrite defaults to true on this path: the installation's own
        // permissions are not fetched here, and connect-time verification is
        // the authoritative check anyway.
        return res.json({ repositories, installations: [], discovered: false });
      }

      const { repositories, installations, warning } = await listAllAccessibleRepos();
      res.json({ repositories, installations, warning, discovered: true });
    } catch (err) {
      fail(res, err, 'list repositories');
    }
  });

  /**
   * Whether this deployment offers the App, and where to install it.
   *
   * Separate from the connection endpoint because the UI needs it BEFORE any
   * connection exists — this is what replaces "paste a token here".
   */
  app.get('/api/infra/git-connection/app', async (_req: Request, res: Response) => {
    try {
      const creds = await appCredentials();
      res.json({
        available: creds !== null,
        installUrl: await installationUrl(),
        // Named so support can confirm which App a customer installed without
        // asking them to read a URL out over a call.
        appId: creds ? creds.appId : null,
        slug: creds?.slug ?? null,
        reason: creds
          ? null
          : 'No GitHub App has been registered for this organization yet. Set one up to connect a repository.',
      });
    } catch (err) {
      fail(res, err, 'read GitHub App status');
    }
  });

  /**
   * Connects a repository through the App. No token is ever entered or stored.
   *
   * The installation is DISCOVERED from the repository rather than asked for.
   * The alternative is telling someone to dig a numeric id out of a GitHub
   * settings URL, which is exactly the kind of step that sends people back to
   * pasting a personal access token.
   */
  app.post('/api/infra/git-connection/app', async (req: Request, res: Response) => {
    try {
      const body = z.object({
        repository: z.string().min(3),
        baseBranch: z.string().max(255).nullish(),
        basePath: z.string().max(255).default('infrastructure'),
        emitPipeline: z.boolean().default(true),
      }).parse(req.body ?? {});

      if (!(await isAppConfigured())) {
        throw new GitProviderError(
          'No GitHub App is configured for this deployment. Connect with an access token instead.',
          null,
        );
      }

      const repo = parseRepo(body.repository);
      const installation = await findInstallationForRepo(repo.owner, repo.repo);

      // Proved before it is stored, exactly as the token path is. A connection
      // that only fails at the first pull request is worse than one that
      // refuses to save.
      // Checked against the INSTALLATION rather than the repository. A
      // repository response cannot report an App's access — see verify().
      if (!installation.canWrite) {
        const granted = Object.entries(installation.permissions)
          .map(([k, v]) => `${k}: ${v}`).join(', ') || 'none';
        throw new GitProviderError(
          `The App is installed on ${repo.owner}/${repo.repo} but that installation has not been ` +
          `granted write access (it currently has ${granted}). Set Contents and Pull requests to ` +
          '"Read and write" in the App\'s permissions. If the App is already installed, GitHub will ' +
          'ask you to accept the updated permissions before they take effect.',
          403,
        );
      }

      const probe = new GitHubProvider({
        repo,
        token: () => getInstallationToken(installation.installationId, [repo.repo]),
        knownWritable: true,
      });
      // Still called: it proves the token works and reads the default branch,
      // which is what the pull request will be opened against.
      await probe.verify();

      const basePath = body.basePath.replace(/^\/+|\/+$/g, '') || 'infrastructure';
      const shared = {
        provider: 'github' as const,
        repoOwner: repo.owner,
        repoName: repo.repo,
        baseBranch: body.baseBranch ?? null,
        authMethod: 'app' as const,
        // Any previously stored token is dropped. Leaving it behind would keep
        // a live credential we no longer use and nobody remembers is there.
        accessToken: null,
        appInstallationId: installation.installationId,
        basePath,
        emitPipeline: body.emitPipeline,
        lastVerifiedAt: new Date(),
        lastError: null,
      };

      await db
        .insert(infraGitConnections)
        .values({ organizationId: currentOrgId(), ...shared, createdBy: currentUserId() ?? null })
        .onConflictDoUpdate({
          target: [infraGitConnections.organizationId],
          set: { ...shared, updatedAt: new Date() },
        });

      void recordAudit({
        action: 'infra.git_connection.update',
        resourceType: 'infra_git_connection',
        metadata: {
          repository: `${repo.owner}/${repo.repo}`,
          authMethod: 'app',
          installationId: installation.installationId,
          installedOn: installation.account,
          repositorySelection: installation.repositorySelection,
          basePath,
        },
      });

      res.json({
        connected: true,
        authMethod: 'app',
        repository: probe.describe(),
        installedOn: installation.account,
        repositorySelection: installation.repositorySelection,
      });
    } catch (err) {
      fail(res, err, 'connect the GitHub App');
    }
  });

  app.put('/api/infra/git-connection', async (req: Request, res: Response) => {
    try {
      const body = z.object({
        provider: z.literal('github').default('github'),
        repository: z.string().min(3),
        token: z.string().min(8),
        baseBranch: z.string().max(255).nullish(),
        basePath: z.string().max(255).default('infrastructure'),
        emitPipeline: z.boolean().default(true),
      }).parse(req.body ?? {});

      const repo = parseRepo(body.repository);

      // Proved before it is stored. Storing an unusable token means the failure
      // surfaces later, during a deployment, when someone is waiting on it.
      const probe = new GitHubProvider({ repo, token: body.token });
      const { canWrite } = await probe.verify();
      if (!canWrite) {
        throw new GitProviderError(
          `The token can read ${probe.describe()} but not write to it. It needs "Contents: write" and "Pull requests: write".`,
          403,
        );
      }

      const orgId = currentOrgId();
      await db
        .insert(infraGitConnections)
        .values({
          organizationId: orgId,
          provider: body.provider,
          repoOwner: repo.owner,
          repoName: repo.repo,
          baseBranch: body.baseBranch ?? null,
          authMethod: 'pat',
          accessToken: encrypt(body.token),
          // Switching back to a token drops the installation, so a row never
          // carries two credentials and leaves the next reader guessing.
          appInstallationId: null,
          basePath: body.basePath.replace(/^\/+|\/+$/g, '') || 'infrastructure',
          emitPipeline: body.emitPipeline,
          lastVerifiedAt: new Date(),
          lastError: null,
          createdBy: currentUserId() ?? null,
        })
        .onConflictDoUpdate({
          target: [infraGitConnections.organizationId],
          set: {
            provider: body.provider,
            repoOwner: repo.owner,
            repoName: repo.repo,
            baseBranch: body.baseBranch ?? null,
            authMethod: 'pat',
            accessToken: encrypt(body.token),
            appInstallationId: null,
            basePath: body.basePath.replace(/^\/+|\/+$/g, '') || 'infrastructure',
            emitPipeline: body.emitPipeline,
            lastVerifiedAt: new Date(),
            lastError: null,
            updatedAt: new Date(),
          },
        });

      // The repository is recorded; the token never is, here or anywhere else
      // outside the encrypted column.
      void recordAudit({
        action: 'infra.git_connection.update',
        resourceType: 'infra_git_connection',
        metadata: { repository: `${repo.owner}/${repo.repo}`, basePath: body.basePath, emitPipeline: body.emitPipeline },
      });

      res.json({ connected: true, repository: probe.describe() });
    } catch (err) {
      fail(res, err, 'save repository connection');
    }
  });

  app.delete('/api/infra/git-connection', async (_req: Request, res: Response) => {
    try {
      await db.delete(infraGitConnections).where(eq(infraGitConnections.organizationId, currentOrgId()));
      void recordAudit({ action: 'infra.git_connection.delete', resourceType: 'infra_git_connection' });
      res.json({ connected: false });
    } catch (err) {
      fail(res, err, 'remove repository connection');
    }
  });

  /* ---- Terraform state backend ------------------------------------------ */

  app.get('/api/infra/state-backend', async (req: Request, res: Response) => {
    try {
      const provider = String(req.query.provider ?? 'aws');
      const [row] = await db
        .select()
        .from(infraStateBackends)
        .where(and(eq(infraStateBackends.organizationId, currentOrgId()), eq(infraStateBackends.provider, provider)))
        .limit(1);

      if (!row) {
        return res.json({
          configured: false,
          kind: 'local',
          warning:
            'No remote state is configured. Terraform state is kept on the machine that runs the apply and is ' +
            'discarded afterwards, so anything deployed becomes untracked — it cannot later be updated or ' +
            'destroyed by Terraform, and keeps billing.',
        });
      }

      res.json({
        configured: true,
        provider: row.provider,
        kind: row.kind,
        settings: row.settings,
        verifiedAt: row.verifiedAt,
        verificationError: row.verificationError,
      });
    } catch (err) {
      fail(res, err, 'read state backend');
    }
  });

  app.put('/api/infra/state-backend', async (req: Request, res: Response) => {
    try {
      const body = z.object({
        provider: z.string().min(2).max(20).default('aws'),
        kind: z.enum(['s3', 'azurerm', 'gcs', 'local']),
        settings: z.record(z.unknown()).default({}),
      }).parse(req.body ?? {});

      const settings = { kind: body.kind, ...body.settings } as BackendSettings;

      // Validated against a representative key so a bad bucket name is rejected
      // here rather than at `terraform init`, where the error points at a
      // generated file nobody can edit.
      const probe: BackendConfig = { settings, stateKey: 'cloudwise/org-1/plan-1-probe/terraform.tfstate' };
      const errors = validateBackend(probe);
      if (errors.length > 0) {
        return res.status(400).json({ error: 'Invalid state backend configuration', details: errors });
      }

      const orgId = currentOrgId();
      await db
        .insert(infraStateBackends)
        .values({
          organizationId: orgId,
          provider: body.provider,
          kind: body.kind,
          settings: body.settings as never,
          createdBy: currentUserId() ?? null,
        })
        .onConflictDoUpdate({
          target: [infraStateBackends.organizationId, infraStateBackends.provider],
          set: { kind: body.kind, settings: body.settings as never, updatedAt: new Date() },
        });

      void recordAudit({
        action: 'infra.state_backend.update',
        resourceType: 'infra_state_backend',
        metadata: { provider: body.provider, kind: body.kind, location: describeBackend(probe) },
      });

      res.json({ configured: true, kind: body.kind, description: describeBackend(probe) });
    } catch (err) {
      fail(res, err, 'save state backend');
    }
  });
}


// ── Setup-flow helpers ───────────────────────────────────────────────────────

/**
 * Signs the organization id into the `state` GitHub round-trips.
 *
 * The callback arrives as an ordinary browser GET with no session guarantee, so
 * the tenant cannot be read from the request. Signing it means a code cannot be
 * redeemed against an organization the initiator did not own — which would
 * otherwise let someone bind an App they control to another tenant.
 */
export function signSetupState(orgId: number): string {
  const payload = `${orgId}.${Date.now()}`;
  const mac = createHmac('sha256', setupSecret()).update(payload).digest('hex').slice(0, 32);
  return `${payload}.${mac}`;
}

/** Ten minutes. Long enough to click through GitHub, short enough to not linger. */
const SETUP_STATE_TTL_MS = 10 * 60 * 1000;

export function verifySetupState(state: string | null): number {
  if (!state) throw new GitProviderError('The setup link is missing its state parameter.', null);

  const [rawOrg, rawTs, mac] = state.split('.');
  if (!rawOrg || !rawTs || !mac) throw new GitProviderError('The setup state is malformed.', null);

  const expected = createHmac('sha256', setupSecret())
    .update(`${rawOrg}.${rawTs}`).digest('hex').slice(0, 32);

  // Constant time: a fast-failing compare leaks the signature a byte at a time.
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new GitProviderError('The setup state failed verification. Start the setup again.', null);
  }

  if (Date.now() - Number(rawTs) > SETUP_STATE_TTL_MS) {
    throw new GitProviderError('The setup link expired. Start the setup again.', null);
  }

  return Number(rawOrg);
}

function setupSecret(): string {
  const secret = process.env.SESSION_SECRET || process.env.ENCRYPTION_KEY;
  if (!secret) {
    // Refused rather than defaulted: an unsigned state is a forgeable state.
    throw new GitProviderError(
      'Cannot sign the setup callback because neither SESSION_SECRET nor ENCRYPTION_KEY is set.',
      null,
    );
  }
  return secret;
}

/**
 * The page GitHub's redirect lands on.
 *
 * Posts the outcome to the opener so the settings screen can raise a toast, and
 * still says something useful if it was opened directly with no opener.
 */
export function setupResultPage(ok: boolean, message: string, extra: Record<string, unknown> = {}): string {
  // `<` is escaped as well as stringified. JSON.stringify quotes quotes, but it
  // does NOT escape "</script>" — so a message containing one would close the
  // script block and everything after it would be parsed as markup. The message
  // can carry text straight from a GitHub error response, so this is reachable.
  const payload = JSON.stringify({ source: 'cloudwise-github-setup', ok, message, ...extra })
    .replace(/</g, '\\u003c');
  const safe = message.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string));

  return `<!doctype html><meta charset="utf-8"><title>${ok ? 'Connected' : 'Setup failed'}</title>
<style>body{font:15px system-ui;margin:0;display:grid;place-items:center;height:100vh;
background:${ok ? '#f6fdf9' : '#fef6f6'};color:#1f2937}div{text-align:center;max-width:34rem;padding:2rem}
b{display:block;font-size:1.1rem;margin-bottom:.5rem;color:${ok ? '#047857' : '#b91c1c'}}</style>
<div><b>${ok ? 'GitHub connected' : 'Setup failed'}</b><p>${safe}</p></div>
<script>
try { window.opener && window.opener.postMessage(${payload}, window.location.origin); } catch (e) {}
setTimeout(function () { try { window.close(); } catch (e) {} }, ${ok ? 1200 : 6000});
</script>`;
}


/**
 * Builds the manifest and the GitHub URL it is posted to.
 *
 * Shared by the JSON endpoint and the self-submitting page so the two can never
 * drift — a manifest that works in one and not the other is a bug nobody finds
 * until setup fails in front of a customer.
 */
function prepareManifest(
  req: Request,
  name: string,
  organization: string | null,
): { manifest: Record<string, unknown>; state: string; postUrl: string } {
  const orgId = currentOrgId();

  // Derived from the request rather than configured: the callback has to come
  // back to the host the operator is actually using, which a fixed setting gets
  // wrong behind every proxy and on every laptop.
  const proto = (req.headers['x-forwarded-proto'] as string)?.split(',')[0] ?? req.protocol;
  const host = (req.headers['x-forwarded-host'] as string) ?? req.get('host');
  const baseUrl = `${proto}://${host}`;

  const state = signSetupState(orgId);

  return {
    // GitHub App names are globally unique, so a collision is likely on a common
    // name. Suffixed here rather than failing at GitHub with an error the
    // operator cannot act on.
    manifest: buildManifest(`${name} (${orgId})`, baseUrl),
    state,
    postUrl: organization
      ? `https://github.com/organizations/${encodeURIComponent(organization)}/settings/apps/new?state=${encodeURIComponent(state)}`
      : `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`,
  };
}

const htmlAttr = (value: string): string =>
  value.replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));

/**
 * The page that hands the manifest to GitHub.
 *
 * Auto-submits, but keeps a visible button. Auto-submission is blocked in some
 * configurations, and — more commonly — an operator who is not signed in to
 * GitHub is bounced through the login page, which discards the POST body. With
 * the form still on screen they sign in and press the button; with a script-only
 * submit they get GitHub's "url wasn't supplied" and no way forward.
 */
export function manifestFormPage(manifest: Record<string, unknown>, postUrl: string): string {
  const payload = htmlAttr(JSON.stringify(manifest));

  return `<!doctype html><meta charset="utf-8"><title>Creating the GitHub App</title>
<style>
 body{font:15px system-ui;margin:0;display:grid;place-items:center;height:100vh;color:#1f2937;background:#f8fafc}
 div{text-align:center;max-width:32rem;padding:2rem}
 b{display:block;font-size:1.05rem;margin-bottom:.5rem}
 p{color:#475569;line-height:1.5}
 button{font:inherit;padding:.6rem 1.1rem;border:0;border-radius:.4rem;background:#2563eb;color:#fff;cursor:pointer}
</style>
<div>
  <b>Taking you to GitHub&hellip;</b>
  <p>GitHub should show a short <em>Create GitHub App</em> confirmation with the name and
     permissions already filled in.</p>
  <p><strong>If you land on GitHub&rsquo;s long, empty &ldquo;Register new GitHub App&rdquo; form
     instead, you were signed out.</strong> GitHub sent the sign-in page in place of ours and
     dropped the details on the way back. Do not fill that form in by hand &mdash; it cannot
     complete the setup. Sign in to GitHub, come back here and press the button again.</p>
  <form id="f" method="post" action="${htmlAttr(postUrl)}">
    <input type="hidden" name="manifest" value="${payload}">
    <button type="submit">Continue to GitHub</button>
  </form>
</div>
<script>
  // Submitted from the page that owns the form, so there is no cross-document
  // timing to get wrong. A frame gives the button time to paint first, so a
  // bounce through GitHub's login leaves something usable on screen.
  requestAnimationFrame(function () { document.getElementById('f').submit(); });
</script>`;
}
