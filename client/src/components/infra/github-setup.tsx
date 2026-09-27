/**
 * Connecting GitHub, without anyone typing a secret.
 *
 * Three steps, in the order they actually happen:
 *
 *   1. Register  — GitHub creates the App from a manifest we supply and hands
 *                  back its private key. Once per organization.
 *   2. Install   — the customer chooses, on GitHub's own screen, which
 *                  repositories the App may touch.
 *   3. Connect   — they pick one from a dropdown of exactly those repositories.
 *
 * The dropdown is the point. Asking someone to type "owner/repo" invites the
 * failure where the name is right but the App cannot see it — which surfaces
 * much later as a permission error on a pull request. If a repository is in
 * this list, access already exists.
 *
 * Steps 1 and 2 finish in a popup on github.com, so they report back by
 * postMessage rather than by resolving a promise. Both outcomes raise a toast;
 * there is no silent path, because there is no environment fallback to fall
 * back to.
 */
import { useEffect, useState } from "react";
import {
  Check, ExternalLink, Github, Loader2, RefreshCw, Trash2, AlertTriangle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useGitConnection } from "@/hooks/use-infra-agent";
import {
  useAppRegistration, useInstallationRepos, useRegisterApp, useRemoveApp,
  useConnectRepo, onSetupMessage,
} from "@/hooks/use-github-app";

function Step({
  n, title, done, children,
}: { n: number; title: string; done: boolean; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div
        className={`shrink-0 h-7 w-7 rounded-full grid place-items-center text-sm font-medium ${
          done ? 'bg-emerald-600 text-white' : 'bg-muted text-muted-foreground'
        }`}
      >
        {done ? <Check className="h-4 w-4" /> : n}
      </div>
      <div className="min-w-0 flex-1 pb-6">
        <p className="font-medium text-sm mb-1.5">{title}</p>
        {children}
      </div>
    </div>
  );
}

export function GitHubSetup() {
  const { toast } = useToast();

  const registration = useAppRegistration();
  const connection = useGitConnection();
  const register = useRegisterApp();
  const remove = useRemoveApp();
  const connect = useConnectRepo();

  const [installationId, setInstallationId] = useState<string | null>(null);
  const [repository, setRepository] = useState<string>('');
  const [basePath, setBasePath] = useState('infrastructure');

  const repos = useInstallationRepos(installationId);

  // Both popups report back this way. Registered once, for the lifetime of the
  // panel, because the popup can return at any point after it is opened.
  useEffect(() => onSetupMessage((m) => {
    if (!m.ok) {
      toast({ title: 'GitHub setup failed', description: m.message, variant: 'destructive' });
      return;
    }

    if (m.installationId) {
      setInstallationId(m.installationId);
      toast({ title: 'App installed', description: 'Now choose which repository to use.' });
    } else {
      toast({ title: 'GitHub App created', description: 'Next, install it on your repositories.' });
    }

    void registration.refetch();
  }), [toast, registration]);

  const isRegistered = registration.data?.registered === true;
  const isConnected = connection.data?.connected === true;

  const startRegister = async () => {
    try {
      await register.mutateAsync({});
    } catch (err: any) {
      toast({ title: 'Could not start setup', description: err.message, variant: 'destructive' });
    }
  };

  const startInstall = () => {
    const url = registration.data?.installUrl;
    if (!url) {
      toast({
        title: 'No install link yet',
        description: 'GitHub has not reported the App name. Refresh and try again.',
        variant: 'destructive',
      });
      return;
    }
    if (!window.open(url, 'cloudwise-github-setup', 'width=980,height=760')) {
      toast({
        title: 'Pop-up blocked',
        description: 'Allow pop-ups for this site, then try again.',
        variant: 'destructive',
      });
    }
  };

  const doConnect = async () => {
    try {
      const res: any = await connect.mutateAsync({ repository, basePath });
      toast({ title: 'Repository connected', description: `Pull requests will open in ${res.repository}.` });
    } catch (err: any) {
      toast({ title: 'Could not connect', description: err.message, variant: 'destructive' });
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Github className="h-5 w-5" />
              GitHub
            </CardTitle>
            <CardDescription>
              Where generated Terraform is proposed as a pull request. Nothing is applied to your
              cloud from here — a human reviews and merges, and your own pipeline runs the apply.
            </CardDescription>
          </div>
          {isConnected && (
            <Badge variant="secondary" className="bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
              {connection.data?.repository}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent>
        <Step n={1} title="Create the GitHub App" done={isRegistered}>
          {isRegistered ? (
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>
                App <code className="text-foreground">{registration.data?.slug ?? registration.data?.appId}</code> is registered.
              </span>
              <Button
                size="sm" variant="ghost"
                onClick={() => remove.mutate(undefined, {
                  onSuccess: () => toast({
                    title: 'Registration removed',
                    description: 'Delete the App on GitHub too if you no longer want it.',
                  }),
                })}
                disabled={remove.isPending}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1.5" />Remove
              </Button>
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground mb-2">
                GitHub creates the App and returns its key to us directly. You will not download or
                paste anything.
              </p>
              <Button size="sm" onClick={startRegister} disabled={register.isPending}>
                {register.isPending
                  ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                  : <ExternalLink className="h-4 w-4 mr-1.5" />}
                Create the App on GitHub
              </Button>
            </>
          )}
        </Step>

        <Step n={2} title="Install it on your repositories" done={!!installationId || isConnected}>
          {!isRegistered ? (
            <p className="text-sm text-muted-foreground">Create the App first.</p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground mb-2">
                GitHub will ask which repositories the App may access. Choose as few as you need —
                it only ever writes to the one you pick in step 3.
              </p>
              <Button size="sm" variant={installationId ? 'ghost' : 'default'} onClick={startInstall}>
                <ExternalLink className="h-4 w-4 mr-1.5" />
                {installationId ? 'Change repository access' : 'Install on GitHub'}
              </Button>
            </>
          )}
        </Step>

        <Step n={3} title="Choose the repository for pull requests" done={isConnected}>
          {!installationId ? (
            <p className="text-sm text-muted-foreground">
              {isConnected
                ? 'Already connected. Install again above to change which repositories are available.'
                : 'Install the App first — the list below comes from what you grant it.'}
            </p>
          ) : repos.isLoading ? (
            <p className="text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />Loading your repositories…
            </p>
          ) : repos.error ? (
            <p className="text-sm text-destructive flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              {(repos.error as Error).message}
            </p>
          ) : (
            <div className="space-y-3 max-w-md">
              <div>
                <Label className="text-xs">Repository</Label>
                <Select value={repository} onValueChange={setRepository}>
                  <SelectTrigger><SelectValue placeholder="Choose a repository" /></SelectTrigger>
                  <SelectContent>
                    {(repos.data?.repositories ?? []).map(r => (
                      <SelectItem key={r.fullName} value={r.fullName} disabled={!r.canWrite}>
                        {r.fullName}
                        {r.private && <span className="text-muted-foreground"> · private</span>}
                        {!r.canWrite && <span className="text-muted-foreground"> · read-only</span>}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {repos.data?.repositories.length === 0 && (
                  <p className="text-xs text-muted-foreground mt-1">
                    The App has no repositories yet. Install it on at least one above.
                  </p>
                )}
              </div>

              <div>
                <Label className="text-xs">Folder inside the repository</Label>
                <Input value={basePath} onChange={e => setBasePath(e.target.value)} placeholder="infrastructure" />
                <p className="text-xs text-muted-foreground mt-1">
                  Generated Terraform is written under this path.
                </p>
              </div>

              <Button size="sm" onClick={doConnect} disabled={!repository || connect.isPending}>
                {connect.isPending
                  ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                  : <Check className="h-4 w-4 mr-1.5" />}
                Connect
              </Button>
            </div>
          )}
        </Step>

        <div className="flex items-center gap-2 pt-1 border-t text-xs text-muted-foreground">
          <RefreshCw className="h-3 w-3" />
          Access is granted per repository and expires hourly — no token is stored anywhere.
        </div>
      </CardContent>
    </Card>
  );
}
