import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Cloud, Plus, Trash2, CheckCircle, XCircle, Loader2, Eye, EyeOff } from "lucide-react";
import type { CloudProvider } from "@shared/schema";

interface CloudAccount {
  id: number;
  provider: CloudProvider;
  accountName: string;
  accountId: string;
  isActive: boolean;
  lastSyncAt: string | null;
  createdAt: string;
  credentials?: any; // Only populated when fetching single account for editing
}

interface CloudAccountForm {
  provider: CloudProvider;
  accountName: string;
  accountId: string;
  credentials: any;
  isActive: boolean;
}

export default function Configuration() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedProvider, setSelectedProvider] = useState<CloudProvider>("aws");
  const [showForm, setShowForm] = useState(false);
  const [editingAccount, setEditingAccount] = useState<CloudAccount | null>(null);
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});

  // Fetch all cloud accounts
  const { data: accounts, isLoading } = useQuery<{ accounts: CloudAccount[] }>({
    queryKey: ["/api/cloud-accounts"],
  });
  
  // Debug logging
  console.log('[Configuration] Accounts data:', accounts);
  console.log('[Configuration] Is loading:', isLoading);
  console.log('[Configuration] AWS accounts:', accounts?.accounts.filter(a => a.provider === 'aws'));

  // Create cloud account mutation
  const createAccount = useMutation({
    mutationFn: async (data: CloudAccountForm) => {
      const url = editingAccount 
        ? `/api/cloud-accounts/${editingAccount.id}`
        : "/api/cloud-accounts";
      const method = editingAccount ? "PATCH" : "POST";
      
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        credentials: "include",
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || `Failed to ${editingAccount ? 'update' : 'create'} account`);
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/cloud-accounts"] });
      toast({
        title: "Success",
        description: editingAccount 
          ? "Cloud account updated successfully"
          : "Cloud account connected successfully",
      });
      setShowForm(false);
      setEditingAccount(null);
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Delete cloud account mutation
  const deleteAccount = useMutation({
    mutationFn: async (id: number) => {
      const response = await fetch(`/api/cloud-accounts/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to delete account");
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/cloud-accounts"] });
      toast({
        title: "Success",
        description: "Cloud account removed successfully",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to remove cloud account",
        variant: "destructive",
      });
    },
  });

  // Toggle account active status
  const toggleAccount = useMutation({
    mutationFn: async ({ id, isActive }: { id: number; isActive: boolean }) => {
      const response = await fetch(`/api/cloud-accounts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to update account");
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/cloud-accounts"] });
    },
  });

  const getAccountsByProvider = (provider: CloudProvider) => {
    return accounts?.accounts.filter((acc) => acc.provider === provider) || [];
  };

  const toggleSecretVisibility = (key: string) => {
    setShowSecrets((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleEdit = async (account: CloudAccount) => {
    try {
      // Fetch full account details including credentials
      const response = await fetch(`/api/cloud-accounts/${account.id}`, {
        credentials: 'include',
      });
      
      if (!response.ok) {
        throw new Error('Failed to fetch account details');
      }
      
      const data = await response.json();
      
      if (data.success && data.account) {
        setEditingAccount(data.account);
        setSelectedProvider(data.account.provider);
        setShowForm(true);
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to load account details for editing",
        variant: "destructive",
      });
    }
  };

  const handleCancelEdit = () => {
    setEditingAccount(null);
    setShowForm(false);
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Cloud Configuration</h1>
          <p className="text-muted-foreground mt-1">
            Connect and manage your cloud provider accounts
          </p>
        </div>
        <Button onClick={() => setShowForm(!showForm)}>
          <Plus className="h-4 w-4 mr-2" />
          Add Cloud Account
        </Button>
      </div>

      {showForm && (
        <Card>
          <CardHeader>
            <CardTitle>{editingAccount ? 'Edit Cloud Account' : 'Add New Cloud Account'}</CardTitle>
            <CardDescription>
              {editingAccount 
                ? 'Update your cloud provider account credentials'
                : 'Connect a new cloud provider account to start tracking costs'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CloudAccountFormComponent
              provider={selectedProvider}
              onProviderChange={setSelectedProvider}
              onSubmit={(data) => createAccount.mutate(data)}
              onCancel={handleCancelEdit}
              isSubmitting={createAccount.isPending}
              showSecrets={showSecrets}
              toggleSecretVisibility={toggleSecretVisibility}
              editingAccount={editingAccount}
            />
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="aws" className="space-y-4">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="aws">
            <Cloud className="h-4 w-4 mr-2" />
            AWS
          </TabsTrigger>
          <TabsTrigger value="gcp">
            <Cloud className="h-4 w-4 mr-2" />
            GCP
          </TabsTrigger>
          <TabsTrigger value="azure">
            <Cloud className="h-4 w-4 mr-2" />
            Azure
          </TabsTrigger>
        </TabsList>

        <TabsContent value="aws" className="space-y-4">
          <CloudAccountsList
            provider="aws"
            accounts={getAccountsByProvider("aws")}
            onToggle={(id, isActive) => toggleAccount.mutate({ id, isActive })}
            onDelete={(id) => deleteAccount.mutate(id)}
            onEdit={handleEdit}
            isLoading={isLoading}
          />
        </TabsContent>

        <TabsContent value="gcp" className="space-y-4">
          <CloudAccountsList
            provider="gcp"
            accounts={getAccountsByProvider("gcp")}
            onToggle={(id, isActive) => toggleAccount.mutate({ id, isActive })}
            onDelete={(id) => deleteAccount.mutate(id)}
            onEdit={handleEdit}
            isLoading={isLoading}
          />
        </TabsContent>

        <TabsContent value="azure" className="space-y-4">
          <CloudAccountsList
            provider="azure"
            accounts={getAccountsByProvider("azure")}
            onToggle={(id, isActive) => toggleAccount.mutate({ id, isActive })}
            onDelete={(id) => deleteAccount.mutate(id)}
            onEdit={handleEdit}
            isLoading={isLoading}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// Cloud Accounts List Component
function CloudAccountsList({
  provider,
  accounts,
  onToggle,
  onDelete,
  onEdit,
  isLoading,
}: {
  provider: CloudProvider;
  accounts: CloudAccount[];
  onToggle: (id: number, isActive: boolean) => void;
  onDelete: (id: number) => void;
  onEdit: (account: CloudAccount) => void;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center p-8 text-center">
          <Cloud className="h-12 w-12 text-muted-foreground mb-4" />
          <h3 className="text-lg font-semibold mb-2">No {provider.toUpperCase()} accounts connected</h3>
          <p className="text-sm text-muted-foreground">
            Add your first {provider.toUpperCase()} account to start tracking costs
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4">
      {accounts.map((account) => (
        <Card key={account.id}>
          <CardContent className="flex items-center justify-between p-6">
            <div className="flex items-center space-x-4">
              <div className="flex items-center justify-center w-10 h-10 rounded-full bg-primary/10">
                <Cloud className="h-5 w-5 text-primary" />
              </div>
              <div>
                <h3 className="font-semibold">{account.accountName}</h3>
                <p className="text-sm text-muted-foreground">
                  Account ID: {account.accountId}
                </p>
                {account.lastSyncAt && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Last synced: {new Date(account.lastSyncAt).toLocaleString()}
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center space-x-4">
              <Badge variant={account.isActive ? "default" : "secondary"}>
                {account.isActive ? (
                  <>
                    <CheckCircle className="h-3 w-3 mr-1" />
                    Active
                  </>
                ) : (
                  <>
                    <XCircle className="h-3 w-3 mr-1" />
                    Inactive
                  </>
                )}
              </Badge>
              <Switch
                checked={account.isActive}
                onCheckedChange={(checked) => onToggle(account.id, checked)}
              />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onEdit(account)}
                title="Edit account"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onDelete(account.id)}
                title="Delete account"
              >
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// Cloud Account Form Component
function CloudAccountFormComponent({
  provider,
  onProviderChange,
  onSubmit,
  onCancel,
  isSubmitting,
  showSecrets,
  toggleSecretVisibility,
  editingAccount,
}: {
  provider: CloudProvider;
  onProviderChange: (provider: CloudProvider) => void;
  onSubmit: (data: CloudAccountForm) => void;
  onCancel: () => void;
  isSubmitting: boolean;
  showSecrets: Record<string, boolean>;
  toggleSecretVisibility: (key: string) => void;
  editingAccount?: CloudAccount | null;
}) {
  const [formData, setFormData] = useState<CloudAccountForm>({
    provider: editingAccount?.provider || provider,
    accountName: editingAccount?.accountName || "",
    accountId: editingAccount?.accountId || "",
    credentials: editingAccount?.credentials || {},
    isActive: editingAccount?.isActive ?? true,
  });
  
  // Update form data when editingAccount changes
  useEffect(() => {
    if (editingAccount) {
      setFormData({
        provider: editingAccount.provider,
        accountName: editingAccount.accountName,
        accountId: editingAccount.accountId,
        credentials: editingAccount.credentials || {},
        isActive: editingAccount.isActive,
      });
    }
  }, [editingAccount]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(formData);
  };

  const updateCredential = (key: string, value: string) => {
    setFormData((prev) => ({
      ...prev,
      credentials: { ...prev.credentials, [key]: value },
    }));
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {!editingAccount && (
        <div className="space-y-2">
          <Label>Cloud Provider</Label>
          <Tabs
            value={provider}
            onValueChange={(value) => {
              onProviderChange(value as CloudProvider);
              setFormData((prev) => ({ ...prev, provider: value as CloudProvider, credentials: {} }));
            }}
          >
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="aws">AWS</TabsTrigger>
              <TabsTrigger value="gcp">GCP</TabsTrigger>
              <TabsTrigger value="azure">Azure</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="accountName">Account Name</Label>
        <Input
          id="accountName"
          placeholder="e.g., Production AWS Account"
          value={formData.accountName}
          onChange={(e) => setFormData({ ...formData, accountName: e.target.value })}
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="accountId">Account ID</Label>
        <Input
          id="accountId"
          placeholder={
            provider === "aws"
              ? "AWS Account ID"
              : provider === "gcp"
              ? "GCP Project ID"
              : "Azure Subscription ID"
          }
          value={formData.accountId}
          onChange={(e) => setFormData({ ...formData, accountId: e.target.value })}
          required
        />
      </div>

      {provider === "aws" && (
        <AWSCredentialsForm
          credentials={formData.credentials}
          updateCredential={updateCredential}
          showSecrets={showSecrets}
          toggleSecretVisibility={toggleSecretVisibility}
        />
      )}

      {provider === "gcp" && (
        <GCPCredentialsForm
          credentials={formData.credentials}
          updateCredential={updateCredential}
          showSecrets={showSecrets}
          toggleSecretVisibility={toggleSecretVisibility}
        />
      )}

      {provider === "azure" && (
        <AzureCredentialsForm
          credentials={formData.credentials}
          updateCredential={updateCredential}
          showSecrets={showSecrets}
          toggleSecretVisibility={toggleSecretVisibility}
        />
      )}

      <div className="flex items-center space-x-2">
        <Switch
          id="isActive"
          checked={formData.isActive}
          onCheckedChange={(checked) => setFormData({ ...formData, isActive: checked })}
        />
        <Label htmlFor="isActive">Enable this account immediately</Label>
      </div>

      <div className="flex justify-end space-x-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          {editingAccount ? 'Update Account' : 'Connect Account'}
        </Button>
      </div>
    </form>
  );
}

// AWS Credentials Form
function AWSCredentialsForm({
  credentials,
  updateCredential,
  showSecrets,
  toggleSecretVisibility,
}: {
  credentials: any;
  updateCredential: (key: string, value: string) => void;
  showSecrets: Record<string, boolean>;
  toggleSecretVisibility: (key: string) => void;
}) {
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="accessKeyId">Access Key ID</Label>
        <Input
          id="accessKeyId"
          placeholder="AKIAIOSFODNN7EXAMPLE"
          value={credentials.accessKeyId || ""}
          onChange={(e) => updateCredential("accessKeyId", e.target.value)}
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="secretAccessKey">Secret Access Key</Label>
        <div className="relative">
          <Input
            id="secretAccessKey"
            type={showSecrets["secretAccessKey"] ? "text" : "password"}
            placeholder="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
            value={credentials.secretAccessKey || ""}
            onChange={(e) => updateCredential("secretAccessKey", e.target.value)}
            required
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-0 top-0"
            onClick={() => toggleSecretVisibility("secretAccessKey")}
          >
            {showSecrets["secretAccessKey"] ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="region">Region</Label>
        <Input
          id="region"
          placeholder="us-east-1"
          value={credentials.region || "us-east-1"}
          onChange={(e) => updateCredential("region", e.target.value)}
        />
      </div>
    </>
  );
}

// GCP Credentials Form
function GCPCredentialsForm({
  credentials,
  updateCredential,
  showSecrets,
  toggleSecretVisibility,
}: {
  credentials: any;
  updateCredential: (key: string, value: string) => void;
  showSecrets: Record<string, boolean>;
  toggleSecretVisibility: (key: string) => void;
}) {
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="serviceAccountKey">Service Account Key (JSON)</Label>
        <Textarea
          id="serviceAccountKey"
          placeholder='{"type": "service_account", "project_id": "...", ...}'
          value={credentials.serviceAccountKey || ""}
          onChange={(e) => updateCredential("serviceAccountKey", e.target.value)}
          rows={6}
          className="font-mono text-sm"
          required
        />
        <p className="text-xs text-muted-foreground">
          Paste the entire JSON key file content from your GCP service account
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="billingDataset">Billing Dataset</Label>
        <Input
          id="billingDataset"
          placeholder="finops_billing"
          value={credentials.billingDataset || ""}
          onChange={(e) => updateCredential("billingDataset", e.target.value)}
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="billingTable">Billing Table</Label>
        <Input
          id="billingTable"
          placeholder="gcp_billing_export_resource_v1_xxx"
          value={credentials.billingTable || ""}
          onChange={(e) => updateCredential("billingTable", e.target.value)}
          required
        />
      </div>
    </>
  );
}

// Azure Credentials Form
function AzureCredentialsForm({
  credentials,
  updateCredential,
  showSecrets,
  toggleSecretVisibility,
}: {
  credentials: any;
  updateCredential: (key: string, value: string) => void;
  showSecrets: Record<string, boolean>;
  toggleSecretVisibility: (key: string) => void;
}) {
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="tenantId">Tenant ID</Label>
        <Input
          id="tenantId"
          placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
          value={credentials.tenantId || ""}
          onChange={(e) => updateCredential("tenantId", e.target.value)}
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="clientId">Client ID</Label>
        <Input
          id="clientId"
          placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
          value={credentials.clientId || ""}
          onChange={(e) => updateCredential("clientId", e.target.value)}
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="clientSecret">Client Secret</Label>
        <div className="relative">
          <Input
            id="clientSecret"
            type={showSecrets["clientSecret"] ? "text" : "password"}
            placeholder="Your Azure client secret"
            value={credentials.clientSecret || ""}
            onChange={(e) => updateCredential("clientSecret", e.target.value)}
            required
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-0 top-0"
            onClick={() => toggleSecretVisibility("clientSecret")}
          >
            {showSecrets["clientSecret"] ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="billingAccountId">Billing Account ID (Optional)</Label>
        <Input
          id="billingAccountId"
          placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx_YYYY-MM-DD"
          value={credentials.billingAccountId || ""}
          onChange={(e) => updateCredential("billingAccountId", e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          If provided, uses Billing Account scope (no additional permissions needed). Otherwise uses Subscription scope (requires Cost Management Reader role).
        </p>
      </div>
    </>
  );
}
