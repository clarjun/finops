/**
 * What the agent has learned.
 *
 * Two kinds of knowledge, deliberately shown together because they answer the
 * same question from different heights: a blueprint is a whole architecture that
 * has been built, a standard step is a single resource that has been built.
 *
 * Evidence is displayed on every row — how often something was used, how often
 * it worked, when it was last confirmed. A library that shows only names invites
 * trust it has not earned; the point of recording usage and success is that a
 * reader can weigh it.
 */
import { useState } from "react";
import { useLocation } from "wouter";
import {
  Library, Layers, PackageCheck, AlertTriangle, Loader2, Rocket, ExternalLink, Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import {
  useSteps, useStepDetail, useBlueprints, useInstantiateBlueprint,
  type LibraryStep,
} from "@/hooks/use-infra-agent";

export default function InfraLibraryPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
          <Library className="h-7 w-7" /> Deployment Library
        </h1>
        <p className="text-muted-foreground mt-1">
          What the agent has learned from deployments that actually succeeded. Nothing here comes from a simulation.
        </p>
      </div>

      <Tabs defaultValue="blueprints" className="space-y-4">
        <TabsList>
          <TabsTrigger value="blueprints" className="gap-2"><Layers className="h-4 w-4" /> Blueprints</TabsTrigger>
          <TabsTrigger value="steps" className="gap-2"><PackageCheck className="h-4 w-4" /> Standard steps</TabsTrigger>
        </TabsList>

        <TabsContent value="blueprints"><Blueprints /></TabsContent>
        <TabsContent value="steps"><Steps /></TabsContent>
      </Tabs>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function Blueprints() {
  const { toast } = useToast();
  const { can } = useAuth();
  const [, navigate] = useLocation();
  const { data, isLoading } = useBlueprints();
  const instantiate = useInstantiateBlueprint();

  const blueprints = data?.templates ?? [];

  const use = (templateId: number, name: string) => {
    instantiate.mutate({ templateId }, {
      onSuccess: () => {
        // The clone starts at `clarifying`: account and environment are asked
        // again rather than inherited, so the user is sent back to the console.
        toast({
          title: `Started from "${name}"`,
          description: 'Choose the account and environment for this deployment.',
        });
        navigate('/infra-agent');
      },
      onError: (e) => toast({ title: 'Could not use the blueprint', description: e.message, variant: 'destructive' }),
    });
  };

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading blueprints…</p>;

  if (blueprints.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center space-y-2">
          <Layers className="h-8 w-8 mx-auto text-muted-foreground" />
          <p className="font-medium">No blueprints yet</p>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            After a real deployment succeeds, save it as a blueprint from the summary. Simulations cannot become
            blueprints — a blueprint asserts an arrangement has actually been built.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {blueprints.map((b) => (
        <Card key={b.id}>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-start justify-between gap-2">
              <span>{b.name}</span>
              {b.templateUseCount > 0 && (
                <Badge variant="secondary" className="shrink-0">used {b.templateUseCount}×</Badge>
              )}
            </CardTitle>
            <CardDescription>
              {b.provider?.toUpperCase()}{b.region ? ` / ${b.region}` : ''}
              {b.estimatedMonthlyCost ? ` — ~$${Number(b.estimatedMonthlyCost).toFixed(0)}/mo` : ''}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {b.templateDescription && <p className="text-sm">{b.templateDescription}</p>}
            <p className="text-xs text-muted-foreground line-clamp-2">{b.requirements}</p>

            {can('agent:propose') ? (
              <Button
                size="sm"
                className="gap-2"
                disabled={instantiate.isPending}
                onClick={() => use(b.id, b.name)}
                data-testid={`use-blueprint-${b.id}`}
              >
                {instantiate.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
                Start from this
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">
                Using a blueprint requires the <code>agent:propose</code> permission.
              </p>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function Steps() {
  const { data, isLoading } = useSteps();
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const steps = data?.steps ?? [];

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading steps…</p>;

  if (steps.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center space-y-2">
          <PackageCheck className="h-8 w-8 mx-auto text-muted-foreground" />
          <p className="font-medium">Nothing learned yet</p>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            Each time a resource is created successfully, the agent records how it was done. Those steps are then
            recognised in future plans, so it gets faster at architectures it has built before.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      {steps.map((step) => (
        <StepRow
          key={step.slug}
          step={step}
          open={openSlug === step.slug}
          onToggle={() => setOpenSlug(openSlug === step.slug ? null : step.slug)}
        />
      ))}
    </div>
  );
}

function StepRow({ step, open, onToggle }: { step: LibraryStep; open: boolean; onToggle: () => void }) {
  const detail = useStepDetail(open ? step.slug : null);

  return (
    <Card>
      <CardContent className="py-3">
        <button className="w-full text-left" onClick={onToggle} data-testid={`step-${step.slug}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="font-medium text-sm truncate">{step.name}</p>
              <p className="text-xs text-muted-foreground font-mono truncate">{step.slug}</p>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <Badge variant="outline">v{step.version}</Badge>
              {/* Evidence, not decoration: how often it was used and how often
                  it worked is what makes a step worth trusting. */}
              <span className="text-xs text-muted-foreground">
                used {step.usageCount}× · {(step.successRate * 100).toFixed(0)}% success
              </span>
              {step.stale ? (
                <Badge variant="secondary" className="gap-1" title="Not confirmed recently — worth re-checking against current provider documentation">
                  <Clock className="h-3 w-3" /> needs re-check
                </Badge>
              ) : (
                <Badge variant={step.validationStatus === 'validated' ? 'default' : 'secondary'}>
                  {step.validationStatus}
                </Badge>
              )}
            </div>
          </div>
        </button>

        {open && (
          <div className="mt-3 border-t pt-3 space-y-3">
            {detail.isLoading ? (
              <p className="text-xs text-muted-foreground">Loading…</p>
            ) : (
              <>
                {/* Provenance. A step with no source is knowledge nobody can
                    re-check, and is labelled as such rather than shown bare. */}
                <div>
                  <p className="text-xs font-medium mb-1">Where this came from</p>
                  {(detail.data?.provenance ?? []).length === 0 ? (
                    <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                      <AlertTriangle className="h-3 w-3 text-yellow-600" />
                      Learned from a successful deployment; no documentation source recorded yet.
                    </p>
                  ) : (
                    <ul className="space-y-1">
                      {detail.data!.provenance.map((p) => (
                        <li key={p.id} className="text-xs">
                          <a href={p.url} target="_blank" rel="noreferrer" className="text-primary inline-flex items-center gap-1 hover:underline">
                            {p.title ?? p.url} <ExternalLink className="h-3 w-3" />
                          </a>
                          <span className="text-muted-foreground"> — retrieved {new Date(p.retrievedAt).toLocaleDateString()}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {(detail.data?.versions?.length ?? 0) > 1 && (
                  <div>
                    <p className="text-xs font-medium mb-1">Versions</p>
                    <div className="space-y-0.5">
                      {detail.data!.versions.map((v) => (
                        <p key={v.id} className="text-xs text-muted-foreground">
                          v{v.version} — used {v.usageCount}×, {v.successCount} successful
                          {v.lastValidatedAt ? `, last confirmed ${new Date(v.lastValidatedAt).toLocaleDateString()}` : ''}
                        </p>
                      ))}
                    </div>
                  </div>
                )}

                {detail.data?.versions?.[0]?.implementation && (
                  <details>
                    <summary className="text-xs font-medium cursor-pointer">Implementation</summary>
                    <pre className="mt-2 text-[11px] bg-muted/50 rounded p-2 overflow-x-auto">
                      {detail.data.versions[0].implementation}
                    </pre>
                  </details>
                )}
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
