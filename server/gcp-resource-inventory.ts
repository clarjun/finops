import { InstancesClient } from "@google-cloud/compute";
import { CloudFunctionsServiceClient } from "@google-cloud/functions";
import { Storage } from "@google-cloud/storage";

/**
 * GCP Resource Inventory Module
 * 
 * Fetches real GCP infrastructure data for the AI Agent Planner.
 * Supports Compute Engine instances, Cloud Functions, and Cloud Storage buckets.
 * 
 * Features:
 * - Full pagination support for all GCP services
 * - Robust error handling with Promise.allSettled pattern
 * - Per-service error tracking and warning propagation
 * - 5-minute cache TTL to minimize API calls
 * - Service account authentication
 */

// GCP configuration from environment variables
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;
const GCP_SERVICE_ACCOUNT_KEY = process.env.GCP_SERVICE_ACCOUNT_KEY;

export interface GCPComputeInstance {
  id: string;
  name: string;
  zone: string;
  machineType: string;
  status?: string;
  labels?: Record<string, string>;
  creationTimestamp?: string;
}

export interface GCPCloudFunction {
  name: string;
  runtime?: string;
  availableMemoryMb?: number;
  entryPoint?: string;
  status?: string;
  labels?: Record<string, string>;
  region: string;
}

export interface GCPStorageBucket {
  name: string;
  location: string;
  storageClass?: string;
  labels?: Record<string, string>;
  timeCreated?: Date;
}

export interface GCPResourceInventory {
  computeInstances: GCPComputeInstance[];
  cloudFunctions: GCPCloudFunction[];
  storageBuckets: GCPStorageBucket[];
  fetchedAt: string;
  hasErrors: boolean;
  errors: InventoryFetchError[];
}

export interface InventoryFetchError {
  service: string;
  error: string;
}

// Cache for GCP inventory (5-minute TTL)
let inventoryCache: GCPResourceInventory | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function isGCPResourceInventoryConfigured(): boolean {
  return !!(GCP_PROJECT_ID && GCP_SERVICE_ACCOUNT_KEY);
}

// Get GCP credentials
function getGCPCredentials() {
  if (!GCP_SERVICE_ACCOUNT_KEY) {
    return undefined;
  }

  try {
    return JSON.parse(GCP_SERVICE_ACCOUNT_KEY);
  } catch (error) {
    console.error('Failed to parse GCP service account key:', error);
    return undefined;
  }
}

/**
 * Fetch all Compute Engine instances with pagination
 */
async function fetchComputeInstances(projectId: string): Promise<GCPComputeInstance[]> {
  const credentials = getGCPCredentials();
  const instancesClient = new InstancesClient({
    credentials,
    projectId,
  });

  const instances: GCPComputeInstance[] = [];

  try {
    // List instances across all zones
    const aggListRequest = instancesClient.aggregatedListAsync({
      project: projectId,
    });

    for await (const [zone, instancesObject] of aggListRequest) {
      if (!instancesObject.instances) continue;

      for (const instance of instancesObject.instances) {
        // Extract machine type from full URL
        const machineType = instance.machineType?.split('/').pop() || '';
        
        instances.push({
          id: instance.id?.toString() || '',
          name: instance.name || '',
          zone: zone.replace('zones/', ''),
          machineType,
          status: instance.status || undefined,
          labels: instance.labels || undefined,
          creationTimestamp: instance.creationTimestamp || undefined,
        });
      }
    }
  } catch (error) {
    console.error('Error fetching GCP compute instances:', error);
    throw error;
  }

  return instances;
}

/**
 * Fetch all Cloud Functions with pagination
 */
async function fetchCloudFunctions(projectId: string): Promise<GCPCloudFunction[]> {
  const credentials = getGCPCredentials();
  const functionsClient = new CloudFunctionsServiceClient({
    credentials,
  });

  const functions: GCPCloudFunction[] = [];

  try {
    // List all functions across all regions
    // Note: Cloud Functions v1 API requires listing by location
    const locations = ['us-central1', 'us-east1', 'us-west1', 'europe-west1', 'asia-east1'];

    for (const location of locations) {
      try {
        const parent = `projects/${projectId}/locations/${location}`;
        const [functionsList] = await functionsClient.listFunctions({
          parent,
        });

        for (const func of functionsList) {
          functions.push({
            name: func.name || '',
            runtime: func.runtime || undefined,
            availableMemoryMb: func.availableMemoryMb || undefined,
            entryPoint: func.entryPoint || undefined,
            status: func.status ? String(func.status) : undefined,
            labels: func.labels || undefined,
            region: location,
          });
        }
      } catch (error: any) {
        // Skip regions where functions are not enabled or no functions exist
        if (error.code !== 5) { // 5 = NOT_FOUND
          console.warn(`Error fetching functions in ${location}:`, error.message);
        }
      }
    }
  } catch (error) {
    console.error('Error fetching GCP cloud functions:', error);
    throw error;
  }

  return functions;
}

/**
 * Fetch all Cloud Storage buckets
 */
async function fetchStorageBuckets(projectId: string): Promise<GCPStorageBucket[]> {
  const credentials = getGCPCredentials();
  const storage = new Storage({
    credentials,
    projectId,
  });

  const buckets: GCPStorageBucket[] = [];

  try {
    const [bucketsList] = await storage.getBuckets();

    for (const bucket of bucketsList) {
      const labels: Record<string, string> = {};
      if (bucket.metadata.labels) {
        for (const [key, value] of Object.entries(bucket.metadata.labels)) {
          if (value !== null) {
            labels[key] = value;
          }
        }
      }

      buckets.push({
        name: bucket.name,
        location: bucket.metadata.location || '',
        storageClass: bucket.metadata.storageClass || undefined,
        labels: Object.keys(labels).length > 0 ? labels : undefined,
        timeCreated: bucket.metadata.timeCreated ? new Date(bucket.metadata.timeCreated) : undefined,
      });
    }
  } catch (error) {
    console.error('Error fetching GCP storage buckets:', error);
    throw error;
  }

  return buckets;
}

/**
 * Fetch complete GCP resource inventory
 * Uses Promise.allSettled to handle partial failures gracefully
 */
export async function fetchGCPResourceInventory(): Promise<GCPResourceInventory> {
  // Check cache first
  const now = Date.now();
  if (inventoryCache && (now - cacheTimestamp) < CACHE_TTL_MS) {
    console.log('Using cached GCP inventory');
    return inventoryCache;
  }

  // Check if GCP is configured
  if (!isGCPResourceInventoryConfigured()) {
    return {
      computeInstances: [],
      cloudFunctions: [],
      storageBuckets: [],
      fetchedAt: new Date().toISOString(),
      hasErrors: true,
      errors: [
        {
          service: 'GCP',
          error: 'GCP credentials not configured (GCP_PROJECT_ID, GCP_SERVICE_ACCOUNT_KEY)',
        },
      ],
    };
  }

  const projectId = GCP_PROJECT_ID!;

  console.log('Fetching GCP resource inventory...');

  // Fetch all resources in parallel using Promise.allSettled
  const results = await Promise.allSettled([
    fetchComputeInstances(projectId),
    fetchCloudFunctions(projectId),
    fetchStorageBuckets(projectId),
  ]);

  const errors: InventoryFetchError[] = [];
  const inventory: GCPResourceInventory = {
    computeInstances: [],
    cloudFunctions: [],
    storageBuckets: [],
    fetchedAt: new Date().toISOString(),
    hasErrors: false,
    errors: [],
  };

  // Process Compute Instances
  if (results[0].status === 'fulfilled') {
    inventory.computeInstances = results[0].value;
  } else {
    errors.push({
      service: 'Compute Instances',
      error: results[0].reason?.message || 'Unknown error',
    });
  }

  // Process Cloud Functions
  if (results[1].status === 'fulfilled') {
    inventory.cloudFunctions = results[1].value;
  } else {
    errors.push({
      service: 'Cloud Functions',
      error: results[1].reason?.message || 'Unknown error',
    });
  }

  // Process Storage Buckets
  if (results[2].status === 'fulfilled') {
    inventory.storageBuckets = results[2].value;
  } else {
    errors.push({
      service: 'Storage Buckets',
      error: results[2].reason?.message || 'Unknown error',
    });
  }

  inventory.hasErrors = errors.length > 0;
  inventory.errors = errors;

  // Log results
  console.log('GCP inventory fetched:', {
    computeInstances: inventory.computeInstances.length,
    cloudFunctions: inventory.cloudFunctions.length,
    storageBuckets: inventory.storageBuckets.length,
    errors: errors.length,
  });

  if (errors.length > 0) {
    console.warn('GCP inventory fetch had errors:', errors);
  }

  // Cache the result
  inventoryCache = inventory;
  cacheTimestamp = now;

  return inventory;
}
