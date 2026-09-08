/**
 * Estimated vs realized savings.
 *
 * The product used to report its own estimates back as results — actual_savings
 * was the estimate copied across. This panel shows the two side by side, plus
 * the accuracy ratio, which is the number that says whether the recommendations
 * can be believed.
 *
 * Confidence is displayed rather than hidden. Measurement currently happens at
 * service granularity because the cost store has no resource-level rows, so a
 * figure here is an attribution, not a meter reading. Presenting it without that
 * caveat would repeat the original mistake in a more sophisticated form.
 */
import { TrendingUp, TrendingDown, Target, Clock, HelpCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useRealizedSavings, useSavingsMeasurements } from "@/hooks/use-cost-store";

const money = (n: number) =>
  `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function confidenceVariant(c: string | null): 'default' | 'secondary' | 'outline' {
  if (c === 'high') return 'default';
  if (c === 'medium') return 'secondary';
  return 'outline';
}

export function RealizedSavingsPanel() {
  const { data: summary, isLoading } = useRealizedSavings();
  const { data: measured } = useSavingsMeasurements('measured');

  if (isLoading) {
    return (
      <Card>
        <CardHeader><CardTitle>Realized Savings</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-muted-foreground">Loading…</p></CardContent>
      </Card>
    );
  }

  const nothingMeasuredYet = (summary?.measuredActions ?? 0) === 0;
  const accuracy = summary?.estimateAccuracyPercent ?? null;
  const realized = summary?.realizedMonthlySavings ?? 0;
  const estimated = summary?.estimatedMonthlySavings ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Target className="h-5 w-5" /> Realized Savings
        </CardTitle>
        <CardDescription>
          Measured against actual spend after each change, not the estimate that was predicted.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        {nothingMeasuredYet ? (
          <div className="text-sm text-muted-foreground space-y-1">
            <p>Nothing has been measured yet.</p>
            <p>
              When an optimization executes, its prior spend is recorded and compared against actual
              cost after a settling period. Results appear here once that window has passed
              {(summary?.pendingMeasurements ?? 0) > 0
                ? ` — ${summary!.pendingMeasurements} measurement${summary!.pendingMeasurements === 1 ? '' : 's'} pending.`
                : '.'}
            </p>
          </div>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <p className="text-xs text-muted-foreground">Estimated</p>
                <p className="text-2xl font-semibold">{money(estimated)}<span className="text-sm font-normal text-muted-foreground">/mo</span></p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Realized</p>
                <p className={`text-2xl font-semibold ${realized < 0 ? 'text-destructive' : 'text-green-600'}`}>
                  {money(realized)}<span className="text-sm font-normal text-muted-foreground">/mo</span>
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  Estimate accuracy
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger><HelpCircle className="h-3 w-3" /></TooltipTrigger>
                      <TooltipContent className="max-w-xs">
                        Realized divided by estimated. Consistently below 100% means the
                        recommendations over-promise.
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </p>
                <p className="text-2xl font-semibold flex items-center gap-1.5">
                  {accuracy === null ? '—' : `${accuracy.toFixed(0)}%`}
                  {accuracy !== null && (accuracy >= 90
                    ? <TrendingUp className="h-4 w-4 text-green-600" />
                    : <TrendingDown className="h-4 w-4 text-yellow-600" />)}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="outline">{summary!.measuredActions} measured</Badge>
              {summary!.pendingMeasurements > 0 && (
                <Badge variant="outline" className="gap-1">
                  <Clock className="h-3 w-3" /> {summary!.pendingMeasurements} pending
                </Badge>
              )}
              {summary!.inconclusiveMeasurements > 0 && (
                <Badge variant="outline">{summary!.inconclusiveMeasurements} inconclusive</Badge>
              )}
              {summary!.confidenceBreakdown.low > 0 && (
                <Badge variant="secondary">{summary!.confidenceBreakdown.low} low confidence</Badge>
              )}
            </div>

            {/* Never present these as precise. Attribution is at service level. */}
            {summary!.confidenceBreakdown.high === 0 && (
              <p className="text-xs text-muted-foreground border-l-2 pl-3">
                Measurements are attributed at service level, not per resource, so other activity in
                the same service is included. Treat these as directional.
              </p>
            )}

            {(measured?.measurements?.length ?? 0) > 0 && (
              <div className="border-t pt-4 space-y-2">
                <p className="text-sm font-medium">Recent measurements</p>
                {measured!.measurements.slice(0, 5).map(m => {
                  const r = Number(m.realizedMonthlySavings ?? 0);
                  const e = Number(m.estimatedMonthlySavings ?? 0);
                  return (
                    <div key={m.id} className="flex items-center justify-between gap-2 text-sm">
                      <div className="min-w-0">
                        <p className="truncate">{m.serviceName ?? `${m.provider} account`}</p>
                        <p className="text-xs text-muted-foreground truncate">{m.notes}</p>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <span className="text-muted-foreground text-xs">est {money(e)}</span>
                        <span className={r < 0 ? 'text-destructive' : 'text-green-600'}>{money(r)}</span>
                        <Badge variant={confidenceVariant(m.confidence)}>{m.confidence ?? 'n/a'}</Badge>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
