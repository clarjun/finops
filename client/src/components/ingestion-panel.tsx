/**
 * Ingestion status and controls.
 *
 * Until now there was no way to see whether cost data was current, no way to
 * trigger a refresh, and no way to load history — the scheduler ran every six
 * hours and that was the entire interface. A FinOps tool whose numbers might be
 * a day stale, with nothing on screen saying so, is a tool people stop trusting.
 */
import { useState } from "react";
import { Database, RefreshCw, AlertTriangle, CheckCircle2, Clock, DollarSign } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { useIngestionStatus, useRunIngestion } from "@/hooks/use-cost-store";

/** How stale data may get before it stops being trustworthy for decisions. */
const STALE_AFTER_HOURS = 30;   // one scheduled cycle (6h) plus generous slack

function hoursSince(iso: string | null): number | null {
  if (!iso) return null;
  return (Date.now() - new Date(iso).getTime()) / 3_600_000;
}

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'success') return 'default';
  if (status === 'partial') return 'secondary';
  if (status === 'failed') return 'destructive';
  return 'outline';
}

export function IngestionPanel() {
  const { toast } = useToast();
  const { can } = useAuth();
  const { data, isLoading } = useIngestionStatus();
  const runIngestion = useRunIngestion();

  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');

  // Ingestion spends money on billing APIs, so it is gated on account:write.
  const mayIngest = can('account:write');

  const coverage = data?.coverage;
  const runs = data?.recentRuns ?? [];
  const staleHours = hoursSince(coverage?.lastUpdated ?? null);
  const isStale = staleHours !== null && staleHours > STALE_AFTER_HOURS;
  const hasData = (coverage?.rows ?? 0) > 0;

  const run = (body: { start?: string; end?: string }) => {
    runIngestion.mutate(body, {
      onSuccess: (result) => {
        const failed = result.results.filter(r => r.status === 'failed');
        const partial = result.results.filter(r => r.status === 'partial');

        // Report partial and failed providers explicitly. A summary that only
        // shows the total row count would hide one cloud silently returning
        // nothing, which is indistinguishable from that cloud costing nothing.
        toast({
          title: failed.length > 0 ? 'Ingestion finished with errors' : 'Ingestion complete',
          description:
            `${result.totalRecords} records, ${result.totalApiCalls} API call(s).` +
            (failed.length ? ` Failed: ${failed.map(f => f.provider).join(', ')}.` : '') +
            (partial.length ? ` Partial: ${partial.map(f => f.provider).join(', ')}.` : ''),
          variant: failed.length > 0 ? 'destructive' : undefined,
        });
      },
      onError: (e) => toast({ title: 'Ingestion failed', description: e.message, variant: 'destructive' }),
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Database className="h-5 w-5" /> Cost Data Ingestion
        </CardTitle>
        <CardDescription>
          Cost data is pulled from your providers on a schedule and stored locally. Dashboards read
          the stored copy, so they do not call billing APIs on every page load.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading ingestion status…</p>
        ) : !hasData ? (
          <div className="flex items-start gap-2 rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3">
            <AlertTriangle className="h-4 w-4 text-yellow-600 mt-0.5 shrink-0" />
            <div className="text-sm">
              <p className="font-medium">No cost data has been ingested yet.</p>
              <p className="text-muted-foreground">
                Dashboards are falling back to live provider calls. Run ingestion to populate the store.
              </p>
            </div>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <p className="text-xs text-muted-foreground">Data covers</p>
              <p className="font-medium">{coverage?.earliest} → {coverage?.latest}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Records stored</p>
              <p className="font-medium">{coverage?.rows.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Last updated</p>
              <p className={`font-medium flex items-center gap-1.5 ${isStale ? 'text-yellow-600' : ''}`}>
                {isStale ? <AlertTriangle className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />}
                {coverage?.lastUpdated
                  ? `${new Date(coverage.lastUpdated).toLocaleString()}${staleHours !== null ? ` (${Math.floor(staleHours)}h ago)` : ''}`
                  : 'never'}
              </p>
            </div>
          </div>
        )}

        {isStale && (
          <p className="text-sm text-yellow-600">
            Data is more than {STALE_AFTER_HOURS} hours old. The scheduler may not be running.
          </p>
        )}

        {mayIngest ? (
          <div className="space-y-4 border-t pt-4">
            <div className="flex flex-wrap items-end gap-3">
              <Button
                onClick={() => run({})}
                disabled={runIngestion.isPending}
                className="gap-2"
                data-testid="button-ingest-now"
              >
                <RefreshCw className={`h-4 w-4 ${runIngestion.isPending ? 'animate-spin' : ''}`} />
                {runIngestion.isPending ? 'Ingesting…' : 'Refresh now'}
              </Button>
              <p className="text-xs text-muted-foreground pb-2">
                Re-reads the last 7 days. Providers restate recent days, so this window is always re-fetched.
              </p>
            </div>

            <div className="space-y-2">
              <Label className="text-sm">Backfill history</Label>
              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <Label htmlFor="ingest-start" className="text-xs text-muted-foreground">From</Label>
                  <Input id="ingest-start" type="date" value={start} onChange={e => setStart(e.target.value)} className="w-40" />
                </div>
                <div>
                  <Label htmlFor="ingest-end" className="text-xs text-muted-foreground">To</Label>
                  <Input id="ingest-end" type="date" value={end} onChange={e => setEnd(e.target.value)} className="w-40" />
                </div>
                <Button
                  variant="outline"
                  disabled={!start || !end || runIngestion.isPending}
                  onClick={() => run({ start, end })}
                  data-testid="button-backfill"
                >
                  Backfill
                </Button>
              </div>
              <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                <DollarSign className="h-3 w-3" />
                Billing APIs charge per request — AWS Cost Explorer bills $0.01 per call. A long
                backfill costs real money, though it is safe to repeat: re-ingesting updates rows
                rather than duplicating them.
              </p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground border-t pt-4">
            Running ingestion requires the <code className="text-xs">account:write</code> permission.
          </p>
        )}

        {runs.length > 0 && (
          <div className="border-t pt-4">
            <p className="text-sm font-medium mb-2 flex items-center gap-1.5">
              <Clock className="h-4 w-4" /> Recent runs
            </p>
            <div className="space-y-1.5">
              {runs.slice(0, 6).map(r => (
                <div key={r.id} className="flex items-center justify-between text-sm gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Badge variant={statusVariant(r.status)} className="uppercase text-[10px]">{r.provider}</Badge>
                    <span className="text-muted-foreground truncate">
                      {r.periodStart?.slice(0, 10)} → {r.periodEnd?.slice(0, 10)}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-muted-foreground">{r.recordsIngested.toLocaleString()} rows</span>
                    <span className="text-xs text-muted-foreground">{r.apiCalls} call{r.apiCalls === 1 ? '' : 's'}</span>
                    <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                  </div>
                </div>
              ))}
            </div>
            {/* Warnings live in the error column even for partial successes —
                an expired Azure secret shows up here rather than nowhere. */}
            {runs.filter(r => r.error).slice(0, 2).map(r => (
              <p key={`err-${r.id}`} className="text-xs text-destructive mt-2 break-words">
                {r.provider}: {r.error!.slice(0, 220)}
              </p>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
