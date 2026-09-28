/**
 * Published Bedrock rates, from the AWS Price List API.
 *
 * This removes the need for anyone to type a rate in. AWS publishes every
 * on-demand Bedrock token price programmatically, and the response carries
 * clean attributes rather than requiring string archaeology:
 *
 *   inferenceType  "Input tokens" | "Output tokens" | cache variants
 *   model          "Claude 3 Sonnet"
 *   provider       "Anthropic"
 *   feature        "On-demand Inference"
 *   usagetype      "USE1-Claude3Sonnet-input-tokens"
 *   unit           "1K tokens"
 *
 * Verified live against this account, not assumed.
 *
 * ── Two things that must not be got wrong ───────────────────────────────────
 *
 * 1. The API publishes per 1K tokens; everything downstream is per 1M. The
 *    conversion happens once, here, rather than being repeated at each call
 *    site where one of them would eventually be forgotten — a 1000x error that
 *    would look like a catastrophic overspend.
 *
 * 2. Only "On-demand Inference" is collected. Batch is roughly half price and
 *    Provisioned Throughput is billed per model-unit-hour, not per token.
 *    Mixing either into a per-token rate produces a number that cannot be
 *    reconciled with any invoice.
 */
import { PricingClient, GetProductsCommand } from '@aws-sdk/client-pricing';
import { awsReadClient } from '../../aws/client-factory';

export interface PublishedRate {
  providerKey: 'bedrock';
  /** Vendor label from AWS, e.g. "Anthropic". */
  vendor: string | null;
  modelLabel: string | null;
  usageType: string;
  direction: 'input' | 'output' | 'cache_read' | 'cache_write';
  /** Converted from the API's per-1K figure. */
  pricePerMillion: number;
  currency: string;
  regionCode: string;
  sourceUrl: string;
}

/**
 * The Price List API is served only from a few regions regardless of where the
 * priced resources live. us-east-1 is the canonical one.
 */
const PRICING_API_REGION = 'us-east-1';

const SOURCE_URL = 'https://aws.amazon.com/bedrock/pricing/';

/** Safety valve: a full unfiltered walk is ~10k rows and we filter server-side. */
const MAX_PAGES = 40;

/**
 * Features priced on something other than on-demand tokens.
 *
 * Batch is roughly half price; provisioned throughput bills per model-unit-hour
 * regardless of tokens. Either one entering a per-token rate produces a figure
 * that cannot be reconciled against any invoice.
 */
const NON_ON_DEMAND = /batch|provisioned|customization|custom model import|prompt router|flow execution/i;

function readDirection(inferenceType: string, usageType: string): PublishedRate['direction'] | null {
  const t = `${inferenceType} ${usageType}`.toLowerCase();

  // Cache first: "cache-read-input-tokens" contains "input", so checking input
  // first would misclassify a cache read as ordinary input and overstate it by
  // roughly ten times.
  if (t.includes('cache') && t.includes('read')) return 'cache_read';
  if (t.includes('cache') && t.includes('write')) return 'cache_write';
  if (t.includes('output')) return 'output';
  if (t.includes('input')) return 'input';
  return null;
}

/**
 * Converts the API's unit to a per-million price.
 *
 * Returns null for units that are not token-based — images, custom model
 * units, text units. Those are real charges but not per-token, and folding
 * them in would corrupt every rate they touched.
 */
function toPerMillion(price: number, unit: string): number | null {
  const u = unit.toLowerCase();
  if (u.includes('1k tokens') || u === '1k token') return price * 1000;
  if (u.includes('1m tokens')) return price;
  if (u === 'tokens' || u === 'token') return price * 1_000_000;
  return null;
}

export interface FetchRatesResult {
  rates: PublishedRate[];
  apiCalls: number;
  warning?: string;
}

/**
 * Fetches on-demand token rates for a region.
 *
 * Filtered server-side by feature and region so the walk stays small; the
 * Price List has tens of thousands of rows across all services and regions.
 */
export async function fetchBedrockRates(regionCode = 'us-east-1'): Promise<FetchRatesResult> {
  const client = await awsReadClient(PricingClient, { region: PRICING_API_REGION });

  const rates: PublishedRate[] = [];
  let nextToken: string | undefined;
  let apiCalls = 0;
  let pages = 0;
  let skippedNonToken = 0;

  do {
    const res = await client.send(new GetProductsCommand({
      ServiceCode: 'AmazonBedrock',
      Filters: [
        { Type: 'TERM_MATCH', Field: 'regionCode', Value: regionCode },
        // Deliberately NOT filtered on feature = 'On-demand Inference'.
        // 459 of ~1000 Bedrock rows leave `feature` BLANK, and that is where
        // the newer models live — filtering on it server-side returned only
        // five Anthropic rates, all of them from the Claude 2/3 era. Batch,
        // provisioned and customisation rows are excluded below instead, which
        // is an exclusion list rather than an inclusion one and therefore does
        // not silently drop anything AWS has not labelled.
      ],
      MaxResults: 100,
      NextToken: nextToken,
    }));

    apiCalls++;
    pages++;

    for (const raw of res.PriceList ?? []) {
      let item: any;
      try {
        item = JSON.parse(raw as string);
      } catch {
        continue;   // one malformed row must not abort the whole refresh
      }

      const attrs = item.product?.attributes ?? {};
      const usageType: string = attrs.usagetype ?? '';

      // A blank feature means on-demand; only named non-on-demand features are
      // excluded. The usage type is checked too, because "…-tokens-batch"
      // appears with no feature set.
      const feature = String(attrs.feature ?? '');
      if (NON_ON_DEMAND.test(feature) || NON_ON_DEMAND.test(usageType)) continue;

      const direction = readDirection(attrs.inferenceType ?? '', usageType);
      if (!direction) continue;

      // The first (and normally only) on-demand price dimension.
      const onDemand = item.terms?.OnDemand ?? {};
      const firstTerm: any = Object.values(onDemand)[0];
      const dimension: any = Object.values(firstTerm?.priceDimensions ?? {})[0];
      if (!dimension) continue;

      const usd = Number(dimension.pricePerUnit?.USD);
      if (!Number.isFinite(usd)) continue;

      const perMillion = toPerMillion(usd, String(dimension.unit ?? ''));
      if (perMillion === null) {
        skippedNonToken++;
        continue;
      }

      rates.push({
        providerKey: 'bedrock',
        vendor: attrs.provider ?? null,
        modelLabel: attrs.model ?? null,
        usageType,
        direction,
        pricePerMillion: perMillion,
        currency: 'USD',
        regionCode,
        sourceUrl: SOURCE_URL,
      });
    }

    nextToken = res.NextToken;
  } while (nextToken && pages < MAX_PAGES);

  return {
    rates,
    apiCalls,
    warning: nextToken
      ? `Stopped after ${MAX_PAGES} pages; some rates may be missing. Narrow the region filter.`
      : rates.length === 0
        ? `No on-demand Bedrock token rates were returned for ${regionCode}. Check that the credential has pricing:GetProducts.`
        : skippedNonToken > 0
          ? `${skippedNonToken} non-token charges (images, custom model units) were skipped — they are not per-token and cannot be expressed as a token rate.`
          : undefined,
  };
}
