/**
 * Which pricing model each estimated line uses.
 *
 * The previous version was an if/else chain over substrings, and two of its
 * properties were quietly wrong.
 *
 * It stopped at the first match, so "Amazon S3 + CloudFront" was priced as a
 * bucket and the CDN transfer — the larger of the two — was dropped without
 * trace. A line naming two services is charged for both here.
 *
 * And an unmatched service produced zero, which the total then absorbed. WAF,
 * CloudWatch and Route 53 were all reported at $0.00 that way; Route 53 because
 * the chain looked for "route53" while AWS writes it "Route 53". Matching is on
 * word-ish boundaries now, and anything unrecognised is reported as unpriced
 * rather than free.
 */
import type { ArchitectureLayer } from './architecture-generator';
import type { RateCard } from './rate-card';
import {
  buildUsageModel, withRequests, priceApiGateway, priceCloudFront, priceCloudWatch, priceDynamoDb,
  priceLambda, priceRoute53, priceS3, priceSqs, priceWaf, priceUnknown,
  type PricedLine, type UsageModel,
} from './pricing-model';

export type Category = 'compute' | 'database' | 'storage' | 'network' | 'other';

export interface PricedComponent {
  service: string;
  category: Category;
  line: PricedLine;
}

/** Config the model may attach to a line; all optional, all sanity-checked. */
type LayerExtras = ArchitectureLayer & {
  memoryMb?: number;
  durationMs?: number;
  provisionedConcurrency?: number;
  managedRuleGroups?: number;
  healthChecks?: number;
  pitr?: boolean;
  [key: string]: unknown;
};

/**
 * Sizing inputs, under whatever name the model gave them.
 *
 * A model asked for "storage size in GB" will happily answer with
 * `storageSizeGB`, and reading only `storageSize` then finds nothing and prices
 * one gigabyte of S3 at zero — a service reported as free because of a field
 * name. That is the same failure as the unmatched services this module was
 * written to fix, arriving through the shape of the JSON instead of the shape
 * of the if/else.
 *
 * Aliases are read in order of specificity. Nothing is invented: when no
 * spelling is present the caller is told the value is missing rather than given
 * a zero.
 */
const ALIASES: Record<string, string[]> = {
  storageSize: ['storageSize', 'storageSizeGB', 'storageGB', 'storageGb', 'sizeGB'],
  dataTransfer: ['dataTransfer', 'dataTransferGB', 'dataTransferOutGB', 'dataTransferOutGb', 'egressGB'],
  logsGb: ['logIngestGBPerMonth', 'logsGBPerMonth', 'logIngestGb', 'logsGb'],
  memoryMb: ['memoryMb', 'memoryMB', 'memorySizeMB'],
  durationMs: ['durationMs', 'durationMS', 'averageDurationMs'],
  provisionedConcurrency: ['provisionedConcurrency', 'provisionedConcurrencyCount'],
  healthChecks: ['healthChecks', 'healthCheckCount'],
  managedRuleGroups: ['managedRuleGroups', 'managedRuleGroupCount', 'ruleGroups'],
  monthlyRequests: ['monthlyRequests', 'monthlyInvocations', 'requestsPerMonth'],
};

function pick(layer: LayerExtras, field: keyof typeof ALIASES): number | undefined {
  for (const name of ALIASES[field]) {
    const v = layer[name];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  }
  return undefined;
}

/**
 * Matchers, in the order a line is scanned. Every matcher that hits contributes
 * a component — this is not a first-match-wins chain.
 */
const MATCHERS: Array<{
  key: string;
  category: Category;
  test: RegExp;
  price: (layer: LayerExtras, usage: UsageModel, card?: RateCard) => PricedLine;
}> = [
  {
    key: 'lambda', category: 'compute', test: /\blambda\b/i,
    price: (l, u, card) => priceLambda(u, { card, 
      memoryMb: pick(l, 'memoryMb'),
      durationMs: pick(l, 'durationMs'),
      provisionedConcurrency: pick(l, 'provisionedConcurrency'),
    }),
  },
  {
    key: 'api-gateway', category: 'network', test: /\bapi\s*gateway\b/i,
    price: (l, u, card) => priceApiGateway(u, { card,  type: /\brest\b/i.test(l.configuration ?? '') ? 'rest' : 'http' }),
  },
  {
    key: 'dynamodb', category: 'database', test: /\bdynamo\s*db\b/i,
    price: (l, u, card) => priceDynamoDb(u, { card, 
      storageGb: pick(l, 'storageSize'),
      pitr: l.pitr ?? /\bpitr\b|point-in-time/i.test(l.configuration ?? ''),
    }),
  },
  {
    key: 'sqs', category: 'other', test: /\bsqs\b|simple queue/i,
    price: (_l, u, card) => priceSqs(u, { card }),
  },
  {
    // Matches "AWS WAF" and "WAF"; the word boundary keeps it off "software".
    key: 'waf', category: 'other', test: /\bwaf\b|web application firewall/i,
    price: (l, u, card) => priceWaf(u, { card,  managedRuleGroups: pick(l, 'managedRuleGroups') }),
  },
  {
    key: 'cloudwatch', category: 'other', test: /\bcloud\s*watch\b|\bmonitoring\b/i,
    price: (l, _u, card) => priceCloudWatch({ card,  logsGbPerMonth: pick(l, 'logsGb') ?? pick(l, 'storageSize') }),
  },
  {
    // "Route 53" with a space is how AWS writes it, and is what the old
    // substring test for "route53" could never match.
    key: 'route53', category: 'network', test: /\broute\s*53\b/i,
    price: (l, u, card) => priceRoute53(u, { card,  healthChecks: pick(l, 'healthChecks') }),
  },
  {
    key: 'cloudfront', category: 'network', test: /\bcloud\s*front\b|\bcdn\b/i,
    price: (l, u, card) => priceCloudFront(u, { card,  dataTransferGb: pick(l, 'dataTransfer') }),
  },
  {
    // Last of the S3 family so the more specific bucket-ish matches above win
    // their own components first; this one only ever prices storage.
    key: 's3', category: 'storage', test: /\bs3\b|simple storage/i,
    price: (l, _u, card) => priceS3({ card,  storageGb: pick(l, 'storageSize') }),
  },
];

/** Services priced elsewhere, via the live AWS Price List API. */
export const INSTANCE_PRICED = /\bec2\b|\brds\b|\baurora\b|\belasticache\b|\bredis\b|\bmemcached\b|load balancer|\balb\b|\belb\b/i;

/**
 * Prices one estimated line, which may name more than one service.
 *
 * Returns every component it recognised. An empty result means nothing was
 * recognised, and the caller must present that as unpriced rather than free.
 */
export function priceLayer(layer: LayerExtras, usage: UsageModel, card?: RateCard): PricedComponent[] {
  const text = `${layer.service} ${layer.layer ?? ''}`;

  // A service may state its own volume — a queue handling a fraction of the
  // application's traffic, say — and is priced on that rather than on the
  // application total.
  const forThisLayer = withRequests(usage, pick(layer, 'monthlyRequests'));

  const components = MATCHERS
    .filter((m) => m.test.test(text))
    .map((m) => ({ service: m.key, category: m.category, line: m.price(layer, forThisLayer, card) }));

  return components;
}

export { buildUsageModel, withRequests, priceUnknown, pick as sizingValue };
export type { UsageModel, PricedLine };
