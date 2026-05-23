/**
 * Azure Resource Fetcher
 * Fetches actual Azure resources for AI analysis
 */

import { ComputeManagementClient } from "@azure/arm-compute";
import { StorageManagementClient } from "@azure/arm-storage";
import { ClientSecretCredential } from "@azure/identity";
import { getProviderCredentials } from "../cloud-config-manager";
import type { QueryIntent } from './query-analyzer';

export interface AzureDisk {
  id: string;
  name: string;
  diskSizeGB: number;
  diskState: string;
  managedBy?: string; // VM it's attached to
  location: string;
  tags?: Record<string, string>;
}

export interface AzureVM {
  id: string;
  name: string;
  vmSize: string;
  powerState: string;
  location: string;
  osType?: string;
  tags?: Record<string, string>;
}

export interface AzureStorageAccount {
  id: string;
  name: string;
  location: string;
  kind: string;
  sku: string;
  tags?: Record<string, string>;
}

interface AzureClients {
  computeClient: ComputeManagementClient;
  storageClient: StorageManagementClient;
  subscriptionId: string;
}

/**
 * Get Azure SDK clients using credentials from database
 */
async function getAzureClients(): Promise<AzureClients | null> {
  try {
    const accountConfig = await getProviderCredentials('azure');
    
    if (!accountConfig) {
      console.log('[Azure Resources] No Azure credentials configured');
      return null;
    }

    const credentials = accountConfig.credentials;
    
    // Create credential object
    const credential = new ClientSecretCredential(
      credentials.tenantId,
      credentials.clientId,
      credentials.clientSecret
    );

    // Create management clients
    const computeClient = new ComputeManagementClient(credential, credentials.subscriptionId);
    const storageClient = new StorageManagementClient(credential, credentials.subscriptionId);

    return {
      computeClient,
      storageClient,
      subscriptionId: credentials.subscriptionId
    };
  } catch (error) {
    console.error('[Azure Resources] Error creating Azure clients:', error);
    return null;
  }
}

/**
 * Fetch all Azure managed disks
 */
export async function fetchAzureDisks(): Promise<AzureDisk[]> {
  try {
    const clients = await getAzureClients();
    if (!clients) {
      console.log('[Azure Resources] No Azure credentials configured');
      return [];
    }

    console.log('[Azure Resources] Fetching managed disks...');
    const disks: AzureDisk[] = [];
    
    for await (const disk of clients.computeClient.disks.list()) {
      disks.push({
        id: disk.id || '',
        name: disk.name || '',
        diskSizeGB: disk.diskSizeGB || 0,
        diskState: disk.diskState || 'unknown',
        managedBy: disk.managedBy,
        location: disk.location || '',
        tags: disk.tags,
      });
    }

    console.log(`[Azure Resources] Found ${disks.length} managed disks`);
    return disks;
  } catch (error) {
    console.error('[Azure Resources] Error fetching disks:', error);
    return [];
  }
}

/**
 * Fetch orphaned (unattached) Azure disks
 */
export async function fetchOrphanedDisks(): Promise<AzureDisk[]> {
  const allDisks = await fetchAzureDisks();
  const orphaned = allDisks.filter(disk => !disk.managedBy);
  console.log(`[Azure Resources] Found ${orphaned.length} orphaned disks`);
  return orphaned;
}

/**
 * Fetch all Azure VMs
 */
export async function fetchAzureVMs(): Promise<AzureVM[]> {
  try {
    const clients = await getAzureClients();
    if (!clients) return [];

    console.log('[Azure Resources] Fetching virtual machines...');
    const vms: AzureVM[] = [];
    
    for await (const vm of clients.computeClient.virtualMachines.listAll()) {
      // Get instance view for power state
      let powerState = 'unknown';
      try {
        if (vm.id) {
          const parts = vm.id.split('/');
          const resourceGroup = parts[4];
          const vmName = parts[8];
          const instanceView = await clients.computeClient.virtualMachines.instanceView(
            resourceGroup,
            vmName
          );
          const status = instanceView.statuses?.find((s: any) => s.code?.startsWith('PowerState/'));
          if (status?.code) {
            powerState = status.code.replace('PowerState/', '');
          }
        }
      } catch (error) {
        // Continue without power state
      }

      vms.push({
        id: vm.id || '',
        name: vm.name || '',
        vmSize: vm.hardwareProfile?.vmSize || '',
        powerState,
        location: vm.location || '',
        osType: vm.storageProfile?.osDisk?.osType,
        tags: vm.tags,
      });
    }

    console.log(`[Azure Resources] Found ${vms.length} virtual machines`);
    return vms;
  } catch (error) {
    console.error('[Azure Resources] Error fetching VMs:', error);
    return [];
  }
}

/**
 * Fetch Azure storage accounts
 */
export async function fetchAzureStorageAccounts(): Promise<AzureStorageAccount[]> {
  try {
    const clients = await getAzureClients();
    if (!clients) return [];

    console.log('[Azure Resources] Fetching storage accounts...');
    const accounts: AzureStorageAccount[] = [];
    
    for await (const account of clients.storageClient.storageAccounts.list()) {
      accounts.push({
        id: account.id || '',
        name: account.name || '',
        location: account.location || '',
        kind: account.kind || '',
        sku: account.sku?.name || '',
        tags: account.tags,
      });
    }

    console.log(`[Azure Resources] Found ${accounts.length} storage accounts`);
    return accounts;
  } catch (error) {
    console.error('[Azure Resources] Error fetching storage accounts:', error);
    return [];
  }
}

/**
 * Fetch all Azure resources based on query intent
 */
export async function fetchAzureResources(intent: QueryIntent): Promise<any> {
  console.log('[Azure Resources] Fetching resources for intent:', intent);
  const resources: any = {};
  const resourceTypes = intent.resourceTypes;

  if (resourceTypes.includes('storage') || resourceTypes.includes('general')) {
    console.log('[Azure Resources] Fetching storage resources...');
    resources.disks = await fetchAzureDisks();
    resources.orphanedDisks = resources.disks.filter((d: AzureDisk) => !d.managedBy);
    console.log(`[Azure Resources] Found ${resources.disks.length} disks, ${resources.orphanedDisks.length} orphaned`);
    resources.storageAccounts = await fetchAzureStorageAccounts();
  }

  if (resourceTypes.includes('compute') || resourceTypes.includes('general')) {
    console.log('[Azure Resources] Fetching compute resources...');
    resources.vms = await fetchAzureVMs();
    resources.stoppedVMs = resources.vms.filter((vm: AzureVM) => 
      vm.powerState === 'deallocated' || vm.powerState === 'stopped'
    );
    console.log(`[Azure Resources] Found ${resources.vms.length} VMs, ${resources.stoppedVMs.length} stopped`);
  }

  console.log('[Azure Resources] Final resources:', JSON.stringify(resources, null, 2));
  return resources;
}
