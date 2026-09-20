/**
 * Populates resource_inventory so the estate-level policies have something to
 * evaluate.
 *
 * Three governance policies — idle waste, public exposure and encryption at
 * rest — read the inventory rather than the cost store, because "is this bucket
 * public" is not a question a billing API can answer. The table existed but was
 * never written to, so those policies correctly reported "not assessed" and the
 * security domain had a permanent hole in it.
 *
 * Scope, stated plainly:
 *
 *   - AWS only. Azure and GCP have inventory fetchers, but they do not carry
 *     encryption or exposure attributes yet, so syncing them would populate
 *     rows that answer none of the questions the policies ask.
 *   - EC2, EBS and RDS. These are the resource types whose DescribeX response
 *     ALREADY contains the security attributes, so this adds no IAM permission
 *     beyond what inventory collection has always used. S3 public-access and
 *     bucket encryption need a per-bucket GetPublicAccessBlock and
 *     GetEncryptionConfiguration — new permissions and N API calls — and belong
 *     in a separate change with its own IAM policy update.
 *
 * What that means for a reader of the dashboard: the encryption and exposure
 * policies assess EBS and RDS, and say so. They do not claim to have assessed
 * S3, and they do not report an unassessed bucket as compliant.
 */
import { sql } from "drizzle-orm";
import { db } from "../db";
import { resourceInventory } from "@shared/schema";
import { currentOrgId } from "../tenant-context";
import { loadAwsConnection } from "../aws/credential-provider";

type InventoryRow = typeof resourceInventory.$inferInsert;

export interface SyncResult {
  provider: string;
  resources: number;
  skipped: string | null;
  error: string | null;
}

/**
 * Writes a batch, updating what is already there.
 *
 * `lastSeenAt` is the field that matters downstream: loadDataset() ignores
 * anything not seen in the last fortnight, which is how a deleted resource
 * stops producing findings without anyone having to detect the deletion.
 */
async function persist(rows: InventoryRow[], now: Date): Promise<number> {
  if (rows.length === 0) return 0;

  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db
      .insert(resourceInventory)
      .values(rows.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: [
          resourceInventory.organizationId,
          resourceInventory.provider,
          resourceInventory.resourceId,
        ],
        set: {
          resourceType: sql`excluded.resource_type`,
          resourceName: sql`excluded.resource_name`,
          region: sql`excluded.region`,
          state: sql`excluded.state`,
          size: sql`excluded.size`,
          utilizationPercent: sql`excluded.utilization_percent`,
          tags: sql`excluded.tags`,
          metadata: sql`excluded.metadata`,
          lastSeenAt: now,
          updatedAt: now,
        },
      });
  }

  return rows.length;
}

async function syncAws(now: Date): Promise<SyncResult> {
  const orgId = currentOrgId();

  const connection = await loadAwsConnection();
  if (!connection) {
    return { provider: 'aws', resources: 0, skipped: 'No AWS connection configured.', error: null };
  }

  const accountId = connection.accountId;

  try {
    // Imported lazily for the same reason every other caller does: the module
    // pulls in five AWS SDK clients, and a tenant with no AWS connection should
    // not pay for that on boot.
    const { fetchEC2Instances, fetchEBSVolumes, fetchRDSInstances } =
      await import('../aws-resource-inventory');

    const [instances, volumes, databases] = await Promise.all([
      fetchEC2Instances(),
      fetchEBSVolumes(),
      fetchRDSInstances(),
    ]);

    const rows: InventoryRow[] = [];

    for (const i of instances) {
      rows.push({
        organizationId: orgId,
        provider: 'aws',
        accountId,
        resourceId: i.instanceId,
        resourceType: 'EC2',
        resourceName: i.tags?.Name ?? i.instanceId,
        region: process.env.AWS_REGION ?? null,
        // 'stopped' is not 'idle': a stopped instance bills only for its
        // storage, and the waste detector already treats the two differently.
        state: i.state,
        size: i.instanceType,
        // Utilization needs CloudWatch, which is a separate and much more
        // expensive call. Left null so the idle policy falls back to the
        // provider-reported state rather than inventing a number.
        utilizationPercent: null,
        tags: (i.tags ?? {}) as any,
        metadata: {
          platform: i.platform ?? null,
          vCpus: i.vCpus ?? null,
          memory: i.memory ?? null,
          launchTime: i.launchTime ? i.launchTime.toISOString() : null,
        } as any,
        lastSeenAt: now,
      });
    }

    for (const v of volumes) {
      rows.push({
        organizationId: orgId,
        provider: 'aws',
        accountId,
        resourceId: v.volumeId,
        resourceType: 'EBSVolume',
        resourceName: v.volumeId,
        region: v.availabilityZone ? v.availabilityZone.replace(/[a-z]$/, '') : (process.env.AWS_REGION ?? null),
        // An unattached volume is the canonical idle resource.
        state: v.attachedTo ? 'in-use' : 'idle',
        size: `${v.size} GiB ${v.volumeType}`,
        utilizationPercent: null,
        tags: {} as any,
        metadata: {
          // The key the encryption policy reads. Undefined would mean "we did
          // not look"; DescribeVolumes always returns it, so this is a fact.
          encrypted: v.encrypted ?? false,
          volumeType: v.volumeType,
          sizeGib: v.size,
          attachedTo: v.attachedTo ?? null,
          createTime: v.createTime ? v.createTime.toISOString() : null,
        } as any,
        lastSeenAt: now,
      });
    }

    for (const d of databases) {
      rows.push({
        organizationId: orgId,
        provider: 'aws',
        accountId,
        resourceId: d.instanceId,
        resourceType: 'RDSInstance',
        resourceName: d.instanceId,
        region: d.availabilityZone ? d.availabilityZone.replace(/[a-z]$/, '') : (process.env.AWS_REGION ?? null),
        state: d.status,
        size: d.instanceClass,
        utilizationPercent: null,
        tags: {} as any,
        metadata: {
          encrypted: d.storageEncrypted ?? false,
          publiclyAccessible: d.publiclyAccessible ?? false,
          engine: d.engine,
          engineVersion: d.engineVersion ?? null,
          multiAZ: d.multiAZ ?? false,
          allocatedStorage: d.allocatedStorage ?? null,
        } as any,
        lastSeenAt: now,
      });
    }

    const written = await persist(rows, now);
    return { provider: 'aws', resources: written, skipped: null, error: null };
  } catch (err: any) {
    // A failed sync must not fail the governance sweep. The policies then find
    // stale-or-absent inventory and report "not assessed", which is the correct
    // reading of "we could not look".
    return { provider: 'aws', resources: 0, skipped: null, error: err?.message ?? String(err) };
  }
}

/**
 * Refreshes the inventory for the tenant in the ambient context.
 *
 * Called before an evaluation sweep so the estate policies read current state
 * rather than whatever was last recorded. Never throws.
 */
export async function syncInventory(now: Date = new Date()): Promise<SyncResult[]> {
  return [await syncAws(now)];
}
