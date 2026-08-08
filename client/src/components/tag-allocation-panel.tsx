/**
 * Cost allocation by tag.
 *
 * The number this exists to show is the unallocated share: the portion of the
 * bill that cannot be charged to anyone. Every chargeback programme starts by
 * discovering that figure is far larger than expected, and no amount of
 * dashboard elsewhere substitutes for putting it on screen.
 */
import { useState } from "react";
import { Tags, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useCostByTag, type CostBasis } from "@/hooks/use-cost-store";

/** Common allocation keys, offered so the field is not a blank box. */
const SUGGESTED_KEYS = ['environment', 'cost-center', 'team', 'project', 'owner', 'application'];

const money = (n: number) =>
  `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function TagAllocationPanel({
  start, end, costBasis, provider,
}: { start: string; end: string; costBasis?: CostBasis; provider?: string }) {
  const [tagKey, setTagKey] = useState('environment');
  const [pending, setPending] = useState('environment');

  const { data, isLoading, error } = useCostByTag({ tagKey, start, end, costBasis, provider });

  const coverage = data?.allocationCoveragePercent ?? 0;
  const allocated = (data?.values ?? []).filter(v => v.allocated);
  const poorCoverage = !!data && coverage < 80;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Tags className="h-5 w-5" /> Cost Allocation
        </CardTitle>
        <CardDescription>
          How much of your spend can be attributed to a team, environment or cost centre.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={e => { e.preventDefault(); setTagKey(pending.trim()); }}
        >
          <div className="flex-1 min-w-48">
            <label htmlFor="tag-key" className="text-xs text-muted-foreground">Tag key</label>
            <Input
              id="tag-key"
              value={pending}
              onChange={e => setPending(e.target.value)}
              placeholder="e.g. cost-center"
              list="suggested-tag-keys"
            />
            <datalist id="suggested-tag-keys">
              {SUGGESTED_KEYS.map(k => <option key={k} value={k} />)}
            </datalist>
          </div>
          <Button type="submit" variant="outline" disabled={!pending.trim()}>Analyze</Button>
        </form>

        <div className="flex flex-wrap gap-1.5">
          {SUGGESTED_KEYS.map(k => (
            <Button
              key={k}
              type="button"
              variant={tagKey === k ? 'default' : 'outline'}
              size="sm"
              className="h-7 text-xs"
              onClick={() => { setPending(k); setTagKey(k); }}
            >
              {k}
            </Button>
          ))}
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading allocation…</p>
        ) : error ? (
          <p className="text-sm text-destructive">{(error as Error).message}</p>
        ) : !data || data.totalCost === 0 ? (
          <p className="text-sm text-muted-foreground">
            No ingested cost data for this period. Run ingestion from Configuration.
          </p>
        ) : (
          <>
            <div>
              <div className="flex items-center justify-between text-sm mb-1.5">
                <span>Tagged with <code className="text-xs">{data.tagKey}</code></span>
                <span className={poorCoverage ? 'text-yellow-600 font-medium' : 'font-medium'}>
                  {coverage.toFixed(1)}%
                </span>
              </div>
              <Progress value={coverage} className="h-2" />
              <div className="flex items-center justify-between text-xs text-muted-foreground mt-1.5">
                <span>{money(data.totalCost - data.unallocatedCost)} attributable</span>
                <span>{money(data.unallocatedCost)} unallocated</span>
              </div>
            </div>

            {poorCoverage && (
              <div className="flex items-start gap-2 rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3">
                <AlertTriangle className="h-4 w-4 text-yellow-600 mt-0.5 shrink-0" />
                <p className="text-sm">
                  {money(data.unallocatedCost)} of {money(data.totalCost)} carries no{' '}
                  <code className="text-xs">{data.tagKey}</code> tag and cannot be charged back.
                  Chargeback is not meaningful until this is small.
                </p>
              </div>
            )}

            {allocated.length > 0 && (
              <div className="space-y-1.5 border-t pt-4">
                {allocated.slice(0, 10).map(v => (
                  <div key={v.tagValue} className="flex items-center justify-between text-sm">
                    <span className="truncate">{v.tagValue}</span>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-xs text-muted-foreground">
                        {((v.cost / data.totalCost) * 100).toFixed(1)}%
                      </span>
                      <span>{money(v.cost)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
