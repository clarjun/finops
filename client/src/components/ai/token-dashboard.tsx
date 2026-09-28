/**
 * The metered AI view: tokens, calls, and what we calculate they cost.
 *
 * Distinct from the billing-derived view in the other tab, and the distinction
 * is the point. That one shows what the provider charged and is authoritative.
 * This one shows what we compute from metered usage — which is the only way to
 * get input/output tokens and call counts, because billing carries neither.
 * The two will differ (free tiers, committed-use discounts, rounding), and
 * presenting either as the other would be dishonest.
 *
 * Unpriced usage is surfaced at the top rather than folded into the total at
 * zero. A model with millions of tokens and no configured rate would otherwise
 * make the whole figure quietly too low.
 */
import { useState } from "react";
import {
  Coins, Cpu, Layers, ArrowDownUp, Boxes, AlertTriangle, RefreshCw, Plus, ExternalLink,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import {
  useAiTokens, useAiProviders, useIngestAiUsage, useSaveModelPrice, useRefreshRates,
  type GroupedSpend, type TokenFilterState,
} from "@/hooks/use-ai-tokens";

const money = (n: number): string =>
  n >= 1000 ? `$${Math.round(n).toLocaleString('en-US')}`
  : n >= 1 ? `$${n.toFixed(2)}`
  : `$${n.toFixed(4)}`;

const tokens = (n: number): string =>
  n >= 1_000_000_000 ? `${(n / 1_000_000_000).toFixed(2)}B`
  : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M`
  : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K`
  : n.toLocaleString();

const count = (n: number): string => n.toLocaleString('en-US');

/** A dash, not a zero. "No data" and "zero" are different facts. */
const orDash = (v: number | null, fmt: (n: number) => string): string =>
  v === null ? '—' : fmt(v);

function Bar({ share }: { share: number }) {
  return (
    <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
      <div className="h-full rounded-full bg-primary/70" style={{ width: `${Math.max(1, Math.min(100, share))}%` }} />
    </div>
  );
}

function GroupTable({ title, icon: Icon, rows, emptyHint }: {
  title: string;
  icon: typeof Coins;
  rows: GroupedSpend[];
  emptyHint: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2"><Icon className="h-4 w-4" /> {title}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">{emptyHint}</p>
        ) : (
          <div className="space-y-2.5">
            {rows.slice(0, 12).map(r => (
              <div key={r.key}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="truncate font-medium">{r.label}</span>
                  <span className="shrink-0 tabular-nums">{money(r.totalCost)}</span>
                </div>
                <div className="mt-1"><Bar share={r.share} /></div>
                <div className="flex justify-between text-xs text-muted-foreground mt-1">
                  <span>{tokens(r.totalTokens)} tokens · {count(r.inferenceCalls)} calls</span>
                  <span>{orDash(r.costPerCall, (v) => `${money(v)}/call`)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PriceDialog({
  open, onOpenChange, providerKey, modelId,
}: {
  open: boolean; onOpenChange: (v: boolean) => void;
  providerKey: string; modelId: string;
}) {
  const { toast } = useToast();
  const save = useSaveModelPrice();
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [cacheRead, setCacheRead] = useState('');
  const [from, setFrom] = useState(new Date().toISOString().slice(0, 10));
  const [source, setSource] = useState<'customer' | 'contract'>('customer');

  const valid = Number(input) >= 0 && Number(output) >= 0 && input !== '' && output !== '';

  const submit = async () => {
    try {
      await save.mutateAsync({
        providerKey, modelId,
        inputPerMillion: Number(input),
        outputPerMillion: Number(output),
        cacheReadPerMillion: cacheRead === '' ? null : Number(cacheRead),
        effectiveFrom: from,
        source,
      });
      toast({ title: 'Price saved', description: `Usage from ${from} onwards is now costed.` });
      onOpenChange(false);
    } catch (err: any) {
      toast({ title: 'Could not save the price', description: err.message, variant: 'destructive' });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Set a rate for {modelId}</DialogTitle>
          <DialogDescription>
            Per million tokens, as the vendor publishes them. Enter your negotiated rate if you have
            one — list price would overstate what you actually pay.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Input, per 1M</Label>
              <Input type="number" step="any" min="0" value={input} onChange={e => setInput(e.target.value)} placeholder="3.00" />
            </div>
            <div className="space-y-1.5">
              <Label>Output, per 1M</Label>
              <Input type="number" step="any" min="0" value={output} onChange={e => setOutput(e.target.value)} placeholder="15.00" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Cache read, per 1M <span className="text-muted-foreground font-normal">(optional)</span></Label>
            <Input type="number" step="any" min="0" value={cacheRead} onChange={e => setCacheRead(e.target.value)} placeholder="0.30" />
            <p className="text-xs text-muted-foreground">
              Left blank, cache tokens are excluded from the cost rather than charged at the input
              rate — which would overstate a caching workload roughly tenfold.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Effective from</Label>
              <Input type="date" value={from} onChange={e => setFrom(e.target.value)} />
              <p className="text-xs text-muted-foreground">Earlier usage keeps whatever rate applied then.</p>
            </div>
            <div className="space-y-1.5">
              <Label>Rate type</Label>
              <Select value={source} onValueChange={v => setSource(v as 'customer' | 'contract')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="customer">List price</SelectItem>
                  <SelectItem value="contract">Negotiated rate</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={!valid || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save rate'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function TokenDashboard() {
  const { can } = useAuth();
  const { toast } = useToast();

  const [filters, setFilters] = useState<TokenFilterState>({
    days: 30, providers: [], models: [], applications: [], environments: [],
  });
  const [pricing, setPricing] = useState<{ providerKey: string; modelId: string } | null>(null);

  const { data, isLoading, error } = useAiTokens(filters);
  const { data: providerData } = useAiProviders();
  const ingest = useIngestAiUsage();
  const refreshRates = useRefreshRates();

  const canIngest = can('account:write');
  const canPrice = can('budget:write');

  const set = <K extends keyof TokenFilterState>(key: K, value: TokenFilterState[K]) =>
    setFilters(f => ({ ...f, [key]: value }));

  const one = (key: 'providers' | 'models' | 'applications' | 'environments', v: string) =>
    set(key, v === 'all' ? [] : [v]);

  const collect = async () => {
    try {
      // Collect the window being looked at, not a fixed 48 hours. A team
      // calling Bedrock a few times a week found nothing in two days, saw an
      // empty dashboard and concluded the feature was broken. Capped at 63
      // days, which is how far back CloudWatch serves hourly data.
      const result = await ingest.mutateAsync(Math.min(filters.days * 24, 24 * 63));
      const ok = result.providers.filter(p => p.configured && !p.error);
      const total = ok.reduce((s, p) => s + p.tokensIngested, 0);
      const warnings = result.providers.map(p => p.warning).filter(Boolean) as string[];

      toast({
        title: total > 0
          ? `Collected ${tokens(total)} tokens over ${filters.days} days`
          : `No usage found in the last ${filters.days} days`,
        description: total > 0
          ? `${result.repriced.priced} rows priced` +
            (result.repriced.unpriced > 0
              ? `, ${result.repriced.unpriced} still need a rate — set one below.`
              : '.')
          // An empty result has a cause, and the adapter already knows it. A
          // bare "nothing found" sends someone hunting for a bug that is really
          // "your usage is older than the window you asked for".
          : warnings[0] ?? 'Try a longer date range, or check the region — CloudWatch metrics are regional.',
      });
    } catch (err: any) {
      toast({ title: 'Collection failed', description: err.message, variant: 'destructive' });
    }
  };

  const t = data?.totals;
  const unimplemented = (providerData?.providers ?? []).filter(p => !p.implemented);

  return (
    <div className="space-y-6">
      {/* Filters — all five, as specified. */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Date range</Label>
              <Select value={String(filters.days)} onValueChange={v => set('days', Number(v))}>
                <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">Last 24 hours</SelectItem>
                  <SelectItem value="7">Last 7 days</SelectItem>
                  <SelectItem value="30">Last 30 days</SelectItem>
                  <SelectItem value="90">Last 90 days</SelectItem>
                  <SelectItem value="365">Last year</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Provider</Label>
              <Select value={filters.providers[0] ?? 'all'} onValueChange={v => one('providers', v)}>
                <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All providers</SelectItem>
                  {(data?.filters.providers ?? []).map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Model</Label>
              <Select value={filters.models[0] ?? 'all'} onValueChange={v => one('models', v)}>
                <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All models</SelectItem>
                  {(data?.filters.models ?? []).map(m => (
                    <SelectItem key={m.modelId} value={m.modelId}>{m.modelId}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Application</Label>
              <Select value={filters.applications[0] ?? 'all'} onValueChange={v => one('applications', v)}>
                <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All applications</SelectItem>
                  {(data?.filters.applications ?? []).map(a => <SelectItem key={a} value={a}>{a}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Environment</Label>
              <Select value={filters.environments[0] ?? 'all'} onValueChange={v => one('environments', v)}>
                <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All environments</SelectItem>
                  {(data?.filters.environments ?? []).map(e => <SelectItem key={e} value={e}>{e}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            {canPrice && (
              <Button
                variant="outline"
                className="ml-auto"
                disabled={refreshRates.isPending}
                onClick={async () => {
                  try {
                    const r = await refreshRates.mutateAsync('bedrock');
                    toast({
                      title: r.modelsMatched > 0
                        ? `Rates fetched for ${r.modelsMatched} model${r.modelsMatched === 1 ? '' : 's'}`
                        : 'No published rates matched',
                      description:
                        `${r.repriced.priced} usage rows priced` +
                        (r.repriced.unpriced > 0 ? `, ${r.repriced.unpriced} still unpriced` : '') +
                        (r.warning ? `. ${r.warning}` : '.'),
                    });
                  } catch (err: any) {
                    toast({ title: 'Could not fetch rates', description: err.message, variant: 'destructive' });
                  }
                }}
              >
                <Coins className={`h-4 w-4 mr-2 ${refreshRates.isPending ? 'animate-pulse' : ''}`} />
                {refreshRates.isPending ? 'Fetching…' : 'Fetch published rates'}
              </Button>
            )}

            {canIngest && (
              <Button variant="outline" onClick={collect} disabled={ingest.isPending}>
                <RefreshCw className={`h-4 w-4 mr-2 ${ingest.isPending ? 'animate-spin' : ''}`} />
                {ingest.isPending ? 'Collecting…' : 'Collect usage'}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* A failed request must never render as an empty dataset. It did, and the
          result was a broken SQL query that looked for days like "there is no
          usage" — the one failure mode guaranteed to waste someone's time. */}
      {error ? (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">Could not load AI token economics</p>
                <p className="text-sm text-muted-foreground mt-1">{(error as Error).message}</p>
                <p className="text-xs text-muted-foreground mt-2">
                  This is a failure, not an absence of data. Your usage records are unaffected.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : !data || data.totals.totalTokens === 0 ? (
        <Card>
          <CardContent className="pt-6 py-10 text-center">
            <Cpu className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
            <p className="font-medium">No metered AI usage yet</p>
            <p className="text-sm text-muted-foreground mt-1 max-w-xl mx-auto">
              Token and call counts come from provider metrics, not from billing — billing carries
              neither. Press <strong>Collect usage</strong> to read them for the selected range.
            </p>
            <p className="text-xs text-muted-foreground mt-3 max-w-xl mx-auto">
              Already collected and still empty? Widen the date range. Collection only reads the
              window shown above, and intermittent usage can fall outside a short one. CloudWatch
              serves hourly Bedrock metrics for 63 days.
            </p>
            {unimplemented.length > 0 && (
              <p className="text-xs text-muted-foreground mt-4">
                Collection is implemented for AWS Bedrock. Still to come:{' '}
                {unimplemented.map(p => p.displayName).join(', ')}.
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          {data.unpriced.length > 0 && (
            <Card className="border-amber-500/50">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                  {data.unpriced.length} model{data.unpriced.length === 1 ? '' : 's'} have usage but no rate
                </CardTitle>
                <CardDescription>
                  Their tokens are counted, their cost is not — so the totals below are understated
                  until a rate is set. They are shown rather than costed at zero, which would read
                  as free. Try <strong>Fetch published rates</strong> first; only enter a rate by
                  hand if the vendor does not publish one, or if you have a negotiated price.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="divide-y">
                  {data.unpriced.map(u => (
                    <div key={`${u.providerKey}-${u.modelId}`} className="flex items-center justify-between py-2 gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-mono truncate">{u.modelId}</p>
                        <p className="text-xs text-muted-foreground">
                          {u.providerKey} · {tokens(u.tokens)} tokens · {count(u.calls)} calls · since {u.firstSeen}
                        </p>
                      </div>
                      {canPrice && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setPricing({ providerKey: u.providerKey, modelId: u.modelId })}
                        >
                          <Plus className="h-3.5 w-3.5 mr-1.5" /> Set rate
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          <div className="grid gap-4 md:grid-cols-4">
            <Card>
              <CardHeader className="pb-2"><CardDescription>Calculated spend</CardDescription></CardHeader>
              <CardContent>
                <p className="text-3xl font-bold">{money(t!.totalCost)}</p>
                <p className="text-xs text-muted-foreground mt-2">
                  {money(t!.inputCost)} in · {money(t!.outputCost)} out
                  {t!.cacheCost > 0 && ` · ${money(t!.cacheCost)} cache`}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2"><CardDescription>Tokens</CardDescription></CardHeader>
              <CardContent>
                <p className="text-3xl font-bold">{tokens(t!.totalTokens)}</p>
                <p className="text-xs text-muted-foreground mt-2">
                  {tokens(t!.inputTokens)} in · {tokens(t!.outputTokens)} out
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2"><CardDescription>Inference calls</CardDescription></CardHeader>
              <CardContent>
                <p className="text-3xl font-bold">{count(t!.inferenceCalls)}</p>
                <p className="text-xs text-muted-foreground mt-2">
                  {t!.inferenceCalls > 0
                    ? `${tokens(Math.round(t!.totalTokens / t!.inferenceCalls))} tokens per call`
                    : 'No call counts reported'}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2"><CardDescription>Cost per call</CardDescription></CardHeader>
              <CardContent>
                <p className="text-3xl font-bold">{orDash(t!.costPerCall, money)}</p>
                <p className="text-xs text-muted-foreground mt-2">
                  {orDash(t!.costPerMillionTokens, (v) => `${money(v)} per 1M tokens`)}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Input vs output split — where the money actually goes, since output
              is typically several times the input rate. */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <ArrowDownUp className="h-4 w-4" /> Input vs output
              </CardTitle>
              <CardDescription>
                Output tokens usually cost several times input. The split is where the money goes.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-6 sm:grid-cols-2">
                {[
                  { label: 'Input', tok: t!.inputTokens, cost: t!.inputCost },
                  { label: 'Output', tok: t!.outputTokens, cost: t!.outputCost },
                ].map(side => {
                  const tokShare = t!.totalTokens > 0 ? (side.tok / t!.totalTokens) * 100 : 0;
                  const costShare = t!.totalCost > 0 ? (side.cost / t!.totalCost) * 100 : 0;
                  return (
                    <div key={side.label} className="space-y-2">
                      <div className="flex items-baseline justify-between">
                        <span className="font-medium text-sm">{side.label}</span>
                        <span className="text-sm tabular-nums">{money(side.cost)}</span>
                      </div>
                      <div>
                        <div className="flex justify-between text-xs text-muted-foreground mb-1">
                          <span>{tokens(side.tok)} tokens</span><span>{tokShare.toFixed(0)}% of volume</span>
                        </div>
                        <Bar share={tokShare} />
                      </div>
                      <div>
                        <div className="flex justify-between text-xs text-muted-foreground mb-1">
                          <span>share of spend</span><span>{costShare.toFixed(0)}%</span>
                        </div>
                        <Bar share={costShare} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <GroupTable title="Spend by provider" icon={Layers} rows={data.byProvider} emptyHint="No provider data." />
            <GroupTable title="Spend by model" icon={Cpu} rows={data.byModel} emptyHint="No model data." />
            <GroupTable title="Spend by application" icon={Boxes} rows={data.byApplication}
              emptyHint="No application attribution. Tag workloads, or use per-project credentials, to split AI spend by application." />
            <GroupTable title="Spend by environment" icon={Boxes} rows={data.byEnvironment}
              emptyHint="No environment attribution yet." />
          </div>

          {data.trend.length > 1 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Coins className="h-4 w-4" /> Token cost over time
                </CardTitle>
                <CardDescription>Daily calculated spend, with calls and cost per call.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-end gap-1 h-28">
                  {data.trend.map(pt => {
                    const max = Math.max(...data.trend.map(p => p.totalCost), 0.0001);
                    return (
                      <div
                        key={pt.day}
                        className="flex-1 min-w-[3px] rounded-t bg-primary/70 hover:bg-primary transition-colors"
                        style={{ height: `${Math.max(2, (pt.totalCost / max) * 100)}%` }}
                        title={`${pt.day} — ${money(pt.totalCost)}, ${count(pt.inferenceCalls)} calls, ${orDash(pt.costPerCall, money)}/call`}
                      />
                    );
                  })}
                </div>
                <div className="flex justify-between text-xs text-muted-foreground mt-2">
                  <span>{data.trend[0].day}</span>
                  <span>{data.trend[data.trend.length - 1].day}</span>
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Per-model detail</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Model</TableHead>
                      <TableHead className="text-right">Input</TableHead>
                      <TableHead className="text-right">Output</TableHead>
                      <TableHead className="text-right">Calls</TableHead>
                      <TableHead className="text-right">Input $</TableHead>
                      <TableHead className="text-right">Output $</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead className="text-right">Per call</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.byModel.map(m => (
                      <TableRow key={m.key}>
                        <TableCell className="font-mono text-xs">{m.label}</TableCell>
                        <TableCell className="text-right">{tokens(m.inputTokens)}</TableCell>
                        <TableCell className="text-right">{tokens(m.outputTokens)}</TableCell>
                        <TableCell className="text-right">{count(m.inferenceCalls)}</TableCell>
                        <TableCell className="text-right">{money(m.inputCost)}</TableCell>
                        <TableCell className="text-right">{money(m.outputCost)}</TableCell>
                        <TableCell className="text-right font-medium">{money(m.totalCost)}</TableCell>
                        <TableCell className="text-right">{orDash(m.costPerCall, money)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {unimplemented.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Providers</CardTitle>
            <CardDescription>Where usage is collected from, and what each needs.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="divide-y">
              {(providerData?.providers ?? []).map(p => (
                <div key={p.key} className="py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-sm">{p.displayName}</span>
                    <Badge variant={p.implemented ? 'default' : 'outline'} className="text-xs font-normal">
                      {p.implemented ? 'collecting' : 'adapter not built yet'}
                    </Badge>
                    <Badge variant="secondary" className="text-xs font-normal">{p.billingMode}</Badge>
                    {p.docsUrl && (
                      <a href={p.docsUrl} target="_blank" rel="noreferrer"
                         className="text-xs text-primary inline-flex items-center gap-0.5">
                        docs <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">{p.usageSource}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {pricing && (
        <PriceDialog
          open
          onOpenChange={(v) => { if (!v) setPricing(null); }}
          providerKey={pricing.providerKey}
          modelId={pricing.modelId}
        />
      )}
    </div>
  );
}
