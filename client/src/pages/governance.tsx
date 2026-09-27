/**
 * Governance & compliance.
 *
 * One screen answering three different people's questions:
 *
 *   an executive  — one number, its trend, and what it is costing;
 *   an engineer   — which resources, and what to do about each;
 *   an auditor    — which named controls are monitored, and the evidence.
 *
 * Every number on the posture tab is a way in. A card that shows "42 open
 * findings" and cannot tell you which 42 is a poster, not a tool — the reader
 * has to translate a figure into a filter by hand, and most will not bother.
 * Clicking any of these navigates to the tab that explains it, pre-filtered.
 *
 * The posture tab is also deliberately honest about what was NOT assessed. A
 * policy that could not run is shown next to the score, with the reason, rather
 * than folded into it — a dashboard that reports unanswered questions as green
 * ticks is worse than no dashboard, because people act on it.
 */
import { useState } from "react";
import {
  DOMAIN_LABEL,
  POLICY_SEVERITIES,
  SEVERITY_LABEL,
  type PolicyDomain,
  type PolicySeverity,
  type FrameworkCoverage,
  type PolicyCatalogEntry,
} from "@shared/governance";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import {
  usePosture,
  usePolicyCatalog,
  useExemptions,
  useFrameworkCoverage,
  useGovernanceHistory,
  useRunEvaluation,
  useRevokeExemption,
  type ViolationFilters,
} from "@/hooks/use-governance";
import { PolicyCatalog } from "@/components/governance/policy-catalog";
import { Findings } from "@/components/governance/findings";
import { GovernanceIntro, TAB_HELP, Term, WhatIsThis } from "@/components/governance/explain";
import { FixFirst } from "@/components/governance/fix-first";
import {
  ScoreNumber,
  ScoreBar,
  SeverityBadge,
  DOMAIN_ICON,
  money,
  relativeTime,
  daysUntil,
} from "@/components/governance/shared";
import {
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  TrendingUp,
  TrendingDown,
  Minus,
  HelpCircle,
  ChevronRight,
  AlertTriangle,
  Settings2,
} from "lucide-react";

/**
 * Where a click on a posture card should land.
 *
 * Passed down rather than each card knowing about tabs, so the drill-down
 * targets are declared in one place and can be read at a glance.
 */
interface Drilldown {
  toFindings: (filters: ViolationFilters) => void;
  toPolicies: (policyKey?: string) => void;
}

/**
 * A card that navigates somewhere.
 *
 * A real <button> rather than an onClick on a div: keyboard users have to be
 * able to reach these, and the whole point of the change is that the numbers
 * stop being dead ends.
 */
function DrillCard({
  label,
  onClick,
  hint,
  children,
}: {
  label: string;
  onClick: () => void;
  /** What the reader gets by clicking. Shown at the foot of the card. */
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="transition-colors hover:border-primary/50 focus-within:border-primary/50">
      <button
        type="button"
        onClick={onClick}
        aria-label={`${label} — ${hint}`}
        className="w-full text-left focus:outline-none"
      >
        <CardHeader className="pb-2">
          <CardDescription>{label}</CardDescription>
        </CardHeader>
        <CardContent>
          {children}
          <p className="text-xs text-primary/80 mt-3 flex items-center gap-0.5">
            {hint}
            <ChevronRight className="h-3 w-3" />
          </p>
        </CardContent>
      </button>
    </Card>
  );
}

// ── Posture ───────────────────────────────────────────────────────────────────

function PostureTab({ drill }: { drill: Drilldown }) {
  const { data: posture, isLoading } = usePosture();
  const { data: history } = useGovernanceHistory(30);

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading posture…</p>;
  if (!posture) return null;

  const runs = history?.runs ?? [];
  const previous = runs.length >= 2 ? runs[runs.length - 2].score : null;
  const delta = previous === null ? null : posture.score - previous;
  const neverRun = posture.lastRunAt === null;

  return (
    <div className="space-y-6">
      {neverRun && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="flex items-start gap-3 pt-6">
            <HelpCircle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">No evaluation has run yet</p>
              <p className="text-sm text-muted-foreground mt-1">
                The score below is not a result. Run an evaluation, or wait for the scheduled sweep,
                before reading anything into it.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {posture.lastRunStatus === 'failed' && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="flex items-start gap-3 pt-6">
            <ShieldAlert className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">The last evaluation failed</p>
              <p className="text-sm text-muted-foreground mt-1">
                {posture.lastRunError ?? 'No detail recorded.'} The findings below are from an
                earlier run and may be stale.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-4">
        {/* The score itself does not drill down: it is the summary of every other
            card here, so "show me the score" has no narrower view to open. */}
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1.5">
              Governance score
              <WhatIsThis k="score" />
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <ScoreNumber score={posture.score} className="text-5xl font-bold tracking-tight" />
              <span className="text-2xl text-muted-foreground">/100</span>
              <Badge variant="secondary" className="ml-1">{posture.grade}</Badge>
            </div>
            <div className="mt-3"><ScoreBar score={posture.score} /></div>
            <p className="text-xs text-muted-foreground mt-2 flex items-center gap-1">
              {delta === null ? <Minus className="h-3 w-3" />
                : delta > 0 ? <TrendingUp className="h-3 w-3 text-green-600" />
                : delta < 0 ? <TrendingDown className="h-3 w-3 text-red-600" />
                : <Minus className="h-3 w-3" />}
              {delta === null ? 'No previous run to compare'
                : delta === 0 ? 'Unchanged since the last run'
                : `${delta > 0 ? '+' : ''}${delta.toFixed(1)} since the last run`}
            </p>
          </CardContent>
        </Card>

        <DrillCard
          label="Open findings"
          hint="See every finding"
          onClick={() => drill.toFindings({ status: 'open' })}
        >
          <p className="text-3xl font-bold">{posture.openViolations.toLocaleString()}</p>
          <div className="flex flex-wrap gap-1.5 mt-3">
            {POLICY_SEVERITIES
              .filter(s => posture.severityCounts[s] > 0)
              .map(s => (
                // Nested interactive element: stopPropagation so a click on the
                // badge filters by severity instead of opening the unfiltered
                // list the card behind it would.
                <Badge
                  key={s}
                  variant="outline"
                  role="button"
                  tabIndex={0}
                  className="font-normal text-xs cursor-pointer hover:bg-accent"
                  onClick={e => {
                    e.stopPropagation();
                    drill.toFindings({ status: 'open', severity: s });
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.stopPropagation();
                      e.preventDefault();
                      drill.toFindings({ status: 'open', severity: s });
                    }
                  }}
                >
                  {posture.severityCounts[s]} {SEVERITY_LABEL[s].toLowerCase()}
                </Badge>
              ))}
            {posture.openViolations === 0 && (
              <span className="text-xs text-muted-foreground">Nothing open.</span>
            )}
          </div>
        </DrillCard>

        <DrillCard
          label="Spend at risk"
          hint="See what is at stake"
          onClick={() => drill.toFindings({ status: 'open' })}
        >
          <p className="text-3xl font-bold">{money(posture.costAtRisk)}</p>
          <p className="text-xs text-muted-foreground mt-3">
            Monthly spend covered by an open finding — unallocated, idle, out of region or
            otherwise ungoverned.
          </p>
        </DrillCard>

        <DrillCard
          label="Coverage"
          hint="Review the policy set"
          onClick={() => drill.toPolicies()}
        >
          <p className="text-3xl font-bold">
            {posture.policiesEnabled}
            <span className="text-lg text-muted-foreground font-normal">/{posture.policiesAvailable}</span>
          </p>
          <p className="text-xs text-muted-foreground mt-3">
            Policies switched on. {posture.exemptViolations > 0
              ? `${posture.exemptViolations} finding${posture.exemptViolations === 1 ? '' : 's'} currently exempt.`
              : 'No active exemptions.'}
          </p>
        </DrillCard>
      </div>

      {/* Placed immediately under the numbers: the score says how you are doing,
          and this says what to do about it. Anything between them is a detour. */}
      <FixFirst
        impacts={posture.policyImpacts ?? []}
        score={posture.score}
        onOpenFindings={policyKey => drill.toFindings({ status: 'open', policyKey })}
      />

      {posture.notAssessed.length > 0 && (
        <Card className="border-amber-500/40">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <HelpCircle className="h-4 w-4 text-amber-600" />
              {posture.notAssessed.length} polic{posture.notAssessed.length === 1 ? 'y' : 'ies'} reached no verdict
            </CardTitle>
            <CardDescription>
              These rules ran but could not reach a verdict, so they are left{' '}
              <strong>out of the score</strong> rather than counted as passing — a question nobody
              answered is not a pass. Usually it means the rule had no data to look at, or it needs
              a value from you first (which regions you allow, which tags you require). Click one to
              see the reason and fix the cause.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="divide-y">
              {posture.notAssessed.map(n => (
                <button
                  key={n.policyKey}
                  type="button"
                  onClick={() => drill.toPolicies(n.policyKey)}
                  className="w-full text-left py-2.5 flex items-start gap-3 hover:bg-accent/50 rounded px-2 -mx-2"
                >
                  {n.failed
                    ? <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                    : <HelpCircle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{n.title}</span>
                      <Badge variant="outline" className="font-normal text-xs">
                        {DOMAIN_LABEL[n.domain]}
                      </Badge>
                      {n.failed && (
                        <Badge variant="destructive" className="font-normal text-xs">failed to run</Badge>
                      )}
                    </div>
                    {/* The reason is the whole value of this panel. Without it a
                        reader sees five names and no idea what to do next. */}
                    <p className="text-xs text-muted-foreground mt-0.5">{n.reason}</p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {posture.domains.length > 0 && (
        <div>
          <h3 className="text-sm font-medium mb-1">
            Which areas are weakest
          </h3>
          <p className="text-xs text-muted-foreground mb-3">
            Worst first. Each area scores out of 100 on the rules that apply to it — click one to
            see what is failing there.
          </p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {/* Ordered worst-first rather than by a fixed domain order. The
                reader's first question is "where is the problem", and making
                them scan five cards to find the low number answers it slowly.
                Areas with nothing assessed sort last: they are not good news,
                but they are not a failing score either. */}
            {[...posture.domains]
              .sort((a, b) => {
                const unassessed = (d: typeof a) => (d.policiesEvaluated === 0 ? 1 : 0);
                if (unassessed(a) !== unassessed(b)) return unassessed(a) - unassessed(b);
                if (a.score !== b.score) return a.score - b.score;
                return b.violations - a.violations;
              })
              .map(d => {
              const Icon = DOMAIN_ICON[d.domain];
              return (
                <Card
                  key={d.domain}
                  className="transition-colors hover:border-primary/50 focus-within:border-primary/50"
                >
                  <button
                    type="button"
                    // A clean domain has no findings to show, so send the reader
                    // to the policies that made it clean instead of to an empty
                    // list that reads like an error.
                    onClick={() =>
                      d.violations > 0
                        ? drill.toFindings({ status: 'open', domain: d.domain })
                        : drill.toPolicies()
                    }
                    className="w-full text-left focus:outline-none"
                  >
                    <CardHeader className="pb-2">
                      <CardDescription className="flex items-center gap-1.5">
                        <Icon className="h-3.5 w-3.5" />
                        {DOMAIN_LABEL[d.domain]}
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="flex items-baseline gap-1">
                        <ScoreNumber score={d.score} className="text-2xl font-semibold" />
                        <span className="text-sm text-muted-foreground">/100</span>
                      </div>
                      <div className="mt-2"><ScoreBar score={d.score} /></div>
                      <p className="text-xs text-muted-foreground mt-2">
                        {d.policiesEvaluated === 0
                          ? 'Nothing assessed'
                          : `${d.policiesPassing}/${d.policiesEvaluated} policies clean`}
                      </p>
                      <p className="text-xs text-primary/80 mt-1 flex items-center gap-0.5">
                        {d.violations > 0
                          ? `${d.violations} finding${d.violations === 1 ? '' : 's'}`
                          : 'View policies'}
                        <ChevronRight className="h-3 w-3" />
                      </p>
                    </CardContent>
                  </button>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {runs.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Score history</CardTitle>
            <CardDescription>The last {runs.length} successful evaluations.</CardDescription>
          </CardHeader>
          <CardContent>
            {/* A row of bars rather than a charting import: this is one series
                with no axes worth drawing, and the trend is the entire message. */}
            <div className="flex items-end gap-1 h-24">
              {runs.map(run => (
                <div
                  key={run.id}
                  className="flex-1 min-w-[3px] rounded-t bg-primary/70 hover:bg-primary transition-colors"
                  style={{ height: `${Math.max(3, run.score)}%` }}
                  title={`${new Date(run.at).toLocaleString()} — ${run.score.toFixed(0)}/100, ${run.openViolations} open`}
                />
              ))}
            </div>
            <div className="flex justify-between text-xs text-muted-foreground mt-2">
              <span>{relativeTime(runs[0].at)}</span>
              <span>{relativeTime(runs[runs.length - 1].at)}</span>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── Exemptions ────────────────────────────────────────────────────────────────

function ExemptionsTab({ canExempt }: { canExempt: boolean }) {
  const { data, isLoading } = useExemptions();
  const revoke = useRevokeExemption();
  const { toast } = useToast();

  const exemptions = data?.exemptions ?? [];
  const active = exemptions.filter(e => e.isActive);
  const past = exemptions.filter(e => !e.isActive);

  const doRevoke = async (id: number) => {
    try {
      await revoke.mutateAsync(id);
      toast({ title: 'Exemption revoked', description: 'The finding returns on the next evaluation.' });
    } catch (err: any) {
      toast({ title: 'Could not revoke', description: err.message, variant: 'destructive' });
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Active exemptions</CardTitle>
          <CardDescription>
            Accepted risk, with a name against it and a date it comes back. Nothing here is
            permanent.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : active.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">
              No active exemptions. Every finding is counted against the posture.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Policy</TableHead>
                  <TableHead>Covers</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Granted by</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {active.map(e => {
                  const remaining = daysUntil(e.expiresAt);
                  return (
                    <TableRow key={e.id}>
                      <TableCell className="font-medium">{e.policyTitle}</TableCell>
                      <TableCell className="font-mono text-xs max-w-[14rem] truncate">
                        {e.resourceId ?? 'Entire policy'}
                      </TableCell>
                      <TableCell className="max-w-[22rem] text-sm">{e.reason}</TableCell>
                      <TableCell className="text-sm">{e.approvedByUsername ?? '—'}</TableCell>
                      <TableCell>
                        <Badge variant={remaining <= 7 ? 'destructive' : 'secondary'} className="font-normal">
                          {remaining === 0 ? 'today' : `${remaining} day${remaining === 1 ? '' : 's'}`}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {canExempt && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => doRevoke(e.id)}
                            disabled={revoke.isPending}
                          >
                            Revoke
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {past.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Expired and revoked</CardTitle>
            <CardDescription>
              Kept rather than deleted. The record that a risk was once accepted is the point.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="divide-y">
              {past.slice(0, 25).map(e => (
                <div key={e.id} className="py-2.5 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{e.policyTitle}</span>
                    <Badge variant="outline" className="font-normal text-xs">
                      {e.revokedAt ? 'revoked' : 'expired'} {relativeTime(e.revokedAt ?? e.expiresAt)}
                    </Badge>
                  </div>
                  <p className="text-muted-foreground text-xs mt-0.5">
                    {e.reason} — granted by {e.approvedByUsername ?? 'unknown'}
                  </p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── Frameworks ────────────────────────────────────────────────────────────────

/**
 * What one framework control means here.
 *
 * Clicking a control used to open the policy *editor* — a settings form, for
 * whichever policy happened to be first in the mapping. That answered a
 * question nobody asked. Someone on this tab is reading, not configuring: they
 * want to know what the control is, whether we meet it, and what evidence backs
 * that. Editing is a deliberate step taken afterwards, from here.
 *
 * The explanation is assembled from the policies that implement the control
 * rather than from a stored description of the control itself. That is a
 * deliberate limit: paraphrasing SOC 2 or ISO 27001 text would put words in an
 * auditor's mouth that we cannot stand behind. What we can state precisely is
 * what Cloudwise actually checks, and that is what this shows.
 */
function ControlDetail({
  framework,
  control,
  policies,
  onOpenChange,
  drill,
}: {
  framework: string;
  control: FrameworkCoverage['controls'][number];
  /** Catalog entries for the policies this control maps to. */
  policies: PolicyCatalogEntry[];
  onOpenChange: (open: boolean) => void;
  drill: Drilldown;
}) {
  const statusLabel =
    control.status === 'compliant' ? 'Meeting this control'
    : control.status === 'violations' ? 'Not meeting this control'
    : 'Not being checked';

  const statusClass =
    control.status === 'compliant' ? 'text-green-600 dark:text-green-400'
    : control.status === 'violations' ? 'text-amber-600 dark:text-amber-400'
    : 'text-muted-foreground';

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogDescription className="text-xs uppercase tracking-wide">{framework}</DialogDescription>
          <DialogTitle className="text-xl">{control.control}</DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          <div className="flex items-start gap-3 rounded-md border bg-muted/40 p-3">
            {control.status === 'compliant' ? (
              <ShieldCheck className="h-5 w-5 text-green-600 shrink-0 mt-0.5" />
            ) : control.status === 'violations' ? (
              <ShieldAlert className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
            ) : (
              <HelpCircle className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
            )}
            <div>
              <p className={`font-medium ${statusClass}`}>{statusLabel}</p>
              <p className="text-sm text-muted-foreground mt-1">
                {control.status === 'compliant'
                  ? `${control.enabledPolicies} polic${control.enabledPolicies === 1 ? 'y is' : 'ies are'} monitoring this control and ${control.enabledPolicies === 1 ? 'it has' : 'they have'} no open findings.`
                  : control.status === 'violations'
                    ? `${control.violations} open finding${control.violations === 1 ? '' : 's'} from ${control.enabledPolicies} monitoring polic${control.enabledPolicies === 1 ? 'y' : 'ies'}.`
                    : `${control.totalPolicies} polic${control.totalPolicies === 1 ? 'y' : 'ies'} in the catalog could check this, but none ${control.totalPolicies === 1 ? 'is' : 'are'} switched on. This is an unanswered question, not a pass.`}
              </p>
            </div>
          </div>

          <div>
            <h4 className="text-sm font-medium mb-1">How Cloudwise checks this</h4>
            <p className="text-xs text-muted-foreground mb-3">
              Cloudwise does not reproduce the framework's own wording. What follows is exactly what
              it inspects on your behalf against this control.
            </p>

            <div className="space-y-3">
              {policies.map(({ descriptor, assignment, openViolations }) => (
                <div key={descriptor.key} className="rounded-md border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-sm">{descriptor.title}</span>
                    <SeverityBadge severity={assignment.severity} />
                    {assignment.enabled ? (
                      openViolations > 0 ? (
                        <Badge variant="outline" className="font-normal text-xs text-amber-600 border-amber-600/30">
                          {openViolations} open
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="font-normal text-xs text-green-600 border-green-600/30">
                          clean
                        </Badge>
                      )
                    ) : (
                      <Badge variant="secondary" className="font-normal text-xs">disabled</Badge>
                    )}
                  </div>

                  <p className="text-sm text-muted-foreground mt-1.5">{descriptor.description}</p>
                  {/* The rationale is the part that actually teaches: it says why
                      the control exists in operational terms, not legal ones. */}
                  <p className="text-sm mt-2 leading-relaxed">{descriptor.rationale}</p>

                  <div className="flex flex-wrap gap-2 mt-3">
                    {assignment.enabled && openViolations > 0 && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          onOpenChange(false);
                          drill.toFindings({ status: 'open', policyKey: descriptor.key });
                        }}
                      >
                        View {openViolations} finding{openViolations === 1 ? '' : 's'}
                        <ChevronRight className="h-3.5 w-3.5 ml-1" />
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        onOpenChange(false);
                        drill.toPolicies(descriptor.key);
                      }}
                    >
                      <Settings2 className="h-3.5 w-3.5 mr-1.5" />
                      {/* Was "Configure policy", which readers took to mean
                          "you must set something up before this works". It means
                          "change this rule's own settings" — rarely what anyone
                          wants while looking at a broken resource. */}
                      {assignment.enabled ? 'Rule settings' : 'Turn this rule on'}
                    </Button>
                  </div>
                </div>
              ))}

              {policies.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  The policies mapped to this control are not in the loaded catalog.
                </p>
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FrameworksTab({ drill }: { drill: Drilldown }) {
  const { data, isLoading } = useFrameworkCoverage();
  const { data: catalog } = usePolicyCatalog();
  const [selected, setSelected] = useState<{ framework: string; control: FrameworkCoverage['controls'][number] } | null>(null);

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const frameworks = data?.frameworks ?? [];
  const byKey = new Map((catalog?.policies ?? []).map(p => [p.descriptor.key, p]));

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        A control counts as compliant only when a policy claiming it is switched on and has no open
        findings. A control nobody monitors is shown as unmonitored, never as passing. Click any
        control to see what Cloudwise checks for it.
      </p>

      {frameworks.map(f => (
        <Card key={f.framework}>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <CardTitle className="text-base">{f.framework}</CardTitle>
                <CardDescription>
                  {f.compliantControls} of {f.totalControls} mapped controls clean ·{' '}
                  {f.totalControls - f.monitoredControls} unmonitored
                </CardDescription>
              </div>
              <div className="w-40">
                <ScoreBar score={f.totalControls ? (f.compliantControls / f.totalControls) * 100 : 0} />
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid gap-1 sm:grid-cols-2">
              {f.controls.map(c => (
                <button
                  key={c.control}
                  type="button"
                  onClick={() => setSelected({ framework: f.framework, control: c })}
                  className="flex items-start gap-2 text-sm text-left hover:bg-accent/50 rounded px-2 py-1.5 -mx-2"
                >
                  {c.status === 'compliant' ? (
                    <ShieldCheck className="h-4 w-4 text-green-600 shrink-0 mt-0.5" />
                  ) : c.status === 'violations' ? (
                    <ShieldAlert className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                  ) : (
                    <HelpCircle className="h-4 w-4 text-muted-foreground/60 shrink-0 mt-0.5" />
                  )}
                  <div className="min-w-0">
                    <p className={c.status === 'not-monitored' ? 'text-muted-foreground' : ''}>
                      {c.control}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {c.status === 'not-monitored'
                        ? `${c.totalPolicies} polic${c.totalPolicies === 1 ? 'y' : 'ies'} available, none enabled`
                        : c.violations > 0
                          ? `${c.violations} open finding${c.violations === 1 ? '' : 's'}`
                          : `${c.enabledPolicies} polic${c.enabledPolicies === 1 ? 'y' : 'ies'} monitoring`}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      ))}

      {selected && (
        <ControlDetail
          framework={selected.framework}
          control={selected.control}
          policies={selected.control.policyKeys
            .map(k => byKey.get(k))
            .filter((p): p is PolicyCatalogEntry => p !== undefined)}
          onOpenChange={open => { if (!open) setSelected(null); }}
          drill={drill}
        />
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function GovernancePage() {
  const { can } = useAuth();
  const { toast } = useToast();
  const [tab, setTab] = useState('posture');

  // Owned here, not inside the tabs, so a drill-down can set a filter and
  // switch tab in one action and the filter survives switching away and back.
  const [findingFilters, setFindingFilters] = useState<ViolationFilters>({ status: 'open' });
  const [focusPolicy, setFocusPolicy] = useState<string | null>(null);

  const canWrite = can('governance:write');
  const canExempt = can('governance:exempt');

  const { data: posture } = usePosture();
  const { data: catalog, isLoading: catalogLoading } = usePolicyCatalog();
  const run = useRunEvaluation();

  const drill: Drilldown = {
    toFindings: (filters) => {
      setFindingFilters(filters);
      setTab('findings');
    },
    toPolicies: (policyKey) => {
      setFocusPolicy(policyKey ?? null);
      setTab('policies');
    },
  };

  const evaluate = async () => {
    try {
      const result = await run.mutateAsync();
      toast({
        title: `Score ${result.score.toFixed(0)}/100`,
        description:
          `${result.openViolations} open finding${result.openViolations === 1 ? '' : 's'}: ` +
          `${result.violationsOpened} new, ${result.violationsResolved} resolved.` +
          (result.notAssessed.length ? ` ${result.notAssessed.length} policies reached no verdict.` : ''),
      });
    } catch (err: any) {
      toast({ title: 'Evaluation failed', description: err.message, variant: 'destructive' });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Governance & Compliance</h1>
          <p className="text-muted-foreground mt-1">
            What your organization has agreed the cloud estate must look like, and where it does
            not — across AWS, Azure and GCP.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">
            Last evaluated {relativeTime(posture?.lastRunAt)}
          </span>
          {canWrite && (
            <Button onClick={evaluate} disabled={run.isPending}>
              <RefreshCw className={`h-4 w-4 mr-2 ${run.isPending ? 'animate-spin' : ''}`} />
              {run.isPending ? 'Evaluating…' : 'Evaluate now'}
            </Button>
          )}
        </div>
      </div>

      <GovernanceIntro policyCount={posture?.policiesAvailable ?? null} />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="posture">Posture</TabsTrigger>
          <TabsTrigger value="findings">
            Findings
            {posture && posture.openViolations > 0 && (
              <Badge variant="secondary" className="ml-2">{posture.openViolations}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="policies">Policies</TabsTrigger>
          <TabsTrigger value="exemptions">Exemptions</TabsTrigger>
          <TabsTrigger value="frameworks">Frameworks</TabsTrigger>
        </TabsList>

        {/* A tab name alone ("Posture", "Frameworks") tells a first-time reader
            nothing. One sentence under the strip costs a line and removes the
            guesswork about which tab answers which question. */}
        <p className="text-sm text-muted-foreground mt-3 max-w-3xl">{TAB_HELP[tab]}</p>

        <TabsContent value="posture" className="mt-6">
          <PostureTab drill={drill} />
        </TabsContent>

        <TabsContent value="findings" className="mt-6">
          <Findings
            canWrite={canWrite}
            canExempt={canExempt}
            filters={findingFilters}
            onFiltersChange={setFindingFilters}
          />
        </TabsContent>

        <TabsContent value="policies" className="mt-6">
          {catalogLoading ? (
            <p className="text-sm text-muted-foreground">Loading policies…</p>
          ) : (
            <PolicyCatalog
              policies={catalog?.policies ?? []}
              canWrite={canWrite}
              focusPolicyKey={focusPolicy}
              onFocusHandled={() => setFocusPolicy(null)}
            />
          )}
        </TabsContent>

        <TabsContent value="exemptions" className="mt-6">
          <ExemptionsTab canExempt={canExempt} />
        </TabsContent>

        <TabsContent value="frameworks" className="mt-6">
          <FrameworksTab drill={drill} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
