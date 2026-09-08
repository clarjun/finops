import { ClientSecretCredential } from "@azure/identity";
import { ComputeManagementClient } from "@azure/arm-compute";
import { SqlManagementClient } from "@azure/arm-sql";
import { StorageManagementClient } from "@azure/arm-storage";
import { ResourceManagementClient } from "@azure/arm-resources";
import { getProviderCredentials } from "./cloud-config-manager";

/**
 * Azure Resource Inventory Module
 * 
 * Fetches real Azure infrastructure data for the AI Agent Planner.
 * Supports Virtual Machines, SQL Databases, Storage Accounts, and Resource Groups.
 * 
 * Features:
 * - Full pagination support for all Azure services
 * - Robust error handling with Promise.allSettled pattern
 * - Per-service error tracking and warning propagation
 * - 5-minute cache TTL to minimize API calls
 * - Supports multiple subscriptions
 */

/**
 * Credentials come from the database, per call — the same source every other
 * cloud client in this codebase uses.
 *
 * They used to be read from process.env into module-level consts, which was
 * wrong three times over:
 *
 *   1. The names did not match. This file wanted AZURE_SUBSCRIPTION_ID; .env
 *      defines AZURE_SUB_ID, so isAzureResourceInventoryConfigured() was
 *      permanently false and the agent planner silently fell back to
 *      "recommendations based on cost data only" for Azure alone.
 *
 *   2. A second copy of the credentials that could drift. The .env secret was
 *      the rotated-away one while the database held the working value, so even
 *      with the names aligned this path would have failed to authenticate.
 *
 *   3. Consts captured at module evaluation. optimization-generator.ts worked
 *      around (1) by injecting process.env before a dynamic import, but ESM
 *      caches a module after its first evaluation — so the first Azure account
 *      to trigger inventory baked its credentials in and every later account
 *      reused them. With one tenant that is invisible; with two it is one
 *      customer's credentials being used against another's subscription.
 *
 * Resolving per call fixes all three, and is why the env-injection dance in
 * optimization-generator.ts is no longer needed.
 */
interface ResolvedAzureAccount {
  credential: ClientSecretCredential;
  subscriptionId: string;
  accountName: string;
}

export interface AzureVirtualMachine {
  id: string;
  name: string;
  location: string;
  vmSize: string;
  provisioningState?: string;
  resourceGroup: string;
  tags?: Record<string, string>;
  osType?: string;
}

export interface AzureSQLDatabase {
  id: string;
  name: string;
  serverName: string;
  location: string;
  sku?: {
    name: string;
    tier?: string;
    capacity?: number;
  };
  resourceGroup: string;
  tags?: Record<string, string>;
}

export interface AzureStorageAccount {
  id: string;
  name: string;
  location: string;
  sku?: {
    name: string;
    tier?: string;
  };
  kind?: string;
  resourceGroup: string;
  tags?: Record<string, string>;
}

export interface AzureResourceGroup {
  id: string;
  name: string;
  location: string;
  tags?: Record<string, string>;
}

export interface AzureResourceInventory {
  virtualMachines: AzureVirtualMachine[];
  sqlDatabases: AzureSQLDatabase[];
  storageAccounts: AzureStorageAccount[];
  resourceGroups: AzureResourceGroup[];
  fetchedAt: string;
  hasErrors: boolean;
  errors: InventoryFetchError[];
}

export interface InventoryFetchError {
  service: string;
  error: string;
}

/**
 * Cached inventory, keyed by subscription.
 *
 * It was a single module-level variable, which was safe only while credentials
 * were also global. Now that each caller resolves its own tenant's account, one
 * shared slot would hand the first tenant's virtual machines to the second for
 * five minutes. The key makes the cache per subscription, so a hit can only
 * ever be the caller's own data.
 */
const inventoryCache = new Map<string, { data: AzureResourceInventory; at: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Resolves the calling tenant's Azure account into an SDK credential.
 *
 * Returns null rather than throwing when nothing is configured: an absent Azure
 * account is a normal state for a tenant that only uses AWS, not an error.
 */
async function resolveAzureAccount(): Promise<ResolvedAzureAccount | null> {
  const account = await getProviderCredentials('azure');
  if (!account) return null;

  const { tenantId, clientId, clientSecret, subscriptionId } = account.credentials as Record<string, string>;
  // accountId is the fallback because that is where the Configuration page puts
  // the subscription for an Azure account.
  const subscription = subscriptionId || account.accountId;

  if (!tenantId || !clientId || !clientSecret || !subscription) return null;

  return {
    credential: new ClientSecretCredential(tenantId, clientId, clientSecret),
    subscriptionId: subscription,
    accountName: account.accountName,
  };
}

/**
 * Whether this tenant has an Azure account the inventory can use.
 *
 * Async now, because the answer lives in the database rather than in a module
 * constant. Callers that treated it as a cheap synchronous check must await it;
 * the alternative was caching the answer, which is what caused the stale
 * credential problem this function used to have.
 */
export async function isAzureResourceInventoryConfigured(): Promise<boolean> {
  try {
    return (await resolveAzureAccount()) !== null;
  } catch {
    // currentOrgId() throws outside a request or runAsSystem() block. Not
    // configured is the honest answer there, and a safe one.
    return false;
  }
}

/**
 * Fetch all Virtual Machines with pagination
 */
async function fetchVirtualMachines(
  credential: ClientSecretCredential,
  subscriptionId: string
): Promise<AzureVirtualMachine[]> {
  const client = new ComputeManagementClient(credential, subscriptionId);
  const vms: AzureVirtualMachine[] = [];

  // List all VMs across all resource groups
  for await (const vm of client.virtualMachines.listAll()) {
    // Extract resource group from VM ID
    const resourceGroup = vm.id?.split('/')[4] || 'unknown';
    
    vms.push({
      id: vm.id || '',
      name: vm.name || '',
      location: vm.location || '',
      vmSize: vm.hardwareProfile?.vmSize || '',
      provisioningState: vm.provisioningState,
      resourceGroup,
      tags: vm.tags,
      osType: vm.storageProfile?.osDisk?.osType,
    });
  }

  return vms;
}

/**
 * Fetch all SQL Databases with pagination
 */
async function fetchSQLDatabases(
  credential: ClientSecretCredential,
  subscriptionId: string
): Promise<AzureSQLDatabase[]> {
  const client = new SqlManagementClient(credential, subscriptionId);
  const databases: AzureSQLDatabase[] = [];

  // First, list all SQL servers
  const servers: Array<{ name: string; resourceGroup: string }> = [];
  for await (const server of client.servers.list()) {
    const resourceGroup = server.id?.split('/')[4] || '';
    if (server.name && resourceGroup) {
      servers.push({ name: server.name, resourceGroup });
    }
  }

  // Then, list databases for each server
  for (const server of servers) {
    try {
      for await (const db of client.databases.listByServer(
        server.resourceGroup,
        server.name
      )) {
        // Skip system database 'master'
        if (db.name === 'master') continue;

        databases.push({
          id: db.id || '',
          name: db.name || '',
          serverName: server.name,
          location: db.location || '',
          sku: db.sku ? {
            name: db.sku.name || '',
            tier: db.sku.tier,
            capacity: db.sku.capacity,
          } : undefined,
          resourceGroup: server.resourceGroup,
          tags: db.tags,
        });
      }
    } catch (error) {
      console.warn(`Failed to fetch databases for server ${server.name}:`, error);
    }
  }

  return databases;
}

/**
 * Fetch all Storage Accounts with pagination
 */
async function fetchStorageAccounts(
  credential: ClientSecretCredential,
  subscriptionId: string
): Promise<AzureStorageAccount[]> {
  const client = new StorageManagementClient(credential, subscriptionId);
  const accounts: AzureStorageAccount[] = [];

  // List all storage accounts
  for await (const account of client.storageAccounts.list()) {
    const resourceGroup = account.id?.split('/')[4] || 'unknown';
    
    accounts.push({
      id: account.id || '',
      name: account.name || '',
      location: account.location || '',
      sku: account.sku ? {
        name: account.sku.name || '',
        tier: account.sku.tier,
      } : undefined,
      kind: account.kind,
      resourceGroup,
      tags: account.tags,
    });
  }

  return accounts;
}

/**
 * Fetch all Resource Groups
 */
async function fetchResourceGroups(
  credential: ClientSecretCredential,
  subscriptionId: string
): Promise<AzureResourceGroup[]> {
  const client = new ResourceManagementClient(credential, subscriptionId);
  const resourceGroups: AzureResourceGroup[] = [];

  for await (const rg of client.resourceGroups.list()) {
    resourceGroups.push({
      id: rg.id || '',
      name: rg.name || '',
      location: rg.location || '',
      tags: rg.tags,
    });
  }

  return resourceGroups;
}

/**
 * Fetch complete Azure resource inventory
 * Uses Promise.allSettled to handle partial failures gracefully
 */
export async function fetchAzureResourceInventory(): Promise<AzureResourceInventory> {
  // Resolved before the cache is consulted, because the cache key is the
  // subscription — without knowing which account is calling there is no safe
  // way to decide whether a cached entry belongs to this caller.
  const account = await resolveAzureAccount().catch(() => null);

  if (!account) {
    return {
      virtualMachines: [],
      sqlDatabases: [],
      storageAccounts: [],
      resourceGroups: [],
      fetchedAt: new Date().toISOString(),
      hasErrors: true,
      errors: [
        {
          service: 'Azure',
          error:
            'No Azure account is connected for this organization, or the stored ' +
            'credentials are incomplete. Add or update it on the Configuration page.',
        },
      ],
    };
  }

  const { credential, subscriptionId } = account;

  const now = Date.now();
  const cached = inventoryCache.get(subscriptionId);
  if (cached && (now - cached.at) < CACHE_TTL_MS) {
    console.log(`[Azure] Using cached resource inventory for ${account.accountName}`);
    return cached.data;
  }

  console.log(`[Azure] Fetching resource inventory for ${account.accountName} (${subscriptionId})...`);

  // Fetch all resources in parallel using Promise.allSettled
  const results = await Promise.allSettled([
    fetchVirtualMachines(credential, subscriptionId),
    fetchSQLDatabases(credential, subscriptionId),
    fetchStorageAccounts(credential, subscriptionId),
    fetchResourceGroups(credential, subscriptionId),
  ]);

  const errors: InventoryFetchError[] = [];
  const inventory: AzureResourceInventory = {
    virtualMachines: [],
    sqlDatabases: [],
    storageAccounts: [],
    resourceGroups: [],
    fetchedAt: new Date().toISOString(),
    hasErrors: false,
    errors: [],
  };

  // Process Virtual Machines
  if (results[0].status === 'fulfilled') {
    inventory.virtualMachines = results[0].value;
  } else {
    errors.push({
      service: 'Virtual Machines',
      error: results[0].reason?.message || 'Unknown error',
    });
  }

  // Process SQL Databases
  if (results[1].status === 'fulfilled') {
    inventory.sqlDatabases = results[1].value;
  } else {
    errors.push({
      service: 'SQL Databases',
      error: results[1].reason?.message || 'Unknown error',
    });
  }

  // Process Storage Accounts
  if (results[2].status === 'fulfilled') {
    inventory.storageAccounts = results[2].value;
  } else {
    errors.push({
      service: 'Storage Accounts',
      error: results[2].reason?.message || 'Unknown error',
    });
  }

  // Process Resource Groups
  if (results[3].status === 'fulfilled') {
    inventory.resourceGroups = results[3].value;
  } else {
    errors.push({
      service: 'Resource Groups',
      error: results[3].reason?.message || 'Unknown error',
    });
  }

  inventory.hasErrors = errors.length > 0;
  inventory.errors = errors;

  // Log results
  console.log('Azure inventory fetched:', {
    virtualMachines: inventory.virtualMachines.length,
    sqlDatabases: inventory.sqlDatabases.length,
    storageAccounts: inventory.storageAccounts.length,
    resourceGroups: inventory.resourceGroups.length,
    errors: errors.length,
  });

  if (errors.length > 0) {
    console.warn('Azure inventory fetch had errors:', errors);
  }

  // Cached against the subscription it was fetched for, never globally.
  inventoryCache.set(subscriptionId, { data: inventory, at: Date.now() });

  return inventory;
}
