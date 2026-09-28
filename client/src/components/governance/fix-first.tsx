/**
 * "What should I fix first?"
 *
 * The question the section could not previously answer. It showed a score and
 * it showed findings, and nothing connected the two — so the only available
 * strategy was to sort by severity and hope.
 *
 * Hoping is wrong often enough to matter. On this tenant the fourteen CRITICAL
 * unencrypted volumes are the fourth most valuable thing to fix: three smaller
 * rules are failing 100% of what they examine and each recovers more score. A
 * reader sorting by severity would have started in the wrong place and had no
 * way to know.
 *
 * The number shown is exact, not a ranking heuristic. Because
 *   score = 100 · (1 − Σ(wᵢ·gapᵢ) / Σw)
 * zeroing one policy removes precisely w_P·gap_P from the numerator, so the
 * gains are additive — which is what lets the panel show a running total and
 * say "fix these three and you reach 80".
 */
import { ArrowRight, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { PolicyImpact, PolicySeverity } from "@shared/governance";
import { SeverityBadge } from "./shared";

/** How many to show before folding the rest away. Enough to plan a sprint. */
const SHOWN = 5;

export function FixFirst({
  impacts,
  score,
  onOpenFindings,
}: {
  impacts: PolicyImpact[];
  score: number;
  onOpenFindings: (policyKey: string) => void;
}) {
  // Runs recorded before migration 0026 carry no impacts, and `checked` cannot
  // be reconstructed from the findings afterwards. Saying nothing is correct:
  // a fabricated priority order would be worse than none.
  if (impacts.length === 0) return null;

  const top = impacts.slice(0, SHOWN);
  const rest = impacts.slice(SHOWN);
  const restGain = rest.reduce((sum, i) => sum + i.potentialGain, 0);

  // Running total, so each row answers "and where does that leave me".
  let running = score;
  const withRunning = top.map(i => {
    running += i.potentialGain;
    return { impact: i, scoreAfter: running };
  });

  return (
    <Card className="border-primary/30">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-primary" />
          Fix these first
        </CardTitle>
        <CardDescription>
          Ordered by how much each one would raise your score, not by how many findings it has —
          those are different questions. A rule failing everything it looks at costs you more than
          a rule failing a handful of things out of thousands.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <div className="divide-y">
          {withRunning.map(({ impact, scoreAfter }, idx) => (
            <div key={impact.policyKey} className="py-3 flex items-start gap-3">
              <span className="text-sm font-semibold text-muted-foreground w-5 shrink-0 mt-0.5">
                {idx + 1}
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-sm">{impact.title}</span>
                  <SeverityBadge severity={impact.severity as PolicySeverity} />
                </div>

                <p className="text-xs text-muted-foreground mt-1">
                  {/* The denominator is the whole point. "14 findings" hides
                      whether that is everything or almost nothing. */}
                  <strong className="text-foreground">
                    {impact.violating.toLocaleString()} of {impact.checked.toLocaleString()}
                  </strong>{' '}
                  failing ({Math.round(impact.failRate * 100)}%)
                </p>

                <button
                  type="button"
                  onClick={() => onOpenFindings(impact.policyKey)}
                  className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  See the {impact.violating.toLocaleString()} finding{impact.violating === 1 ? '' : 's'}
                  <ArrowRight className="h-3 w-3" />
                </button>
              </div>

              <div className="shrink-0 text-right">
                <Badge variant="secondary" className="font-mono">
                  +{impact.potentialGain.toFixed(1)}
                </Badge>
                <p className="text-xs text-muted-foreground mt-1 whitespace-nowrap">
                  score {scoreAfter.toFixed(1)}
                </p>
              </div>
            </div>
          ))}
        </div>

        {rest.length > 0 && (
          <p className="text-xs text-muted-foreground pt-3">
            {rest.length} more failing rule{rest.length === 1 ? '' : 's'} worth a further{' '}
            <strong className="text-foreground">+{restGain.toFixed(1)}</strong> between them.
          </p>
        )}

        <p className="text-xs text-muted-foreground mt-3 pt-3 border-t">
          These add up: clearing the top {Math.min(3, top.length)} would take you from{' '}
          <strong className="text-foreground">{score.toFixed(1)}</strong> to{' '}
          <strong className="text-foreground">
            {(score + top.slice(0, 3).reduce((s, i) => s + i.potentialGain, 0)).toFixed(1)}
          </strong>
          . Nothing here needs to be marked as done — fix the resource and the findings close at the
          next evaluation.
        </p>
      </CardContent>
    </Card>
  );
}
