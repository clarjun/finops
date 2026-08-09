/**
 * The completion card.
 *
 * States the execution mode before anything else. A summary reading "5
 * resources created" is a very different claim depending on whether the run was
 * live, and this is the artefact people paste into a change record — so it must
 * not be quotable out of context.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2, XCircle, Clock, Server, ShieldCheck, DollarSign, Save, Loader2, FlaskConical,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";

export interface DeploymentSummaryData {
  runId: number;
  name: string;
  provider: string;
  region: string | null;
  environment: string | null;
  executionMode: string;
  status: string;
  resourcesCreated: number;
  resourcesSkipped: number;
  resourcesFailed: number;
  approvalsRequired: number;
  approvalsGranted: number;
  approvalsRejected: number;
  durationSeconds: number | null;
  estimatedMonthlyCost: number | null;
  eventCount: number;
  resources: string[];
  approvals: Array<{ summary: string; riskLevel: string; status: string; decidedBy: string | null; reason: string | null }>;
  error: string | null;
}

function duration(seconds: number | null): string {
  if (seconds == null) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function DeploymentSummaryCard({ runId }: { runId: number }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [templateName, setTemplateName] = useState('');
  const [saving, setSaving] = useState(false);

  const { data } = useQuery<DeploymentSummaryData>({
    queryKey: ['/api/infra/runs', runId, 'summary'],
    queryFn: async () => {
      const res = await fetch(`/api/infra/runs/${runId}/summary`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load summary');
      return res.json();
    },
  });

  const saveTemplate = useMutation<{ templateId: number }, Error, { name: string }>({
    mutationFn: async (body) => {
      const res = await fetch(`/api/infra/runs/${runId}/save-as-template`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.details || payload.error);
      return payload;
    },
    onSuccess: () => {
      toast({ title: 'Saved as a blueprint', description: 'It can now seed a future deployment.' });
      setSaving(false);
      setTemplateName('');
      qc.invalidateQueries({ queryKey: ['/api/infra/templates'] });
    },
    onError: (e) => toast({ title: 'Could not save the blueprint', description: e.message, variant: 'destructive' }),
  });

  if (!data) return null;

  const succeeded = data.status === 'succeeded';
  const simulated = data.executionMode === 'simulate';

  return (
    <Card className={succeeded ? 'border-green-500/60' : 'border-destructive/60'}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {succeeded ? <CheckCircle2 className="h-6 w-6 text-green-600" /> : <XCircle className="h-6 w-6 text-destructive" />}
          {succeeded ? (simulated ? 'Simulation complete' : 'Deployment complete') : 'Deployment failed'}
          {simulated && (
            <Badge variant="outline" className="gap-1 ml-1">
              <FlaskConical className="h-3 w-3" /> nothing was created
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          {data.name} — {data.provider.toUpperCase()}
          {data.region ? ` / ${data.region}` : ''}
          {data.environment ? ` / ${data.environment}` : ''}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        {simulated && (
          <p className="text-sm rounded-md border border-blue-500/40 bg-blue-500/10 p-3">
            Terraform planned this against your real account and stopped. No resource listed below exists.
          </p>
        )}

        {data.error && (
          <p className="text-sm rounded-md border border-destructive/50 bg-destructive/10 p-3 break-words">
            {data.error}
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-4">
          <Metric icon={Server} label={simulated ? 'Would create' : 'Resources created'} value={String(data.resourcesCreated)} />
          <Metric icon={ShieldCheck} label="Approvals" value={`${data.approvalsGranted} / ${data.approvalsRequired}`} />
          <Metric icon={Clock} label="Duration" value={duration(data.durationSeconds)} />
          <Metric
            icon={DollarSign}
            label="Estimated cost"
            value={data.estimatedMonthlyCost != null ? `$${data.estimatedMonthlyCost.toFixed(0)}/mo` : '—'}
          />
        </div>

        {(data.resourcesSkipped > 0 || data.resourcesFailed > 0) && (
          <p className="text-sm text-muted-foreground">
            {data.resourcesSkipped > 0 && `${data.resourcesSkipped} not deployed (unsupported or skipped). `}
            {data.resourcesFailed > 0 && `${data.resourcesFailed} failed.`}
          </p>
        )}

        {data.approvals.length > 0 && (
          <div>
            <p className="text-sm font-medium mb-1.5">Approvals</p>
            <div className="space-y-1">
              {data.approvals.map((a, i) => (
                <div key={i} className="flex items-start justify-between gap-2 text-sm">
                  <span className="truncate">{a.summary}</span>
                  <span className="shrink-0 flex items-center gap-2">
                    {a.decidedBy && <span className="text-xs text-muted-foreground">{a.decidedBy}</span>}
                    <Badge variant={a.status === 'approved' ? 'default' : a.status === 'rejected' ? 'destructive' : 'secondary'}>
                      {a.status}
                    </Badge>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {data.resources.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer font-medium">{data.resources.length} resource(s)</summary>
            <ul className="mt-2 space-y-0.5 font-mono text-xs text-muted-foreground">
              {data.resources.map((r) => <li key={r}>{r}</li>)}
            </ul>
          </details>
        )}

        {/* Only a real, successful deployment may become a blueprint: a
            blueprint asserts that an arrangement has actually been built. */}
        {succeeded && !simulated && (
          <div className="border-t pt-4">
            {saving ? (
              <div className="flex flex-wrap gap-2">
                <Input
                  value={templateName}
                  onChange={(e) => setTemplateName(e.target.value)}
                  placeholder="Blueprint name, e.g. E-commerce HA on AWS"
                  className="max-w-sm"
                  autoFocus
                />
                <Button
                  onClick={() => saveTemplate.mutate({ name: templateName.trim() })}
                  disabled={!templateName.trim() || saveTemplate.isPending}
                  className="gap-2"
                >
                  {saveTemplate.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  Save
                </Button>
                <Button variant="ghost" onClick={() => setSaving(false)}>Cancel</Button>
              </div>
            ) : (
              <Button variant="outline" onClick={() => setSaving(true)} className="gap-2" data-testid="button-save-template">
                <Save className="h-4 w-4" /> Save as blueprint
              </Button>
            )}
            <p className="text-xs text-muted-foreground mt-2">
              Reusing a blueprint asks again which account and environment to deploy into — it never inherits them.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Metric({ icon: Icon, label, value }: { icon: typeof Server; label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground flex items-center gap-1.5"><Icon className="h-3.5 w-3.5" />{label}</p>
      <p className="text-xl font-semibold mt-0.5">{value}</p>
    </div>
  );
}
