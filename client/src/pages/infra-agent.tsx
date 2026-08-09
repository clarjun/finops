/**
 * The Infrastructure Deployment Agent console.
 *
 * Four phases in one place — clarify, review, deploy, done — because they are
 * one continuous decision. Splitting them across pages would make it possible to
 * approve a deployment without the plan in front of you.
 */
import { useEffect, useState } from "react";
import { useSearch } from "wouter";
import {
  Rocket, Loader2, AlertTriangle, CheckCircle2, XCircle, ShieldAlert, Server, DollarSign, GitBranch,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { ArchitectureGraph, type GraphNode } from "@/components/infra/architecture-graph";
import { AgentActivity } from "@/components/infra/agent-activity";
import { ApprovalCard } from "@/components/infra/approval-card";
import { DeploymentSummaryCard } from "@/components/infra/deployment-summary";
import {
  useCompilePlan, useStartRun, useCloudAccounts, useRun, useRunStream,
  type ClarificationQuestion, type CompileResult, type NodeStatus,
} from "@/hooks/use-infra-agent";

/** Handed over by the Cost Estimator when the agent is created. */
interface Handoff {
  planId: number;
  name: string;
  questions: ClarificationQuestion[];
}

const HANDOFF_KEY = 'infra-agent-handoff';

export default function InfraAgentPage() {
  const search = useSearch();
  const { toast } = useToast();
  const { can } = useAuth();

  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [compiled, setCompiled] = useState<CompileResult | null>(null);
  const [runId, setRunId] = useState<number | null>(null);

  const accounts = useCloudAccounts();
  const compile = useCompilePlan();
  const startRun = useStartRun();
  const run = useRun(runId);
  const { events, connected } = useRunStream(runId);

  // The estimator hands off through sessionStorage rather than the URL: a
  // requirement can be thousands of characters and does not belong in a link
  // someone might paste into a ticket.
  useEffect(() => {
    const params = new URLSearchParams(search);
    const existingRun = params.get('run');
    if (existingRun) setRunId(Number(existingRun));

    const raw = sessionStorage.getItem(HANDOFF_KEY);
    if (raw) {
      try { setHandoff(JSON.parse(raw)); } catch { /* ignore a corrupt handoff */ }
    }
  }, [search]);

  const planId = handoff?.planId ?? null;

  const onCompile = () => {
    if (!planId) return;
    compile.mutate({ planId, answers }, {
      onSuccess: (r) => setCompiled(r),
      onError: (e) => toast({ title: 'Could not compile the architecture', description: e.message, variant: 'destructive' }),
    });
  };

  const onDeploy = (executionMode: 'live' | 'simulate') => {
    if (!planId) return;
    startRun.mutate({ planId, executionMode }, {
      onSuccess: (r) => {
        setRunId(r.runId);
        toast({
          title: executionMode === 'live' ? 'Deployment started' : 'Simulation started',
          description: executionMode === 'live'
            ? 'Real infrastructure will be created once each gate is approved.'
            : 'A real Terraform plan will run. Nothing will be created.',
        });
      },
      onError: (e) => toast({ title: 'Could not start the run', description: e.message, variant: 'destructive' }),
    });
  };

  /* ---- No agent yet ---------------------------------------------------- */

  if (!planId && !runId) {
    return (
      <div className="space-y-6">
        <Header />
        <Card>
          <CardContent className="py-12 text-center space-y-2">
            <Rocket className="h-10 w-10 mx-auto text-muted-foreground" />
            <p className="font-medium">No agent yet</p>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              Describe your application in the Cost Estimator and choose <strong>Create your agent</strong>.
              The agent takes the estimate, designs a deployable architecture and builds it with your approval.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  /* ---- Live run -------------------------------------------------------- */

  // Timing and error come from the run; shape and cost come from the plan.
  const runNodeByKey = new Map((run.data?.nodes ?? []).map((n) => [n.nodeKey, n]));
  const statusByNode = new Map<string, NodeStatus>(
    (run.data?.nodes ?? []).map((n) => [n.nodeKey, n.status]),
  );

  const runFacts = (key: string) => {
    const r = runNodeByKey.get(key);
    return { startedAt: r?.startedAt ?? null, finishedAt: r?.finishedAt ?? null, error: r?.error ?? null };
  };

  const graphNodes: GraphNode[] = compiled
    ? compiled.nodes.map((n) => ({
        key: n.key, label: n.label, logicalType: n.logicalType, dependsOn: n.dependsOn,
        requiresApproval: n.requiresApproval, riskLevel: n.risk.level,
        status: statusByNode.get(n.key) ?? 'pending',
        estimatedMonthlyCost: n.estimatedMonthlyCost ?? null,
        ...runFacts(n.key),
      }))
    : (run.data?.planNodes ?? []).map((n) => ({
        key: n.nodeKey, label: n.label, logicalType: n.logicalType, dependsOn: n.dependsOn ?? [],
        requiresApproval: n.requiresApproval, riskLevel: n.riskLevel,
        status: statusByNode.get(n.nodeKey) ?? 'pending',
        // Postgres returns numeric as a string; NaN would render as "$NaN/mo".
        estimatedMonthlyCost: n.estimatedMonthlyCost != null && Number.isFinite(Number(n.estimatedMonthlyCost))
          ? Number(n.estimatedMonthlyCost)
          : null,
        ...runFacts(n.nodeKey),
      }));

  const pendingApprovals = (run.data?.approvals ?? []).filter((a) => a.status === 'pending');
  const applied = graphNodes.filter((n) => n.status === 'applied').length;
  const progress = graphNodes.length > 0 ? Math.round((applied / graphNodes.length) * 100) : 0;
  const runStatus = run.data?.run.status;

  return (
    <div className="space-y-6">
      <Header
        name={handoff?.name}
        status={runStatus}
        executionMode={run.data?.run.executionMode}
      />

      {/* Clarify */}
      {!compiled && !runId && handoff && (
        <Card>
          <CardHeader>
            <CardTitle>A few questions</CardTitle>
            <CardDescription>
              Only what changes the infrastructure. Anything the requirement already implied is filled in.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {handoff.questions.map((q) => (
              <Question
                key={q.id}
                question={q}
                accounts={accounts.data?.accounts ?? []}
                value={answers[q.id]}
                onChange={(v) => setAnswers((prev) => ({ ...prev, [q.id]: v }))}
              />
            ))}
            <Button onClick={onCompile} disabled={compile.isPending} className="gap-2">
              {compile.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitBranch className="h-4 w-4" />}
              Design the architecture
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Review before deploying */}
      {compiled && !runId && (
        <Card>
          <CardHeader>
            <CardTitle>Proposed architecture</CardTitle>
            <CardDescription>
              {compiled.summary.total} resources — {compiled.summary.fromEstimate} from your estimate and{' '}
              {compiled.summary.synthesized} the agent added because the requested resources cannot exist without them.{' '}
              {compiled.summary.approvalGates} step(s) will pause for your approval.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {compiled.warnings.map((w, i) => (
              <div key={i} className="flex gap-2 rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 text-sm">
                <AlertTriangle className="h-4 w-4 text-yellow-600 mt-0.5 shrink-0" />
                <span>{w}</span>
              </div>
            ))}

            <ArchitectureGraph nodes={graphNodes} provider={run.data?.plan?.provider ?? (typeof answers.provider === 'string' ? answers.provider : undefined)} />

            <div className="flex flex-wrap gap-2 pt-2">
              <Button variant="outline" onClick={() => onDeploy('simulate')} disabled={startRun.isPending}>
                Simulate — plan only
              </Button>
              {can('agent:execute') ? (
                <Button onClick={() => onDeploy('live')} disabled={startRun.isPending} className="gap-2">
                  <Rocket className="h-4 w-4" /> Deploy for real
                </Button>
              ) : (
                <p className="text-sm text-muted-foreground self-center">
                  Deploying requires the <code className="text-xs">agent:execute</code> permission.
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Approval gates come first: the run cannot proceed until they are answered. */}
      {pendingApprovals.map((a) => (
        <ApprovalCard
          key={a.ref}
          approval={{
            ref: a.ref, nodeKey: a.nodeKey, summary: a.summary, details: a.details,
            riskLevel: a.riskLevel, riskReasons: a.riskReasons ?? [],
            estimatedCostImpact: a.estimatedCostImpact,
          }}
        />
      ))}

      {/* Terminal state: the summary replaces the live stats. */}
      {runId && (runStatus === 'succeeded' || runStatus === 'failed') && (
        <DeploymentSummaryCard runId={runId} />
      )}

      {/* Live deployment */}
      {runId && (
        <>
          <div className="grid gap-4 md:grid-cols-4">
            <Stat icon={Server} label="Resources created" value={`${applied} / ${graphNodes.length}`} />
            <Stat icon={GitBranch} label="Progress" value={`${progress}%`} />
            <Stat icon={ShieldAlert} label="Approvals" value={`${run.data?.run.approvalsGranted ?? 0} / ${run.data?.run.approvalsRequired ?? 0}`} />
            <Stat
              icon={DollarSign}
              label="Plan"
              value={run.data?.run.resourcesToAdd != null ? `+${run.data.run.resourcesToAdd}` : '—'}
            />
          </div>

          {run.data?.run.executionMode === 'simulate' && (
            <div className="flex gap-2 rounded-md border border-blue-500/40 bg-blue-500/10 p-3 text-sm">
              <AlertTriangle className="h-4 w-4 text-blue-600 mt-0.5 shrink-0" />
              <span>
                <strong>Simulation.</strong> Terraform is planning against your real account, but nothing will be
                created. No resource shown here exists.
              </span>
            </div>
          )}

          {run.data?.run.error && (
            <div className="flex gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm">
              <XCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
              <span className="break-words">{run.data.run.error}</span>
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-5">
            <Card className="lg:col-span-3">
              <CardHeader><CardTitle className="text-base">Architecture</CardTitle></CardHeader>
              <CardContent><ArchitectureGraph nodes={graphNodes} provider={run.data?.plan?.provider ?? (typeof answers.provider === 'string' ? answers.provider : undefined)} /></CardContent>
            </Card>

            <Card className="lg:col-span-2">
              <CardContent className="pt-6 h-full">
                <AgentActivity events={events} connected={connected} />
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function Header({ name, status, executionMode }: { name?: string; status?: string; executionMode?: string }) {
  const done = status === 'succeeded';
  const failed = status === 'failed';

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
          <Rocket className="h-7 w-7" /> Infrastructure Deployment Agent
        </h1>
        <p className="text-muted-foreground mt-1">
          {name ? `${name} — ` : ''}designs, plans and builds cloud infrastructure with approval at every risky step.
        </p>
      </div>
      {status && (
        <div className="flex items-center gap-2">
          {executionMode === 'simulate' && <Badge variant="outline">simulation</Badge>}
          <Badge variant={done ? 'default' : failed ? 'destructive' : 'secondary'} className="gap-1">
            {done && <CheckCircle2 className="h-3 w-3" />}
            {failed && <XCircle className="h-3 w-3" />}
            {!done && !failed && <Loader2 className="h-3 w-3 animate-spin" />}
            {status.replace(/_/g, ' ')}
          </Badge>
        </div>
      )}
    </div>
  );
}

function Stat({ icon: Icon, label, value }: { icon: typeof Server; label: string; value: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-xs text-muted-foreground flex items-center gap-1.5"><Icon className="h-3.5 w-3.5" />{label}</p>
        <p className="text-2xl font-semibold mt-1">{value}</p>
      </CardContent>
    </Card>
  );
}

function Question({
  question, accounts, value, onChange,
}: {
  question: ClarificationQuestion;
  accounts: Array<{ id: number; provider: string; accountName: string; accountId: string }>;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  // The inferred answer is pre-selected so the user confirms rather than retypes.
  const current = value ?? question.inferred?.value ?? '';

  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium">{question.question}</label>
      <p className="text-xs text-muted-foreground">{question.rationale}</p>

      {question.type === 'account' ? (
        <Select value={String(current)} onValueChange={(v) => onChange(Number(v))}>
          <SelectTrigger><SelectValue placeholder="Choose a connected account" /></SelectTrigger>
          <SelectContent>
            {accounts.length === 0 ? (
              <SelectItem value="none" disabled>No connected accounts — add one in Configuration</SelectItem>
            ) : accounts.map((a) => (
              <SelectItem key={a.id} value={String(a.id)}>
                {a.provider.toUpperCase()} — {a.accountName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Select
          value={String(current)}
          onValueChange={(v) => onChange(question.id === 'compliance' ? (v ? [v] : []) : v)}
        >
          <SelectTrigger><SelectValue placeholder="Choose…" /></SelectTrigger>
          <SelectContent>
            {question.options?.map((o) => (
              <SelectItem key={o.value || 'none'} value={o.value || 'none'}>
                {o.label}{o.description ? ` — ${o.description}` : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {question.inferred && (
        <p className="text-xs text-muted-foreground italic">
          Pre-filled: {question.inferred.because}.
        </p>
      )}
    </div>
  );
}
