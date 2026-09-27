/**
 * The contract every AI usage source implements.
 *
 * Five providers, five completely different sources — CloudWatch metrics, Azure
 * Monitor, two vendor admin APIs, and GCP monitoring — but the shape of what
 * they return is the same: how many tokens, how many calls, for which model, in
 * which period. Normalising at the adapter boundary means the pricing engine,
 * the queries and the dashboard never learn that Anthropic calls it
 * `uncached_input_tokens` while CloudWatch calls it `InputTokenCount`.
 */

export interface UsageBucket {
  /** The provider's own model identifier, unmodified. */
  modelId: string;
  periodStart: Date;
  periodEnd: Date;

  inputTokens: number;
  outputTokens: number;
  /** Priced at a fraction of input, so never folded into inputTokens. */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /**
   * Inference calls. Zero is meaningful (tokens with no call count available is
   * different from no calls), so adapters that cannot supply it leave it at 0
   * and the UI reports cost-per-call as unavailable rather than infinite.
   */
  inferenceCalls: number;

  accountId?: string | null;
  region?: string | null;
  application?: string | null;
  environment?: string | null;
  sourceRef?: string | null;
}

export interface FetchWindow {
  start: Date;
  end: Date;
}

export interface AdapterResult {
  buckets: UsageBucket[];
  /** API calls made, so ingestion cost is visible like it is for cost data. */
  apiCalls: number;
  /**
   * Set when the adapter ran but could not produce complete data — a permission
   * missing, a metric absent. Distinct from throwing: partial data is still
   * worth storing, but the gap must not read as "no usage".
   */
  warning?: string;
}

export interface UsageAdapter {
  readonly providerKey: string;
  /** Whether this tenant has what the adapter needs. Cheap; no data fetched. */
  isConfigured(): Promise<boolean>;
  /** What the customer must set up, shown when isConfigured() is false. */
  readonly setupHint: string;
  fetchUsage(window: FetchWindow): Promise<AdapterResult>;
}

/**
 * A provider that returned nothing, with the reason.
 *
 * Adapters never throw for "not configured" — that is a normal state for a
 * customer who uses two of the five providers, and an exception would make the
 * ingestion sweep look broken.
 */
export class AdapterNotConfigured extends Error {
  constructor(readonly providerKey: string, message: string) {
    super(message);
    this.name = 'AdapterNotConfigured';
  }
}
