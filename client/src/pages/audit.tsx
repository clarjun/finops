/**
 * Audit log viewer.
 *
 * The log has been written since the tenancy work landed but had no way to read
 * it short of querying the database. An audit trail nobody can look at only
 * satisfies a checkbox, not an incident.
 */
import { useState } from "react";
import { ShieldAlert, ShieldCheck, ShieldX, Filter, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuditLogs, type AuditLogEntry } from "@/hooks/use-cost-store";

/** Groupings that answer the questions actually asked after an incident. */
const FILTERS: Array<{ label: string; value: string }> = [
  { label: 'Everything', value: '' },
  { label: 'Sign-ins', value: 'auth.login' },
  { label: 'Permission denials', value: 'authz.denied' },
  { label: 'Agent executions', value: 'agent.action.execute' },
  { label: 'Agent guardrail decisions', value: 'agent.action.guardrail' },
  { label: 'Credential changes', value: 'cloud_account.create' },
  { label: 'User changes', value: 'user.create' },
];

function outcomeIcon(outcome: AuditLogEntry['outcome']) {
  if (outcome === 'denied') return <ShieldX className="h-4 w-4 text-destructive" />;
  if (outcome === 'failure') return <ShieldAlert className="h-4 w-4 text-yellow-600" />;
  return <ShieldCheck className="h-4 w-4 text-green-600" />;
}

function outcomeVariant(outcome: AuditLogEntry['outcome']): 'default' | 'secondary' | 'destructive' {
  if (outcome === 'denied') return 'destructive';
  if (outcome === 'failure') return 'secondary';
  return 'default';
}

/** One-line summary of the interesting parts of a metadata blob. */
function summarize(entry: AuditLogEntry): string | null {
  const m = entry.metadata;
  if (!m) return null;

  if (typeof m.requiredPermission === 'string') {
    return `needed ${m.requiredPermission}, had role ${m.role ?? 'unknown'}`;
  }
  if (typeof m.decision === 'string') {
    const reasons = Array.isArray(m.reasons) ? m.reasons.join(' ') : '';
    return `${m.decision}${reasons ? ` — ${reasons}` : ''}`;
  }
  if (typeof m.reason === 'string') return String(m.reason);
  if (m.simulated === true) return 'simulated (dry run)';
  if (m.simulated === false) return 'applied to live infrastructure';
  if (m.body && typeof m.body === 'object') {
    return Object.keys(m.body as Record<string, unknown>).join(', ');
  }
  return null;
}

export default function AuditPage() {
  const [action, setAction] = useState('');
  const { data, isLoading, refetch, isFetching } = useAuditLogs({ limit: 200, action: action || undefined });

  const logs = data?.logs ?? [];
  const denials = logs.filter(l => l.outcome === 'denied').length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Audit Log</h1>
          <p className="text-muted-foreground mt-1">
            Every state-changing request, sign-in and permission denial for your organization.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={action || 'all'} onValueChange={v => setAction(v === 'all' ? '' : v)}>
            <SelectTrigger className="w-60">
              <Filter className="h-4 w-4 mr-2" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FILTERS.map(f => (
                <SelectItem key={f.value || 'all'} value={f.value || 'all'}>{f.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="icon" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {denials > 0 && (
        <p className="text-sm text-muted-foreground">
          {denials} denied attempt{denials === 1 ? '' : 's'} in this view.
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
          <CardDescription>
            Entries are append-only and cannot be edited or removed, including by an administrator.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : logs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No entries match this filter.</p>
          ) : (
            <div className="divide-y">
              {logs.map(entry => {
                const detail = summarize(entry);
                return (
                  <div key={entry.id} className="flex items-start gap-3 py-3">
                    <div className="mt-0.5">{outcomeIcon(entry.outcome)}</div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-sm">{entry.action}</span>
                        <Badge variant={outcomeVariant(entry.outcome)} className="text-[10px]">
                          {entry.outcome}
                        </Badge>
                        {entry.statusCode && (
                          <span className="text-xs text-muted-foreground">{entry.statusCode}</span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 break-words">
                        {entry.actorUsername ?? 'system'}
                        {entry.actorIp ? ` · ${entry.actorIp}` : ''}
                        {entry.method && entry.path ? ` · ${entry.method} ${entry.path}` : ''}
                        {entry.resourceType ? ` · ${entry.resourceType}${entry.resourceId ? ` #${entry.resourceId}` : ''}` : ''}
                      </p>
                      {detail && (
                        <p className="text-xs text-muted-foreground mt-0.5 break-words italic">{detail}</p>
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground whitespace-nowrap shrink-0">
                      {new Date(entry.createdAt).toLocaleString()}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
