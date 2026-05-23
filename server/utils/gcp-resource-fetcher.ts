/**
 * GCP Resource Fetcher
 * Fetches actual GCP resources for AI analysis
 */

import { InstancesClient, DisksClient } from "@google-cloud/compute";
import { Storage } from "@google-cloud/storage";
import { getProviderCredentials } from "../cloud-config-manager";
import type { QueryIntent } from './query-analyzer';

export interface GCPDisk {
  id: string;
  name: string;
  sizeGb: number;
  status: string;
  users: string[]; // VMs using this disk
  zone: string;
  type: string;
}

export interface GCPInstance {
  id: string;
  name: string;
  machineType: string;
  status: string;
  zone: string;
  creationTimestamp: string;
}

export interface GCPBucket {
  name: string;
  location: string;
  storageClass: string;
  timeCreated: Date;
}

interface GCPClients {
  instancesClient: InstancesClient;
  disksClient: DisksClient;
  storage: Storage;
  projectId: string;
}

/**
 * Get GCP SDK clients using credentials from database
 */
async function getGCPClients(): Promise<GCPClients | null> {
  try {
    const accountConfig = await getProviderCredentials('gcp');
    
    if (!accountConfig) {
      console.log('[GCP Resources] No GCP credentials configured');
      return null;
    }

    const credentials = accountConfig.credentials;
    
    // Parse service account key if it's a string
    let serviceAccountKey;
    if (typeof credentials.serviceAccountKey === 'string') {
      try {
        serviceAccountKey = JSON.parse(credentials.serviceAccountKey);
      } catch (error) {
        console.error('[GCP Resources] Failed to parse service account key:', error);
        return null;
      }
    } else {
      serviceAccountKey = credentials.serviceAccountKey || credentials;
    }

    const projectId = credentials.projectId || serviceAccountKey.project_id;

    // Create GCP clients
    const instancesClient = new InstancesClient({
      credentials: serviceAccountKey,
      projectId,
    });

    const disksClient = new DisksClient({
      credentials: serviceAccountKey,
      projectId,
    });

    const storage = new Storage({
      projectId,
      credentials: serviceAccountKey,
    });

    return { instancesClient, disksClient, storage, projectId };
  } catch (error) {
    console.error('[GCP Resources] Error creating GCP clients:', error);
    return null;
  }
}

/**
 * Fetch all GCP persistent disks
 */
export async function fetchGCPDisks(): Promise<GCPDisk[]> {
  try {
    const clients = await getGCPClients();
    if (!clients) {
      console.log('[GCP Resources] No GCP credentials configured');
      return [];
    }

    console.log('[GCP Resources] Fetching persistent disks...');
    const disks: GCPDisk[] = [];
    
    // List disks across all zones using aggregatedList
    const aggListRequest = clients.disksClient.aggregatedListAsync({
      project: clients.projectId,
    });

    for await (const [zone, disksObject] of aggListRequest) {
      if (!disksObject.disks) continue;

      for (const disk of disksObject.disks) {
        disks.push({
          id: disk.id?.toString() || '',
          name: disk.name || '',
          sizeGb: parseInt(String(disk.sizeGb || '0')),
          status: disk.status || 'unknown',
          users: disk.users || [],
          zone: zone.replace('zones/', ''),
          type: disk.type?.split('/').pop() || '',
        });
      }
    }

    console.log(`[GCP Resources] Found ${disks.length} persistent disks`);
    return disks;
  } catch (error) {
    console.error('[GCP Resources] Error fetching disks:', error);
    return [];
  }
}

/**
 * Fetch orphaned (unattached) GCP disks
 */
export async function fetchOrphanedDisks(): Promise<GCPDisk[]> {
  const allDisks = await fetchGCPDisks();
  const orphaned = allDisks.filter(disk => 
    disk.status === 'READY' && disk.users.length === 0
  );
  console.log(`[GCP Resources] Found ${orphaned.length} orphaned disks`);
  return orphaned;
}

/**
 * Fetch all GCP compute instances
 */
export async function fetchGCPInstances(): Promise<GCPInstance[]> {
  try {
    const clients = await getGCPClients();
    if (!clients) return [];

    console.log('[GCP Resources] Fetching compute instances...');
    const instances: GCPInstance[] = [];
    
    // List instances across all zones using aggregatedList
    const aggListRequest = clients.instancesClient.aggregatedListAsync({
      project: clients.projectId,
    });

    for await (const [zone, instancesObject] of aggListRequest) {
      if (!instancesObject.instances) continue;

      for (const instance of instancesObject.instances) {
        instances.push({
          id: instance.id?.toString() || '',
          name: instance.name || '',
          machineType: instance.machineType?.split('/').pop() || '',
          status: instance.status || 'unknown',
          zone: zone.replace('zones/', ''),
          creationTimestamp: instance.creationTimestamp || '',
        });
      }
    }

    console.log(`[GCP Resources] Found ${instances.length} compute instances`);
    return instances;
  } catch (error) {
    console.error('[GCP Resources] Error fetching instances:', error);
    return [];
  }
}

/**
 * Fetch GCP storage buckets
 */
export async function fetchGCPBuckets(): Promise<GCPBucket[]> {
  try {
    const clients = await getGCPClients();
    if (!clients) return [];

    console.log('[GCP Resources] Fetching storage buckets...');
    const [buckets] = await clients.storage.getBuckets();
    const gcpBuckets: GCPBucket[] = buckets.map(bucket => ({
      name: bucket.name,
      location: bucket.metadata.location || '',
      storageClass: bucket.metadata.storageClass || '',
      timeCreated: new Date(bucket.metadata.timeCreated || Date.now()),
    }));

    console.log(`[GCP Resources] Found ${gcpBuckets.length} storage buckets`);
    return gcpBuckets;
  } catch (error) {
    console.error('[GCP Resources] Error fetching buckets:', error);
    return [];
  }
}

/**
 * Fetch all GCP resources based on query intent
 */
export async function fetchGCPResources(intent: QueryIntent): Promise<any> {
  const resources: any = {};
  const resourceTypes = intent.resourceTypes;

  if (resourceTypes.includes('storage') || resourceTypes.includes('general')) {
    resources.disks = await fetchGCPDisks();
    resources.orphanedDisks = resources.disks.filter((d: GCPDisk) => 
      d.status === 'READY' && d.users.length === 0
    );
    resources.buckets = await fetchGCPBuckets();
  }

  if (resourceTypes.includes('compute') || resourceTypes.includes('general')) {
    resources.instances = await fetchGCPInstances();
    resources.stoppedInstances = resources.instances.filter((i: GCPInstance) => 
      i.status === 'TERMINATED' || i.status === 'STOPPED'
    );
  }

  return resources;
}
