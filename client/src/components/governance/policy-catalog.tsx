/**
 * The policy catalog, grouped by domain, with an editor per policy.
 *
 * The editor is generated from the descriptor's parameter specs rather than
 * hand-written per policy. That is what makes adding a policy a server-side
 * change only, and it is what keeps twenty policies from becoming twenty
 * bespoke forms that drift apart.
 */
import { useEffect, useRef, useState } from "react";
import {
  POLICY_DOMAINS,
  DOMAIN_LABEL,
  DOMAIN_DESCRIPTION,
  POLICY_SEVERITIES,
  ENFORCEMENT_MODES,
  ENFORCEMENT_LABEL,
  ENFORCEMENT_DESCRIPTION,
  SEVERITY_LABEL,
  isScopeEmpty,
  type PolicyCatalogEntry,
  type PolicyParameterSpec,
  type PolicyScope,
  type PolicySeverity,
  type EnforcementMode,
} from "@shared/governance";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { useUpdatePolicy, useResetPolicy, type PolicyUpdate } from "@/hooks/use-governance";
import { SeverityBadge, EnforcementBadge, DOMAIN_ICON } from "./shared";
import { AlertTriangle, RotateCcw, Settings2, ShieldCheck } from "lucide-react";

// ── Parameter inputs ──────────────────────────────────────────────────────────

function ParameterField({
  spec,
  value,
  onChange,
}: {
  spec: PolicyParameterSpec;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  if (spec.type === 'boolean') {
    return (
      <div className="flex items-start justify-between gap-4 py-2">
        <div className="min-w-0">
          <Label className="text-sm">{spec.label}</Label>
          {spec.help && <p className="text-xs text-muted-foreground mt-0.5">{spec.help}</p>}
        </div>
        <Switch checked={value === true} onCheckedChange={onChange} />
      </div>
    );
  }

  if (spec.type === 'stringList') {
    const list = Array.isArray(value) ? (value as string[]) : [];
    return (
      <div className="space-y-1.5 py-2">
        <Label className="text-sm">{spec.label}</Label>
        <Input
          // Comma-separated, because that is how people paste a list of tag
          // keys or regions. A chip editor looks better and is slower to use.
          value={list.join(', ')}
          placeholder={spec.placeholder ?? 'Comma-separated'}
          onChange={e => onChange(e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
        />
        {spec.suggestions && spec.suggestions.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-1">
            {spec.suggestions
              .filter(s => !list.some(v => v.toLowerCase() === s.toLowerCase()))
              .map(s => (
                <button
                  key={s}
                  type="button"
                  onClick={() => onChange([...list, s])}
                  className="text-xs rounded-full border border-dashed px-2 py-0.5 text-muted-foreground hover:text-foreground hover:border-solid"
                >
                  + {s}
                </button>
              ))}
          </div>
        )}
        {spec.help && <p className="text-xs text-muted-foreground">{spec.help}</p>}
        {list.length === 0 && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Empty. Until you add at least one entry, this rule cannot reach a verdict, so it is
            left out of your score rather than counted as a pass.
          </p>
        )}
      </div>
    );
  }

  if (spec.type === 'string') {
    return (
      <div className="space-y-1.5 py-2">
        <Label className="text-sm">{spec.label}</Label>
        <Input
          value={typeof value === 'string' ? value : ''}
          placeholder={spec.placeholder}
          onChange={e => onChange(e.target.value)}
        />
        {spec.help && <p className="text-xs text-muted-foreground">{spec.help}</p>}
      </div>
    );
  }

  const prefix = spec.type === 'currency' ? '$' : null;
  const suffix = spec.type === 'percent' ? '%' : null;

  return (
    <div className="space-y-1.5 py-2">
      <Label className="text-sm">{spec.label}</Label>
      <div className="flex items-center gap-2">
        {prefix && <span className="text-sm text-muted-foreground">{prefix}</span>}
        <Input
          type="number"
          className="max-w-[10rem]"
          min={spec.min}
          max={spec.max}
          value={typeof value === 'number' || typeof value === 'string' ? String(value) : ''}
          onChange={e => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        />
        {suffix && <span className="text-sm text-muted-foreground">{suffix}</span>}
      </div>
      {spec.help && <p className="text-xs text-muted-foreground">{spec.help}</p>}
    </div>
  );
}

// ── Scope editor ──────────────────────────────────────────────────────────────

function ScopeEditor({ scope, onChange }: { scope: PolicyScope; onChange: (s: PolicyScope) => void }) {
  const list = (v: string[] | undefined) => (v ?? []).join(', ');
  const parse = (v: string) => {
    const out = v.split(',').map(s => s.trim()).filter(Boolean);
    return out.length ? out : undefined;
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-sm">Providers</Label>
        <Input
          placeholder="aws, azure, gcp — leave empty for all"
          value={list(scope.providers)}
          onChange={e => onChange({ ...scope, providers: parse(e.target.value) })}
        />
      </div>
      <div className="space-y-1.5">
        <Label className="text-sm">Accounts</Label>
        <Input
          placeholder="Account, subscription or project ids — leave empty for all"
          value={list(scope.accountIds)}
          onChange={e => onChange({ ...scope, accountIds: parse(e.target.value) })}
        />
      </div>
      <div className="space-y-1.5">
        <Label className="text-sm">Regions</Label>
        <Input
          placeholder="us-east-1, westeurope — leave empty for all"
          value={list(scope.regions)}
          onChange={e => onChange({ ...scope, regions: parse(e.target.value) })}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        An empty field matches everything. Narrowing the scope makes the policy apply to less of
        the estate — it does not make the rest compliant.
      </p>
    </div>
  );
}

// ── Editor dialog ─────────────────────────────────────────────────────────────

function PolicyEditor({
  entry,
  open,
  onOpenChange,
  canWrite,
}: {
  entry: PolicyCatalogEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canWrite: boolean;
}) {
  const { descriptor, assignment } = entry;
  const { toast } = useToast();
  const update = useUpdatePolicy();
  const reset = useResetPolicy();

  const [draft, setDraft] = useState<PolicyUpdate>({
    enabled: assignment.enabled,
    severity: assignment.severity,
    enforcement: assignment.enforcement,
    parameters: { ...assignment.parameters },
    scope: { ...assignment.scope },
  });

  const save = async () => {
    try {
      const result = await update.mutateAsync({ policyKey: descriptor.key, update: draft });
      const warnings = (result as { warnings?: string[] })?.warnings ?? [];
      toast({
        title: 'Policy saved',
        description: warnings.length
          ? `Applied with adjustments: ${warnings.join(' ')}`
          : `${descriptor.title} takes effect on the next evaluation.`,
      });
      onOpenChange(false);
    } catch (err: any) {
      toast({ title: 'Could not save policy', description: err.message, variant: 'destructive' });
    }
  };

  const restore = async () => {
    try {
      await reset.mutateAsync(descriptor.key);
      toast({ title: 'Restored defaults', description: `${descriptor.title} is back on the catalog defaults.` });
      onOpenChange(false);
    } catch (err: any) {
      toast({ title: 'Could not reset policy', description: err.message, variant: 'destructive' });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{descriptor.title}</DialogTitle>
          <DialogDescription>{descriptor.description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="rounded-md border bg-muted/40 p-3 space-y-2">
            <p className="text-sm leading-relaxed">{descriptor.rationale}</p>
            <p className="text-sm leading-relaxed text-muted-foreground">
              <span className="font-medium text-foreground">To fix a violation: </span>
              {descriptor.remediation}
            </p>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label>Enabled</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                A disabled policy stops being evaluated and its open findings are closed.
              </p>
            </div>
            <Switch
              checked={draft.enabled}
              disabled={!canWrite}
              onCheckedChange={v => setDraft({ ...draft, enabled: v })}
            />
          </div>

          <Separator />

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-sm">Severity</Label>
              <Select
                value={draft.severity ?? descriptor.severity}
                disabled={!canWrite}
                onValueChange={v => setDraft({ ...draft, severity: v as PolicySeverity })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {POLICY_SEVERITIES.map(s => (
                    <SelectItem key={s} value={s}>
                      {SEVERITY_LABEL[s]}{s === descriptor.severity ? ' (default)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Drives how much this policy moves the posture score.</p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm">Enforcement</Label>
              <Select
                value={draft.enforcement}
                disabled={!canWrite}
                onValueChange={v => setDraft({ ...draft, enforcement: v as EnforcementMode })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ENFORCEMENT_MODES.map(m => (
                    <SelectItem key={m} value={m}>{ENFORCEMENT_LABEL[m]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{ENFORCEMENT_DESCRIPTION[draft.enforcement]}</p>
            </div>
          </div>

          {descriptor.parameters.length > 0 && (
            <>
              <Separator />
              <div>
                <h4 className="text-sm font-medium mb-1">Thresholds</h4>
                <div className="divide-y">
                  {descriptor.parameters.map(spec => (
                    <ParameterField
                      key={spec.key}
                      spec={spec}
                      value={draft.parameters[spec.key]}
                      onChange={v => setDraft({ ...draft, parameters: { ...draft.parameters, [spec.key]: v } })}
                    />
                  ))}
                </div>
              </div>
            </>
          )}

          {descriptor.supportsScope && (
            <>
              <Separator />
              <div>
                <h4 className="text-sm font-medium mb-2">Scope</h4>
                <ScopeEditor scope={draft.scope} onChange={s => setDraft({ ...draft, scope: s })} />
              </div>
            </>
          )}

          <Separator />

          <div>
            <h4 className="text-sm font-medium mb-2">Maps to</h4>
            <div className="flex flex-wrap gap-1.5">
              {descriptor.frameworks.map(fc => (
                <Badge key={`${fc.framework}-${fc.control}`} variant="secondary" className="font-normal">
                  {fc.framework} · {fc.control}
                </Badge>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          {!assignment.isDefault && canWrite && (
            <Button variant="ghost" onClick={restore} disabled={reset.isPending} className="mr-auto">
              <RotateCcw className="h-4 w-4 mr-2" />
              Restore defaults
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={!canWrite || update.isPending}>
            {update.isPending ? 'Saving…' : 'Save policy'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Catalog ───────────────────────────────────────────────────────────────────

function PolicyRow({
  entry,
  canWrite,
  autoOpen,
  onAutoOpened,
}: {
  entry: PolicyCatalogEntry;
  canWrite: boolean;
  /** Set when the page navigated here to show this specific policy. */
  autoOpen?: boolean;
  onAutoOpened?: () => void;
}) {
  const [editing, setEditing] = useState(false);

  // Opening on arrival is what makes "why was this not assessed?" a single
  // click from the posture card rather than a hunt through five sections.
  useEffect(() => {
    if (autoOpen) {
      setEditing(true);
      onAutoOpened?.();
    }
  }, [autoOpen, onAutoOpened]);
  const { descriptor, assignment, openViolations } = entry;

  // A policy that is on but has nothing to act on is not the same as a passing
  // one, and the row has to say so or it reads as a green tick.
  const unconfigured =
    descriptor.requiresConfiguration &&
    assignment.enabled &&
    descriptor.parameters.some(p => {
      const v = assignment.parameters[p.key];
      return p.type === 'stringList' && (!Array.isArray(v) || v.length === 0);
    });

  return (
    <>
      <div className="flex items-start gap-3 py-3">
        <div className="pt-0.5">
          {assignment.enabled
            ? openViolations > 0
              ? <AlertTriangle className="h-4 w-4 text-amber-500" />
              : <ShieldCheck className="h-4 w-4 text-green-600" />
            : <ShieldCheck className="h-4 w-4 text-muted-foreground/40" />}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`font-medium ${assignment.enabled ? '' : 'text-muted-foreground'}`}>
              {descriptor.title}
            </span>
            <SeverityBadge severity={assignment.severity} />
            {assignment.enforcement !== 'audit' && <EnforcementBadge mode={assignment.enforcement} />}
            {!assignment.isDefault && (
              <Badge variant="outline" className="font-normal text-xs">customised</Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">{descriptor.description}</p>

          {unconfigured && (
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
              Switched on, but it has nothing to check until you fill in its list — so it reports
              as “not assessed” rather than as passing.
            </p>
          )}
          {assignment.enabled && openViolations > 0 && (
            <p className="text-xs text-muted-foreground mt-1">
              {openViolations} open finding{openViolations === 1 ? '' : 's'}
            </p>
          )}
          {!assignment.isDefault && assignment.updatedByUsername && (
            <p className="text-xs text-muted-foreground mt-1">
              Last changed by {assignment.updatedByUsername}
            </p>
          )}
        </div>

        <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
          <Settings2 className="h-4 w-4 mr-1.5" />
          {canWrite ? 'Settings' : 'View'}
        </Button>
      </div>

      {/* Mounted only while open so the draft state resets to the saved values
          every time it is reopened, rather than keeping a stale edit around. */}
      {editing && (
        <PolicyEditor entry={entry} open={editing} onOpenChange={setEditing} canWrite={canWrite} />
      )}
    </>
  );
}

export function PolicyCatalog({
  policies,
  canWrite,
  focusPolicyKey,
  onFocusHandled,
}: {
  policies: PolicyCatalogEntry[];
  canWrite: boolean;
  /** A policy the page wants opened on arrival, from a posture drill-down. */
  focusPolicyKey?: string | null;
  onFocusHandled?: () => void;
}) {
  const focusRef = useRef<HTMLDivElement>(null);

  // Scroll the focused policy's section into view. Opening its dialog is not
  // enough on its own — dismissing the dialog would otherwise leave the reader
  // at the top of a long page with no idea which row they just looked at.
  useEffect(() => {
    if (focusPolicyKey && focusRef.current) {
      focusRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [focusPolicyKey]);

  return (
    <div className="space-y-6">
      {!canWrite && (
        <p className="text-sm text-muted-foreground">
          You can read the policy set but not change it. Changing what the organization is measured
          against requires the FinOps role or above.
        </p>
      )}

      {POLICY_DOMAINS.map(domain => {
        const inDomain = policies.filter(p => p.descriptor.domain === domain);
        if (inDomain.length === 0) return null;
        const Icon = DOMAIN_ICON[domain];
        const enabled = inDomain.filter(p => p.assignment.enabled).length;

        const holdsFocus = inDomain.some(p => p.descriptor.key === focusPolicyKey);

        return (
          <Card key={domain} ref={holdsFocus ? focusRef : undefined}>
            <CardHeader>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <Icon className="h-4 w-4" />
                    {DOMAIN_LABEL[domain]}
                  </CardTitle>
                  <CardDescription>{DOMAIN_DESCRIPTION[domain]}</CardDescription>
                </div>
                <Badge variant="secondary" className="shrink-0">
                  {enabled}/{inDomain.length} on
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="divide-y">
                {inDomain.map(entry => (
                  <PolicyRow
                    key={entry.descriptor.key}
                    entry={entry}
                    canWrite={canWrite}
                    autoOpen={entry.descriptor.key === focusPolicyKey}
                    onAutoOpened={onFocusHandled}
                  />
                ))}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
