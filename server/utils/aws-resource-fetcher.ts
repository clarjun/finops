/**
 * AWS Resource Fetcher
 * Fetches actual AWS resources (not just cost data) for AI analysis
 */

import { EC2Client, DescribeVolumesCommand, DescribeInstancesCommand, DescribeSnapshotsCommand, DescribeAddressesCommand } from "@aws-sdk/client-ec2";
import { S3Client, ListBucketsCommand, GetBucketLocationCommand } from "@aws-sdk/client-s3";
import { RDSClient, DescribeDBInstancesCommand } from "@aws-sdk/client-rds";
import { CloudWatchClient, GetMetricStatisticsCommand } from "@aws-sdk/client-cloudwatch";
import { initializeAWSClient } from "../aws-client";
import { getProviderCredentials } from "../cloud-config-manager";

export interface AWSVolume {
  volumeId: string;
  size: number; // GB
  state: string; // available, in-use, deleting
  attachments: any[];
  createTime: Date;
  volumeType: string;
  encrypted: boolean;
  tags?: Record<string, string>;
}

export interface AWSInstance {
  instanceId: string;
  instanceType: string;
  state: string;
  launchTime: Date;
  platform?: string;
  tags?: Record<string, string>;
  cpuUtilization?: number;
}

export interface AWSS3Bucket {
  name: string;
  creationDate: Date;
  region?: string;
}

export interface AWSSnapshot {
  snapshotId: string;
  volumeId?: string;
  state: string;
  startTime: Date;
  volumeSize: number;
  description?: string;
  tags?: Record<string, string>;
}

export interface AWSElasticIP {
  publicIp: string;
  allocationId: string;
  associationId?: string;
  instanceId?: string;
  attached: boolean;
}

export interface AWSRDSInstance {
  dbInstanceIdentifier: string;
  dbInstanceClass: string;
  engine: string;
  dbInstanceStatus: string;
  allocatedStorage: number;
  createTime?: Date;
}

/**
 * Fetch all EBS volumes
 */
export async function fetchEBSVolumes(): Promise<AWSVolume[]> {
  try {
    const accountConfig = await getProviderCredentials('aws');
    if (!accountConfig) {
      console.log('[AWS Resources] No AWS credentials configured');
      return [];
    }

    const credentials = accountConfig.credentials;
    const ec2Client = new EC2Client({
      region: credentials.region || 'us-east-1',
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
      },
    });

    console.log('[AWS Resources] Fetching EBS volumes...');
    const command = new DescribeVolumesCommand({});
    const response = await ec2Client.send(command);

    const volumes: AWSVolume[] = (response.Volumes || []).map(vol => ({
      volumeId: vol.VolumeId || '',
      size: vol.Size || 0,
      state: vol.State || 'unknown',
      attachments: vol.Attachments || [],
      createTime: vol.CreateTime || new Date(),
      volumeType: vol.VolumeType || 'gp2',
      encrypted: vol.Encrypted || false,
      tags: vol.Tags?.reduce((acc, tag) => {
        if (tag.Key) acc[tag.Key] = tag.Value || '';
        return acc;
      }, {} as Record<string, string>),
    }));

    console.log(`[AWS Resources] Found ${volumes.length} EBS volumes`);
    return volumes;
  } catch (error) {
    console.error('[AWS Resources] Error fetching EBS volumes:', error);
    return [];
  }
}

/**
 * Fetch orphaned (unattached) EBS volumes
 */
export async function fetchOrphanedVolumes(): Promise<AWSVolume[]> {
  const allVolumes = await fetchEBSVolumes();
  const orphaned = allVolumes.filter(vol => 
    vol.state === 'available' && vol.attachments.length === 0
  );
  console.log(`[AWS Resources] Found ${orphaned.length} orphaned volumes`);
  return orphaned;
}

/**
 * Fetch all EC2 instances
 */
export async function fetchEC2Instances(): Promise<AWSInstance[]> {
  try {
    const accountConfig = await getProviderCredentials('aws');
    if (!accountConfig) return [];

    const credentials = accountConfig.credentials;
    const ec2Client = new EC2Client({
      region: credentials.region || 'us-east-1',
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
      },
    });

    console.log('[AWS Resources] Fetching EC2 instances...');
    const command = new DescribeInstancesCommand({});
    const response = await ec2Client.send(command);

    const instances: AWSInstance[] = [];
    for (const reservation of response.Reservations || []) {
      for (const instance of reservation.Instances || []) {
        instances.push({
          instanceId: instance.InstanceId || '',
          instanceType: instance.InstanceType || '',
          state: instance.State?.Name || 'unknown',
          launchTime: instance.LaunchTime || new Date(),
          platform: instance.Platform,
          tags: instance.Tags?.reduce((acc, tag) => {
            if (tag.Key) acc[tag.Key] = tag.Value || '';
            return acc;
          }, {} as Record<string, string>),
        });
      }
    }

    console.log(`[AWS Resources] Found ${instances.length} EC2 instances`);
    return instances;
  } catch (error) {
    console.error('[AWS Resources] Error fetching EC2 instances:', error);
    return [];
  }
}

/**
 * Fetch S3 buckets
 */
export async function fetchS3Buckets(): Promise<AWSS3Bucket[]> {
  try {
    const accountConfig = await getProviderCredentials('aws');
    if (!accountConfig) return [];

    const credentials = accountConfig.credentials;
    const s3Client = new S3Client({
      region: credentials.region || 'us-east-1',
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
      },
    });

    console.log('[AWS Resources] Fetching S3 buckets...');
    const command = new ListBucketsCommand({});
    const response = await s3Client.send(command);

    const buckets: AWSS3Bucket[] = (response.Buckets || []).map(bucket => ({
      name: bucket.Name || '',
      creationDate: bucket.CreationDate || new Date(),
    }));

    console.log(`[AWS Resources] Found ${buckets.length} S3 buckets`);
    return buckets;
  } catch (error) {
    console.error('[AWS Resources] Error fetching S3 buckets:', error);
    return [];
  }
}

/**
 * Fetch EBS snapshots
 */
export async function fetchEBSSnapshots(): Promise<AWSSnapshot[]> {
  try {
    const accountConfig = await getProviderCredentials('aws');
    if (!accountConfig) return [];

    const credentials = accountConfig.credentials;
    const ec2Client = new EC2Client({
      region: credentials.region || 'us-east-1',
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
      },
    });

    console.log('[AWS Resources] Fetching EBS snapshots...');
    const command = new DescribeSnapshotsCommand({
      OwnerIds: ['self'],
    });
    const response = await ec2Client.send(command);

    const snapshots: AWSSnapshot[] = (response.Snapshots || []).map(snap => ({
      snapshotId: snap.SnapshotId || '',
      volumeId: snap.VolumeId,
      state: snap.State || 'unknown',
      startTime: snap.StartTime || new Date(),
      volumeSize: snap.VolumeSize || 0,
      description: snap.Description,
      tags: snap.Tags?.reduce((acc, tag) => {
        if (tag.Key) acc[tag.Key] = tag.Value || '';
        return acc;
      }, {} as Record<string, string>),
    }));

    console.log(`[AWS Resources] Found ${snapshots.length} EBS snapshots`);
    return snapshots;
  } catch (error) {
    console.error('[AWS Resources] Error fetching EBS snapshots:', error);
    return [];
  }
}

/**
 * Fetch Elastic IPs
 */
export async function fetchElasticIPs(): Promise<AWSElasticIP[]> {
  try {
    const accountConfig = await getProviderCredentials('aws');
    if (!accountConfig) return [];

    const credentials = accountConfig.credentials;
    const ec2Client = new EC2Client({
      region: credentials.region || 'us-east-1',
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
      },
    });

    console.log('[AWS Resources] Fetching Elastic IPs...');
    const command = new DescribeAddressesCommand({});
    const response = await ec2Client.send(command);

    const ips: AWSElasticIP[] = (response.Addresses || []).map(addr => ({
      publicIp: addr.PublicIp || '',
      allocationId: addr.AllocationId || '',
      associationId: addr.AssociationId,
      instanceId: addr.InstanceId,
      attached: !!addr.InstanceId,
    }));

    console.log(`[AWS Resources] Found ${ips.length} Elastic IPs`);
    return ips;
  } catch (error) {
    console.error('[AWS Resources] Error fetching Elastic IPs:', error);
    return [];
  }
}

/**
 * Fetch RDS instances
 */
export async function fetchRDSInstances(): Promise<AWSRDSInstance[]> {
  try {
    const accountConfig = await getProviderCredentials('aws');
    if (!accountConfig) return [];

    const credentials = accountConfig.credentials;
    const rdsClient = new RDSClient({
      region: credentials.region || 'us-east-1',
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
      },
    });

    console.log('[AWS Resources] Fetching RDS instances...');
    const command = new DescribeDBInstancesCommand({});
    const response = await rdsClient.send(command);

    const instances: AWSRDSInstance[] = (response.DBInstances || []).map(db => ({
      dbInstanceIdentifier: db.DBInstanceIdentifier || '',
      dbInstanceClass: db.DBInstanceClass || '',
      engine: db.Engine || '',
      dbInstanceStatus: db.DBInstanceStatus || '',
      allocatedStorage: db.AllocatedStorage || 0,
      createTime: db.InstanceCreateTime,
    }));

    console.log(`[AWS Resources] Found ${instances.length} RDS instances`);
    return instances;
  } catch (error) {
    console.error('[AWS Resources] Error fetching RDS instances:', error);
    return [];
  }
}

/**
 * Fetch all AWS resources based on resource types
 * If action is 'find-idle', also fetch utilization metrics
 * @param resourceTypes - Types of resources to fetch
 * @param action - Action being performed (e.g., 'find-idle')
 * @param days - Number of days for metrics lookback (default: 30)
 */
export async function fetchAWSResources(resourceTypes: string[], action?: string, days: number = 30): Promise<any> {
  const resources: any = {};

  if (resourceTypes.includes('storage') || resourceTypes.includes('general')) {
    resources.volumes = await fetchEBSVolumes();
    resources.orphanedVolumes = resources.volumes.filter((v: AWSVolume) => 
      v.state === 'available' && v.attachments.length === 0
    );
    resources.snapshots = await fetchEBSSnapshots();
    resources.s3Buckets = await fetchS3Buckets();
  }

  if (resourceTypes.includes('compute') || resourceTypes.includes('general')) {
    resources.instances = await fetchEC2Instances();
    resources.stoppedInstances = resources.instances.filter((i: AWSInstance) => 
      i.state === 'stopped'
    );
    
    // Fetch metrics for idle detection
    if (action === 'find-idle' && resources.instances.length > 0) {
      console.log(`[AWS Resources] Fetching utilization metrics for idle detection (${days} days)...`);
      const { fetchEC2Metrics } = await import('./aws-metrics-fetcher');
      const runningInstances = resources.instances.filter((i: AWSInstance) => i.state === 'running');
      const instanceIds = runningInstances.map((i: AWSInstance) => i.instanceId);
      resources.instanceMetrics = await fetchEC2Metrics(instanceIds, days);
      resources.idleInstances = resources.instanceMetrics.filter((m: any) => m.isIdle);
    }
  }

  if (resourceTypes.includes('network') || resourceTypes.includes('general')) {
    resources.elasticIPs = await fetchElasticIPs();
    resources.unattachedIPs = resources.elasticIPs.filter((ip: AWSElasticIP) => 
      !ip.attached
    );
  }

  if (resourceTypes.includes('database') || resourceTypes.includes('general')) {
    resources.rdsInstances = await fetchRDSInstances();
    
    // Fetch metrics for idle detection
    if (action === 'find-idle' && resources.rdsInstances.length > 0) {
      console.log(`[AWS Resources] Fetching RDS utilization metrics for idle detection (${days} days)...`);
      const { fetchRDSMetrics } = await import('./aws-metrics-fetcher');
      const dbInstanceIds = resources.rdsInstances.map((db: AWSRDSInstance) => db.dbInstanceIdentifier);
      resources.rdsMetrics = await fetchRDSMetrics(dbInstanceIds, days);
      resources.idleRDSInstances = resources.rdsMetrics.filter((m: any) => m.isIdle);
    }
  }

  return resources;
}
