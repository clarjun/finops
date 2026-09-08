/**
 * Waste Detector — idle resources, unattached disks, underutilized VMs.
 *
 * Two things about this section were wrong, and together they made it report
 * nearly the same thing every month, because it very nearly was.
 *
 * 1. IT IGNORED THE REPORTED PERIOD. DescribeVolumes and DescribeInstances
 *    describe the account as it is RIGHT NOW, and the CloudWatch lookback was a
 *    hardcoded 7 days. Whether you asked for a January report or a September
 *    one, you got today's snapshot. Twelve months of cached reports differed
 *    only because the account itself drifted between the days they were built.
 *
 *    Attachment and power state genuinely cannot be reconstructed for a past
 *    month — nothing recorded it — so that half stays a point-in-time reading
 *    and now says so via `asOf`. CPU utilisation CAN be read for a past window
 *    (CloudWatch keeps daily datapoints for well over a year), so it now uses
 *    the reported period instead of always the last week.
 *
 * 2. EVERY COST WAS A HARDCODED CONSTANT. The lookup was
 *
 *        costData.find(c => c.resourceId.includes(volume.VolumeId))?.cost || 5
 *
 *    against an array whose resourceIds are `"<service name>-aggregate"` — it
 *    could never match a vol- or i- id, so the `|| 5`, `|| 50` and `|| 100`
 *    fallbacks fired 100% of the time. "Potential monthly savings" was exactly
 *    `5×disks + 50×stopped + 50×lowCpu` in every report ever generated: $955 in
 *    April, May, June and September alike, from three different resource mixes.
 *
 *    Costs now come from volume size and instance type priced through the AWS
 *    Price List API, and each finding records whether it was priced or estimated.
 *
 * One further correctness fix: a STOPPED instance costs nothing for compute —
 * you are billed only for the EBS volumes still attached to it. Charging it a
 * flat $50/month of "savings" overstated the opportunity and pointed at the
 * wrong remedy. Its waste is now the cost of those volumes.
 */

import { WasteDetection, ResourceUtilization } from './types';
import {
  EC2Client,
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  type Volume,
} from "@aws-sdk/client-ec2";
import {
  CloudWatchClient,
  GetMetricStatisticsCommand
} from "@aws-sdk/client-cloudwatch";
import { getProviderCredentials } from "../cloud-config-manager";
import { fetchEBSPricing, fetchEC2Pricing } from "../cost-estimator/aws-price-list-fetcher";
import { runProviderQuery } from "../cloud/query-runner";

/** Billable hours in an average month, for converting hourly rates. */
const HOURS_PER_MONTH = 730;

/** Below this average CPU a running instance is treated as underutilized. */
const LOW_CPU_THRESHOLD = 10;

/** Instances to pull CloudWatch metrics for. The remainder is reported, not hidden. */
const METRIC_SAMPLE_LIMIT = 20;

export interface WasteDetectionOptions {
  /** Window for the CPU utilisation read. Defaults to the last 7 days. */
  startDate?: Date;
  endDate?: Date;
}

export async function detectWaste(
  provider: 'aws' | 'azure' | 'gcp',
  costData: Array<{ resourceId: string; service: string; cost: number }>,
  options: WasteDetectionOptions = {},
): Promise<WasteDetection> {
  console.log(`[Waste Detector] Analyzing ${provider} resources`);

  if (provider === 'aws') {
    return detectAWSWaste(options);
  }

  // Azure and GCP have no implementation. Said out loud rather than returned as
  // a confident set of zeros, which reads as "no waste found".
  return {
    idleInstances: 0,
    unattachedDisks: 0,
    lowCpuVMs: 0,
    potentialSaving: 0,
    unavailableReason:
      `Waste detection is not implemented for ${provider.toUpperCase()} yet. ` +
      `Idle and underutilized resources for this provider are not assessed — ` +
      `this is not a finding of zero waste.`,
    details: {
      idleResources: [],
      underutilizedResources: [],
    },
  };
}

async function awsClients(): Promise<{ ec2: EC2Client; cw: CloudWatchClient; region: string } | null> {
  const accountConfig = await getProviderCredentials('aws');
  if (!accountConfig) return null;

  const credentials = accountConfig.credentials;
  const region = credentials.region || 'us-east-1';
  const creds = {
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
  };

  return {
    ec2: new EC2Client({ region, credentials: creds }),
    cw: new CloudWatchClient({ region, credentials: creds }),
    region,
  };
}

/** Monthly cost of one volume, priced by its size and type. */
async function volumeMonthlyCost(
  volume: Volume,
  region: string,
): Promise<{ cost: number; estimated: boolean }> {
  const sizeGb = volume.Size ?? 0;
  const { pricePerGbMonth, estimated } = await fetchEBSPricing(volume.VolumeType ?? 'gp3', region);
  return { cost: sizeGb * pricePerGbMonth, estimated };
}

/** Average CPU over a window, or null when CloudWatch has no datapoints. */
async function averageCpu(
  cw: CloudWatchClient,
  instanceId: string,
  startTime: Date,
  endTime: Date,
): Promise<number | null> {
  const response = await runProviderQuery('aws', 'waste:cloudwatch', () =>
    cw.send(new GetMetricStatisticsCommand({
      Namespace: 'AWS/EC2',
      MetricName: 'CPUUtilization',
      Dimensions: [{ Name: 'InstanceId', Value: instanceId }],
      StartTime: startTime,
      EndTime: endTime,
      Period: 86400,
      Statistics: ['Average'],
    })));

  const datapoints = response.Datapoints ?? [];
  if (datapoints.length === 0) return null;
  return datapoints.reduce((sum, dp) => sum + (dp.Average || 0), 0) / datapoints.length;
}

async function detectAWSWaste(options: WasteDetectionOptions): Promise<WasteDetection> {
  const waste: WasteDetection = {
    idleInstances: 0,
    unattachedDisks: 0,
    lowCpuVMs: 0,
    potentialSaving: 0,
    details: {
      idleResources: [],
      underutilizedResources: [],
    },
  };

  try {
    const clients = await awsClients();
    if (!clients) {
      waste.unavailableReason = 'AWS is not connected, so no resources were assessed.';
      return waste;
    }
    const { ec2, cw, region } = clients;

    // Attachment and power state are current-state facts, so record when they
    // were read. The card shows this, because a reader comparing two monthly
    // reports otherwise has no way to know both describe today.
    waste.asOf = new Date().toISOString();
    waste.regionAssessed = region;

    // ── Volumes ──────────────────────────────────────────────────────────────
    const volumesResponse = await runProviderQuery('aws', 'waste:volumes', () =>
      ec2.send(new DescribeVolumesCommand({})));
    const volumes = volumesResponse.Volumes ?? [];

    // Attached volumes, indexed by instance, so a stopped instance can be
    // charged for what it actually still costs.
    const volumesByInstance = new Map<string, Volume[]>();
    for (const volume of volumes) {
      for (const attachment of volume.Attachments ?? []) {
        if (!attachment.InstanceId) continue;
        const list = volumesByInstance.get(attachment.InstanceId) ?? [];
        list.push(volume);
        volumesByInstance.set(attachment.InstanceId, list);
      }
    }

    let anyEstimated = false;

    for (const volume of volumes) {
      if (volume.State !== 'available' || !volume.VolumeId) continue;

      const { cost, estimated } = await volumeMonthlyCost(volume, region);
      anyEstimated = anyEstimated || estimated;

      waste.unattachedDisks++;
      waste.potentialSaving += cost;
      waste.details.idleResources.push({
        resourceId: volume.VolumeId,
        type: 'EBS Volume',
        cost,
        reason: `Unattached ${volume.VolumeType ?? 'gp3'} volume, ${volume.Size ?? 0} GB`,
        costBasis: estimated ? 'estimated' : 'list-price',
      });
    }

    // ── Instances ────────────────────────────────────────────────────────────
    const instancesResponse = await runProviderQuery('aws', 'waste:instances', () =>
      ec2.send(new DescribeInstancesCommand({})));

    const runningInstances: Array<{ id: string; name: string; instanceType: string }> = [];

    for (const reservation of instancesResponse.Reservations ?? []) {
      for (const instance of reservation.Instances ?? []) {
        const instanceId = instance.InstanceId;
        if (!instanceId) continue;

        const instanceName = instance.Tags?.find(t => t.Key === 'Name')?.Value || instanceId;

        if (instance.State?.Name === 'stopped') {
          // A stopped instance is billed $0 for compute. What it still costs is
          // the EBS attached to it, which is also what deleting it would save.
          const attached = volumesByInstance.get(instanceId) ?? [];
          let cost = 0;
          for (const volume of attached) {
            const priced = await volumeMonthlyCost(volume, region);
            cost += priced.cost;
            anyEstimated = anyEstimated || priced.estimated;
          }

          waste.idleInstances++;
          waste.potentialSaving += cost;
          waste.details.idleResources.push({
            resourceId: instanceId,
            type: 'EC2 Instance',
            cost,
            reason: attached.length
              ? `Stopped, still paying for ${attached.length} attached volume(s)`
              : 'Stopped with no attached storage — no ongoing cost',
            costBasis: 'list-price',
          });
        }

        if (instance.State?.Name === 'running') {
          runningInstances.push({
            id: instanceId,
            name: instanceName,
            instanceType: instance.InstanceType ?? 'unknown',
          });
        }
      }
    }

    // ── CPU utilisation over the reported period ─────────────────────────────
    const endTime = options.endDate ?? new Date();
    const startTime = options.startDate ?? new Date(endTime.getTime() - 7 * 24 * 60 * 60 * 1000);
    const lookbackDays = Math.max(1, Math.round((endTime.getTime() - startTime.getTime()) / 86_400_000));

    const sampled = runningInstances.slice(0, METRIC_SAMPLE_LIMIT);
    // Truncation stated rather than silent: "3 low-CPU VMs" out of 20 assessed
    // means something different from 3 out of 200.
    waste.instancesAssessed = sampled.length;
    waste.instancesNotAssessed = runningInstances.length - sampled.length;
    waste.utilizationPeriod =
      `${startTime.toISOString().split('T')[0]} to ${endTime.toISOString().split('T')[0]}`;

    for (const instance of sampled) {
      try {
        const avgCPU = await averageCpu(cw, instance.id, startTime, endTime);
        if (avgCPU === null || avgCPU >= LOW_CPU_THRESHOLD) continue;

        // Priced from the instance type, not a flat $100.
        const hourly = await fetchEC2Pricing(instance.instanceType, region);
        const monthly = hourly * HOURS_PER_MONTH;

        waste.lowCpuVMs++;
        // Downsizing one step halves the rate; stopping it saves all of it. Half
        // is the conservative figure, and is what the recommendation describes.
        waste.potentialSaving += monthly * 0.5;
        waste.details.underutilizedResources.push({
          resourceId: instance.id,
          type: 'EC2 Instance',
          cost: monthly,
          utilization: avgCPU,
          recommendation:
            `CPU averaged ${avgCPU.toFixed(1)}% over ${lookbackDays} day(s) on ${instance.instanceType} ` +
            `($${monthly.toFixed(2)}/mo). Downsizing one step would save about $${(monthly * 0.5).toFixed(2)}/mo.`,
          costBasis: 'list-price',
        });
      } catch (error: any) {
        console.log(`[Waste Detector] No metrics for ${instance.id}: ${error?.message ?? error}`);
      }
    }

    if (anyEstimated) {
      waste.costBasisNote =
        'Some volume prices could not be fetched from the AWS Price List API and use dated list prices (as of 2026-06).';
    }

    console.log(
      `[Waste Detector] ✓ ${waste.idleInstances} stopped, ${waste.unattachedDisks} unattached, ` +
      `${waste.lowCpuVMs} underutilized of ${sampled.length} assessed; ` +
      `$${waste.potentialSaving.toFixed(2)}/mo in ${region}`,
    );

  } catch (error: any) {
    // A failure must not read as "no waste found" — that is exactly how the AI
    // spend section came to show zero for a day.
    console.error('[Waste Detector] Error:', error?.message ?? error);
    waste.unavailableReason = `Could not assess resources: ${error?.message ?? 'unknown error'}`;
  }

  return waste;
}

/**
 * Per-instance cost against utilisation, for the cost-vs-utilisation chart.
 *
 * Had the same fabricated cost as the waste detector — `?.cost || 100` against
 * service aggregates that never match an instance id — so every point on that
 * chart sat at exactly $100 regardless of instance type. Now priced from the
 * instance type, and the window follows the reported period.
 */
export async function getResourceUtilization(
  provider: 'aws' | 'azure' | 'gcp',
  costData: Array<{ resourceId: string; service: string; cost: number }>,
  options: WasteDetectionOptions = {},
): Promise<ResourceUtilization[]> {
  console.log(`[Resource Utilization] Fetching data for ${provider}`);

  if (provider !== 'aws') {
    return [];
  }

  const utilization: ResourceUtilization[] = [];

  try {
    const clients = await awsClients();
    if (!clients) return [];
    const { ec2, cw, region } = clients;

    const instancesResponse = await runProviderQuery('aws', 'utilization:instances', () =>
      ec2.send(new DescribeInstancesCommand({})));

    const endTime = options.endDate ?? new Date();
    const startTime = options.startDate ?? new Date(endTime.getTime() - 7 * 24 * 60 * 60 * 1000);

    const running = (instancesResponse.Reservations ?? [])
      .flatMap(r => r.Instances ?? [])
      .filter(i => i.State?.Name === 'running' && i.InstanceId)
      .slice(0, 30);   // chart legibility, not a rate-limit workaround

    for (const instance of running) {
      const instanceId = instance.InstanceId!;
      const instanceName = instance.Tags?.find(t => t.Key === 'Name')?.Value || instanceId;
      const instanceType = instance.InstanceType || 'unknown';

      try {
        const avgCPU = await averageCpu(cw, instanceId, startTime, endTime);
        if (avgCPU === null) continue;

        const hourly = await fetchEC2Pricing(instanceType, region);
        const monthly = hourly * HOURS_PER_MONTH;

        let recommendation = 'Optimal usage';
        if (avgCPU < 10) recommendation = 'Consider stopping or downsizing';
        else if (avgCPU < 30) recommendation = 'Consider downsizing';
        else if (avgCPU > 80) recommendation = 'Consider upsizing';

        utilization.push({
          resourceId: instanceId,
          resourceName: instanceName,
          service: 'EC2',
          cost: monthly,
          utilization: avgCPU,
          size: instanceType,
          recommendation,
        });
      } catch {
        // One instance without metrics should not empty the chart.
      }
    }

    console.log(`[Resource Utilization] ✓ Fetched ${utilization.length} resources`);

  } catch (error: any) {
    console.error('[Resource Utilization] Error:', error?.message ?? error);
  }

  return utilization;
}
