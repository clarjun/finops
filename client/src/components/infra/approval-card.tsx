/**
 * The approval gate.
 *
 * Shows exactly what will run and why it was held, because an approver who
 * cannot see the action cannot meaningfully approve it — and a gate that is
 * always clicked through is worse than no gate, since it manufactures a record
 * of oversight that did not happen.
 *
 * Rejection asks for a reason. It is stored on the approval and appears in the
 * audit trail, so a refused deployment can be explained later.
 */
import { useState } from "react";
import { ShieldAlert, Check, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useDecideApproval } from "@/hooks/use-infra-agent";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { PlanReview, type PlanFindingView, type PlannedChangeView } from "./plan-review";

export interface PendingApproval {
  ref: string;
  nodeKey: string | null;
  summary: string;
  details: string | null;
  riskLevel: string;
  riskReasons: string[];
  estimatedCostImpact: string | null;
  /** Attribute-level risks read out of the plan. */
  planFindings?: PlanFindingView[];
  /** Per-resource actions Terraform will take. */
  plannedChanges?: PlannedChangeView[];
  /** Lets the card offer the generated Terraform for reading. */
  planId?: number | null;
}

/** Plain-language explanation of why a step was held. */
const REASON_TEXT: Record<string, string> = {
  iam: 'Grants permissions that outlive this deployment',
  public_exposure: 'Makes resources reachable from the public internet',
  network_change: 'Changes network connectivity or routing',
  secrets: 'Handles credential or key material',
  production: 'Targets a production environment',
  expensive: 'Adds material recurring cost',
  destructive: 'Destroys or replaces existing infrastructure',
  data_store: 'Stores customer data',
};

const RISK_BADGE: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  low: 'outline', medium: 'secondary', high: 'destructive', critical: 'destructive',
};

export function ApprovalCard({ approval }: { approval: PendingApproval }) {
  const { toast } = useToast();
  const findings = approval.planFindings ?? [];
  const critical = findings.filter((f) => f.severity === 'critical').length;
  const { can } = useAuth();
  const decide = useDecideApproval();
  const [reason, setReason] = useState('');
  const [rejecting, setRejecting] = useState(false);

  const mayDecide = can('agent:approve');

  const submit = (decision: 'approved' | 'rejected') => {
    if (decision === 'rejected' && !reason.trim()) {
      setRejecting(true);
      return;
    }

    decide.mutate(
      { ref: approval.ref, decision, reason: reason.trim() || undefined },
      {
        onSuccess: () => toast({
          title: decision === 'approved' ? 'Approved — deployment resuming' : 'Rejected — deployment stopped',
        }),
        onError: (e) => toast({ title: 'Could not record the decision', description: e.message, variant: 'destructive' }),
      },
    );
  };

  return (
    <Card
      // A critical finding outranks the stage's own risk label: the stage may
      // be "medium" while the plan quietly makes a database internet-facing.
      className={critical > 0 ? 'border-red-500/70' : 'border-yellow-500/60'}
      data-testid={`approval-${approval.ref}`}
    >
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldAlert className={`h-5 w-5 ${critical > 0 ? 'text-red-600' : 'text-yellow-600'}`} />
          Human approval required
          <Badge variant={RISK_BADGE[approval.riskLevel] ?? 'secondary'} className="ml-auto uppercase text-[10px]">
            {approval.riskLevel}
          </Badge>
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        <div>
          <p className="text-xs text-muted-foreground">Step</p>
          <p className="font-medium">{approval.summary}</p>
          {approval.details && <p className="text-sm text-muted-foreground mt-1">{approval.details}</p>}
        </div>

        {approval.riskReasons.length > 0 && (
          <div>
            <p className="text-xs text-muted-foreground mb-1">Why this was held</p>
            <ul className="text-sm space-y-0.5">
              {approval.riskReasons.map((r) => (
                <li key={r} className="flex gap-2">
                  <span className="text-yellow-600">•</span>
                  <span>{REASON_TEXT[r] ?? r}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* The evidence. Above the cost line on purpose: an approver decides on
            what the deployment does before what it costs. */}
        <PlanReview
          findings={findings}
          changes={approval.plannedChanges ?? []}
          planId={approval.planId ?? null}
        />

        {approval.estimatedCostImpact && Number(approval.estimatedCostImpact) > 0 && (
          <p className="text-sm">
            Estimated cost impact{' '}
            <span className="font-medium">${Number(approval.estimatedCostImpact).toFixed(2)}/month</span>
          </p>
        )}

        {rejecting && (
          <div>
            <p className="text-xs text-muted-foreground mb-1">Reason for rejecting (recorded in the audit trail)</p>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why should this not proceed?"
              rows={2}
              autoFocus
            />
          </div>
        )}

        {mayDecide ? (
          <div className="flex gap-2">
            <Button
              onClick={() => submit('approved')}
              disabled={decide.isPending || rejecting}
              className="gap-2"
              data-testid="button-approve"
            >
              {decide.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              Approve
            </Button>
            <Button
              variant="outline"
              onClick={() => submit('rejected')}
              disabled={decide.isPending}
              className="gap-2"
              data-testid="button-reject"
            >
              <X className="h-4 w-4" />
              {rejecting ? 'Confirm rejection' : 'Reject'}
            </Button>
            {rejecting && (
              <Button variant="ghost" onClick={() => { setRejecting(false); setReason(''); }}>Cancel</Button>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Deciding this requires the <code className="text-xs">agent:approve</code> permission.
            The deployment stays paused until someone with it responds.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
