/**
 * Usage-driven AWS pricing.
 *
 * The calculator this replaces returned constants: Lambda was $10, DynamoDB
 * $25, SQS $5, API Gateway $10 — the same figures for five users or five
 * million, which is why every estimate came out in round numbers. Services it
 * had no branch for, including WAF and CloudWatch, fell through to zero and
 * were presented as free.
 *
 * Both failures are the same mistake in opposite directions: a number was
 * produced where no calculation existed. Everything here either computes a cost
 * from stated usage or reports that it could not, and the difference is visible
 * to the caller rather than smoothed into a total.
 *
 * Every rate is an on-demand list price for us-east-1, recorded with the date
 * it was taken. They are not fetched live — for the request-priced services
 * below the AWS Price List API is awkward enough that a wrong parse would be
 * less honest than a dated constant that says it is one.
 */

import type { RateCard } from './rate-card';

/**
 * Resolves a rate: the fetched price when there is one, the dated constant
 * otherwise. Passing no card is the offline path and uses constants throughout.
 */
function rate(card: RateCard | undefined, key: keyof RateCard['rates'], fallback: number): number {
  const found = card?.rates?.[key];
  return typeof found?.value === 'number' && found.value > 0 ? found.value : fallback;
}

/** us-east-1 on-demand list prices, taken 2026-06. Superseded by a live card. */
export const RATES = {
  lambda: {
    perRequest: 0.20 / 1_000_000,
    perGbSecond: 0.0000166667,
    provisionedPerGbSecond: 0.0000041667,
    freeRequests: 1_000_000,
    freeGbSeconds: 400_000,
  },
  apiGateway: {
    httpPerMillion: 1.00,
    restPerMillion: 3.50,
  },
  dynamodb: {
    writeUnitPerMillion: 1.25,
    readUnitPerMillion: 0.25,
    storagePerGb: 0.25,
    pitrPerGb: 0.20,
    freeStorageGb: 25,
  },
  sqs: { perMillion: 0.40, freeRequests: 1_000_000 },
  sns: { perMillion: 0.50, freeRequests: 1_000_000 },
  waf: { webAclPerMonth: 5.00, rulePerMonth: 1.00, perMillionRequests: 0.60 },
  cloudwatch: {
    logIngestPerGb: 0.50,
    logStorePerGb: 0.03,
    dashboardPerMonth: 3.00,
    freeDashboards: 3,
    alarmPerMonth: 0.10,
    freeAlarms: 10,
  },
  route53: { hostedZonePerMonth: 0.50, perMillionQueries: 0.40, healthCheckPerMonth: 0.50 },
  cloudfront: { perGbOut: 0.085, perTenThousandRequests: 0.0000075 * 10_000 },
  s3: { standardPerGb: 0.023, putPer1000: 0.005, getPer1000: 0.0004 },
} as const;

/**
 * How much the application is actually used.
 *
 * Derived from the stated audience rather than invented per service, so one
 * change to the user count moves every request-priced line together — which is
 * what makes an estimate answerable to its own assumptions.
 */
export interface UsageModel {
  dailyActiveUsers: number;
  requestsPerUserPerDay: number;
  monthlyRequests: number;
  /** Set when the model's own arithmetic did not match its inputs. */
  discrepancy?: string;
}

/** A modest default: a simple application, not a chat client. */
export const DEFAULT_REQUESTS_PER_USER_PER_DAY = 20;

/**
 * Thirty, not 30.44.
 *
 * Slightly less accurate than the average month, and worth it: the architecture
 * prompt tells the model to compute users x requests x 30, so using anything
 * else would put the two permanently 1.5% apart and make every returned figure
 * look like an arithmetic error. A reader can also check this one on paper.
 */
const DAYS_PER_MONTH = 30;

/** How far the model's own total may drift before it is treated as a mistake. */
const TOLERANCE = 0.05;

export function buildUsageModel(input: {
  dailyActiveUsers?: number | null;
  requestsPerUserPerDay?: number | null;
  monthlyRequests?: number | null;
}): UsageModel {
  const users = positive(input.dailyActiveUsers) ?? 100;
  const perUser = positive(input.requestsPerUserPerDay) ?? DEFAULT_REQUESTS_PER_USER_PER_DAY;
  const derived = Math.round(users * perUser * DAYS_PER_MONTH);

  const stated = positive(input.monthlyRequests);
  if (stated == null) {
    return { dailyActiveUsers: users, requestsPerUserPerDay: perUser, monthlyRequests: derived };
  }

  // The model is asked to do this multiplication and to reuse one figure across
  // every request-priced service. Taking its answer on trust would let a slip
  // in that one number move the whole estimate, so it is checked against its
  // own stated inputs — and the arithmetic wins, because the cost follows the
  // requests rather than the label.
  const drift = Math.abs(stated - derived) / Math.max(derived, 1);
  if (drift <= TOLERANCE) {
    return { dailyActiveUsers: users, requestsPerUserPerDay: perUser, monthlyRequests: stated };
  }

  return {
    dailyActiveUsers: users,
    requestsPerUserPerDay: perUser,
    monthlyRequests: derived,
    discrepancy:
      `The architecture stated ${stated.toLocaleString('en-US')} requests/month, but ` +
      `${users.toLocaleString('en-US')} users x ${perUser} requests x ${DAYS_PER_MONTH} days is ` +
      `${derived.toLocaleString('en-US')}. The calculated figure was used.`,
  };
}

/** The same assumptions, for a service with its own request volume. */
export function withRequests(usage: UsageModel, monthlyRequests?: number | null): UsageModel {
  const own = positive(monthlyRequests);
  return own == null ? usage : { ...usage, monthlyRequests: own };
}

const positive = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;

/**
 * The outcome of pricing one service.
 *
 * `cost: null` means "not priced", which is deliberately not the same value as
 * zero. A caller that cannot tell them apart will publish an unpriced service
 * as free, which is how WAF came to be listed at $0.00.
 */
export interface PricedLine {
  cost: number | null;
  /** How the number was reached, in the reader's terms. */
  basis: string;
}

const priced = (cost: number, basis: string): PricedLine => ({ cost: Number(cost.toFixed(2)), basis });
const unpriced = (basis: string): PricedLine => ({ cost: null, basis });

/* -------------------------------------------------------------------------- */
/*  Per-service pricing                                                        */
/* -------------------------------------------------------------------------- */

export function priceLambda(usage: UsageModel, opts: {
  memoryMb?: number; durationMs?: number; provisionedConcurrency?: number; card?: RateCard;
} = {}): PricedLine {
  const perRequest = rate(opts.card, 'lambdaRequest', RATES.lambda.perRequest);
  const perGbSecond = rate(opts.card, 'lambdaGbSecond', RATES.lambda.perGbSecond);
  const memoryGb = (opts.memoryMb ?? 512) / 1024;
  const durationSec = (opts.durationMs ?? 200) / 1000;

  const billableRequests = Math.max(0, usage.monthlyRequests - RATES.lambda.freeRequests);
  const gbSeconds = usage.monthlyRequests * memoryGb * durationSec;
  const billableGbSeconds = Math.max(0, gbSeconds - RATES.lambda.freeGbSeconds);

  let cost = billableRequests * perRequest + billableGbSeconds * perGbSecond;

  const parts = [
    `${usage.monthlyRequests.toLocaleString('en-US')} invocations/month at ${opts.memoryMb ?? 512} MB for ${opts.durationMs ?? 200} ms`,
    billableRequests === 0 && billableGbSeconds === 0 ? 'entirely within the always-free allowance' : null,
  ];

  // Charged for every second it is held ready, whether or not anything calls it.
  // At low request rates this is usually the whole Lambda bill.
  const provisioned = positive(opts.provisionedConcurrency);
  if (provisioned) {
    const provisionedCost = provisioned * memoryGb * 730 * 3600 * RATES.lambda.provisionedPerGbSecond;
    cost += provisionedCost;
    parts.push(`plus $${provisionedCost.toFixed(2)} for ${provisioned} provisioned concurrency held all month`);
  }

  return priced(cost, parts.filter(Boolean).join(', '));
}

export function priceApiGateway(usage: UsageModel, opts: { type?: 'http' | 'rest'; card?: RateCard } = {}): PricedLine {
  const rest = opts.type === 'rest';
  const perRequest = rest
    ? rate(opts.card, 'apiGatewayRestRequest', RATES.apiGateway.restPerMillion / 1_000_000)
    : rate(opts.card, 'apiGatewayHttpRequest', RATES.apiGateway.httpPerMillion / 1_000_000);
  const cost = usage.monthlyRequests * perRequest;
  const perMillion = (perRequest * 1_000_000).toFixed(2);
  return priced(cost, `${usage.monthlyRequests.toLocaleString('en-US')} requests/month on ${rest ? 'REST' : 'HTTP'} API at $${perMillion}/million`);
}

export function priceDynamoDb(usage: UsageModel, opts: {
  storageGb?: number; writesPerRequest?: number; readsPerRequest?: number; pitr?: boolean; card?: RateCard;
} = {}): PricedLine {
  const perWrite = rate(opts.card, 'dynamoWriteUnit', RATES.dynamodb.writeUnitPerMillion / 1_000_000);
  const perRead = rate(opts.card, 'dynamoReadUnit', RATES.dynamodb.readUnitPerMillion / 1_000_000);
  const perStorageGb = rate(opts.card, 'dynamoStorageGb', RATES.dynamodb.storagePerGb);
  const storageGb = opts.storageGb ?? 1;
  // A typical read-heavy application: one write and three reads per request.
  const writes = usage.monthlyRequests * (opts.writesPerRequest ?? 1);
  const reads = usage.monthlyRequests * (opts.readsPerRequest ?? 3);

  const writeCost = writes * perWrite;
  const readCost = reads * perRead;
  const billableStorage = Math.max(0, storageGb - RATES.dynamodb.freeStorageGb);
  const storageCost = billableStorage * perStorageGb;
  const pitrCost = opts.pitr ? storageGb * RATES.dynamodb.pitrPerGb : 0;

  const parts = [`${writes.toLocaleString('en-US')} writes and ${reads.toLocaleString('en-US')} reads/month on-demand`];
  if (billableStorage > 0) parts.push(`${storageGb} GB stored`);
  else parts.push(`${storageGb} GB stored, within the 25 GB free allowance`);
  if (opts.pitr) parts.push('point-in-time recovery enabled');

  return priced(writeCost + readCost + storageCost + pitrCost, parts.join(', '));
}

export function priceSqs(usage: UsageModel, opts: { requestsPerAppRequest?: number; card?: RateCard } = {}): PricedLine {
  const perRequest = rate(opts.card, 'sqsRequest', RATES.sqs.perMillion / 1_000_000);
  const requests = usage.monthlyRequests * (opts.requestsPerAppRequest ?? 1);
  const billable = Math.max(0, requests - RATES.sqs.freeRequests);
  const cost = billable * perRequest;
  return priced(cost, billable === 0
    ? `${requests.toLocaleString('en-US')} requests/month, within the 1 million always-free allowance`
    : `${requests.toLocaleString('en-US')} requests/month at $${RATES.sqs.perMillion}/million`);
}

export function priceWaf(usage: UsageModel, opts: { managedRuleGroups?: number; card?: RateCard } = {}): PricedLine {
  const perAcl = rate(opts.card, 'wafWebAcl', RATES.waf.webAclPerMonth);
  const perRule = rate(opts.card, 'wafRule', RATES.waf.rulePerMonth);
  // Never free, whatever the traffic: the web ACL is billed monthly on its own.
  const rules = opts.managedRuleGroups ?? 2;
  const cost = perAcl
    + rules * perRule
    + (usage.monthlyRequests / 1_000_000) * RATES.waf.perMillionRequests;
  return priced(cost, `one web ACL at $${perAcl}/month plus ${rules} rule group(s), and ${usage.monthlyRequests.toLocaleString('en-US')} inspected requests`);
}

export function priceCloudWatch(opts: {
  logsGbPerMonth?: number; dashboards?: number; alarms?: number; card?: RateCard;
} = {}): PricedLine {
  const perLogGb = rate(opts.card, 'cloudwatchLogIngestGb', RATES.cloudwatch.logIngestPerGb);
  const logsGb = opts.logsGbPerMonth ?? 3;
  const dashboards = Math.max(0, (opts.dashboards ?? 1) - RATES.cloudwatch.freeDashboards);
  const alarms = Math.max(0, (opts.alarms ?? 5) - RATES.cloudwatch.freeAlarms);

  const cost = logsGb * perLogGb
    + logsGb * RATES.cloudwatch.logStorePerGb
    + dashboards * RATES.cloudwatch.dashboardPerMonth
    + alarms * RATES.cloudwatch.alarmPerMonth;

  return priced(cost, `${logsGb} GB of logs ingested and stored${dashboards > 0 ? `, ${dashboards} chargeable dashboard(s)` : ''}${alarms > 0 ? `, ${alarms} chargeable alarm(s)` : ''}`);
}

export function priceRoute53(usage: UsageModel, opts: { hostedZones?: number; healthChecks?: number; card?: RateCard } = {}): PricedLine {
  const perZone = rate(opts.card, 'route53HostedZone', RATES.route53.hostedZonePerMonth);
  const zones = opts.hostedZones ?? 1;
  const checks = opts.healthChecks ?? 0;
  // Roughly one DNS lookup per request once caching is taken into account.
  const queries = usage.monthlyRequests;
  const cost = zones * perZone
    + checks * RATES.route53.healthCheckPerMonth
    + (queries / 1_000_000) * RATES.route53.perMillionQueries;
  return priced(cost, `${zones} hosted zone(s)${checks ? `, ${checks} health check(s)` : ''}, ${queries.toLocaleString('en-US')} queries/month`);
}

export function priceCloudFront(usage: UsageModel, opts: { dataTransferGb?: number; card?: RateCard } = {}): PricedLine {
  const perGb = rate(opts.card, 'cloudfrontTransferGb', RATES.cloudfront.perGbOut);
  // Requests alone are pennies; transfer is the bill. Without it the number
  // would be misleadingly small rather than merely incomplete.
  if (opts.dataTransferGb == null) {
    return unpriced('No data transfer figure was given for the CDN, so it is not priced. Transfer out is $0.085/GB.');
  }
  const gb = opts.dataTransferGb;
  const cost = gb * perGb
    + (usage.monthlyRequests / 10_000) * RATES.cloudfront.perTenThousandRequests;
  return priced(cost, `${gb} GB served to the internet plus ${usage.monthlyRequests.toLocaleString('en-US')} requests`);
}

export function priceS3(opts: { storageGb?: number; card?: RateCard } = {}): PricedLine {
  const perGb = rate(opts.card, 's3StorageGb', RATES.s3.standardPerGb);
  // No size given is not the same as no storage. Pricing it at zero would put a
  // service on the estimate at $0.00 for want of a number, which is the shape of
  // mistake this module exists to stop.
  if (opts.storageGb == null) {
    return unpriced('No storage size was given for this bucket, so it is not priced. Storage is $0.023/GB/month.');
  }
  return priced(opts.storageGb * perGb, `${opts.storageGb} GB stored at $${perGb}/GB`);
}

/** For a service nothing here knows how to price. */
export function priceUnknown(service: string): PricedLine {
  return unpriced(`No pricing model for "${service}". It is excluded from the total rather than counted as free.`);
}
