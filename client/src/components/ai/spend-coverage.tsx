/**
 * Every billed AI service, and whether we can see its tokens.
 *
 * The Tokens & calls tab can only show what it managed to meter. On a tenant
 * whose Claude usage is billed through AWS Marketplace that is a tiny fraction
 * of the real spend, and a page showing only the fraction reads as though the
 * rest does not exist. This panel shows the whole bill and attaches a reason to
 * each line that has no token data, so the gap is visible rather than implied.
 */
import { AlertTriangle, CheckCircle2, ShoppingCart, Server, HelpCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DateRangePicker } from "@/components/date-range-picker";
import { useDateRange } from "@/contexts/date-range-context";
import { useAiCoverage, type CoverageRow, type CoverageStatus } from "@/hooks/use-ai-tokens";

const money = (n: number) =>
  n >= 1000 ? `$${Math.round(n).toLocaleString('en-US')}` : `$${n.toFixed(2)}`;

const compactTokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M`
  : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K`
  : String(n);

const STATUS: Record<CoverageStatus, {
  label: string; icon: typeof CheckCircle2; className: string;
}> = {
  metered:      { label: 'Tokens available', icon: CheckCircle2, className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300' },
  marketplace:  { label: 'Marketplace',      icon: ShoppingCart, className: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300' },
  platform:     { label: 'Not per-token',    icon: Server,       className: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
  no_telemetry: { label: 'No data yet',      icon: HelpCircle,   className: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
};

function Row({ r }: { r: CoverageRow }) {
  const s = STATUS[r.status];
  const Icon = s.icon;

  return (
    <TableRow data-testid={`coverage-row-${r.serviceName}`}>
      <TableCell className="align-top">
        <div className="font-medium">{r.serviceName}</div>
        <div className="text-xs text-muted-foreground uppercase">{r.provider}</div>
      </TableCell>

      <TableCell className="align-top text-right font-mono tabular-nums">
        {money(r.cost)}
      </TableCell>

      <TableCell className="align-top text-right font-mono tabular-nums text-sm">
        {r.inputTokens === null ? (
          <span className="text-muted-foreground">&mdash;</span>
        ) : (
          <>
            <div>{compactTokens(r.inputTokens + (r.outputTokens ?? 0))}</div>
            <div className="text-xs text-muted-foreground">
              {(r.inferenceCalls ?? 0).toLocaleString()} calls
            </div>
          </>
        )}
      </TableCell>

      <TableCell className="align-top">
        <Badge variant="secondary" className={`gap-1 ${s.className}`}>
          <Icon className="h-3 w-3" />{s.label}
        </Badge>
      </TableCell>

      <TableCell className="align-top text-sm text-muted-foreground max-w-md">
        {r.reason}
        {r.remedy && (
          <div className="mt-1 text-xs text-foreground/70">
            <span className="font-medium">To fix: </span>{r.remedy}
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

/**
 * Driven by the SAME date-range context the FinOps report uses, rather than by
 * its own window. The two pages previously disagreed by about $1,000 purely
 * because one showed a rolling 30 days and the other showed the month to date,
 * and no amount of labelling makes two different totals on two screens read as
 * anything other than a bug.
 */
export function SpendCoverage() {
  const { dateRange } = useDateRange();
  const { data, isLoading, error } = useAiCoverage(dateRange.startDate, dateRange.endDate);

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground">
          Reconciling AI spend&hellip;
        </CardContent>
      </Card>
    );
  }

  // Shown rather than swallowed: a silent failure here looks identical to
  // "there is no AI spend", which is the one conclusion this panel exists to
  // stop someone drawing by accident.
  if (error) {
    return (
      <Card className="border-destructive/40">
        <CardContent className="py-8 flex gap-3">
          <AlertTriangle className="h-5 w-5 text-destructive shrink-0" />
          <div>
            <div className="font-medium">Could not reconcile AI spend</div>
            <div className="text-sm text-muted-foreground">{(error as Error).message}</div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!data || data.rows.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground">
          No AI spend was billed between {dateRange.startDate} and {dateRange.endDate}.
        </CardContent>
      </Card>
    );
  }

  const pct = data.coveragePercent;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <CardTitle>Token coverage of AI spend</CardTitle>
            <DateRangePicker />
          </div>
          <CardDescription>
            Every AI service on your bill from <strong>{data.windowStart}</strong> to{' '}
            <strong>{data.windowEnd}</strong>, and whether token-level data exists for it.
            Services without tokens are still real spend &mdash; they are listed here with the
            reason rather than left out.
            <span className="block mt-1">
              This is the same period as the FinOps report, so the two totals agree.
            </span>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <div className="text-xs uppercase text-muted-foreground">Total AI spend</div>
              <div className="text-2xl font-semibold tabular-nums">{money(data.totalAiCost)}</div>
            </div>
            <div>
              <div className="text-xs uppercase text-muted-foreground">With token data</div>
              <div className="text-2xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                {money(data.meteredCost)}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase text-muted-foreground">Without token data</div>
              <div className="text-2xl font-semibold tabular-nums text-amber-600 dark:text-amber-400">
                {money(data.unmeteredCost)}
              </div>
            </div>
          </div>

          <div>
            <div className="flex justify-between text-sm mb-1">
              <span className="text-muted-foreground">Share of spend with tokens</span>
              <span className="font-medium tabular-nums">
                {pct > 0 && pct < 0.1 ? '<0.1' : pct.toFixed(1)}%
              </span>
            </div>
            <Progress value={pct} />
          </div>

          {pct < 50 && (
            <div className="flex gap-3 rounded-md border border-amber-300/60 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm">
              <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
              <div>
                Most of your AI spend has no token data, so the cost-per-token and
                cost-per-call figures on the other tabs describe only {money(data.meteredCost)}
                {' '}of {money(data.totalAiCost)}. The table below says why, for each service.
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Service</TableHead>
                <TableHead className="text-right">Billed</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Why</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.map((r) => <Row key={`${r.provider}:${r.serviceName}`} r={r} />)}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
