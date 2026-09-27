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
}

export function useAppRegistration() {
  return useQuery<AppRegistration>({
    queryKey: ['/api/infra/git/app'],
    queryFn: () => api('/api/infra/git/app', { what: 'Checking the GitHub App' }),
    staleTime: 30_000,
  });
}

/** Repositories the installation can reach. This is the dropdown. */
export function useInstallationRepos(installationId: string | null) {
  return useQuery<{ repositories: InstallationRepo[] }>({
    queryKey: ['/api/infra/git/repositories', installationId],
    enabled: !!installationId,
    queryFn: () => api(
      `/api/infra/git/repositories?installationId=${encodeURIComponent(installationId!)}`,
      { what: 'Loading repositories' },
    ),
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
 * GitHub requires a form POST — the manifest is too large for a query string
 * and must arrive as a field — so this builds and submits a real form into a
 * popup rather than setting window.location.
 */
export function useRegisterApp() {
  return useMutation({
    mutationFn: async (input: { name?: string; organization?: string | null }) => {
      const res = await api<ManifestResponse>('/api/infra/git/app/manifest', {
        method: 'POST', body: input, what: 'Preparing the GitHub App',
      });

      const popup = window.open('', 'cloudwise-github-setup', 'width=980,height=760');
      if (!popup) {
        throw new Error('The browser blocked the GitHub window. Allow pop-ups for this site and try again.');
      }

      const form = popup.document.createElement('form');
      form.method = 'post';
      form.action = res.postUrl;
      const field = popup.document.createElement('input');
      field.type = 'hidden';
      field.name = 'manifest';
      field.value = JSON.stringify(res.manifest);
      form.appendChild(field);
      popup.document.body.appendChild(form);
      form.submit();

      return res;
    },
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
