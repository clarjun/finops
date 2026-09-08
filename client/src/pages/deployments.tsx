/**
 * What this account actually has running.
 *
 * The teardown existed only on the summary card of the run that created a
 * deployment, which meant finding the run id before you could remove anything —
 * and no screen anywhere answered "what have I deployed?". For a tool whose
 * resources bill by the hour, that is the more important question of the two.
 *
 * Ordered newest first, with what is still live separated from what is gone, so
 * the things costing money are the things you see.
 */
import { useState } from "react";
import { Link } from "wouter";
import {
  Server, Trash2, Loader2, ExternalLink, DollarSign, CheckCircle2, Archive, FlaskConical, AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { useDeployments, useStartTeardown, type Deployment } from "@/hooks/use-infra-agent";

export default function DeploymentsPage() {
  const { data, isLoading } = useDeployments();
  const deployments = data?.deployments ?? [];

  // 'partial' is a run that created resources and did not finish. Those
  // resources exist and bill, so it belongs with the live ones — putting it
  // under "Removed" would hide the case most in need of attention.
  const active = deployments.filter((d) => d.status === 'active' || d.status === 'partial');
  const past = deployments.filter((d) => d.status !== 'active' && d.status !== 'partial');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
          <Server className="h-7 w-7" /> Deployments
        </h1>
        <p className="text-muted-foreground mt-1">
          Infrastructure the agent has built and not yet removed. Anything listed as live is running in your cloud
          account now.
        </p>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {!isLoading && deployments.length === 0 && (
        <Card>
          <CardContent className="py-10 text-center space-y-2">
            <Server className="h-8 w-8 mx-auto text-muted-foreground" />
            <p className="font-medium">Nothing deployed</p>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              A deployment appears here once a live run succeeds. Simulations never appear, because they create nothing.
            </p>
          </CardContent>
        </Card>
      )}

      {active.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">
            In your account — {active.length} deployment{active.length === 1 ? '' : 's'}
          </h2>
          {active.map((d) => <DeploymentRow key={d.id} deployment={d} />)}
        </section>
      )}

      {past.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
            <Archive className="h-4 w-4" /> Removed
          </h2>
          {past.map((d) => <DeploymentRow key={d.id} deployment={d} />)}
        </section>
      )}
    </div>
  );
}

function DeploymentRow({ deployment }: { deployment: Deployment }) {
  const { toast } = useToast();
  const { can } = useAuth();
  const [confirming, setConfirming] = useState(false);
  const teardown = useStartTeardown();

  const partial = deployment.status === 'partial';
  const live = deployment.status === 'active' || partial;
  const simulated = deployment.executionMode === 'simulate';
  const cost = Number(deployment.estimatedMonthlyCost);

  const start = () => teardown.mutate({ runId: deployment.runId! }, {
    onSuccess: (r) => {
      setConfirming(false);
      toast({
        title: 'Working out what would be destroyed',
        description: `Nothing has been removed yet. Approve the list on run ${r.teardownRunId}.`,
      });
    },
    onError: (e) => toast({ title: 'Could not start the teardown', description: e.message, variant: 'destructive' }),
  });

  return (
    <Card className={live ? undefined : 'opacity-70'}>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-base flex flex-wrap items-center gap-2">
              {deployment.name}
              {partial
                ? (
                  <Badge variant="destructive" className="gap-1">
                    <AlertTriangle className="h-3 w-3" /> incomplete
                  </Badge>
                )
                : live
                  ? <Badge className="gap-1"><CheckCircle2 className="h-3 w-3" /> live</Badge>
                  : <Badge variant="secondary">{deployment.status}</Badge>}
              {simulated && (
                <Badge variant="outline" className="gap-1">
                  <FlaskConical className="h-3 w-3" /> simulated
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              {deployment.provider?.toUpperCase()}
              {deployment.region ? ` / ${deployment.region}` : ''}
              {deployment.environment ? ` / ${deployment.environment}` : ''}
              {' — '}{deployment.resourceCount} resource{deployment.resourceCount === 1 ? '' : 's'}
              {deployment.createdAt ? `, built ${new Date(deployment.createdAt).toLocaleString()}` : ''}
            </CardDescription>
          </div>

          {Number.isFinite(cost) && cost > 0 && (
            <Badge variant={live ? 'destructive' : 'secondary'} className="gap-1 shrink-0">
              <DollarSign className="h-3 w-3" />{cost.toFixed(0)}/mo
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {partial && (
          <p className="text-sm rounded-md border border-destructive/50 bg-destructive/10 p-3">
            This deployment did not finish. The resources listed above were created and are billing; the rest were
            not. Resume the run to continue, or tear it down to remove what exists.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
        {deployment.runId != null && (
          <Button asChild variant="outline" size="sm" className="gap-2">
            <Link href={`/infra-agent?run=${deployment.runId}`}>
              <ExternalLink className="h-4 w-4" /> View the deployment
            </Link>
          </Button>
        )}

        {/* Only a live deployment has anything to remove. */}
        {live && deployment.runId != null && can('agent:execute') && (
          confirming ? (
            <>
              <Button variant="destructive" size="sm" className="gap-2" disabled={teardown.isPending} onClick={start}>
                {teardown.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Plan the teardown
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>Cancel</Button>
              <span className="text-xs text-muted-foreground">
                Nothing is destroyed until you approve the exact list of resources.
              </span>
            </>
          ) : (
            <Button variant="outline" size="sm" className="gap-2" onClick={() => setConfirming(true)}
              data-testid={`teardown-${deployment.id}`}>
              <Trash2 className="h-4 w-4" /> Tear down
            </Button>
          )
        )}
        </div>
      </CardContent>
    </Card>
  );
}
