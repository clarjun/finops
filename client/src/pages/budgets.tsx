import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus, Trash2, Edit, TrendingUp, TrendingDown, AlertTriangle, DollarSign } from "lucide-react";
import { ProviderSelector, type CloudProvider } from "@/components/provider-selector";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { insertBudgetSchema, type Budget as SchemaBudget } from "@shared/schema";

// Budget type with properly typed alertThresholds
type Budget = Omit<SchemaBudget, 'alertThresholds'> & {
  alertThresholds: Record<string, boolean> | null;
};

// Extend insert schema for form validation with string dates and optional fields
const budgetFormSchema = insertBudgetSchema.extend({
  startDate: z.string(),
  endDate: z.string().optional().nullable(),
  provider: z.string().nullable().optional(),
  accountId: z.string().nullable().optional(),
  serviceName: z.string().nullable().optional(),
  alertThresholds: z.record(z.boolean()).nullable().optional(),
});

type BudgetFormValues = z.infer<typeof budgetFormSchema>;

export default function BudgetsPage() {
  const [selectedProvider, setSelectedProvider] = useState<CloudProvider>('all');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingBudget, setEditingBudget] = useState<Budget | null>(null);
  const { toast } = useToast();

  const { data: budgetsData, isLoading } = useQuery<{ success: boolean; budgets: Budget[] }>({
    queryKey: selectedProvider === 'all' ? ['/api/budgets'] : ['/api/budgets', `?provider=${selectedProvider}`],
    enabled: true,
  });

  const { data: costData } = useQuery<{ success: boolean; totalCost: number }>({
    queryKey: selectedProvider === 'all' ? ['/api/cost-data'] : ['/api/cost-data', `?provider=${selectedProvider}`],
    enabled: true,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      return apiRequest('DELETE', `/api/budgets/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/budgets'] });
      toast({ title: "Budget deleted successfully" });
    },
    onError: () => {
      toast({ title: "Failed to delete budget", variant: "destructive" });
    },
  });

  const budgets = budgetsData?.budgets || [];
  const currentCost = costData?.totalCost || 0;

  const handleEdit = (budget: Budget) => {
    setEditingBudget(budget);
    setDialogOpen(true);
  };

  const handleDelete = (id: number) => {
    if (confirm("Are you sure you want to delete this budget?")) {
      deleteMutation.mutate(id);
    }
  };

  const calculateBudgetStatus = (budget: Budget) => {
    // NOTE: MVP limitation - using global cost for all budgets
    // Production implementation should filter cost data by:
    // - budget.provider (if set)
    // - budget.accountId (if set)  
    // - budget.serviceName (if set)
    // - budget period date range
    // This would require a new API endpoint: GET /api/budgets/:id/spending
    const spent = currentCost;
    const budgetAmount = parseFloat(budget.amount);
    const percentage = (spent / budgetAmount) * 100;
    
    let status: 'success' | 'warning' | 'danger' = 'success';
    if (percentage >= 100) status = 'danger';
    else if (percentage >= 75) status = 'warning';
    
    return { spent, percentage: Math.min(percentage, 100), status };
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold" data-testid="text-page-title">Budget Management</h1>
          <p className="text-muted-foreground mt-1">Track and manage your cloud spending budgets</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <ProviderSelector value={selectedProvider} onChange={setSelectedProvider} />
          <Dialog open={dialogOpen} onOpenChange={(open) => {
            setDialogOpen(open);
            if (!open) setEditingBudget(null);
          }}>
            <DialogTrigger asChild>
              <Button data-testid="button-create-budget">
                <Plus className="h-4 w-4 mr-2" />
                Create Budget
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>{editingBudget ? 'Edit Budget' : 'Create New Budget'}</DialogTitle>
                <DialogDescription>
                  Set spending limits and configure alerts for your cloud resources
                </DialogDescription>
              </DialogHeader>
              <BudgetForm 
                budget={editingBudget} 
                onClose={() => {
                  setDialogOpen(false);
                  setEditingBudget(null);
                }} 
              />
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Budget Summary Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Budgets</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-total-budgets">{budgets.length}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {budgets.filter(b => b.isActive).length} active
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">At Risk</CardTitle>
            <AlertTriangle className="h-4 w-4 text-orange-600 dark:text-orange-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-orange-600 dark:text-orange-400" data-testid="text-at-risk-count">
              {budgets.filter(b => {
                const { percentage } = calculateBudgetStatus(b);
                return percentage >= 75 && percentage < 100;
              }).length}
            </div>
            <p className="text-xs text-muted-foreground mt-1">75-99% consumed</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Exceeded</CardTitle>
            <TrendingUp className="h-4 w-4 text-red-600 dark:text-red-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600 dark:text-red-400" data-testid="text-exceeded-count">
              {budgets.filter(b => {
                const { percentage } = calculateBudgetStatus(b);
                return percentage >= 100;
              }).length}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Over budget limit</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Healthy</CardTitle>
            <TrendingDown className="h-4 w-4 text-green-600 dark:text-green-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600 dark:text-green-400" data-testid="text-healthy-count">
              {budgets.filter(b => {
                const { percentage } = calculateBudgetStatus(b);
                return percentage < 75;
              }).length}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Under 75% spent</p>
          </CardContent>
        </Card>
      </div>

      {/* Budget List */}
      <div className="space-y-4">
        {isLoading ? (
          <Card>
            <CardContent className="p-6">
              <p className="text-center text-muted-foreground">Loading budgets...</p>
            </CardContent>
          </Card>
        ) : budgets.length === 0 ? (
          <Card>
            <CardContent className="p-12 text-center">
              <DollarSign className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold mb-2">No budgets found</h3>
              <p className="text-muted-foreground mb-4">
                Create your first budget to start tracking cloud spending
              </p>
              <Button onClick={() => setDialogOpen(true)} data-testid="button-create-first-budget">
                <Plus className="h-4 w-4 mr-2" />
                Create Budget
              </Button>
            </CardContent>
          </Card>
        ) : (
          budgets.map((budget) => {
            const { spent, percentage, status } = calculateBudgetStatus(budget);
            const progressColor = status === 'danger' ? 'bg-red-600' : status === 'warning' ? 'bg-orange-600' : 'bg-green-600';

            return (
              <Card key={budget.id} data-testid={`card-budget-${budget.id}`}>
                <CardHeader>
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2 mb-2">
                        <CardTitle className="text-xl" data-testid={`text-budget-name-${budget.id}`}>
                          {budget.budgetName}
                        </CardTitle>
                        {!budget.isActive && (
                          <Badge variant="secondary" data-testid={`badge-inactive-${budget.id}`}>Inactive</Badge>
                        )}
                        {budget.provider && (
                          <Badge variant="outline" data-testid={`badge-provider-${budget.id}`}>{budget.provider.toUpperCase()}</Badge>
                        )}
                      </div>
                      <CardDescription>
                        {budget.serviceName || 'All services'} • {budget.period} budget
                        {budget.accountId && ` • Account: ${budget.accountId.substring(0, 12)}...`}
                      </CardDescription>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => handleEdit(budget)}
                        data-testid={`button-edit-${budget.id}`}
                      >
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => handleDelete(budget.id)}
                        data-testid={`button-delete-${budget.id}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex flex-wrap items-end justify-between gap-4">
                    <div>
                      <p className="text-sm text-muted-foreground">Current Spending</p>
                      <p className="text-2xl font-bold" data-testid={`text-spent-${budget.id}`}>
                        ${spent.toFixed(2)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm text-muted-foreground">Budget Limit</p>
                      <p className="text-2xl font-bold" data-testid={`text-limit-${budget.id}`}>
                        ${parseFloat(budget.amount).toFixed(2)}
                      </p>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Progress</span>
                      <span className={`font-medium ${
                        status === 'danger' ? 'text-red-600 dark:text-red-400' :
                        status === 'warning' ? 'text-orange-600 dark:text-orange-400' :
                        'text-green-600 dark:text-green-400'
                      }`} data-testid={`text-percentage-${budget.id}`}>
                        {percentage.toFixed(1)}%
                      </span>
                    </div>
                    <Progress value={percentage} className="h-2" />
                  </div>

                  {budget.alertThresholds && (
                    <div className="flex flex-wrap items-center gap-2" data-testid={`div-thresholds-${budget.id}`}>
                      <span className="text-sm text-muted-foreground">Alert Thresholds:</span>
                      {Object.entries(budget.alertThresholds)
                        .filter(([_, enabled]) => Boolean(enabled))
                        .map(([threshold]) => (
                          <Badge key={threshold} variant="secondary" className="text-xs" data-testid={`badge-threshold-${threshold}-${budget.id}`}>
                            {threshold}%
                          </Badge>
                        ))}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t text-xs text-muted-foreground">
                    <span>Start: {format(new Date(budget.startDate), 'MMM dd, yyyy')}</span>
                    {budget.endDate && (
                      <span>End: {format(new Date(budget.endDate), 'MMM dd, yyyy')}</span>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}

function BudgetForm({ budget, onClose }: { budget: Budget | null; onClose: () => void }) {
  const { toast } = useToast();

  const form = useForm<BudgetFormValues>({
    resolver: zodResolver(budgetFormSchema),
    defaultValues: budget ? {
      budgetName: budget.budgetName,
      provider: budget.provider,
      accountId: budget.accountId,
      serviceName: budget.serviceName,
      amount: budget.amount,
      period: budget.period as any,
      startDate: budget.startDate ? format(new Date(budget.startDate), 'yyyy-MM-dd') : format(new Date(), 'yyyy-MM-dd'),
      endDate: budget.endDate ? format(new Date(budget.endDate), 'yyyy-MM-dd') : undefined,
      alertThresholds: budget.alertThresholds || { "50": true, "75": true, "90": true, "100": true },
      isActive: budget.isActive,
    } : {
      budgetName: "",
      provider: null,
      accountId: null,
      serviceName: null,
      amount: "",
      period: "monthly",
      startDate: format(new Date(), 'yyyy-MM-dd'),
      alertThresholds: { "50": true, "75": true, "90": true, "100": true },
      isActive: true,
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: BudgetFormValues) => {
      const endpoint = budget ? `/api/budgets/${budget.id}` : '/api/budgets';
      const method = budget ? 'PATCH' : 'POST';
      // Convert string dates to Date objects for API
      const submitData = {
        ...data,
        startDate: new Date(data.startDate),
        endDate: data.endDate ? new Date(data.endDate) : null,
      };
      return apiRequest(method, endpoint, submitData);
    },
    onSuccess: () => {
      // Invalidate all budget queries to refresh the list
      queryClient.invalidateQueries({ queryKey: ['/api/budgets'] });
      toast({ title: budget ? "Budget updated successfully" : "Budget created successfully" });
      onClose();
    },
    onError: () => {
      toast({ title: "Failed to save budget", variant: "destructive" });
    },
  });

  const onSubmit = (data: BudgetFormValues) => {
    createMutation.mutate(data);
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        <FormField
          control={form.control}
          name="budgetName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Budget Name</FormLabel>
              <FormControl>
                <Input placeholder="e.g., Production Environment Monthly" {...field} data-testid="input-budget-name" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid gap-4 md:grid-cols-2">
          <FormField
            control={form.control}
            name="amount"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Budget Amount (USD)</FormLabel>
                <FormControl>
                  <Input type="number" step="0.01" placeholder="10000.00" {...field} data-testid="input-amount" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="period"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Period</FormLabel>
                <Select onValueChange={field.onChange} defaultValue={field.value}>
                  <FormControl>
                    <SelectTrigger data-testid="select-period">
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                    <SelectItem value="quarterly">Quarterly</SelectItem>
                    <SelectItem value="yearly">Yearly</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <FormField
            control={form.control}
            name="startDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Start Date</FormLabel>
                <FormControl>
                  <Input type="date" {...field} data-testid="input-start-date" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="endDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>End Date (Optional)</FormLabel>
                <FormControl>
                  <Input type="date" {...field} value={field.value || ''} data-testid="input-end-date" />
                </FormControl>
                <FormDescription>Leave empty for ongoing budget</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <FormField
            control={form.control}
            name="provider"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Cloud Provider (Optional)</FormLabel>
                <Select onValueChange={field.onChange} value={field.value || ''}>
                  <FormControl>
                    <SelectTrigger data-testid="select-provider-filter">
                      <SelectValue placeholder="All providers" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="">All Providers</SelectItem>
                    <SelectItem value="azure">Azure</SelectItem>
                    <SelectItem value="aws">AWS</SelectItem>
                    <SelectItem value="gcp">GCP</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="accountId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Account ID (Optional)</FormLabel>
                <FormControl>
                  <Input placeholder="All accounts" {...field} value={field.value || ''} data-testid="input-account-id" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="serviceName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Service Name (Optional)</FormLabel>
                <FormControl>
                  <Input placeholder="All services" {...field} value={field.value || ''} data-testid="input-service-name" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="space-y-3">
          <FormLabel>Alert Thresholds</FormLabel>
          <div className="grid gap-3 sm:grid-cols-2">
            {(['50', '75', '90', '100'] as const).map((threshold) => (
              <FormField
                key={threshold}
                control={form.control}
                name={`alertThresholds.${threshold}`}
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between gap-2 space-y-0 rounded-md border p-3">
                    <FormLabel className="font-normal">Alert at {threshold}%</FormLabel>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        data-testid={`switch-threshold-${threshold}`}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            ))}
          </div>
        </div>

        <FormField
          control={form.control}
          name="isActive"
          render={({ field }) => (
            <FormItem className="flex items-center justify-between gap-2 rounded-md border p-4">
              <div>
                <FormLabel>Active Budget</FormLabel>
                <FormDescription>Budget is actively monitored</FormDescription>
              </div>
              <FormControl>
                <Switch
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  data-testid="switch-is-active"
                />
              </FormControl>
            </FormItem>
          )}
        />

        <div className="flex justify-end gap-3">
          <Button type="button" variant="outline" onClick={onClose} data-testid="button-cancel">
            Cancel
          </Button>
          <Button type="submit" disabled={createMutation.isPending} data-testid="button-submit">
            {createMutation.isPending ? "Saving..." : budget ? "Update Budget" : "Create Budget"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
