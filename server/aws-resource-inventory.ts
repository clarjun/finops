import { 
  EC2Client, 
  DescribeInstancesCommand, 
  DescribeVolumesCommand,
  DescribeSnapshotsCommand,
  DescribeAddressesCommand
} from "@aws-sdk/client-ec2";
import { 
  LambdaClient, 
  ListFunctionsCommand, 
  GetFunctionCommand 
} from "@aws-sdk/client-lambda";
import { 
  RDSClient, 
  DescribeDBInstancesCommand,
  DescribeDBClustersCommand
} from "@aws-sdk/client-rds";
import { 
  S3Client, 
  ListBucketsCommand,
  GetBucketLocationCommand
} from "@aws-sdk/client-s3";
// CloudWatch metrics intentionally NOT imported - see note below about why metrics
// should be fetched separately via background jobs instead of in the hot path
import { 
  CloudWatchLogsClient, 
  DescribeLogGroupsCommand 
} from "@aws-sdk/client-cloudwatch-logs";

// AWS region from environment
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

// Check if AWS is configured
export function isAWSResourceInventoryConfigured(): boolean {
  return !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
}

// AWS SDK retry configuration to prevent throttling in large accounts
const awsRetryConfig = {
  maxAttempts: 5,
  retryMode: 'adaptive' as const,
};

// Initialize AWS clients with retry configuration
const ec2Client = new EC2Client({ 
  region: AWS_REGION,
  ...awsRetryConfig 
});
const lambdaClient = new LambdaClient({ 
  region: AWS_REGION,
  ...awsRetryConfig 
});
const rdsClient = new RDSClient({ 
  region: AWS_REGION,
  ...awsRetryConfig 
});
const s3Client = new S3Client({ 
  region: AWS_REGION,
  ...awsRetryConfig 
});
const cloudwatchLogsClient = new CloudWatchLogsClient({ 
  region: AWS_REGION,
  ...awsRetryConfig 
});

export interface EC2Instance {
  instanceId: string;
  instanceType: string;
  state: string;
  launchTime?: Date;
  platform?: string;
  vCpus?: number;
  memory?: number;
  tags?: Record<string, string>;
}

export interface LambdaFunction {
  functionName: string;
  functionArn: string;
  runtime?: string;
  memorySize: number;
  timeout: number;
  lastModified?: string;
  codeSize?: number;
}

export interface RDSInstance {
  instanceId: string;
  instanceClass: string;
  engine: string;
  engineVersion?: string;
  status: string;
  allocatedStorage?: number;
  multiAZ?: boolean;
  storageType?: string;
  iops?: number;
}

export interface S3Bucket {
  name: string;
  creationDate?: Date;
  region?: string;
  estimatedSize?: number;
  objectCount?: number;
}

export interface EBSVolume {
  volumeId: string;
  volumeType: string;
  size: number;
  state: string;
  iops?: number;
  throughput?: number;
  attachedTo?: string;
  createTime?: Date;
}

export interface CloudWatchLogGroup {
  logGroupName: string;
  retentionInDays?: number;
  storedBytes?: number;
  creationTime?: number;
}

export interface AWSResourceInventory {
  ec2Instances: EC2Instance[];
  lambdaFunctions: LambdaFunction[];
  rdsInstances: RDSInstance[];
  s3Buckets: S3Bucket[];
  ebsVolumes: EBSVolume[];
  cloudwatchLogGroups: CloudWatchLogGroup[];
  ebsSnapshots: any[];
  elasticIPs: any[];
}

/**
 * Fetch EC2 instances with pagination
 */
export async function fetchEC2Instances(): Promise<EC2Instance[]> {
  try {
    const instances: EC2Instance[] = [];
    let nextToken: string | undefined;
    
    do {
      const command = new DescribeInstancesCommand({
        NextToken: nextToken,
      });
      const response = await ec2Client.send(command);
      
      for (const reservation of response.Reservations || []) {
        for (const instance of reservation.Instances || []) {
          const tags: Record<string, string> = {};
          instance.Tags?.forEach(tag => {
            if (tag.Key && tag.Value) {
              tags[tag.Key] = tag.Value;
            }
          });

          instances.push({
            instanceId: instance.InstanceId || '',
            instanceType: instance.InstanceType || '',
            state: instance.State?.Name || 'unknown',
            launchTime: instance.LaunchTime,
            platform: instance.Platform,
            tags,
          });
        }
      }
      
      nextToken = response.NextToken;
    } while (nextToken);
    
    console.log(`[AWS Inventory] Fetched ${instances.length} EC2 instances`);
    return instances;
  } catch (error) {
    console.error('[AWS Inventory] Error fetching EC2 instances:', error);
    throw new Error(`Failed to fetch EC2 instances: ${error}`);
  }
}

/**
 * Fetch Lambda functions with pagination
 */
export async function fetchLambdaFunctions(): Promise<LambdaFunction[]> {
  try {
    const functions: LambdaFunction[] = [];
    let nextMarker: string | undefined;
    
    do {
      const command = new ListFunctionsCommand({
        Marker: nextMarker,
      });
      const response = await lambdaClient.send(command);
      
      for (const fn of response.Functions || []) {
        functions.push({
          functionName: fn.FunctionName || '',
          functionArn: fn.FunctionArn || '',
          runtime: fn.Runtime,
          memorySize: fn.MemorySize || 128,
          timeout: fn.Timeout || 3,
          lastModified: fn.LastModified,
          codeSize: fn.CodeSize,
        });
      }
      
      nextMarker = response.NextMarker;
    } while (nextMarker);
    
    console.log(`[AWS Inventory] Fetched ${functions.length} Lambda functions`);
    return functions;
  } catch (error) {
    console.error('[AWS Inventory] Error fetching Lambda functions:', error);
    throw new Error(`Failed to fetch Lambda functions: ${error}`);
  }
}

/**
 * Fetch RDS instances with pagination
 */
export async function fetchRDSInstances(): Promise<RDSInstance[]> {
  try {
    const instances: RDSInstance[] = [];
    let nextMarker: string | undefined;
    
    do {
      const command = new DescribeDBInstancesCommand({
        Marker: nextMarker,
      });
      const response = await rdsClient.send(command);
      
      for (const db of response.DBInstances || []) {
        instances.push({
          instanceId: db.DBInstanceIdentifier || '',
          instanceClass: db.DBInstanceClass || '',
          engine: db.Engine || '',
          engineVersion: db.EngineVersion,
          status: db.DBInstanceStatus || 'unknown',
          allocatedStorage: db.AllocatedStorage,
          multiAZ: db.MultiAZ,
          storageType: db.StorageType,
          iops: db.Iops,
        });
      }
      
      nextMarker = response.Marker;
    } while (nextMarker);
    
    console.log(`[AWS Inventory] Fetched ${instances.length} RDS instances`);
    return instances;
  } catch (error) {
    console.error('[AWS Inventory] Error fetching RDS instances:', error);
    throw new Error(`Failed to fetch RDS instances: ${error}`);
  }
}

/**
 * Fetch S3 buckets (no pagination needed - ListBuckets returns all)
 */
export async function fetchS3Buckets(): Promise<S3Bucket[]> {
  try {
    const command = new ListBucketsCommand({});
    const response = await s3Client.send(command);
    
    const buckets: S3Bucket[] = (response.Buckets || []).map(bucket => ({
      name: bucket.Name || '',
      creationDate: bucket.CreationDate,
    }));
    
    console.log(`[AWS Inventory] Fetched ${buckets.length} S3 buckets`);
    return buckets;
  } catch (error) {
    console.error('[AWS Inventory] Error fetching S3 buckets:', error);
    throw new Error(`Failed to fetch S3 buckets: ${error}`);
  }
}

/**
 * Fetch EBS volumes with pagination
 */
export async function fetchEBSVolumes(): Promise<EBSVolume[]> {
  try {
    const volumes: EBSVolume[] = [];
    let nextToken: string | undefined;
    
    do {
      const command = new DescribeVolumesCommand({
        NextToken: nextToken,
      });
      const response = await ec2Client.send(command);
      
      for (const vol of response.Volumes || []) {
        volumes.push({
          volumeId: vol.VolumeId || '',
          volumeType: vol.VolumeType || '',
          size: vol.Size || 0,
          state: vol.State || 'unknown',
          iops: vol.Iops,
          throughput: vol.Throughput,
          attachedTo: vol.Attachments?.[0]?.InstanceId,
          createTime: vol.CreateTime,
        });
      }
      
      nextToken = response.NextToken;
    } while (nextToken);
    
    console.log(`[AWS Inventory] Fetched ${volumes.length} EBS volumes`);
    return volumes;
  } catch (error) {
    console.error('[AWS Inventory] Error fetching EBS volumes:', error);
    throw new Error(`Failed to fetch EBS volumes: ${error}`);
  }
}

/**
 * Fetch CloudWatch Log Groups with pagination
 */
export async function fetchCloudWatchLogGroups(): Promise<CloudWatchLogGroup[]> {
  try {
    const logGroups: CloudWatchLogGroup[] = [];
    let nextToken: string | undefined;
    
    do {
      const command = new DescribeLogGroupsCommand({
        nextToken,
      });
      const response = await cloudwatchLogsClient.send(command);
      
      for (const lg of response.logGroups || []) {
        logGroups.push({
          logGroupName: lg.logGroupName || '',
          retentionInDays: lg.retentionInDays,
          storedBytes: lg.storedBytes,
          creationTime: lg.creationTime,
        });
      }
      
      nextToken = response.nextToken;
    } while (nextToken);
    
    console.log(`[AWS Inventory] Fetched ${logGroups.length} CloudWatch log groups`);
    return logGroups;
  } catch (error) {
    console.error('[AWS Inventory] Error fetching CloudWatch log groups:', error);
    throw new Error(`Failed to fetch CloudWatch log groups: ${error}`);
  }
}

/**
 * Fetch EBS Snapshots with pagination
 */
export async function fetchEBSSnapshots(): Promise<any[]> {
  try {
    const snapshots: any[] = [];
    let nextToken: string | undefined;
    
    do {
      const command = new DescribeSnapshotsCommand({
        OwnerIds: ['self'],
        NextToken: nextToken,
      });
      const response = await ec2Client.send(command);
      
      snapshots.push(...(response.Snapshots || []));
      nextToken = response.NextToken;
    } while (nextToken);
    
    console.log(`[AWS Inventory] Fetched ${snapshots.length} EBS snapshots`);
    return snapshots;
  } catch (error) {
    console.error('[AWS Inventory] Error fetching EBS snapshots:', error);
    throw new Error(`Failed to fetch EBS snapshots: ${error}`);
  }
}

/**
 * Fetch Elastic IPs (no pagination needed - DescribeAddresses returns all)
 */
export async function fetchElasticIPs(): Promise<any[]> {
  try {
    const command = new DescribeAddressesCommand({});
    const response = await ec2Client.send(command);
    
    console.log(`[AWS Inventory] Fetched ${response.Addresses?.length || 0} Elastic IPs`);
    return response.Addresses || [];
  } catch (error) {
    console.error('[AWS Inventory] Error fetching Elastic IPs:', error);
    throw new Error(`Failed to fetch Elastic IPs: ${error}`);
  }
}

/**
 * NOTE: CloudWatch metrics are intentionally NOT fetched during inventory collection
 * to avoid expensive API calls, throttling, and latency issues.
 * 
 * Metrics should be fetched:
 * 1. On-demand for specific resources when needed
 * 2. Via background jobs with proper rate limiting
 * 3. From CloudWatch Logs Insights or cost data analysis instead
 * 
 * The AI planner can make recommendations based on resource configurations
 * (instance types, memory allocations, etc.) without real-time utilization data.
 */

export interface InventoryFetchError {
  resourceType: string;
  error: string;
}

export interface AWSResourceInventoryWithErrors extends AWSResourceInventory {
  errors?: InventoryFetchError[];
  hasErrors?: boolean;
}

/**
 * Fetch complete AWS resource inventory with proper error handling
 */
export async function fetchAWSResourceInventory(): Promise<AWSResourceInventoryWithErrors> {
  console.log('[AWS Inventory] Fetching AWS resource inventory...');
  
  if (!isAWSResourceInventoryConfigured()) {
    console.log('[AWS Inventory] AWS credentials not configured - returning empty inventory');
    return {
      ec2Instances: [],
      lambdaFunctions: [],
      rdsInstances: [],
      s3Buckets: [],
      ebsVolumes: [],
      cloudwatchLogGroups: [],
      ebsSnapshots: [],
      elasticIPs: [],
      errors: [{ resourceType: 'all', error: 'AWS credentials not configured' }],
      hasErrors: true,
    };
  }

  const errors: InventoryFetchError[] = [];
  
  // Fetch all resources with individual error handling
  const [
    ec2Result,
    lambdaResult,
    rdsResult,
    s3Result,
    ebsResult,
    logsResult,
    snapshotsResult,
    eipsResult,
  ] = await Promise.allSettled([
    fetchEC2Instances(),
    fetchLambdaFunctions(),
    fetchRDSInstances(),
    fetchS3Buckets(),
    fetchEBSVolumes(),
    fetchCloudWatchLogGroups(),
    fetchEBSSnapshots(),
    fetchElasticIPs(),
  ]);

  // Extract results or capture errors
  const ec2Instances = ec2Result.status === 'fulfilled' ? ec2Result.value : [];
  if (ec2Result.status === 'rejected') {
    errors.push({ resourceType: 'EC2', error: ec2Result.reason.message });
  }

  const lambdaFunctions = lambdaResult.status === 'fulfilled' ? lambdaResult.value : [];
  if (lambdaResult.status === 'rejected') {
    errors.push({ resourceType: 'Lambda', error: lambdaResult.reason.message });
  }

  const rdsInstances = rdsResult.status === 'fulfilled' ? rdsResult.value : [];
  if (rdsResult.status === 'rejected') {
    errors.push({ resourceType: 'RDS', error: rdsResult.reason.message });
  }

  const s3Buckets = s3Result.status === 'fulfilled' ? s3Result.value : [];
  if (s3Result.status === 'rejected') {
    errors.push({ resourceType: 'S3', error: s3Result.reason.message });
  }

  const ebsVolumes = ebsResult.status === 'fulfilled' ? ebsResult.value : [];
  if (ebsResult.status === 'rejected') {
    errors.push({ resourceType: 'EBS Volumes', error: ebsResult.reason.message });
  }

  const cloudwatchLogGroups = logsResult.status === 'fulfilled' ? logsResult.value : [];
  if (logsResult.status === 'rejected') {
    errors.push({ resourceType: 'CloudWatch Logs', error: logsResult.reason.message });
  }

  const ebsSnapshots = snapshotsResult.status === 'fulfilled' ? snapshotsResult.value : [];
  if (snapshotsResult.status === 'rejected') {
    errors.push({ resourceType: 'EBS Snapshots', error: snapshotsResult.reason.message });
  }

  const elasticIPs = eipsResult.status === 'fulfilled' ? eipsResult.value : [];
  if (eipsResult.status === 'rejected') {
    errors.push({ resourceType: 'Elastic IPs', error: eipsResult.reason.message });
  }

  const hasErrors = errors.length > 0;
  
  if (hasErrors) {
    console.warn('[AWS Inventory] Completed with errors:', errors);
  } else {
    console.log('[AWS Inventory] Resource inventory complete successfully:', {
      ec2: ec2Instances.length,
      lambda: lambdaFunctions.length,
      rds: rdsInstances.length,
      s3: s3Buckets.length,
      ebs: ebsVolumes.length,
      logs: cloudwatchLogGroups.length,
      snapshots: ebsSnapshots.length,
      eips: elasticIPs.length,
    });
  }

  return {
    ec2Instances,
    lambdaFunctions,
    rdsInstances,
    s3Buckets,
    ebsVolumes,
    cloudwatchLogGroups,
    ebsSnapshots,
    elasticIPs,
    errors,
    hasErrors,
  };
}

// Cache for resource inventory (refresh every 5 minutes)
let cachedInventory: AWSResourceInventoryWithErrors | null = null;
let lastFetchTime: number = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get AWS resource inventory (cached)
 */
export async function getAWSResourceInventory(forceRefresh: boolean = false): Promise<AWSResourceInventoryWithErrors> {
  const now = Date.now();
  
  if (!forceRefresh && cachedInventory && (now - lastFetchTime) < CACHE_TTL) {
    console.log('[AWS Inventory] Returning cached inventory');
    return cachedInventory;
  }
  
  cachedInventory = await fetchAWSResourceInventory();
  lastFetchTime = now;
  
  return cachedInventory;
}
