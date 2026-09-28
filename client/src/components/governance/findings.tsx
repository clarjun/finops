/**
 * The findings list.
 *
 * Two actions, kept deliberately distinct because conflating them is how a
 * governance programme dies: acknowledging says "seen, in hand" and changes
 * nothing about the score; exempting suppresses the finding and costs a written
 * reason, an expiry date and a higher permission. If acknowledging also
 * silenced findings, everything would be acknowledged within a week.
 */
import { useState } from "react";
import {
  DEFAULT_EXEMPTION_DAYS,
  MAX_EXEMPTION_DAYS,
  POLICY_DOMAINS,
  POLICY_SEVERITIES,
  DOMAIN_LABEL,
  SEVERITY_LABEL,
  type ViolationView,
} from "@shared/governance";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useViolations,
  useAcknowledgeViolation,
  useGrantExemption,
  usePolicyCatalog,
  type ViolationFilters,
} from "@/hooks/use-governance";
import { SeverityBadge, EnforcementBadge, money, relativeTime } from "./shared";
import { ChevronDown, ChevronRight, Check, ShieldOff, X, HelpCircle } from "lucide-react";

// ── Exemption dialog ──────────────────────────────────────────────────────────

function ExemptDialog({
  violation,
  open,
  onOpenChange,
}: {
  violation: ViolationView;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { toast } = useToast();
  const grant = useGrantExemption();
  const [reason, setReason] = useState('');
  const [days, setDays] = useState(DEFAULT_EXEMPTION_DAYS);
  // Scoped to the resource by default. An exemption covering the whole policy
  // is occasionally right and should be a conscious click, not the default.
  const [wholePolicy, setWholePolicy] = useState(false);

  const tooShort = reason.trim().length < 10;

  const submit = async () => {
    try {
      await grant.mutateAsync({
        policyKey: violation.policyKey,
        resourceId: wholePolicy ? null : violation.resourceId ?? null,
        reason: reason.trim(),
        expiresInDays: days,
      });
      toast({
        title: 'Exemption granted',
        description: `Suppressed for ${days} days. It reappears automatically when the exemption expires.`,
      });
      onOpenChange(false);
    } catch (err: any) {
      toast({ title: 'Could not grant exemption', description: err.message, variant: 'destructive' });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Accept this risk, temporarily</DialogTitle>
          <DialogDescription>
            An exemption stops this finding counting against your posture. It expires on its own —
            it does not change the policy.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-md border bg-muted/40 p-3">
            <p className="text-sm font-medium">{violation.title}</p>
            <p className="text-xs text-muted-foreground mt-1">{violation.policyTitle}</p>
          </div>

          <div className="space-y-1.5">
            <Label>Why is this acceptable?</Label>
            <Textarea
              rows={3}
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="e.g. Legacy billing export bucket, decommission scheduled for Q3 under CHG-4417."
            />
            <p className="text-xs text-muted-foreground">
              Recorded against your name in the audit log. Whoever reviews this in six months has
              only this sentence to go on.
            </p>
            {tooShort && reason.length > 0 && (
              <p className="text-xs text-destructive">At least 10 characters.</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Expires in</Label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                max={MAX_EXEMPTION_DAYS}
                className="max-w-[8rem]"
                value={days}
                onChange={e => setDays(Number(e.target.value))}
              />
              <span className="text-sm text-muted-foreground">days</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Maximum {MAX_EXEMPTION_DAYS} days. The finding returns automatically afterwards.
            </p>
          </div>

          {violation.resourceId && (
            <div className="space-y-1.5">
              <Label>Covers</Label>
              <Select value={wholePolicy ? 'policy' : 'resource'} onValueChange={v => setWholePolicy(v === 'policy')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="resource">This resource only</SelectItem>
                  <SelectItem value="policy">Every finding from this policy</SelectItem>
                </SelectContent>
              </Select>
              {wholePolicy && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  This suppresses the whole policy for the exemption period. Disabling the policy
                  outright is usually the more honest choice.
                </p>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={tooShort || grant.isPending || days < 1}>
            {grant.isPending ? 'Granting…' : 'Grant exemption'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Row ───────────────────────────────────────────────────────────────────────

function FindingRow({
  violation,
  rationale,
  canWrite,
  canExempt,
}: {
  violation: ViolationView;
  /** Why the rule exists, from the policy catalog. The "why should I care" half. */
  rationale?: string;
  canWrite: boolean;
  canExempt: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [exempting, setExempting] = useState(false);
  const { toast } = useToast();
  const acknowledge = useAcknowledgeViolation();

  const ack = async () => {
    try {
      await acknowledge.mutateAsync({ id: violation.id });
      toast({
        title: 'Acknowledged',
        description: 'Still counted against your posture — acknowledging records triage, not a fix.',
      });
    } catch (err: any) {
      toast({ title: 'Could not acknowledge', description: err.message, variant: 'destructive' });
    }
  };

  return (
    <div className="py-3">
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          className="mt-0.5 text-muted-foreground hover:text-foreground shrink-0"
          aria-label={expanded ? 'Hide the explanation' : 'Explain this finding'}
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={violation.severity} />
            <span className="font-medium">{violation.title}</span>
            {violation.status === 'acknowledged' && (
              <Badge variant="secondary" className="font-normal">acknowledged</Badge>
            )}
            {violation.status === 'exempt' && (
              <Badge variant="outline" className="font-normal">exempt</Badge>
            )}
            {violation.enforcement === 'block' && <EnforcementBadge mode="block" />}
          </div>

          <p className="text-sm text-muted-foreground mt-1">{violation.detail}</p>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-xs text-muted-foreground">
            <span>{violation.policyTitle}</span>
            {violation.provider && <span>· {violation.provider.toUpperCase()}</span>}
            {violation.accountId && <span>· {violation.accountId}</span>}
            {violation.region && <span>· {violation.region}</span>}
            <span>· first seen {relativeTime(violation.firstSeenAt)}</span>
            {violation.monthlyCostImpact !== null && (
              <span>· {money(violation.monthlyCostImpact)}/month at stake</span>
            )}
          </div>

          {/* An explicit control, not just the chevron. The explanation is the
              most useful thing on the row and a bare arrow does not advertise
              that it is there. */}
          {!expanded && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              <HelpCircle className="h-3.5 w-3.5" />
              What is this, and what should I do?
            </button>
          )}

          {expanded && (
            <div className="mt-3 space-y-3 rounded-md border bg-muted/40 p-3">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  1 · What we found
                </p>
                <p className="text-sm mt-1">{violation.detail}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Found by the rule “{violation.policyTitle}”.
                </p>
              </div>

              {/* The half that was missing. "Why this matters" is what turns a
                  row of jargon into something a reader can decide about; without
                  it every finding looks equally arbitrary. */}
              {rationale && (
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    2 · Why this matters
                  </p>
                  <p className="text-sm mt-1">{rationale}</p>
                </div>
              )}

              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {rationale ? '3' : '2'} · How to fix it
                </p>
                <p className="text-sm mt-1">{violation.remediation}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Fix the resource and this finding closes on its own at the next evaluation —
                  there is nothing here to mark as done.
                </p>
              </div>

              {violation.resourceId && (
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Resource</p>
                  <p className="text-sm mt-1 font-mono break-all">{violation.resourceId}</p>
                </div>
              )}

              {violation.evidence && Object.keys(violation.evidence).length > 0 && (
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Evidence
                  </p>
                  <dl className="mt-1 grid gap-x-4 gap-y-1 sm:grid-cols-2">
                    {Object.entries(violation.evidence).map(([k, v]) => (
                      <div key={k} className="flex gap-2 text-sm min-w-0">
                        <dt className="text-muted-foreground shrink-0">{k}</dt>
                        <dd className="font-mono text-xs break-all self-center">
                          {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}

              <p className="text-xs text-muted-foreground">
                Last confirmed {relativeTime(violation.lastSeenAt)}.
              </p>
            </div>
          )}
        </div>

        {violation.status !== 'exempt' && (
          // Both verbs are ours, not the reader's, and both are easy to mistake
          // for "fix". Neither changes anything in the cloud — the tooltips say
          // so rather than leaving someone to find out by clicking.
          <TooltipProvider delayDuration={200}>
            <div className="flex shrink-0 gap-1">
              {canWrite && violation.status === 'open' && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="sm" onClick={ack} disabled={acknowledge.isPending}>
                      <Check className="h-4 w-4 mr-1.5" />
                      Acknowledge
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs text-sm leading-relaxed">
                    Records that someone has seen this and is dealing with it. It does not fix
                    anything and it still counts against your score.
                  </TooltipContent>
                </Tooltip>
              )}
              {canExempt && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="sm" onClick={() => setExempting(true)}>
                      <ShieldOff className="h-4 w-4 mr-1.5" />
                      Exempt
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs text-sm leading-relaxed">
                    Accept this one on purpose, with a reason and an expiry date. It stops counting
                    against your score but stays visible under Exemptions.
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          </TooltipProvider>
        )}
      </div>

      {exempting && (
        <ExemptDialog violation={violation} open={exempting} onOpenChange={setExempting} />
      )}
    </div>
  );
}

// ── List ──────────────────────────────────────────────────────────────────────

/**
 * Filters are owned by the page, not by this component.
 *
 * They have to be, because the posture cards navigate here WITH a filter
 * already applied — "show me the 19 critical findings" is the whole point of
 * making a number clickable. Local state would be overwritten on every tab
 * switch and the drill-down would silently land on an unfiltered list.
 */
export function Findings({
  canWrite,
  canExempt,
  filters,
  onFiltersChange,
}: {
  canWrite: boolean;
  canExempt: boolean;
  filters: ViolationFilters;
  onFiltersChange: (f: ViolationFilters) => void;
}) {
  const { data, isLoading } = useViolations(filters);

  // The catalog carries each rule's rationale — the "why does this matter"
  // sentence. The violations endpoint does not return it, and joining here
  // costs nothing because the catalog is already cached for the Policies tab.
  const { data: catalog } = usePolicyCatalog();
  const rationaleFor = new Map(
    (catalog?.policies ?? []).map(p => [p.descriptor.key, p.descriptor.rationale]),
  );

  const violations = data?.violations ?? [];

  const set = (key: keyof ViolationFilters, value: string) =>
    onFiltersChange({ ...filters, [key]: value === 'all' ? undefined : value });

  const narrowed =
    !!filters.severity || !!filters.domain || !!filters.policyKey || !!filters.provider;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <CardTitle>Findings</CardTitle>
            <CardDescription>
              One row per problem, worst first, then by the spend at stake. Open any row to see
              what it means, why it matters and how to fix it. Fixing the resource closes the row
              automatically at the next evaluation.
            </CardDescription>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {narrowed && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onFiltersChange({ status: filters.status ?? 'open' })}
              >
                <X className="h-3.5 w-3.5 mr-1.5" />
                Clear filters
              </Button>
            )}
            <Select value={filters.status ?? 'open'} onValueChange={v => set('status', v)}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="open">Open</SelectItem>
                <SelectItem value="acknowledged">Acknowledged</SelectItem>
                <SelectItem value="exempt">Exempt</SelectItem>
                <SelectItem value="resolved">Resolved</SelectItem>
                <SelectItem value="all">Everything</SelectItem>
              </SelectContent>
            </Select>

            <Select value={filters.severity ?? 'all'} onValueChange={v => set('severity', v)}>
              <SelectTrigger className="w-36"><SelectValue placeholder="Severity" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any severity</SelectItem>
                {POLICY_SEVERITIES.map(s => (
                  <SelectItem key={s} value={s}>{SEVERITY_LABEL[s]}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={filters.domain ?? 'all'} onValueChange={v => set('domain', v)}>
              <SelectTrigger className="w-48"><SelectValue placeholder="Domain" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Every domain</SelectItem>
                {POLICY_DOMAINS.map(d => (
                  <SelectItem key={d} value={d}>{DOMAIN_LABEL[d]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>

      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : violations.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-sm text-muted-foreground">
              {narrowed
                ? 'Nothing matches these filters.'
                : filters.status === 'open'
                  ? 'No open findings.'
                  : 'Nothing matches this filter.'}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {narrowed
                ? 'Clear the filters to see everything else.'
                : 'If no evaluation has run yet, this is an empty page rather than a clean bill of health.'}
            </p>
          </div>
        ) : (
          <>
            <div className="divide-y">
              {violations.map(v => (
                <FindingRow
                  key={v.id}
                  violation={v}
                  rationale={rationaleFor.get(v.policyKey)}
                  canWrite={canWrite}
                  canExempt={canExempt}
                />
              ))}
            </div>
            {data?.truncated && (
              <p className="text-xs text-muted-foreground pt-3">
                Showing the first {violations.length}. Narrow the filters to see the rest.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
