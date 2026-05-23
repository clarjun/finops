import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Brain, CheckCircle2, XCircle, PlayCircle, AlertCircle, TrendingUp, Settings, Sparkles, ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export default function AgentDashboard() {
  const { toast } = useToast();
  const [showCreatePlan, setShowCreatePlan] = useState(false);
  const [planGoal, setPlanGoal] = useState("Reduce AWS costs by 20%");
  const [planProvider, setPlanProvider] = useState("aws");
  const [expandedPlanId, setExpandedPlanId] = useState<number | null>(null);

  // Fetch optimization plans
  const { data: plans = [], isLoading: plansLoading } = useQuery<any[]>({
    queryKey: ["/api/agent/plans"],
  });

  // Fetch actions for expanded plan
  const { data: planActions = [], isLoading: planActionsLoading } = useQuery<any[]>({
    queryKey: ["/api/agent/actions", expandedPlanId],
    queryFn: async () => {
      if (!expandedPlanId) return [];
      const response = await fetch(`/api/agent/actions?planId=${expandedPlanId}`);
      if (!response.ok) throw new Error("Failed to fetch plan actions");
      return response.json();
    },
    enabled: expandedPlanId !== null,
  });

  // Fetch optimization actions for stats
  const { data: allActions = [] } = useQuery<any[]>({
    queryKey: ["/api/agent/actions"],
  });

  // Fetch agent config
  const { data: config } = useQuery<any>({
    queryKey: ["/api/agent/config"],
  });

  useEffect(()=>{
    console.log("configggggggggggggg ", config)
  },[])

  // Create optimization plan
  const createPlanMutation = useMutation({
    mutationFn: async (data: { goal: string; provider: string }) => {
      return apiRequest("POST", "/api/agent/plan", {
        goal: data.goal,
        provider: data.provider,
        includeContext: true,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agent/plans"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agent/actions"] });
      toast({
        title: "Optimization Plan Created",
        description: "AI has generated a multi-step cost optimization plan",
      });
      setShowCreatePlan(false);
    },
    onError: (error: any) => {
      toast({
        title: "Failed to Create Plan",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Approve action
  const approveMutation = useMutation({
    mutationFn: async (actionId: number) => {
      return apiRequest("POST", `/api/agent/actions/${actionId}/approve`, {
        approvedBy: "user",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agent/actions"] });
      toast({
        title: "Action Approved",
        description: "The optimization action has been approved for execution",
      });
    },
  });

  // Reject action
  const rejectMutation = useMutation({
    mutationFn: async ({ actionId, reason }: { actionId: number; reason: string }) => {
      return apiRequest("POST", `/api/agent/actions/${actionId}/reject`, { reason });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agent/actions"] });
      toast({
        title: "Action Rejected",
        description: "The optimization action has been rejected",
      });
    },
  });

  // Execute action
  const executeMutation = useMutation({
    mutationFn: async (actionId: number) => {
      return apiRequest("POST", `/api/agent/actions/${actionId}/execute`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agent/actions"] });
      toast({
        title: "Action Executed",
        description: "The optimization action has been executed",
      });
    },
  });

  // Retry failed action
  const retryMutation = useMutation({
    mutationFn: async (actionId: number) => {
      return apiRequest("POST", `/api/agent/actions/${actionId}/retry`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agent/actions"] });
      toast({
        title: "Retry Initiated",
        description: "AI is generating an alternative strategy for this action",
      });
    },
  });

  // Delete action
  const deleteActionMutation = useMutation({
    mutationFn: async (actionId: number) => {
      return apiRequest("DELETE", `/api/agent/actions/${actionId}`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agent/actions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agent/actions", expandedPlanId] });
      queryClient.invalidateQueries({ queryKey: ["/api/agent/plans"] });
      toast({
        title: "Action Deleted",
        description: "The optimization action has been removed",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Failed to Delete Action",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const pendingActions = allActions.filter((a: any) => a.status === 'proposed');
  const approvedActions = allActions.filter((a: any) => a.status === 'approved');
  const failedActions = allActions.filter((a: any) => a.status === 'failed');
  const completedActions = allActions.filter((a: any) => a.status === 'completed');

  const activePlans = plans.filter((p: any) => ['planning', 'approved', 'executing'].includes(p.status));
  const completedPlans = plans.filter((p: any) => p.status === 'completed');

  const getStatusBadge = (status: string) => {
    const variants: Record<string, any> = {
      proposed: { variant: "outline", icon: AlertCircle, color: "text-yellow-600" },
      approved: { variant: "default", icon: CheckCircle2, color: "text-green-600" },
      executing: { variant: "secondary", icon: PlayCircle, color: "text-blue-600" },
      completed: { variant: "default", icon: CheckCircle2, color: "text-green-600" },
      failed: { variant: "destructive", icon: XCircle, color: "text-red-600" },
    };

    const config = variants[status] || variants.proposed;
    const Icon = config.icon;

    return (
      <Badge variant={config.variant} className="gap-1">
        <Icon className="h-3 w-3" />
        {status}
      </Badge>
    );
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <h1 className="text-3xl font-bold flex items-center gap-2">
              <Brain className="h-8 w-8 text-primary" />
              Agentic AI Agent
            </h1>
            <p className="text-muted-foreground">
              Autonomous cost optimization with multi-step planning and self-correction
            </p>
          </div>
          <Button
            onClick={() => setShowCreatePlan(true)}
            className="gap-2"
            data-testid="button-create-plan"
          >
            <Sparkles className="h-4 w-4" />
            Create Optimization Plan
          </Button>
        </div>

        {/* Agent Status Cards */}
        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Active Plans</CardTitle>
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold" data-testid="text-active-plans">{activePlans.length}</div>
              <p className="text-xs text-muted-foreground">
                Multi-step optimization strategies
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Pending Approval</CardTitle>
              <AlertCircle className="h-4 w-4 text-yellow-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold" data-testid="text-pending-actions">{pendingActions.length}</div>
              <p className="text-xs text-muted-foreground">
                Actions awaiting your approval
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Completed</CardTitle>
              <CheckCircle2 className="h-4 w-4 text-green-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold" data-testid="text-completed-actions">{completedActions.length}</div>
              <p className="text-xs text-muted-foreground">
                Successfully executed optimizations
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Agent Mode</CardTitle>
              <Settings className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{config?.dry_run_mode ? 'DRY RUN' : 'LIVE'}</div>
              <p className="text-xs text-muted-foreground">
                {config?.safety_mode ? 'Safety enabled' : 'Safety disabled'}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Main Content Tabs */}
        <Tabs defaultValue="plans" className="space-y-4">
          <TabsList>
            <TabsTrigger value="plans">Plans</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>

          <TabsContent value="plans" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Optimization Plans</CardTitle>
                <CardDescription>
                  Multi-step AI-generated cost reduction strategies
                </CardDescription>
              </CardHeader>
              <CardContent>
                {plansLoading ? (
                  <p className="text-center text-muted-foreground py-8">Loading plans...</p>
                ) : plans.length === 0 ? (
                  <p className="text-center text-muted-foreground py-8">
                    No plans yet. Create your first optimization plan!
                  </p>
                ) : (
                  <div className="space-y-3">
                    {[...plans].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).map((plan: any) => (
                      <Card key={plan.id} className="hover-elevate">
                        <CardContent className="pt-6">
                          <div className="space-y-3">
                            <div 
                              className="cursor-pointer"
                              onClick={() => setExpandedPlanId(expandedPlanId === plan.id ? null : plan.id)}
                              data-testid={`card-plan-${plan.id}`}
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="flex items-start gap-2 flex-1">
                                  {expandedPlanId === plan.id ? (
                                    <ChevronDown className="h-5 w-5 text-muted-foreground mt-0.5 flex-shrink-0" />
                                  ) : (
                                    <ChevronRight className="h-5 w-5 text-muted-foreground mt-0.5 flex-shrink-0" />
                                  )}
                                  <div className="flex-1 space-y-2">
                                    <div className="flex items-center gap-2">
                                      <h3 className="font-semibold">{plan.goal}</h3>
                                      {getStatusBadge(plan.status)}
                                    </div>
                                    <p className="text-sm text-muted-foreground">
                                      {plan.aiStrategy}
                                    </p>
                                    <div className="flex items-center gap-4 text-sm">
                                      <span className="text-muted-foreground">
                                        Steps: <strong>{plan.totalSteps || 0}</strong>
                                      </span>
                                      <span className="text-muted-foreground">
                                        Completed: <strong>{plan.completedSteps || 0}</strong>
                                      </span>
                                      <span className="text-green-600 font-semibold">
                                        Target Savings: ${parseFloat(plan.targetSavings || '0').toFixed(2)}
                                      </span>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </div>

                            {/* Expanded Actions */}
                            {expandedPlanId === plan.id && (
                              <div className="ml-7 mt-4 space-y-2 border-l-2 border-primary/20 pl-4">
                                <h4 className="text-sm font-semibold text-muted-foreground">Actions ({planActions.length})</h4>
                                {planActionsLoading ? (
                                  <p className="text-sm text-muted-foreground py-4">Loading actions...</p>
                                ) : planActions.length === 0 ? (
                                  <p className="text-sm text-muted-foreground py-4">No actions in this plan</p>
                                ) : (
                                  <div className="space-y-2">
                                    {planActions.map((action: any) => (
                                      <div key={action.id} className="bg-muted/30 rounded-md p-3 space-y-2">
                                        <div className="flex items-start justify-between gap-2">
                                          <div className="flex-1 space-y-1">
                                            <div className="flex items-center gap-2">
                                              <span className="text-sm font-medium">{action.actionType}</span>
                                              {getStatusBadge(action.status)}
                                            </div>
                                            <p className="text-sm text-muted-foreground">
                                              {action.aiReasoning}
                                            </p>
                                            <div className="flex items-center gap-3 text-xs">
                                              <span className="text-muted-foreground">
                                                Resource: <strong>{action.resourceId || 'N/A'}</strong>
                                              </span>
                                              <span className="text-green-600 font-semibold">
                                                ${parseFloat(action.estimatedSavings || '0').toFixed(2)}
                                              </span>
                                            </div>
                                          </div>
                                          <div className="flex gap-2">
                                            {action.status === 'proposed' && (
                                              <>
                                                <Button
                                                  size="sm"
                                                  onClick={(e) => {
                                                    e.stopPropagation();
                                                    approveMutation.mutate(action.id);
                                                  }}
                                                  disabled={approveMutation.isPending}
                                                  data-testid={`button-approve-${action.id}`}
                                                >
                                                  <CheckCircle2 className="h-3 w-3" />
                                                </Button>
                                                <Button
                                                  size="sm"
                                                  variant="outline"
                                                  onClick={(e) => {
                                                    e.stopPropagation();
                                                    rejectMutation.mutate({ actionId: action.id, reason: 'User rejected' });
                                                  }}
                                                  disabled={rejectMutation.isPending}
                                                  data-testid={`button-reject-${action.id}`}
                                                >
                                                  <XCircle className="h-3 w-3" />
                                                </Button>
                                              </>
                                            )}
                                            {action.status === 'approved' && (
                                              <Button
                                                size="sm"
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  executeMutation.mutate(action.id);
                                                }}
                                                disabled={executeMutation.isPending}
                                                data-testid={`button-execute-${action.id}`}
                                              >
                                                <PlayCircle className="h-3 w-3" />
                                              </Button>
                                            )}
                                            {action.status === 'failed' && (
                                              <Button
                                                size="sm"
                                                variant="outline"
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  retryMutation.mutate(action.id);
                                                }}
                                                disabled={retryMutation.isPending}
                                                data-testid={`button-retry-${action.id}`}
                                              >
                                                <PlayCircle className="h-3 w-3" />
                                              </Button>
                                            )}
                                            <Button
                                              size="sm"
                                              variant="ghost"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                if (confirm('Are you sure you want to delete this action?')) {
                                                  deleteActionMutation.mutate(action.id);
                                                }
                                              }}
                                              disabled={deleteActionMutation.isPending}
                                              data-testid={`button-delete-action-${action.id}`}
                                            >
                                              <Trash2 className="h-3 w-3 text-destructive" />
                                            </Button>
                                          </div>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="settings" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Agent Configuration</CardTitle>
                <CardDescription>
                  Control how the AI agent operates
                </CardDescription>
              </CardHeader>
              <CardContent>
                {/* {config ? ( */}
                  <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label>Dry-Run Mode</Label>
                        <p className="text-sm text-muted-foreground">
                          {config?.dry_run_mode ? 'Enabled (Simulated execution only)' : 'Disabled (Real execution)'}
                        </p>
                      </div>
                      <div>
                        <Label>Safety Mode</Label>
                        <p className="text-sm text-muted-foreground">
                          {config?.safety_mode ? 'Enabled (Prevents destructive actions)' : 'Disabled'}
                        </p>
                      </div>
                      <div>
                        <Label>Auto-Execute</Label>
                        <p className="text-sm text-muted-foreground">
                          {config?.auto_execute_enabled ? 'Enabled (Autonomous execution)' : 'Disabled (Manual approval required)'}
                        </p>
                      </div>
                      <div>
                        <Label>Aggressiveness</Label>
                        <p className="text-sm text-muted-foreground capitalize">
                          {config?.aggressiveness}
                        </p>
                      </div>
                    </div>
                  </div>
                {/* ) 
                 : (
                   <p className="text-center text-muted-foreground py-8">Loading configuration...</p>
                )} */}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      {/* Create Plan Dialog */}
      <Dialog open={showCreatePlan} onOpenChange={setShowCreatePlan}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Optimization Plan</DialogTitle>
            <DialogDescription>
              Let the AI agent create a multi-step cost optimization plan
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="goal">Optimization Goal</Label>
              <Textarea
                id="goal"
                placeholder="E.g., Reduce AWS costs by 30%, Optimize idle resources, etc."
                value={planGoal}
                onChange={(e) => setPlanGoal(e.target.value)}
                data-testid="input-plan-goal"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="provider">Cloud Provider</Label>
              <Select value={planProvider} onValueChange={setPlanProvider}>
                <SelectTrigger id="provider" data-testid="select-plan-provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="aws">AWS</SelectItem>
                  <SelectItem value="gcp">GCP</SelectItem>
                  <SelectItem value="azure">Azure</SelectItem>
                  <SelectItem value="all">All Providers</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2">
              <Button
                onClick={() => createPlanMutation.mutate({ goal: planGoal, provider: planProvider })}
                disabled={createPlanMutation.isPending || !planGoal}
                className="flex-1"
                data-testid="button-generate-plan"
              >
                {createPlanMutation.isPending ? 'Generating...' : 'Generate Plan'}
              </Button>
              <Button
                variant="outline"
                onClick={() => setShowCreatePlan(false)}
                data-testid="button-cancel-plan"
              >
                Cancel
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
