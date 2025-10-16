import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { azureConfigSchema, type AzureConfig } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";
import { Loader2, CheckCircle2, XCircle, Settings2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";

export default function Settings() {
  const { toast } = useToast();
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');

  // Get current Azure configuration (non-sensitive data only)
  const { data: azureConfig } = useQuery<{ 
    configured: boolean; 
    subscriptionId?: string; 
    scope?: string; 
    resourceGroupName?: string;
    billingAccountId?: string;
    refreshInterval?: number;
  }>({
    queryKey: ["/api/azure/config"],
  });

  const form = useForm<AzureConfig>({
    resolver: zodResolver(azureConfigSchema),
    defaultValues: {
      tenantId: "",
      clientId: "",
      clientSecret: "",
      subscriptionId: "",
      scope: "subscription",
      refreshInterval: 86400,
    },
  });

  // Configure Azure mutation
  const configureMutation = useMutation({
    mutationFn: async (data: AzureConfig) => {
      return apiRequest<{ success: boolean; message: string }>("POST", "/api/azure/config", data);
    },
    onSuccess: (response) => {
      toast({
        title: "Configuration saved",
        description: response.message,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/azure/config"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cost-data"] });
    },
    onError: (error: any) => {
      toast({
        title: "Configuration failed",
        description: error.message || "Failed to save Azure configuration",
        variant: "destructive",
      });
    },
  });

  // Test connection mutation
  const testMutation = useMutation({
    mutationFn: async (data: AzureConfig) => {
      setTestStatus('testing');
      return apiRequest<{ success: boolean; message: string }>("POST", "/api/azure/test", data);
    },
    onSuccess: (response) => {
      setTestStatus(response.success ? 'success' : 'error');
      toast({
        title: response.success ? "Connection successful" : "Connection failed",
        description: response.message,
        variant: response.success ? "default" : "destructive",
      });
    },
    onError: () => {
      setTestStatus('error');
      toast({
        title: "Test failed",
        description: "Could not connect to Azure",
        variant: "destructive",
      });
    },
  });

  // Manual refresh mutation
  const refreshMutation = useMutation({
    mutationFn: async () => {
      return apiRequest<{ success: boolean; data: any }>("POST", "/api/azure/refresh", {});
    },
    onSuccess: () => {
      toast({
        title: "Data refreshed",
        description: "Successfully fetched latest cost data from Azure",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/cost-data"] });
      queryClient.invalidateQueries({ queryKey: ["/api/anomalies"] });
    },
    onError: (error: any) => {
      toast({
        title: "Refresh failed",
        description: error.message || "Failed to fetch data from Azure",
        variant: "destructive",
      });
    },
  });

  const onSubmit = (data: AzureConfig) => {
    configureMutation.mutate(data);
  };

  const onTestConnection = () => {
    const values = form.getValues();
    testMutation.mutate(values);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground mt-2">
          Configure Azure Cost Management API integration and preferences
        </p>
      </div>

      <div className="grid gap-6">
        {/* Azure Configuration Card */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Settings2 className="h-5 w-5 text-primary" />
              <CardTitle>Azure Cost Management API</CardTitle>
            </div>
            <CardDescription>
              Connect to your Azure subscription to fetch real-time cost data automatically
            </CardDescription>
          </CardHeader>
          <CardContent>
            {azureConfig?.configured && (
              <Alert className="mb-6">
                <CheckCircle2 className="h-4 w-4" />
                <AlertDescription>
                  Azure is configured for subscription: {azureConfig.subscriptionId}
                </AlertDescription>
              </Alert>
            )}

            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="tenantId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Tenant ID</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="00000000-0000-0000-0000-000000000000"
                            {...field}
                            data-testid="input-tenant-id"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="clientId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Client ID (Application ID)</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="00000000-0000-0000-0000-000000000000"
                            {...field}
                            data-testid="input-client-id"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="clientSecret"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Client Secret</FormLabel>
                        <FormControl>
                          <Input
                            type="password"
                            placeholder="Enter client secret"
                            {...field}
                            data-testid="input-client-secret"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="subscriptionId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Subscription ID</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="00000000-0000-0000-0000-000000000000"
                            {...field}
                            data-testid="input-subscription-id"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="scope"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Scope</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value}>
                          <FormControl>
                            <SelectTrigger data-testid="select-scope">
                              <SelectValue placeholder="Select scope" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="subscription">Subscription</SelectItem>
                            <SelectItem value="resourceGroup">Resource Group</SelectItem>
                            <SelectItem value="billingAccount">Billing Account</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="refreshInterval"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Auto-refresh Interval (seconds)</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            min="3600"
                            placeholder="86400"
                            {...field}
                            onChange={(e) => field.onChange(parseInt(e.target.value))}
                            data-testid="input-refresh-interval"
                          />
                        </FormControl>
                        <FormDescription>
                          Minimum: 1 hour (3600s), Default: 24 hours (86400s)
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {form.watch("scope") === "resourceGroup" && (
                  <FormField
                    control={form.control}
                    name="resourceGroupName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Resource Group Name</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="my-resource-group"
                            {...field}
                            data-testid="input-resource-group"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}

                {form.watch("scope") === "billingAccount" && (
                  <FormField
                    control={form.control}
                    name="billingAccountId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Billing Account ID</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="00000000-0000-0000-0000-000000000000"
                            {...field}
                            data-testid="input-billing-account"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}

                <div className="flex gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={onTestConnection}
                    disabled={testMutation.isPending}
                    data-testid="button-test-connection"
                  >
                    {testMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {testStatus === 'success' && <CheckCircle2 className="mr-2 h-4 w-4" />}
                    {testStatus === 'error' && <XCircle className="mr-2 h-4 w-4" />}
                    Test Connection
                  </Button>

                  <Button
                    type="submit"
                    disabled={configureMutation.isPending}
                    data-testid="button-save-config"
                  >
                    {configureMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Save Configuration
                  </Button>
                </div>
              </form>
            </Form>
          </CardContent>
        </Card>

        {/* Manual Refresh Card */}
        {azureConfig?.configured && (
          <Card>
            <CardHeader>
              <CardTitle>Manual Data Refresh</CardTitle>
              <CardDescription>
                Fetch the latest cost data from Azure Cost Management API
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={() => refreshMutation.mutate()}
                disabled={refreshMutation.isPending}
                data-testid="button-manual-refresh"
              >
                {refreshMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Refresh Cost Data
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
