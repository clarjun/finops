/**
 * What the Cost Estimator handed over.
 *
 * The agent page previously showed the architecture it had derived and nothing
 * about where that came from, so the requirement and the priced line items —
 * the things someone is actually checking the plan against — were left behind on
 * the previous screen. Reviewing a deployment means comparing it to what was
 * asked for, and that comparison cannot be made from memory.
 *
 * Collapsed by default: it is reference material during a deployment, not the
 * thing being watched.
 */
import { useState } from "react";
import { ChevronDown, ChevronRight, FileText, DollarSign } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export interface EstimateLine {
  layer?: string;
  service?: string;
  configuration?: string;
  instanceType?: string;
  instanceCount?: number;
  storageSize?: number;
  dataTransfer?: number;
  monthlyCost?: number;
}

export interface EstimateSource {
  name?: string;
  requirements?: string | null;
  estimate?: EstimateLine[] | null;
  estimatedMonthlyCost?: string | number | null;
}

const money = (v: unknown): string => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : '—';
};

/** The configuration of one line, from whichever fields the estimate provided. */
function describe(line: EstimateLine): string {
  const parts = [
    line.instanceType,
    line.instanceCount != null ? `×${line.instanceCount}` : null,
    line.storageSize != null ? `${line.storageSize} GB` : null,
    line.dataTransfer != null ? `${line.dataTransfer} GB transfer` : null,
    line.configuration,
  ].filter(Boolean);
  return parts.join(' · ');
}

export function EstimatePanel({ source }: { source: EstimateSource | null | undefined }) {
  const [open, setOpen] = useState(false);

  const lines = source?.estimate ?? [];
  const requirement = source?.requirements?.trim();

  // Nothing to show is not an empty panel. A heading over no content reads as a
  // loading failure.
  if (!requirement && lines.length === 0) return null;

  // The estimate's own total, not a re-derived one: if the two disagree, the
  // figure the user was quoted is the one that matters here.
  const quoted = source?.estimatedMonthlyCost;
  const summed = lines.reduce((t, l) => t + (typeof l.monthlyCost === 'number' ? l.monthlyCost : 0), 0);

  return (
    <Card>
      <CardContent className="p-0">
        <button
          onClick={() => setOpen(!open)}
          className="w-full flex items-center justify-between gap-3 p-4 text-left"
          data-testid="button-toggle-estimate"
        >
          <span className="flex items-center gap-2 min-w-0">
            {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="font-medium">What was requested</span>
            <span className="text-sm text-muted-foreground truncate hidden sm:inline">
              — {lines.length} priced item{lines.length === 1 ? '' : 's'} from the Cost Estimator
            </span>
          </span>
          <Badge variant="secondary" className="gap-1 shrink-0">
            <DollarSign className="h-3 w-3" />
            {money(quoted ?? summed)}/mo
          </Badge>
        </button>

        {open && (
          <div className="px-4 pb-4 space-y-4">
            {requirement && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">The requirement</p>
                <p className="text-sm whitespace-pre-wrap rounded-md border bg-muted/30 p-3">{requirement}</p>
              </div>
            )}

            {lines.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">The estimate</p>
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/40 text-xs text-muted-foreground">
                      <tr>
                        <th className="text-left font-medium p-2">Layer</th>
                        <th className="text-left font-medium p-2">Service</th>
                        <th className="text-left font-medium p-2">Configuration</th>
                        <th className="text-right font-medium p-2 whitespace-nowrap">Monthly</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((line, i) => (
                        <tr key={i} className="border-t">
                          <td className="p-2 text-muted-foreground whitespace-nowrap">{line.layer ?? '—'}</td>
                          <td className="p-2">{line.service ?? '—'}</td>
                          <td className="p-2 text-muted-foreground">{describe(line) || '—'}</td>
                          <td className="p-2 text-right whitespace-nowrap">{money(line.monthlyCost)}</td>
                        </tr>
                      ))}
                      <tr className="border-t bg-muted/20 font-medium">
                        <td className="p-2" colSpan={3}>Total</td>
                        <td className="p-2 text-right whitespace-nowrap">{money(quoted ?? summed)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                {/* The agent adds the foundation an estimate never prices — the
                    network, routing, roles — so the deployment is legitimately
                    larger than this list. Saying so prevents the difference
                    being read as a fault. */}
                <p className="text-xs text-muted-foreground mt-2">
                  The agent adds the unpriced foundation these services need — network, subnets, routing, roles — so
                  the architecture below contains more resources than this list.
                </p>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
