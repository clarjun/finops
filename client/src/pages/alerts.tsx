import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus, Trash2, Edit, Bell, BellOff, Mail, Webhook } from "lucide-react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { insertAlertRuleSchema, type AlertRule } from "@shared/schema";

const alertFormSchema = insertAlertRuleSchema.extend({
  emailRecipients: z.string().min(1, "At least one email is required"),
});

type AlertFormValues = z.infer<typeof alertFormSchema>;

export default function AlertsPage() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<AlertRule | null>(null);
  const { toast } = useToast();

  // Fetch alert rules
  const { data: rulesData, isLoading: rulesLoading } = useQuery({
    queryKey: ['/api/alerts/rules'],
  });

  const alertRules = (rulesData as { success: boolean; rules: AlertRule[] })?.rules || [];

  // Check budget alerts mutation
  const checkAlertsMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/budgets/check-alerts', {
        method: 'POST',
      });
      if (!response.ok) throw new Error('Failed to check budget alerts');
      return await response.json();
    },
    onSuccess: (data: any) => {
      toast({
        title: "✅ Alert Check Complete",
        description: data.message || `Checked ${data.checked} budgets, sent ${data.alerted} alerts`,
      });
    },
    onError: () => {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to check budget alerts",
      });
    },
  });

  // Create/Update alert rule mutation
  const saveMutation = useMutation({
    mutationFn: async (values: AlertFormValues) => {
      const url = editingRule ? `/api/alerts/rules/${editingRule.id}` : '/api/alerts/rules';
      const method = editingRule ? 'PATCH' : 'POST';
      
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      if (!response.ok) throw new Error('Failed to save alert rule');
      return await response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/alerts/rules'] });
      setDialogOpen(false);
      setEditingRule(null);
      form.reset();
      toast({
        title: editingRule ? "Alert rule updated" : "Alert rule created",
        description: editingRule ? "The alert rule has been updated successfully" : "New alert rule has been created",
      });
    },
    onError: () => {
      toast({
        variant: "destructive",
        title: "Error",
        description: editingRule ? "Failed to update alert rule" : "Failed to create alert rule",
      });
    },
  });

  // Delete alert rule mutation
  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const response = await fetch(`/api/alerts/rules/${id}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error('Failed to delete alert rule');
      return await response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/alerts/rules'] });
      toast({
        title: "Alert rule deleted",
        description: "The alert rule has been removed",
      });
    },
    onError: () => {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to delete alert rule",
      });
    },
  });

  const form = useForm<AlertFormValues>({
    resolver: zodResolver(alertFormSchema),
    defaultValues: {
      ruleName: "",
      provider: undefined,
      accountId: undefined,
      serviceName: undefined,
      thresholdAmount: "0",
      thresholdType: "monthly",
      comparisonOperator: "gt",
      emailRecipients: "",
      webhookUrl: undefined,
      isEnabled: true,
    },
  });

  const handleEdit = (rule: AlertRule) => {
    setEditingRule(rule);
    form.reset({
      ruleName: rule.ruleName,
      provider: rule.provider || undefined,
      accountId: rule.accountId || undefined,
      serviceName: rule.serviceName || undefined,
      thresholdAmount: rule.thresholdAmount,
      thresholdType: rule.thresholdType,
      comparisonOperator: rule.comparisonOperator,
      emailRecipients: rule.emailRecipients,
      webhookUrl: rule.webhookUrl || undefined,
      isEnabled: rule.isEnabled,
    });
    setDialogOpen(true);
  };

  const handleDelete = (id: number) => {
    if (confirm('Are you sure you want to delete this alert rule?')) {
      deleteMutation.mutate(id);
    }
  };

  const onSubmit = (values: AlertFormValues) => {
    saveMutation.mutate(values);
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold" data-testid="heading-alerts">Budget Alerts & Notifications</h1>
          <p className="text-muted-foreground mt-1">
            Configure alert rules and monitor budget notifications
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => checkAlertsMutation.mutate()}
            disabled={checkAlertsMutation.isPending}
            data-testid="button-check-alerts"
          >
            <Bell className="h-4 w-4 mr-2" />
            {checkAlertsMutation.isPending ? "Checking..." : "Check Alerts Now"}
          </Button>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button 
                onClick={() => {
                  setEditingRule(null);
                  form.reset();
                }}
                data-testid="button-create-alert"
              >
                <Plus className="h-4 w-4 mr-2" />
                New Alert Rule
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>{editingRule ? "Edit Alert Rule" : "Create Alert Rule"}</DialogTitle>
                <DialogDescription>
                  Set up automatic notifications when spending thresholds are exceeded
                </DialogDescription>
              </DialogHeader>
              
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                  <FormField
                    control={form.control}
                    name="ruleName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Rule Name</FormLabel>
                        <FormControl>
                          <Input placeholder="e.g., AWS Production Alert" {...field} data-testid="input-rule-name" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="provider"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Provider (optional)</FormLabel>
                          <Select onValueChange={(value) => field.onChange(value === "all" ? undefined : value)} value={field.value || "all"}>
                            <FormControl>
                              <SelectTrigger data-testid="select-provider">
                                <SelectValue placeholder="All providers" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="all">All providers</SelectItem>
                              <SelectItem value="aws">AWS</SelectItem>
                              <SelectItem value="gcp">GCP</SelectItem>
                              <SelectItem value="azure">Azure</SelectItem>
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
                          <FormLabel>Account ID (optional)</FormLabel>
                          <FormControl>
                            <Input placeholder="Leave empty for all accounts" {...field} value={field.value || ""} data-testid="input-account-id" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  <FormField
                    control={form.control}
                    name="serviceName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Service Name (optional)</FormLabel>
                        <FormControl>
                          <Input placeholder="e.g., Amazon EC2, Compute Engine" {...field} value={field.value || ""} data-testid="input-service-name" />
                        </FormControl>
                        <FormDescription>Leave empty to monitor all services</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="thresholdAmount"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Threshold Amount ($)</FormLabel>
                          <FormControl>
                            <Input type="number" step="0.01" placeholder="1000.00" {...field} data-testid="input-threshold-amount" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="thresholdType"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Period</FormLabel>
                          <Select onValueChange={field.onChange} value={field.value}>
                            <FormControl>
                              <SelectTrigger data-testid="select-threshold-type">
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="daily">Daily</SelectItem>
                              <SelectItem value="weekly">Weekly</SelectItem>
                              <SelectItem value="monthly">Monthly</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  <FormField
                    control={form.control}
                    name="emailRecipients"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Email Recipients</FormLabel>
                        <FormControl>
                          <Input placeholder="email@example.com, another@example.com" {...field} data-testid="input-email-recipients" />
                        </FormControl>
                        <FormDescription>Comma-separated email addresses</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="webhookUrl"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Webhook URL (optional)</FormLabel>
                        <FormControl>
                          <Input placeholder="https://hooks.slack.com/services/..." {...field} value={field.value || ""} data-testid="input-webhook-url" />
                        </FormControl>
                        <FormDescription>For Slack, Teams, or custom webhook integrations</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="isEnabled"
                    render={({ field }) => (
                      <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                        <div className="space-y-0.5">
                          <FormLabel className="text-base">Enable Alert</FormLabel>
                          <FormDescription>
                            Receive notifications when this rule is triggered
                          </FormDescription>
                        </div>
                        <FormControl>
                          <Switch
                            checked={field.value}
                            onCheckedChange={field.onChange}
                            data-testid="switch-is-enabled"
                          />
                        </FormControl>
                      </FormItem>
                    )}
                  />

                  <div className="flex justify-end gap-2 pt-4">
                    <Button type="button" variant="outline" onClick={() => setDialogOpen(false)} data-testid="button-cancel">
                      Cancel
                    </Button>
                    <Button type="submit" disabled={saveMutation.isPending} data-testid="button-save-alert">
                      {saveMutation.isPending ? "Saving..." : editingRule ? "Update Rule" : "Create Rule"}
                    </Button>
                  </div>
                </form>
              </Form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Alert Rules List */}
      <div className="grid gap-4">
        {rulesLoading ? (
          <Card>
            <CardContent className="p-6">
              <p className="text-center text-muted-foreground">Loading alert rules...</p>
            </CardContent>
          </Card>
        ) : alertRules.length === 0 ? (
          <Card>
            <CardContent className="p-6">
              <p className="text-center text-muted-foreground">No alert rules configured yet</p>
              <p className="text-center text-sm text-muted-foreground mt-2">
                Create your first alert rule to start monitoring your budgets
              </p>
            </CardContent>
          </Card>
        ) : (
          alertRules.map((rule: AlertRule) => (
            <Card key={rule.id} data-testid={`card-alert-rule-${rule.id}`}>
              <CardHeader className="pb-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <CardTitle className="text-xl">{rule.ruleName}</CardTitle>
                      {rule.isEnabled ? (
                        <Badge variant="default" className="gap-1" data-testid={`badge-enabled-${rule.id}`}>
                          <Bell className="h-3 w-3" />
                          Active
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="gap-1" data-testid={`badge-disabled-${rule.id}`}>
                          <BellOff className="h-3 w-3" />
                          Disabled
                        </Badge>
                      )}
                    </div>
                    <CardDescription className="mt-1">
                      Alerts when {rule.thresholdType} spending exceeds ${parseFloat(rule.thresholdAmount).toFixed(2)}
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => handleEdit(rule)} data-testid={`button-edit-${rule.id}`}>
                      <Edit className="h-3 w-3" />
                    </Button>
                    <Button 
                      variant="outline" 
                      size="sm" 
                      onClick={() => handleDelete(rule.id)}
                      disabled={deleteMutation.isPending}
                      data-testid={`button-delete-${rule.id}`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid gap-2 text-sm">
                  {rule.provider && (
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground w-24">Provider:</span>
                      <Badge variant="outline" data-testid={`badge-provider-${rule.id}`}>{rule.provider.toUpperCase()}</Badge>
                    </div>
                  )}
                  {rule.accountId && (
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground w-24">Account:</span>
                      <code className="text-xs bg-muted px-2 py-1 rounded">{rule.accountId}</code>
                    </div>
                  )}
                  {rule.serviceName && (
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground w-24">Service:</span>
                      <span>{rule.serviceName}</span>
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-3 pt-2 border-t text-sm">
                  {rule.emailRecipients && (
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <Mail className="h-3 w-3" />
                      <span>{rule.emailRecipients.split(',').length} recipient(s)</span>
                    </div>
                  )}
                  {rule.webhookUrl && (
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <Webhook className="h-3 w-3" />
                      <span>Webhook configured</span>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
