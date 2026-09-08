/**
 * Waste detection cost arithmetic.
 *
 * Every cost this section reported used to be a hardcoded constant. The lookup
 *
 *     costData.find(c => c.resourceId.includes(volume.VolumeId))?.cost || 5
 *
 * searched an array whose resourceIds are `"<service name>-aggregate"`, so it
 * could never match a `vol-` or `i-` id and the `|| 5`, `|| 50`, `|| 100`
 * fallbacks fired every time. Twelve months of cached reports show the result:
 * potentialSaving was exactly `5×disks + 50×stopped + 50×lowCpu` in all of them
 * — $955 in April, May, June and September, from three different resource
 * mixes. Against this account the real figure is $148.74, a 6.4x overstatement.
 *
 * These tests pin the arithmetic to measured inputs: volume size x price,
 * instance type x hours, and a stopped instance costing its attached storage
 * rather than a flat $50 of phantom compute.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendEC2 = vi.fn();
const sendCW = vi.fn();

vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: class { send = sendEC2; },
  DescribeInstancesCommand: class { constructor(public input: any) {} },
  DescribeVolumesCommand: class { constructor(public input: any) {} },
}));

vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: class { send = sendCW; },
  GetMetricStatisticsCommand: class { constructor(public input: any) {} },
}));

vi.mock('../cloud-config-manager', () => ({
  getProviderCredentials: vi.fn(async () => ({
    accountName: 'test',
    credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret', region: 'us-east-1' },
  })),
}));

vi.mock('../cost-estimator/aws-price-list-fetcher', () => ({
  // Real prices for this region at time of writing, so the expected numbers
  // below are the arithmetic a customer could check by hand.
  fetchEBSPricing: vi.fn(async (volumeType: string) => ({
    pricePerGbMonth: volumeType === 'gp2' ? 0.10 : 0.08,
    estimated: false,
  })),
  fetchEC2Pricing: vi.fn(async (instanceType: string) =>
    ({ 't3.small': 0.0208, 't3.medium': 0.0416, 't2.large': 0.0928 }[instanceType] ?? 0.05)),
}));

const { detectWaste } = await import('./waste-detector');

const period = { startDate: new Date('2026-09-01'), endDate: new Date('2026-09-06') };

beforeEach(() => {
  sendEC2.mockReset();
  sendCW.mockReset();
});

/** Wire DescribeVolumes / DescribeInstances by command shape. */
function mockAws(volumes: any[], reservations: any[]) {
  sendEC2.mockImplementation(async (cmd: any) =>
    'VolumeIds' in (cmd.input ?? {}) || cmd.constructor.name.includes('Volumes')
      ? { Volumes: volumes }
      : { Reservations: reservations });
}

describe('unattached volumes', () => {
  it('prices a volume by its size and type, not a flat $5', () => {
    // A 500 GB gp3 volume and a 1 GB one both counted as $5 before.
    return (async () => {
      mockAws(
        [{ VolumeId: 'vol-big', State: 'available', Size: 500, VolumeType: 'gp3', Attachments: [] }],
        [],
      );
      const w = await detectWaste('aws', [], period);

      expect(w.unattachedDisks).toBe(1);
      expect(w.potentialSaving).toBeCloseTo(500 * 0.08, 6);   // $40.00, not $5
      expect(w.details.idleResources[0].reason).toMatch(/500 GB/);
      expect(w.details.idleResources[0].costBasis).toBe('list-price');
    })();
  });

  it('distinguishes volume types, which the flat rate could not', async () => {
    mockAws(
      [
        { VolumeId: 'vol-gp3', State: 'available', Size: 100, VolumeType: 'gp3', Attachments: [] },
        { VolumeId: 'vol-gp2', State: 'available', Size: 100, VolumeType: 'gp2', Attachments: [] },
      ],
      [],
    );
    const w = await detectWaste('aws', [], period);
    expect(w.potentialSaving).toBeCloseTo(100 * 0.08 + 100 * 0.10, 6);
  });

  it('ignores attached volumes', async () => {
    mockAws(
      [{ VolumeId: 'vol-live', State: 'in-use', Size: 100, VolumeType: 'gp3', Attachments: [{ InstanceId: 'i-1' }] }],
      [],
    );
    const w = await detectWaste('aws', [], period);
    expect(w.unattachedDisks).toBe(0);
    expect(w.potentialSaving).toBe(0);
  });
});

describe('stopped instances', () => {
  it('costs its attached storage, not a flat $50 of compute', async () => {
    // A stopped instance is billed $0 for compute. Charging $50/mo of "savings"
    // overstated the opportunity and pointed at the wrong remedy.
    mockAws(
      [{ VolumeId: 'vol-a', State: 'in-use', Size: 30, VolumeType: 'gp3', Attachments: [{ InstanceId: 'i-stopped' }] }],
      [{ Instances: [{ InstanceId: 'i-stopped', State: { Name: 'stopped' }, InstanceType: 't3.medium' }] }],
    );
    const w = await detectWaste('aws', [], period);

    expect(w.idleInstances).toBe(1);
    expect(w.potentialSaving).toBeCloseTo(30 * 0.08, 6);       // $2.40, not $50
    expect(w.details.idleResources[0].reason).toMatch(/1 attached volume/);
  });

  it('reports no ongoing cost for a stopped instance with no storage', async () => {
    mockAws([], [{ Instances: [{ InstanceId: 'i-bare', State: { Name: 'stopped' }, InstanceType: 't3.small' }] }]);
    const w = await detectWaste('aws', [], period);

    expect(w.idleInstances).toBe(1);
    expect(w.potentialSaving).toBe(0);
    expect(w.details.idleResources[0].reason).toMatch(/no ongoing cost/i);
  });
});

describe('underutilized instances', () => {
  it('prices by instance type over the reported period, not a flat $100', async () => {
    mockAws([], [{ Instances: [{ InstanceId: 'i-idle', State: { Name: 'running' }, InstanceType: 't2.large' }] }]);
    sendCW.mockResolvedValue({ Datapoints: [{ Average: 2 }, { Average: 4 }] });

    const w = await detectWaste('aws', [], period);
    const monthly = 0.0928 * 730;                              // $67.74

    expect(w.lowCpuVMs).toBe(1);
    expect(w.details.underutilizedResources[0].cost).toBeCloseTo(monthly, 6);
    expect(w.details.underutilizedResources[0].utilization).toBeCloseTo(3, 6);
    // Half the rate — downsizing one step, the conservative figure.
    expect(w.potentialSaving).toBeCloseTo(monthly * 0.5, 6);
  });

  it('leaves a busy instance alone', async () => {
    mockAws([], [{ Instances: [{ InstanceId: 'i-busy', State: { Name: 'running' }, InstanceType: 't3.medium' }] }]);
    sendCW.mockResolvedValue({ Datapoints: [{ Average: 65 }] });

    const w = await detectWaste('aws', [], period);
    expect(w.lowCpuVMs).toBe(0);
    expect(w.potentialSaving).toBe(0);
  });

  it('does not treat "no metrics" as idle', async () => {
    // No datapoints means unknown. Counting it as 0% CPU would invent waste.
    mockAws([], [{ Instances: [{ InstanceId: 'i-quiet', State: { Name: 'running' }, InstanceType: 't3.medium' }] }]);
    sendCW.mockResolvedValue({ Datapoints: [] });

    const w = await detectWaste('aws', [], period);
    expect(w.lowCpuVMs).toBe(0);
  });

  it('measures CPU over the requested window rather than a fixed last-7-days', async () => {
    // The hardcoded 7-day lookback is why every report looked the same.
    mockAws([], [{ Instances: [{ InstanceId: 'i-x', State: { Name: 'running' }, InstanceType: 't3.small' }] }]);
    sendCW.mockResolvedValue({ Datapoints: [{ Average: 1 }] });

    await detectWaste('aws', [], period);

    const call = sendCW.mock.calls[0][0].input;
    expect(call.StartTime).toEqual(period.startDate);
    expect(call.EndTime).toEqual(period.endDate);
  });
});

describe('scope reporting', () => {
  it('stamps when current state was read and which region', async () => {
    mockAws([], []);
    const w = await detectWaste('aws', [], period);

    // Without these the card cannot explain why two different months show the
    // same counts, which is what made the section look fabricated.
    expect(w.asOf).toBeTruthy();
    expect(w.regionAssessed).toBe('us-east-1');
    expect(w.utilizationPeriod).toBe('2026-09-01 to 2026-09-06');
  });

  it('reports how many running instances went unassessed', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      InstanceId: `i-${i}`, State: { Name: 'running' }, InstanceType: 't3.small',
    }));
    mockAws([], [{ Instances: many }]);
    sendCW.mockResolvedValue({ Datapoints: [{ Average: 50 }] });

    const w = await detectWaste('aws', [], period);
    // Silently sampling 20 of 25 makes "0 low-CPU VMs" read as a clean bill.
    expect(w.instancesAssessed).toBe(20);
    expect(w.instancesNotAssessed).toBe(5);
    // Generous timeout because this is real behaviour, not test slowness: the
    // AWS rate lane spaces calls 250ms apart, so assessing 20 instances takes
    // over 5 seconds in production too.
  }, 30_000);

  it('states that Azure and GCP are not assessed instead of returning zeros', async () => {
    for (const provider of ['azure', 'gcp'] as const) {
      const w = await detectWaste(provider, [], period);
      expect(w.potentialSaving).toBe(0);
      // The distinction that matters: not implemented, not "no waste found".
      expect(w.unavailableReason, provider).toMatch(/not implemented/i);
      expect(w.unavailableReason, provider).toMatch(/not a finding of zero waste/i);
    }
  });

  it('reports a failure as a failure rather than as an absence of waste', async () => {
    sendEC2.mockRejectedValue(Object.assign(new Error('AccessDenied'), { status: 403 }));
    const w = await detectWaste('aws', [], period);

    expect(w.unavailableReason).toBeTruthy();
    expect(w.potentialSaving).toBe(0);
  });
});

describe('the regression these tests exist for', () => {
  it('no longer produces 5*disks + 50*stopped + 50*lowCpu', async () => {
    // The exact signature of twelve months of cached reports. This mix would
    // have reported 5 + 50 + 50 = $105 regardless of any actual price.
    mockAws(
      [
        { VolumeId: 'vol-free', State: 'available', Size: 30, VolumeType: 'gp3', Attachments: [] },
        { VolumeId: 'vol-att', State: 'in-use', Size: 8, VolumeType: 'gp3', Attachments: [{ InstanceId: 'i-stop' }] },
      ],
      [{ Instances: [
        { InstanceId: 'i-stop', State: { Name: 'stopped' }, InstanceType: 't3.medium' },
        { InstanceId: 'i-low', State: { Name: 'running' }, InstanceType: 't3.small' },
      ] }],
    );
    sendCW.mockResolvedValue({ Datapoints: [{ Average: 1.5 }] });

    const w = await detectWaste('aws', [], period);

    const expected = 30 * 0.08 + 8 * 0.08 + (0.0208 * 730) / 2;
    expect(w.potentialSaving).toBeCloseTo(expected, 6);
    expect(w.potentialSaving).not.toBeCloseTo(105, 2);
  });
});
