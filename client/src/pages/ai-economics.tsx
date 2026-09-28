/**
 * AI Economics.
 *
 * Answers the question the FinOps Foundation's 2026 report identifies as the
 * one separating mature practices from early ones, and that only 43% of
 * organizations can answer at all: not "how much do we spend on AI" but "on
 * which model, at what rate per million tokens, and what does that cost per
 * customer".
 *
 * The design constraint that shapes this page is honesty about coverage. The
 * two clouds report AI usage very differently — GCP gives real token counts
 * that reconcile exactly against list prices, AWS Bedrock gives the model name
 * and the cost but no tokens at all. A page that quietly averaged the two would
 * produce a confident per-token figure covering a fraction of the spend. So
 * every rate here says what share of spend it is derived from, and spend with
 * no token data is shown as its own number with the reason attached.
 */
import { useState } from "react";
import {
  Brain, Cpu, Coins, TrendingDown, TrendingUp, Minus, HelpCircle,
  Plus, Trash2, Info,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TokenDashboard } from "@/components/ai/token-dashboard";
import { SpendCoverage } from "@/components/ai/spend-coverage";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import {
  useAiEconomics, useAiUnitMetrics, useSaveUnitMetric, useDeleteUnitMetric,
  type ModelSpend,
} from "@/hooks/use-ai-economics";

const money = (n: number): string =>
  n >= 1000 ? `$${Math.round(n).toLocaleString('en-US')}` : `$${n.toFixed(2)}`;

const preciseMoney = (n: number): string =>
  n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;

const tokens = (n: number): string =>
  n >= 1_000_000_000 ? `${(n / 1_000_000_000).toFixed(2)}B`
  : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M`
  : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K`
  : String(n);

const VENDOR_LABEL: Record<string, string> = {
  anthropic: 'Anthropic', google: 'Google', openai: 'OpenAI',
  amazon: 'Amazon', meta: 'Meta', mistral: 'Mistral', cohere: 'Cohere', other: 'Other',
};

function ModelRow({ m }: { m: ModelSpend }) {
  const partial = m.tokenCoverage !== null && m.tokenCoverage < 0.99;

  return (
    <TableRow>
      <TableCell>
        <div className="font-medium">{m.model}</div>
        <div className="text-xs text-muted-foreground">
          {VENDOR_LABEL[m.vendor] ?? m.vendor} · {m.provider.toUpperCase()}
          {!m.isInference && ' · platform'}
        </div>
      </TableCell>

      <TableCell className="text-right font-medium">{money(m.cost)}</TableCell>
      <TableCell className="text-right text-muted-foreground">{m.share.toFixed(1)}%</TableCell>

      <TableCell className="text-right">
        {m.totalTokens === null
          ? <span className="text-xs text-muted-foreground">not reported</span>
          : tokens(m.totalTokens)}
      </TableCell>

      <TableCell className="text-right">
        {m.costPerMillionTokens === null ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <div>
            <span className="font-medium">${m.costPerMillionTokens.toFixed(2)}</span>
            {/* A rate derived from part of the spend is a different claim from
                one derived from all of it, and must not be shown as the same. */}
            {partial && (
              <div className="text-[10px] text-amber-600 dark:text-amber-400">
                from {Math.round((m.tokenCoverage ?? 0) * 100)}% of spend
              </div>
            )}
          </div>
        )}
      </TableCell>

      <TableCell className="text-right">
        {m.outputCostPerMillion === null
          ? <span className="text-xs text-muted-foreground">—</span>
          : `$${m.outputCostPerMillion.toFixed(2)}`}
      </TableCell>
    </TableRow>
  );
}

function MetricDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { toast } = useToast();
  const save = useSaveUnitMetric();
  const thisMonth = new Date().toISOString().slice(0, 7);

  const [name, setName] = useState('Monthly active users');
  const [unitLabel, setUnitLabel] = useState('user');
  const [periodStart, setPeriodStart] = useState(thisMonth);
  const [value, setValue] = useState('');

  const numeric = Number(value);
  const valid = name.trim() && unitLabel.trim() && Number.isFinite(numeric) && numeric > 0;

  const submit = async () => {
    try {
      await save.mutateAsync({ name: name.trim(), unitLabel: unitLabel.trim(), periodStart, value: numeric });
      toast({ title: 'Metric saved', description: `Cost per ${unitLabel.trim()} is now calculated for ${periodStart}.` });
      onOpenChange(false);
      setValue('');
    } catch (err: any) {
      toast({ title: 'Could not save the metric', description: err.message, variant: 'destructive' });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Set a business metric</DialogTitle>
          <DialogDescription>
            AI spend divided by something the business counts. Only you know that number — it is not
            in any cloud bill.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>What are you counting?</Label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="Monthly active users" />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Singular noun</Label>
              <Input value={unitLabel} onChange={e => setUnitLabel(e.target.value)} placeholder="user" />
              <p className="text-xs text-muted-foreground">Shown as "per {unitLabel.trim() || 'unit'}".</p>
            </div>

            <div className="space-y-1.5">
              <Label>Month</Label>
              <Input type="month" value={periodStart} onChange={e => setPeriodStart(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Value for that month</Label>
            <Input
              type="number"
              min="0"
              step="any"
              value={value}
              onChange={e => setValue(e.target.value)}
              placeholder="50000"
            />
            <p className="text-xs text-muted-foreground">
              Recorded per month rather than as one running figure, so the trend stays visible — a
              cost per {unitLabel.trim() || 'unit'} that falls as usage grows is the signal worth
              watching.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={!valid || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save metric'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function AiEconomicsPage() {
  const { can } = useAuth();
  const { toast } = useToast();
  const [days, setDays] = useState(30);
  const [editing, setEditing] = useState(false);

  const { data, isLoading, error } = useAiEconomics(days);
  const { data: metricData } = useAiUnitMetrics();
  const removeMetric = useDeleteUnitMetric();

  const canEdit = can('budget:write');
  const unit = data?.unitEconomics ?? null;

  const delta = unit && unit.previousCostPerUnit !== null
    ? unit.costPerUnit - unit.previousCostPerUnit
    : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Brain className="h-7 w-7" /> AI Economics
          </h1>
          <p className="text-muted-foreground mt-1">
            What each model costs you, per million tokens, per call and per unit of your business.
          </p>
        </div>
      </div>

      {/* Two views, and the split is deliberate. Metered usage is the only
          source of tokens and call counts; billing is the authority on what was
          actually charged. They will not match exactly, and collapsing them
          into one number would hide which is which. */}
      <Tabs defaultValue="tokens">
        <TabsList>
          <TabsTrigger value="tokens">Tokens & calls</TabsTrigger>
          <TabsTrigger value="billed">Billed spend</TabsTrigger>
          <TabsTrigger value="coverage">Coverage</TabsTrigger>
        </TabsList>

        <TabsContent value="tokens" className="mt-6">
          <TokenDashboard />
        </TabsContent>

        <TabsContent value="coverage" className="mt-6">
          <SpendCoverage />
        </TabsContent>

        <TabsContent value="billed" className="mt-6 space-y-6">

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">What the providers charged</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Straight from the cost store. Authoritative for spend; carries no token or call counts.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Select value={String(days)} onValueChange={v => setDays(Number(v))}>
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="90">Last 90 days</SelectItem>
              <SelectItem value="365">Last year</SelectItem>
            </SelectContent>
          </Select>
          {canEdit && (
            <Button onClick={() => setEditing(true)} variant="outline">
              <Plus className="h-4 w-4 mr-2" /> Business metric
            </Button>
          )}
        </div>
      </div>

      {error && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="pt-6 text-sm">{(error as Error).message}</CardContent>
        </Card>
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : !data ? null : data.totalCost === 0 ? (
        <Card>
          <CardContent className="pt-6 text-center py-10">
            <Brain className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
            <p className="font-medium">No AI spend in this window</p>
            <p className="text-sm text-muted-foreground mt-1">
              Bedrock, Vertex AI, SageMaker and Azure OpenAI charges appear here once ingested.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-4">
            <Card>
              <CardHeader className="pb-2"><CardDescription>AI spend</CardDescription></CardHeader>
              <CardContent>
                <p className="text-3xl font-bold">{money(data.totalCost)}</p>
                <p className="text-xs text-muted-foreground mt-2">
                  {money(data.inferenceCost)} inference · {money(data.platformCost)} platform
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2"><CardDescription>Tokens processed</CardDescription></CardHeader>
              <CardContent>
                <p className="text-3xl font-bold">
                  {data.totalTokens === null ? '—' : tokens(data.totalTokens)}
                </p>
                <p className="text-xs text-muted-foreground mt-2">
                  {data.costWithoutTokenData > 0
                    ? `${money(data.costWithoutTokenData)} of spend reports no token counts`
                    : 'Every provider reported token counts'}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2"><CardDescription>Models in use</CardDescription></CardHeader>
              <CardContent>
                <p className="text-3xl font-bold">{data.models.filter(m => m.isInference).length}</p>
                <p className="text-xs text-muted-foreground mt-2">
                  {data.vendors.slice(0, 2).map(v => `${VENDOR_LABEL[v.vendor] ?? v.vendor} ${v.share.toFixed(0)}%`).join(' · ')}
                </p>
              </CardContent>
            </Card>

            <Card className={unit ? '' : 'border-dashed'}>
              <CardHeader className="pb-2">
                <CardDescription>{unit ? `Cost per ${unit.unitLabel}` : 'Cost per unit'}</CardDescription>
              </CardHeader>
              <CardContent>
                {unit ? (
                  <>
                    <p className="text-3xl font-bold">{preciseMoney(unit.costPerUnit)}</p>
                    <p className="text-xs text-muted-foreground mt-2 flex items-center gap-1">
                      {delta === null ? <Minus className="h-3 w-3" />
                        : delta < 0 ? <TrendingDown className="h-3 w-3 text-green-600" />
                        : delta > 0 ? <TrendingUp className="h-3 w-3 text-red-600" />
                        : <Minus className="h-3 w-3" />}
                      {delta === null
                        ? `${unit.value.toLocaleString()} ${unit.name.toLowerCase()}`
                        : `${delta > 0 ? '+' : ''}${preciseMoney(delta)} vs the previous period`}
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-lg text-muted-foreground">Not set</p>
                    <p className="text-xs text-muted-foreground mt-2">
                      Add a business metric to turn AI spend into a per-unit figure.
                    </p>
                  </>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Coverage, stated before the table rather than as a footnote. */}
          {data.tokenGaps.length > 0 && (
            <Card className="border-amber-500/40">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <HelpCircle className="h-4 w-4 text-amber-600" />
                  {money(data.costWithoutTokenData)} of AI spend has no token data
                </CardTitle>
                <CardDescription>
                  Per-token rates below cover only the spend whose provider reports token counts.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {data.tokenGaps.map(g => (
                  <div key={g.provider} className="flex items-start gap-2 text-sm">
                    <Info className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                    <div>
                      <span className="font-medium">{g.provider.toUpperCase()} · {money(g.cost)}</span>
                      <p className="text-muted-foreground text-xs mt-0.5">{g.note}</p>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Cpu className="h-4 w-4" /> Cost by model
              </CardTitle>
              <CardDescription>
                Most expensive first. A dash means the provider reports no token counts for that model.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Model</TableHead>
                      <TableHead className="text-right">Spend</TableHead>
                      <TableHead className="text-right">Share</TableHead>
                      <TableHead className="text-right">Tokens</TableHead>
                      <TableHead className="text-right">Per 1M</TableHead>
                      <TableHead className="text-right">Per 1M out</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.models.map(m => <ModelRow key={`${m.provider}-${m.model}`} m={m} />)}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          {metricData && metricData.metrics.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Coins className="h-4 w-4" /> Business metrics
                </CardTitle>
                <CardDescription>
                  The denominators behind cost per unit. One value per month, so the trend survives.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="divide-y">
                  {metricData.metrics.map(m => (
                    <div key={m.id} className="flex items-center justify-between py-2">
                      <div>
                        <span className="font-medium text-sm">{m.name}</span>
                        <span className="text-xs text-muted-foreground ml-2">
                          {String(m.periodStart).slice(0, 7)} · {Number(m.value).toLocaleString()} {m.unitLabel}s
                        </span>
                      </div>
                      {canEdit && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={removeMetric.isPending}
                          onClick={async () => {
                            try {
                              await removeMetric.mutateAsync(m.id);
                              toast({ title: 'Metric removed' });
                            } catch (err: any) {
                              toast({ title: 'Could not remove', description: err.message, variant: 'destructive' });
                            }
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}

        </TabsContent>
      </Tabs>

      {editing && <MetricDialog open={editing} onOpenChange={setEditing} />}
    </div>
  );
}
