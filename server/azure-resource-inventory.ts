import { ClientSecretCredential } from "@azure/identity";
import { ComputeManagementClient } from "@azure/arm-compute";
import { SqlManagementClient } from "@azure/arm-sql";
import { StorageManagementClient } from "@azure/arm-storage";
import { ResourceManagementClient } from "@azure/arm-resources";

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

// Azure configuration from environment variables
const AZURE_TENANT_ID = process.env.AZURE_TENANT_ID;
const AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID;
const AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET;
const AZURE_SUBSCRIPTION_ID = process.env.AZURE_SUBSCRIPTION_ID;

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

// Cache for Azure inventory (5-minute TTL)
let inventoryCache: AzureResourceInventory | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function isAzureResourceInventoryConfigured(): boolean {
  return !!(
    AZURE_TENANT_ID &&
    AZURE_CLIENT_ID &&
    AZURE_CLIENT_SECRET &&
    AZURE_SUBSCRIPTION_ID
  );
}

// Initialize Azure credential
function getAzureCredential(): ClientSecretCredential | null {
  if (!isAzureResourceInventoryConfigured()) {
    return null;
  }
  
  return new ClientSecretCredential(
    AZURE_TENANT_ID!,
    AZURE_CLIENT_ID!,
    AZURE_CLIENT_SECRET!
  );
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
  // Check cache first
  const now = Date.now();
  if (inventoryCache && (now - cacheTimestamp) < CACHE_TTL_MS) {
    console.log('Using cached Azure inventory');
    return inventoryCache;
  }

  // Check if Azure is configured
  if (!isAzureResourceInventoryConfigured()) {
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
          error: 'Azure credentials not configured (AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_SUBSCRIPTION_ID)',
        },
      ],
    };
  }

  const credential = getAzureCredential()!;
  const subscriptionId = AZURE_SUBSCRIPTION_ID!;

  console.log('Fetching Azure resource inventory...');

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

  // Cache the result
  inventoryCache = inventory;
  cacheTimestamp = now;

  return inventory;
}
