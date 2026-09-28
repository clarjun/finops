/**
 * The evidence behind an approval.
 *
 * The gate used to show a sentence — "Creates a database — risk: high" — while
 * the system already knew the plan would set `publicly_accessible = true` and
 * `storage_encrypted = false`. This is that knowledge, put in front of the
 * person being asked to approve it.
 *
 * Order is the whole design. Findings first, because they are what should stop
 * a deployment; then the resource list, because "what exactly changes" is the
 * next question; then the Terraform, collapsed, because almost nobody reads it
 * and the few who do need it to be there.
 *
 * This is also the argument for reviewing here rather than in a pull request. A
 * diff shows a reviewer text and hopes they notice the wrong line. This reads
 * the planned values and says what is wrong, at the top.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertOctagon, AlertTriangle, Info, ChevronDown, ChevronRight,
  Plus, RefreshCw, Trash2, PencilLine, FileCode2, ShieldCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";

export interface PlanFindingView {
  address: string;
  resourceType: string;
  severity: 'critical' | 'high' | 'medium';
  title: string;
  detail: string;
  attribute?: string;
}

export interface PlannedChangeView {
  address: string;
  resourceType: string;
  /** create | update | replace | delete */
  action: string;
}

// Explicit classes: Tailwind only sees literals, so a template string would
// compile to nothing in production.
const SEVERITY_STYLE: Record<PlanFindingView['severity'], { box: string; icon: string; label: string }> = {
  critical: {
    box: 'border-red-500/50 bg-red-500/5',
    icon: 'text-red-600 dark:text-red-400',
    label: 'Critical',
  },
  high: {
    box: 'border-orange-500/50 bg-orange-500/5',
    icon: 'text-orange-600 dark:text-orange-400',
    label: 'High',
  },
  medium: {
    box: 'border-amber-500/40 bg-amber-500/5',
    icon: 'text-amber-600 dark:text-amber-400',
    label: 'Medium',
  },
};

const ACTION_STYLE: Record<string, { icon: typeof Plus; className: string; label: string }> = {
  create:  { icon: Plus,       className: 'text-green-600 dark:text-green-400',   label: 'create' },
  update:  { icon: PencilLine, className: 'text-sky-600 dark:text-sky-400',       label: 'update' },
  // Replace and delete are both red on purpose: a replacement destroys the
  // existing resource, and in a count it is indistinguishable from a swap.
  replace: { icon: RefreshCw,  className: 'text-red-600 dark:text-red-400',       label: 'replace' },
  delete:  { icon: Trash2,     className: 'text-red-600 dark:text-red-400',       label: 'delete' },
};

function FindingRow({ finding }: { finding: PlanFindingView }) {
  const style = SEVERITY_STYLE[finding.severity];
  const Icon = finding.severity === 'critical' ? AlertOctagon
    : finding.severity === 'high' ? AlertTriangle
    : Info;

  return (
    <div className={`rounded-md border p-3 ${style.box}`}>
      <div className="flex items-start gap-2.5">
        <Icon className={`h-4 w-4 shrink-0 mt-0.5 ${style.icon}`} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-sm">{finding.title}</span>
            <Badge variant="outline" className="text-[10px] uppercase">{style.label}</Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-1">{finding.detail}</p>
          <p className="text-xs font-mono text-muted-foreground mt-1.5 break-all">
            {finding.address}
            {finding.attribute && <span className="text-foreground"> · {finding.attribute}</span>}
          </p>
        </div>
      </div>
    </div>
  );
}

function ChangeRow({ change }: { change: PlannedChangeView }) {
  const style = ACTION_STYLE[change.action] ?? {
    icon: PencilLine, className: 'text-muted-foreground', label: change.action,
  };
  const Icon = style.icon;

  return (
    <div className="flex items-center gap-2 py-1 text-sm">
      <Icon className={`h-3.5 w-3.5 shrink-0 ${style.className}`} />
      <span className={`w-16 shrink-0 text-xs ${style.className}`}>{style.label}</span>
      <span className="font-mono text-xs break-all">{change.address}</span>
    </div>
  );
}

/** Lazily fetched: most approvers never open it, and it is regenerated server-side. */
function TerraformSource({ planId }: { planId: number }) {
  const [open, setOpen] = useState(false);

  const { data, isLoading, error } = useQuery<{ mainTf: string; backendDescription: string | null; backendError: string | null }>({
    queryKey: ['/api/infra/plans', planId, 'terraform'],
    enabled: open,
    queryFn: async () => {
      const res = await fetch(`/api/infra/plans/${planId}/terraform`, { credentials: 'include' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
      return body;
    },
    staleTime: 5 * 60 * 1000,
  });

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <FileCode2 className="h-4 w-4" />
        {open ? 'Hide' : 'Show'} the Terraform this will run
      </button>

      {open && (
        <div className="mt-2">
          {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}

          {data && (
            <>
              <p className="text-xs text-muted-foreground mb-1.5">
                State: {data.backendDescription ?? 'local — not durable'}
                {data.backendError && <span className="text-destructive"> · {data.backendError}</span>}
              </p>
              {/* Regenerated from the stored plan, and generation is
                  deterministic, so this is the configuration that runs. */}
              <pre className="max-h-96 overflow-auto rounded-md border bg-muted/40 p-3 text-xs leading-relaxed">
                <code>{data.mainTf}</code>
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function PlanReview({
  findings,
  changes,
  planId,
}: {
  findings: PlanFindingView[];
  changes: PlannedChangeView[];
  planId: number | null;
}) {
  const [showAllChanges, setShowAllChanges] = useState(false);

  // Destructive actions first: they are the ones a reviewer must not miss, and
  // in a long alphabetical list they would sit wherever the name happened to
  // put them.
  const ordered = [...changes].sort((a, b) => {
    const weight = (c: PlannedChangeView) => (c.action === 'delete' || c.action === 'replace' ? 0 : 1);
    return weight(a) - weight(b) || a.address.localeCompare(b.address);
  });

  const visible = showAllChanges ? ordered : ordered.slice(0, 8);
  const destructive = changes.filter(c => c.action === 'delete' || c.action === 'replace').length;

  return (
    <div className="space-y-4">
      {findings.length > 0 ? (
        <div>
          <p className="text-xs text-muted-foreground mb-1.5">
            Found in the plan — these are the values this deployment will actually set
          </p>
          <div className="space-y-2">
            {findings.map((f, i) => (
              <FindingRow key={`${f.address}-${f.attribute ?? i}`} finding={f} />
            ))}
          </div>
        </div>
      ) : changes.length > 0 ? (
        // Said explicitly. An absent section reads as "not checked", which is a
        // different and much weaker statement than "checked, nothing found".
        <div className="flex items-center gap-2 rounded-md border border-green-600/30 bg-green-500/5 p-2.5 text-sm">
          <ShieldCheck className="h-4 w-4 text-green-600 shrink-0" />
          <span>No public exposure, unencrypted storage or destructive change found in this plan.</span>
        </div>
      ) : null}

      {changes.length > 0 && (
        <div>
          <p className="text-xs text-muted-foreground mb-1">
            {changes.length} resource{changes.length === 1 ? '' : 's'} affected
            {destructive > 0 && (
              <span className="text-red-600 dark:text-red-400 font-medium">
                {' '}· {destructive} destroyed or replaced
              </span>
            )}
          </p>
          <div className="rounded-md border divide-y divide-border/50 px-3 py-1">
            {visible.map(c => <ChangeRow key={c.address} change={c} />)}
          </div>
          {ordered.length > visible.length && (
            <button
              type="button"
              onClick={() => setShowAllChanges(true)}
              className="text-xs text-muted-foreground hover:text-foreground mt-1.5"
            >
              Show {ordered.length - visible.length} more
            </button>
          )}
        </div>
      )}

      {planId !== null && <TerraformSource planId={planId} />}
    </div>
  );
}
