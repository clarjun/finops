/**
 * The GitHub App setup flow, as the UI sees it.
 *
 * Three steps, each a separate hook, because they happen minutes apart and two
 * of them finish in a popup window rather than in a promise:
 *
 *   1. register  — create the App on GitHub (once per organization)
 *   2. install   — grant it repositories (once, and again whenever they change)
 *   3. connect   — pick which repository this tenant raises pull requests into
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export interface AppRegistration {
  registered: boolean;
  appId: string | null;
  slug: string | null;
  installUrl: string | null;
}

export interface InstallationRepo {
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string | null;
  canWrite: boolean;
  installationId?: string;
  account?: string | null;
}

export interface AppInstallation {
  installationId: string;
  account: string | null;
  accountType: string | null;
  repositorySelection: string | null;
}

export function useAppRegistration() {
  return useQuery<AppRegistration>({
    queryKey: ['/api/infra/git/app'],
    queryFn: () => api('/api/infra/git/app', { what: 'Checking the GitHub App' }),
    staleTime: 30_000,
  });
}

/**
 * Repositories the App can reach. This is the dropdown.
 *
 * Runs with or without an installation id. Without one the server asks GitHub
 * where the App is installed, so the list works even when GitHub never
 * redirected back after the install — which is the normal case for an App that
 * has no Setup URL.
 */
export function useInstallationRepos(installationId: string | null, enabled = true) {
  const qs = installationId ? `?installationId=${encodeURIComponent(installationId)}` : '';

  return useQuery<{
    repositories: InstallationRepo[];
    installations: AppInstallation[];
    warning?: string;
    discovered: boolean;
  }>({
    queryKey: ['/api/infra/git/repositories', installationId ?? 'discover'],
    enabled,
    queryFn: () => api(`/api/infra/git/repositories${qs}`, { what: 'Loading repositories' }),
    staleTime: 30_000,
  });
}

interface ManifestResponse {
  manifest: Record<string, unknown>;
  state: string;
  postUrl: string;
}

/**
 * Opens GitHub's "create App" page with the manifest attached.
 *
 * GitHub needs the manifest as a form POST field — it is too large for a query
 * string — so the popup is pointed at a page on OUR origin that carries the
 * form and submits itself.
 *
 * It used to build that form inside an `about:blank` popup from this document.
 * That reached GitHub without the manifest and produced "url wasn't supplied":
 * a freshly opened about:blank may have no document.body yet, and an operator
 * who is not signed in to GitHub is bounced through login, which discards the
 * POST body. Navigating to a real page removes the first and leaves the second
 * recoverable, because the form is still on screen to press again.
 */
export function useRegisterApp() {
  return useMutation({
    mutationFn: async (input: { name?: string; organization?: string | null }) => {
      const params = new URLSearchParams();
      if (input.name) params.set('name', input.name);
      if (input.organization) params.set('organization', input.organization);

      const url = `/api/infra/git/app/register${params.toString() ? `?${params}` : ''}`;
      const popup = window.open(url, 'cloudwise-github-setup', 'width=980,height=760');

      if (!popup) {
        throw new Error('The browser blocked the GitHub window. Allow pop-ups for this site and try again.');
      }
      return { opened: true };
    },
  });
}

/**
 * Registers an App the operator created by hand.
 *
 * The escape hatch for anyone who finished GitHub's own form — usually because
 * they were signed out when the manifest POST fired. Still database-only and
 * per-organization; the key never goes near a file on the server.
 */
export function useRegisterManualApp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { appId: string; privateKey: string }) =>
      api<AppRegistration & { name: string | null }>('/api/infra/git/app/manual', {
        method: 'POST', body: input, what: 'Registering the GitHub App',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['/api/infra/git/app'] }),
  });
}

export function useRemoveApp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api('/api/infra/git/app', { method: 'DELETE', what: 'Removing the GitHub App' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['/api/infra/git/app'] }),
  });
}

export function useConnectRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      repository: string; baseBranch?: string | null; basePath?: string; emitPipeline?: boolean;
    }) => api('/api/infra/git-connection/app', {
      method: 'POST', body: input, what: 'Connecting the repository',
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['/api/infra/git-connection'] }),
  });
}

export interface SetupMessage {
  source: 'cloudwise-github-setup';
  ok: boolean;
  message: string;
  installationId?: string;
}

/**
 * Listens for the popup reporting back.
 *
 * The setup and install callbacks are plain browser redirects that land on a
 * page GitHub navigated to, so the only way back into the app is postMessage.
 * The origin check matters: without it any page could fake a successful setup.
 */
export function onSetupMessage(handler: (m: SetupMessage) => void): () => void {
  const listener = (event: MessageEvent) => {
    if (event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.source !== 'cloudwise-github-setup') return;
    handler(data as SetupMessage);
  };

  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
