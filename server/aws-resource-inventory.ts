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
import { 
  CloudWatchClient, 
  GetMetricStatisticsCommand 
} from "@aws-sdk/client-cloudwatch";
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

// Initialize AWS clients
const ec2Client = new EC2Client({ region: AWS_REGION });
const lambdaClient = new LambdaClient({ region: AWS_REGION });
const rdsClient = new RDSClient({ region: AWS_REGION });
const s3Client = new S3Client({ region: AWS_REGION });
const cloudwatchClient = new CloudWatchClient({ region: AWS_REGION });
const cloudwatchLogsClient = new CloudWatchLogsClient({ region: AWS_REGION });

export interface EC2Instance {
  instanceId: string;
  instanceType: string;
  state: string;
  launchTime?: Date;
  platform?: string;
  vCpus?: number;
  memory?: number;
  tags?: Record<string, string>;
  utilizationMetrics?: {
    avgCpuUtilization?: number;
    maxCpuUtilization?: number;
    networkIn?: number;
    networkOut?: number;
  };
}

export interface LambdaFunction {
  functionName: string;
  functionArn: string;
  runtime?: string;
  memorySize: number;
  timeout: number;
  lastModified?: string;
  codeSize?: number;
  metrics?: {
    invocations?: number;
    avgDuration?: number;
    errors?: number;
    throttles?: number;
  };
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
  metrics?: {
    avgCpuUtilization?: number;
    connections?: number;
    readLatency?: number;
    writeLatency?: number;
  };
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
 * Fetch EC2 instances with utilization metrics
 */
export async function fetchEC2Instances(): Promise<EC2Instance[]> {
  try {
    const command = new DescribeInstancesCommand({});
    const response = await ec2Client.send(command);
    
    const instances: EC2Instance[] = [];
    
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
    
    console.log(`[AWS Inventory] Fetched ${instances.length} EC2 instances`);
    return instances;
  } catch (error) {
    console.error('[AWS Inventory] Error fetching EC2 instances:', error);
    return [];
  }
}

/**
 * Fetch Lambda functions with metrics
 */
export async function fetchLambdaFunctions(): Promise<LambdaFunction[]> {
  try {
    const command = new ListFunctionsCommand({});
    const response = await lambdaClient.send(command);
    
    const functions: LambdaFunction[] = (response.Functions || []).map(fn => ({
      functionName: fn.FunctionName || '',
      functionArn: fn.FunctionArn || '',
      runtime: fn.Runtime,
      memorySize: fn.MemorySize || 128,
      timeout: fn.Timeout || 3,
      lastModified: fn.LastModified,
      codeSize: fn.CodeSize,
    }));
    
    console.log(`[AWS Inventory] Fetched ${functions.length} Lambda functions`);
    return functions;
  } catch (error) {
    console.error('[AWS Inventory] Error fetching Lambda functions:', error);
    return [];
  }
}

/**
 * Fetch RDS instances with metrics
 */
export async function fetchRDSInstances(): Promise<RDSInstance[]> {
  try {
    const command = new DescribeDBInstancesCommand({});
    const response = await rdsClient.send(command);
    
    const instances: RDSInstance[] = (response.DBInstances || []).map(db => ({
      instanceId: db.DBInstanceIdentifier || '',
      instanceClass: db.DBInstanceClass || '',
      engine: db.Engine || '',
      engineVersion: db.EngineVersion,
      status: db.DBInstanceStatus || 'unknown',
      allocatedStorage: db.AllocatedStorage,
      multiAZ: db.MultiAZ,
      storageType: db.StorageType,
      iops: db.Iops,
    }));
    
    console.log(`[AWS Inventory] Fetched ${instances.length} RDS instances`);
    return instances;
  } catch (error) {
    console.error('[AWS Inventory] Error fetching RDS instances:', error);
    return [];
  }
}

/**
 * Fetch S3 buckets
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
    return [];
  }
}

/**
 * Fetch EBS volumes
 */
export async function fetchEBSVolumes(): Promise<EBSVolume[]> {
  try {
    const command = new DescribeVolumesCommand({});
    const response = await ec2Client.send(command);
    
    const volumes: EBSVolume[] = (response.Volumes || []).map(vol => ({
      volumeId: vol.VolumeId || '',
      volumeType: vol.VolumeType || '',
      size: vol.Size || 0,
      state: vol.State || 'unknown',
      iops: vol.Iops,
      throughput: vol.Throughput,
      attachedTo: vol.Attachments?.[0]?.InstanceId,
      createTime: vol.CreateTime,
    }));
    
    console.log(`[AWS Inventory] Fetched ${volumes.length} EBS volumes`);
    return volumes;
  } catch (error) {
    console.error('[AWS Inventory] Error fetching EBS volumes:', error);
    return [];
  }
}

/**
 * Fetch CloudWatch Log Groups
 */
export async function fetchCloudWatchLogGroups(): Promise<CloudWatchLogGroup[]> {
  try {
    const command = new DescribeLogGroupsCommand({});
    const response = await cloudwatchLogsClient.send(command);
    
    const logGroups: CloudWatchLogGroup[] = (response.logGroups || []).map(lg => ({
      logGroupName: lg.logGroupName || '',
      retentionInDays: lg.retentionInDays,
      storedBytes: lg.storedBytes,
      creationTime: lg.creationTime,
    }));
    
    console.log(`[AWS Inventory] Fetched ${logGroups.length} CloudWatch log groups`);
    return logGroups;
  } catch (error) {
    console.error('[AWS Inventory] Error fetching CloudWatch log groups:', error);
    return [];
  }
}

/**
 * Fetch EBS Snapshots
 */
export async function fetchEBSSnapshots(): Promise<any[]> {
  try {
    const command = new DescribeSnapshotsCommand({
      OwnerIds: ['self'],
    });
    const response = await ec2Client.send(command);
    
    console.log(`[AWS Inventory] Fetched ${response.Snapshots?.length || 0} EBS snapshots`);
    return response.Snapshots || [];
  } catch (error) {
    console.error('[AWS Inventory] Error fetching EBS snapshots:', error);
    return [];
  }
}

/**
 * Fetch Elastic IPs
 */
export async function fetchElasticIPs(): Promise<any[]> {
  try {
    const command = new DescribeAddressesCommand({});
    const response = await ec2Client.send(command);
    
    console.log(`[AWS Inventory] Fetched ${response.Addresses?.length || 0} Elastic IPs`);
    return response.Addresses || [];
  } catch (error) {
    console.error('[AWS Inventory] Error fetching Elastic IPs:', error);
    return [];
  }
}

/**
 * Get CloudWatch metrics for an EC2 instance
 */
export async function getEC2Metrics(instanceId: string, days: number = 7): Promise<any> {
  try {
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - days * 24 * 60 * 60 * 1000);
    
    const cpuCommand = new GetMetricStatisticsCommand({
      Namespace: 'AWS/EC2',
      MetricName: 'CPUUtilization',
      Dimensions: [{ Name: 'InstanceId', Value: instanceId }],
      StartTime: startTime,
      EndTime: endTime,
      Period: 3600, // 1 hour
      Statistics: ['Average', 'Maximum'],
    });
    
    const cpuResponse = await cloudwatchClient.send(cpuCommand);
    
    const datapoints = cpuResponse.Datapoints || [];
    const avgCpu = datapoints.length > 0 
      ? datapoints.reduce((sum, dp) => sum + (dp.Average || 0), 0) / datapoints.length 
      : 0;
    const maxCpu = datapoints.length > 0
      ? Math.max(...datapoints.map(dp => dp.Maximum || 0))
      : 0;
    
    return {
      avgCpuUtilization: avgCpu,
      maxCpuUtilization: maxCpu,
    };
  } catch (error) {
    console.error(`[AWS Inventory] Error fetching metrics for instance ${instanceId}:`, error);
    return {};
  }
}

/**
 * Get CloudWatch metrics for a Lambda function
 */
export async function getLambdaMetrics(functionName: string, days: number = 7): Promise<any> {
  try {
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - days * 24 * 60 * 60 * 1000);
    
    // Get invocations
    const invocationsCommand = new GetMetricStatisticsCommand({
      Namespace: 'AWS/Lambda',
      MetricName: 'Invocations',
      Dimensions: [{ Name: 'FunctionName', Value: functionName }],
      StartTime: startTime,
      EndTime: endTime,
      Period: 86400, // 1 day
      Statistics: ['Sum'],
    });
    
    const invocationsResponse = await cloudwatchClient.send(invocationsCommand);
    const totalInvocations = (invocationsResponse.Datapoints || [])
      .reduce((sum, dp) => sum + (dp.Sum || 0), 0);
    
    // Get duration
    const durationCommand = new GetMetricStatisticsCommand({
      Namespace: 'AWS/Lambda',
      MetricName: 'Duration',
      Dimensions: [{ Name: 'FunctionName', Value: functionName }],
      StartTime: startTime,
      EndTime: endTime,
      Period: 86400,
      Statistics: ['Average'],
    });
    
    const durationResponse = await cloudwatchClient.send(durationCommand);
    const datapoints = durationResponse.Datapoints || [];
    const avgDuration = datapoints.length > 0
      ? datapoints.reduce((sum, dp) => sum + (dp.Average || 0), 0) / datapoints.length
      : 0;
    
    return {
      invocations: totalInvocations,
      avgDuration,
    };
  } catch (error) {
    console.error(`[AWS Inventory] Error fetching metrics for Lambda ${functionName}:`, error);
    return {};
  }
}

/**
 * Fetch complete AWS resource inventory
 */
export async function fetchAWSResourceInventory(): Promise<AWSResourceInventory> {
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
    };
  }

  const [
    ec2Instances,
    lambdaFunctions,
    rdsInstances,
    s3Buckets,
    ebsVolumes,
    cloudwatchLogGroups,
    ebsSnapshots,
    elasticIPs,
  ] = await Promise.all([
    fetchEC2Instances(),
    fetchLambdaFunctions(),
    fetchRDSInstances(),
    fetchS3Buckets(),
    fetchEBSVolumes(),
    fetchCloudWatchLogGroups(),
    fetchEBSSnapshots(),
    fetchElasticIPs(),
  ]);

  console.log('[AWS Inventory] Resource inventory complete:', {
    ec2: ec2Instances.length,
    lambda: lambdaFunctions.length,
    rds: rdsInstances.length,
    s3: s3Buckets.length,
    ebs: ebsVolumes.length,
    logs: cloudwatchLogGroups.length,
    snapshots: ebsSnapshots.length,
    eips: elasticIPs.length,
  });

  return {
    ec2Instances,
    lambdaFunctions,
    rdsInstances,
    s3Buckets,
    ebsVolumes,
    cloudwatchLogGroups,
    ebsSnapshots,
    elasticIPs,
  };
}

// Cache for resource inventory (refresh every 5 minutes)
let cachedInventory: AWSResourceInventory | null = null;
let lastFetchTime: number = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get AWS resource inventory (cached)
 */
export async function getAWSResourceInventory(forceRefresh: boolean = false): Promise<AWSResourceInventory> {
  const now = Date.now();
  
  if (!forceRefresh && cachedInventory && (now - lastFetchTime) < CACHE_TTL) {
    console.log('[AWS Inventory] Returning cached inventory');
    return cachedInventory;
  }
  
  cachedInventory = await fetchAWSResourceInventory();
  lastFetchTime = now;
  
  return cachedInventory;
}
