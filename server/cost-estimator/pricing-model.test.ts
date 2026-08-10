/**
 * These numbers are shown to someone deciding what to build, and then feed the
 * deployment agent. The tests below are mostly about the two ways the previous
 * calculator lied: a constant presented as a calculation, and an unpriced
 * service presented as a free one.
 */
import { describe, it, expect } from 'vitest';
import {
  buildUsageModel, priceLambda, priceApiGateway, priceDynamoDb, priceSqs,
  priceWaf, priceCloudWatch, priceRoute53, priceCloudFront, priceS3, priceUnknown,
} from './pricing-model';
import { priceLayer } from './service-pricing';

/** The user's stated scenario: a simple application, 500 daily users. */
const usage = buildUsageModel({ dailyActiveUsers: 500 });

describe('the usage model', () => {
  it('turns stated users into monthly requests', () => {
    // 500 users × 20 requests × 30.4 days
    expect(usage.monthlyRequests).toBe(304_000);
  });

  it('scales with the audience, which is the whole point', () => {
    // The old calculator returned $10 for Lambda at any size. Every
    // request-priced line must move when this number moves.
    const bigger = buildUsageModel({ dailyActiveUsers: 5000 });
    expect(bigger.monthlyRequests).toBe(usage.monthlyRequests * 10);
  });

  it('falls back to a modest default rather than zero', () => {
    // Zero users would make every usage-priced service free, which is the
    // failure mode this whole module exists to remove.
    expect(buildUsageModel({}).monthlyRequests).toBeGreaterThan(0);
    expect(buildUsageModel({ dailyActiveUsers: -5 }).dailyActiveUsers).toBeGreaterThan(0);
  });
});

describe('Lambda', () => {
  it('is free at this scale, because the always-free allowance covers it', () => {
    // 304k invocations against 1M free requests and 400,000 free GB-seconds.
    // The old calculator charged a flat $10 for exactly this.
    expect(priceLambda(usage).cost).toBe(0);
  });

  it('charges for provisioned concurrency, which is billed whether used or not', () => {
    // This is the line item that made the user's estimate look expensive, and
    // it is pure cost at 0.1 requests per second.
    const withPc = priceLambda(usage, { provisionedConcurrency: 1, memoryMb: 512 });
    expect(withPc.cost).toBeGreaterThan(5);
    expect(withPc.basis).toMatch(/provisioned concurrency held all month/);
  });

  it('charges once the free allowance is exhausted', () => {
    const busy = buildUsageModel({ dailyActiveUsers: 2_000_000 });
    expect(priceLambda(busy).cost).toBeGreaterThan(0);
  });
});

describe('the services that were reported as free', () => {
  it('WAF is never free — the web ACL alone is monthly', () => {
    const waf = priceWaf(usage);
    expect(waf.cost).toBeGreaterThanOrEqual(7);
    expect(waf.basis).toMatch(/web ACL/);
  });

  it('CloudWatch charges for log ingestion', () => {
    expect(priceCloudWatch({ logsGbPerMonth: 3 }).cost).toBeGreaterThan(1);
  });

  it('Route 53 charges for the hosted zone', () => {
    expect(priceRoute53(usage).cost).toBeGreaterThan(0);
  });
});

describe('the request-priced services that were constants', () => {
  it('prices API Gateway from actual requests', () => {
    // 304k requests at $1/million ≈ $0.30, not the flat $10 that was shown.
    const api = priceApiGateway(usage);
    expect(api.cost).toBeLessThan(1);
    expect(api.cost).toBeGreaterThan(0);
  });

  it('charges REST more than HTTP, because it costs more', () => {
    expect(priceApiGateway(usage, { type: 'rest' }).cost!)
      .toBeGreaterThan(priceApiGateway(usage, { type: 'http' }).cost!);
  });

  it('prices DynamoDB from reads and writes, not a flat $25', () => {
    const db = priceDynamoDb(usage, { storageGb: 2, pitr: true });
    expect(db.cost).toBeLessThan(5);
    expect(db.cost).toBeGreaterThan(0);
  });

  it('leaves SQS free below the always-free allowance', () => {
    expect(priceSqs(usage).cost).toBe(0);
    expect(priceSqs(usage).basis).toMatch(/always-free/);
  });
});

describe('unpriced services', () => {
  it('report null rather than zero', () => {
    // The distinction that matters: a caller adding this to a total must not be
    // able to mistake "we do not know" for "it is free".
    const unknown = priceUnknown('Amazon Braket');
    expect(unknown.cost).toBeNull();
    expect(unknown.basis).toMatch(/excluded from the total rather than counted as free/);
  });
});

describe('a line naming two services', () => {
  it('charges for both, instead of stopping at the first', () => {
    // "Amazon S3 + CloudFront" priced 2 GB of storage at $0.05 and silently
    // dropped 30 GB of CDN transfer worth roughly fifty times more.
    const components = priceLayer(
      { layer: 'Frontend', service: 'Amazon S3 + CloudFront', storageSize: 2, dataTransfer: 30 },
      usage,
    );

    expect(components.map((c) => c.service).sort()).toEqual(['cloudfront', 's3']);
    const cdn = components.find((c) => c.service === 'cloudfront')!;
    expect(cdn.line.cost).toBeGreaterThan(2);
  });

  it('recognises Route 53 written the way AWS writes it', () => {
    // The old test was `includes('route53')`, and the service is "Amazon
    // Route 53" — with a space. It never matched, so it was always $0.00.
    expect(priceLayer({ layer: 'DNS', service: 'Amazon Route 53' }, usage).map((c) => c.service))
      .toContain('route53');
  });

  it('recognises WAF and CloudWatch, which matched nothing at all', () => {
    expect(priceLayer({ layer: 'Security', service: 'AWS WAF' }, usage).map((c) => c.service)).toContain('waf');
    expect(priceLayer({ layer: 'Monitoring', service: 'Amazon CloudWatch' }, usage).map((c) => c.service)).toContain('cloudwatch');
  });

  it('returns nothing for a service it does not know', () => {
    expect(priceLayer({ layer: 'Quantum', service: 'Amazon Braket' }, usage)).toEqual([]);
  });
});

describe('the user’s actual estimate', () => {
  it('comes to a fraction of the $50.28 that was quoted', () => {
    // Same architecture, priced from 500 daily users instead of constants.
    const lines = [
      { layer: 'Frontend', service: 'Amazon S3 + CloudFront', storageSize: 2, dataTransfer: 30 },
      { layer: 'API', service: 'Amazon API Gateway', dataTransfer: 3 },
      { layer: 'Compute', service: 'AWS Lambda', memoryMb: 512, durationMs: 200 },
      { layer: 'Database', service: 'Amazon DynamoDB', storageSize: 2, pitr: true },
      { layer: 'Storage', service: 'Amazon S3', storageSize: 10 },
      { layer: 'Queue', service: 'Amazon SQS' },
      { layer: 'Security', service: 'AWS WAF' },
      { layer: 'DNS', service: 'Amazon Route 53' },
      { layer: 'Monitoring', service: 'Amazon CloudWatch', storageSize: 3 },
    ];

    const total = lines
      .flatMap((l) => priceLayer(l as never, usage))
      .reduce((sum, c) => sum + (c.line.cost ?? 0), 0);

    expect(total).toBeLessThan(20);
    // And not zero, which is the other way this could be wrong.
    expect(total).toBeGreaterThan(5);
  });
});

describe('sizing values the model spelled differently', () => {
  it('reads storageSizeGB, not just storageSize', () => {
    // The model was asked for "storage size in GB" and answered with
    // storageSizeGB. Reading only storageSize found nothing and priced a real
    // bucket at $0.00 — a service reported free because of a field name.
    const [s3] = priceLayer({ layer: 'Storage', service: 'Amazon S3', storageSizeGB: 10 } as never, usage);
    expect(s3.line.cost).toBeCloseTo(0.23, 2);
  });

  it('reads the log volume CloudWatch was actually given', () => {
    // Otherwise it fell back to a 3 GB default and overcharged by ~14x.
    const [cw] = priceLayer(
      { layer: 'Monitoring', service: 'Amazon CloudWatch', logIngestGBPerMonth: 0.1125 } as never,
      usage,
    );
    expect(cw.line.cost).toBeLessThan(0.2);
  });

  it('reads dataTransferOutGB for a CDN', () => {
    const [cdn] = priceLayer({ layer: 'CDN', service: 'Amazon CloudFront', dataTransferOutGB: 30 } as never, usage);
    expect(cdn.line.cost).toBeGreaterThan(2);
  });
});

describe('a size that is missing entirely', () => {
  it('reports S3 as unpriced rather than free', () => {
    const [s3] = priceLayer({ layer: 'Storage', service: 'Amazon S3' } as never, usage);
    expect(s3.line.cost).toBeNull();
    expect(s3.line.basis).toMatch(/No storage size/);
  });

  it('reports a CDN as unpriced rather than charging only for requests', () => {
    const [cdn] = priceLayer({ layer: 'CDN', service: 'Amazon CloudFront' } as never, usage);
    expect(cdn.line.cost).toBeNull();
  });
});
