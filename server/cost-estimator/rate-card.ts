/**
 * Rates, fetched from AWS rather than remembered.
 *
 * There are three ways to get a price into an estimate and only one of them is
 * defensible.
 *
 *   ask a model        it recalls prices from training data of unknown vintage,
 *                      cannot say when they were true, and returns a different
 *                      number next time. That is not an estimate, it is a guess
 *                      with good grammar — and it is precisely the failure this
 *                      estimator was just repaired for.
 *   hardcode a table   honest if dated, but it rots. DynamoDB's write unit was
 *                      written here at exactly double the real rate and nothing
 *                      would have caught it.
 *   ask AWS            the price, from the party that sets it, on the day.
 *
 * So the model chooses the architecture and its sizing, which is judgement, and
 * this fetches the rates, which is not. Every rate carries where it came from,
 * because a fallback that looks identical to a live price is how a stale number
 * survives unnoticed.
 */
import { PricingClient, GetProductsCommand, type Filter as PricingFilterType } from '@aws-sdk/client-pricing';
import { getProviderCredentials } from '../cloud-config-manager';

export interface Rate {
  value: number;
  unit: string;
  /** live: fetched now. cached: fetched recently. fallback: a dated constant. */
  source: 'live' | 'cached' | 'fallback';
  /** What AWS calls it, or why the fallback is in use. */
  note: string;
}

export interface RateCard {
  region: string;
  rates: Record<RateKey, Rate>;
  /** True when any rate is a dated constant rather than a fetched price. */
  degraded: boolean;
  fetchedAt: string;
}

export type RateKey =
  | 'lambdaRequest' | 'lambdaGbSecond'
  | 'dynamoWriteUnit' | 'dynamoReadUnit' | 'dynamoStorageGb'
  | 'apiGatewayHttpRequest' | 'apiGatewayRestRequest'
  | 's3StorageGb' | 'cloudfrontTransferGb'
  | 'sqsRequest' | 'route53HostedZone' | 'cloudwatchLogIngestGb'
  | 'wafWebAcl' | 'wafRule' | 'wafRequest';

/**
 * Dated list prices, used only when a lookup fails.
 *
 * Kept because an estimator that cannot price anything when the Pricing API is
 * unreachable is worse than one that prices from a stated date — but every one
 * of these is reported as a fallback, never passed off as current.
 */
const FALLBACK: Record<RateKey, { value: number; unit: string }> = {
  lambdaRequest: { value: 0.0000002, unit: 'request' },
  lambdaGbSecond: { value: 0.0000166667, unit: 'GB-second' },
  dynamoWriteUnit: { value: 0.000000625, unit: 'write unit' },
  dynamoReadUnit: { value: 0.000000125, unit: 'read unit' },
  dynamoStorageGb: { value: 0.25, unit: 'GB-month' },
  apiGatewayHttpRequest: { value: 0.000001, unit: 'request' },
  apiGatewayRestRequest: { value: 0.0000035, unit: 'request' },
  s3StorageGb: { value: 0.023, unit: 'GB-month' },
  cloudfrontTransferGb: { value: 0.085, unit: 'GB' },
  sqsRequest: { value: 0.0000004, unit: 'request' },
  route53HostedZone: { value: 0.50, unit: 'zone-month' },
  cloudwatchLogIngestGb: { value: 0.50, unit: 'GB' },
  wafWebAcl: { value: 5.00, unit: 'ACL-month' },
  wafRule: { value: 1.00, unit: 'rule-month' },
  wafRequest: { value: 0.0000006, unit: 'request' },
};

/** When these constants were taken, so a fallback can say how old it is. */
const FALLBACK_AS_OF = '2026-06';

/**
 * Region prefixes as they appear in a usagetype.
 *
 * Some services identify the region only there — WAF's web ACL is
 * USE1-WebACLV2 in Virginia and APS1-WebACLV2 in Mumbai — so a location filter
 * alone returns every region's product.
 */
const USAGE_PREFIX: Record<string, string> = {
  'us-east-1': 'USE1', 'us-east-2': 'USE2', 'us-west-1': 'USW1', 'us-west-2': 'USW2',
  'eu-west-1': 'EUW1', 'eu-west-2': 'EUW2', 'eu-central-1': 'EUC1',
  'ap-south-1': 'APS3', 'ap-southeast-1': 'APS1', 'ap-southeast-2': 'APS2', 'ap-northeast-1': 'APN1',
};

interface Lookup {
  service: string;
  filters: Array<[string, string]>;
  /** Applied after fetching, since the API has no "not equals". */
  usageType?: (usagetype: string, region: string) => boolean;
  /** Global services price once for the world and reject a location filter. */
  global?: boolean;
}

/** How each rate is found in the Price List API. */
const LOOKUPS: Partial<Record<RateKey, Lookup>> = {
  lambdaRequest: { service: 'AWSLambda', filters: [['group', 'AWS-Lambda-Requests']] },
  lambdaGbSecond: { service: 'AWSLambda', filters: [['group', 'AWS-Lambda-Duration']] },
  dynamoWriteUnit: { service: 'AmazonDynamoDB', filters: [['groupDescription', 'DynamoDB PayPerRequest Write Request Units']] },
  dynamoReadUnit: { service: 'AmazonDynamoDB', filters: [['groupDescription', 'DynamoDB PayPerRequest Read Request Units']] },
  s3StorageGb: { service: 'AmazonS3', filters: [['volumeType', 'Standard'], ['storageClass', 'General Purpose']] },
  apiGatewayHttpRequest: { service: 'AmazonApiGateway', filters: [['operation', 'ApiGatewayHttpApi']] },
  apiGatewayRestRequest: { service: 'AmazonApiGateway', filters: [['operation', 'ApiGatewayRequest']] },
  cloudwatchLogIngestGb: { service: 'AmazonCloudWatch', filters: [['group', 'Ingested Logs']] },

  // Storage past the free allowance. The begin=0 tier is the free 25 GB and
  // prices at zero, so the applicable rate is deliberately not the first tier
  // here — the allowance is modelled separately in the pricing functions.
  dynamoStorageGb: {
    service: 'AmazonDynamoDB',
    filters: [['productFamily', 'Database Storage']],
    // Infrequent Access is a different storage class at a different price.
    usageType: (u) => u.endsWith('TimedStorage-ByteHrs') && !u.includes('IA-'),
  },

  sqsRequest: {
    service: 'AWSQueueService',
    filters: [['queueType', 'Standard']],
    usageType: (u) => /Requests/i.test(u) && !/FIFO/i.test(u),
  },

  // Route 53 bills globally; a location filter matches nothing.
  route53HostedZone: {
    service: 'AmazonRoute53',
    filters: [['productFamily', 'DNS Zone']],
    usageType: (u) => u === 'HostedZone',
    global: true,
  },

  // CloudFront prices by the edge that serves the byte, not by a region the
  // distribution lives in. The US/Europe rate is the representative one and is
  // labelled as such rather than presented as region-specific.
  cloudfrontTransferGb: {
    service: 'AmazonCloudFront',
    filters: [['transferType', 'CloudFront Outbound'], ['fromLocation', 'United States']],
    global: true,
  },

  // ShieldProtected variants price at zero because Shield Advanced includes
  // WAF. Taking the cheapest row would report a firewall as free — the exact
  // mistake this estimator was repaired for.
  wafWebAcl: {
    service: 'awswaf',
    filters: [],
    usageType: (u, region) => u === `${USAGE_PREFIX[region] ?? 'USE1'}-WebACLV2`,
  },
  wafRule: {
    service: 'awswaf',
    filters: [],
    usageType: (u, region) => u === `${USAGE_PREFIX[region] ?? 'USE1'}-RuleV2`,
  },
  wafRequest: {
    service: 'awswaf',
    filters: [],
    // Tier0 is the base capacity tier; the higher tiers are for larger WCU
    // allocations that a default rule set does not use.
    usageType: (u, region) => u === `${USAGE_PREFIX[region] ?? 'USE1'}-RequestV2-Tier0`,
  },
};

const CACHE_MS = 24 * 60 * 60 * 1000;
const cache = new Map<string, { card: RateCard; at: number }>();

/** Price List locations are names, not region codes. */
const REGION_NAMES: Record<string, string> = {
  'us-east-1': 'US East (N. Virginia)',
  'us-east-2': 'US East (Ohio)',
  'us-west-1': 'US West (N. California)',
  'us-west-2': 'US West (Oregon)',
  'eu-west-1': 'EU (Ireland)',
  'eu-west-2': 'EU (London)',
  'eu-central-1': 'EU (Frankfurt)',
  'ap-south-1': 'Asia Pacific (Mumbai)',
  'ap-southeast-1': 'Asia Pacific (Singapore)',
  'ap-southeast-2': 'Asia Pacific (Sydney)',
  'ap-northeast-1': 'Asia Pacific (Tokyo)',
};

export const regionName = (region: string): string => REGION_NAMES[region] ?? REGION_NAMES['us-east-1'];

/**
 * The first-tier on-demand rate matching a lookup.
 *
 * Selected by tier, never by price. AWS returns volume tiers in no particular
 * order, and taking the cheapest picks the discount nobody at this size
 * receives: CloudWatch logs came back at $0.05/GB, the rate for traffic over
 * fifty terabytes, when the applicable price is $0.50 — out by a factor of ten
 * and entirely plausible on the page. S3 was wrong the same way.
 *
 * `beginRange` is where a tier starts, so "0" is the one an estimate of any
 * ordinary size actually pays. Rows priced at zero describe a free allowance
 * rather than a rate, and are skipped; the allowances are modelled separately.
 */
function extractRate(
  priceListJson: string[],
  accept?: (usagetype: string) => boolean,
): { value: number; unit: string; note: string } | null {
  let firstTier: { value: number; unit: string; note: string } | null = null;
  let anyTier: { value: number; unit: string; note: string } | null = null;

  for (const raw of priceListJson) {
    let doc: any;
    try { doc = JSON.parse(raw); } catch { continue; }

    const usagetype = String(doc.product?.attributes?.usagetype ?? '');
    if (accept && !accept(usagetype)) continue;

    for (const term of Object.values<any>(doc.terms?.OnDemand ?? {})) {
      for (const dim of Object.values<any>(term.priceDimensions ?? {})) {
        const value = Number(dim.pricePerUnit?.USD);
        // Zero-priced rows describe an allowance or a bundled variant — WAF
        // under Shield, DynamoDB's free storage — never a rate to charge.
        if (!Number.isFinite(value) || value <= 0) continue;

        const candidate = { value, unit: dim.unit ?? '', note: String(dim.description ?? '').slice(0, 120) };

        if (String(dim.beginRange) === '0') {
          // Several products can share the first tier at the same price; the
          // cheapest among genuine first tiers is a real choice, unlike the
          // cheapest across tiers.
          if (!firstTier || value < firstTier.value) firstTier = candidate;
        } else if (!anyTier || value < anyTier.value) {
          anyTier = candidate;
        }
      }
    }
  }

  return firstTier ?? anyTier;
}

async function pricingClient(): Promise<PricingClient> {
  const config = await getProviderCredentials('aws');
  if (!config) throw new Error('No AWS credentials configured');
  // The Pricing API itself lives only in us-east-1 and ap-south-1; the region
  // being priced is a filter, not an endpoint.
  return new PricingClient({
    region: 'us-east-1',
    credentials: {
      accessKeyId: config.credentials.accessKeyId,
      secretAccessKey: config.credentials.secretAccessKey,
    },
  });
}

/**
 * Every rate needed for an estimate, for one region.
 *
 * Never throws. A region AWS cannot answer for still produces a usable card —
 * one that says, rate by rate, that it is not current.
 */
export async function loadRateCard(region: string = 'us-east-1'): Promise<RateCard> {
  const cached = cache.get(region);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return {
      ...cached.card,
      rates: Object.fromEntries(
        Object.entries(cached.card.rates).map(([k, r]) => [k, { ...r, source: r.source === 'live' ? 'cached' : r.source }]),
      ) as Record<RateKey, Rate>,
    };
  }

  const rates = {} as Record<RateKey, Rate>;
  const location = regionName(region);
  let client: PricingClient | null = null;

  try {
    client = await pricingClient();
  } catch (err) {
    console.warn('[RateCard] Pricing API unavailable, every rate falls back:', (err as Error)?.message);
  }

  for (const key of Object.keys(FALLBACK) as RateKey[]) {
    const lookup = LOOKUPS[key];

    if (client && lookup) {
      try {
        const result = await client.send(new GetProductsCommand({
          ServiceCode: lookup.service,
          Filters: [
            ...(lookup.global ? [] : [{ Type: 'TERM_MATCH', Field: 'location', Value: location }]),
            ...lookup.filters.map(([Field, Value]) => ({ Type: 'TERM_MATCH', Field, Value })),
          ] as PricingFilterType[],
          // Enough to hold every tier and variant of one product; the predicate
          // and the tier rule narrow it, not the page size.
          MaxResults: 100,
        }));

        const found = extractRate(
          (result.PriceList ?? []) as string[],
          lookup.usageType ? (u) => lookup.usageType!(u, region) : undefined,
        );
        if (found) {
          rates[key] = { value: found.value, unit: found.unit, source: 'live', note: found.note };
          continue;
        }
      } catch (err) {
        console.warn(`[RateCard] ${key} lookup failed:`, (err as Error)?.message);
      }
    }

    rates[key] = {
      ...FALLBACK[key],
      source: 'fallback',
      note: lookup
        ? `AWS did not return a price; using the list price recorded ${FALLBACK_AS_OF}.`
        : `No Pricing API lookup defined; using the list price recorded ${FALLBACK_AS_OF}.`,
    };
  }

  const card: RateCard = {
    region,
    rates,
    degraded: Object.values(rates).some((r) => r.source === 'fallback'),
    fetchedAt: new Date().toISOString(),
  };

  cache.set(region, { card, at: Date.now() });

  const live = Object.values(rates).filter((r) => r.source === 'live').length;
  console.log(`[RateCard] ${region}: ${live}/${Object.keys(rates).length} rates live from AWS`);

  return card;
}

/** Test seam: rates are cached for a day, which outlives any test. */
export function __clearRateCache(): void {
  cache.clear();
}
