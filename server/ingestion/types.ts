/**
 * The connector contract.
 *
 * Adding a cloud (or a SaaS billing source) should mean writing one adapter and
 * registering it — not touching the ingestion runner, the fact store, or any
 * read path. Everything downstream of a connector speaks NormalizedCostRecord
 * and nothing else.
 *
 * The shape is FOCUS 1.x. Connectors do the provider-specific mapping once, at
 * the edge; nothing further in should ever branch on `provider` to decide what a
 * field means.
 */
import type { CloudProvider, ChargeCategory, ServiceCategory } from "@shared/schema";

export interface DateRange {
  /** Inclusive, YYYY-MM-DD. */
  start: string;
  /** Inclusive, YYYY-MM-DD. */
  end: string;
}

export interface NormalizedCostRecord {
  provider: CloudProvider;

  /** The invoiced account. Null when the provider does not expose it. */
  billingAccountId?: string | null;
  billingAccountName?: string | null;
  /** AWS linked account, Azure subscription, GCP project. Required. */
  subAccountId: string;
  subAccountName?: string | null;

  /** Start of the charge period, YYYY-MM-DD (daily grain). */
  chargePeriodStart: string;
  /** Exclusive end. For daily grain this is the following day. */
  chargePeriodEnd: string;
  billingPeriodStart?: string | null;

  serviceName: string;
  serviceCategory?: ServiceCategory | null;
  chargeCategory?: ChargeCategory;
  chargeDescription?: string | null;
  resourceId?: string | null;
  resourceName?: string | null;
  regionId?: string | null;

  /** What the invoice says. Required — this is the one number every provider gives us. */
  billedCost: number;
  /**
   * After amortizing commitments and applying credits. Leave undefined when the
   * connector genuinely cannot determine it; the ingester will not invent a
   * value, because a fabricated effective cost is worse than a missing one.
   */
  effectiveCost?: number | null;
  /** Public on-demand rate, pre-discount. */
  listCost?: number | null;
  billingCurrency?: string;

  pricingQuantity?: number | null;
  pricingUnit?: string | null;

  tags?: Record<string, string> | null;
  commitmentDiscountId?: string | null;
}

export interface ConnectorResult {
  records: NormalizedCostRecord[];
  /** Billing-API calls made, so ingestion's own cost is visible in ingestion_runs. */
  apiCalls: number;
  /**
   * Non-fatal problems — one account of several failing, a metric the provider
   * would not return. The run is recorded as 'partial' rather than silently
   * looking like a success.
   */
  warnings?: string[];
}

export interface CostConnector {
  readonly provider: CloudProvider;
  /** Whether this tenant has usable credentials. Checked before a run starts. */
  isConfigured(): Promise<boolean>;
  /** Fetch and normalize. Must not write to the database. */
  fetchCosts(range: DateRange): Promise<ConnectorResult>;
}
