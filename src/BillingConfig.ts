export type PriceInterval = "month" | "year" | "week" | "one_time";

export type Price = {
  id?: string;
  amount: number;
  currency: string;
  interval: PriceInterval;
};

export type AutoTopUpConfig = {
  /** Trigger auto top-up when balance drops below this threshold */
  threshold: number;
  /** Number of credits to purchase when auto top-up triggers */
  amount: number;
  /** Maximum auto top-ups per calendar month (default: 10) */
  maxPerMonth?: number;
};

export type CreditAllocation = {
  allocation: number;
  /**
   * What happens on renewal (default: 'reset')
   * - 'reset': Set balance to allocation (unused credits expire)
   * - 'add': Add allocation to current balance (credits accumulate)
   */
  onRenewal?: "reset" | "add";
};

/**
 * Feature configuration supporting credits, top-ups, and usage-based billing.
 */
export type FeatureConfig = {
  /** Human-readable name shown on pricing page */
  displayName?: string;
  /**
   * Price per unit in cents. Enables on-demand top-ups.
   * If trackUsage is also true, enables usage-based billing.
   */
  pricePerCredit?: number;
  /** Minimum units per top-up purchase (default: 1) */
  minPerPurchase?: number;
  /** Maximum units per top-up purchase */
  maxPerPurchase?: number;
  /** Configure automatic top-ups when balance drops below threshold */
  autoTopUp?: AutoTopUpConfig;
  /**
   * Pre-paid credit allocation (optional).
   * When set, users get this many credits per billing period.
   */
  credits?: CreditAllocation;
  /**
   * Enable usage-based billing for this feature.
   * When true, usage.record() sends events to Stripe meters.
   * Requires pricePerCredit to be set.
   * Note: Auto top-ups are disabled when trackUsage is true.
   */
  trackUsage?: boolean;
  /**
   * Stripe metered price ID (auto-populated by sync).
   * Only set when trackUsage is true.
   */
  meteredPriceId?: string;
};

export type WalletConfig = {
  /** Amount to add per billing period */
  allocation: number;
  /**
   * Human-readable name shown on pricing page.
   * @example displayName: "AI Usage" // Shows "$5.00 AI Usage/mo"
   * @default "usage credit" // Shows "$5.00 usage credit/mo"
   */
  displayName?: string;
  /**
   * What happens on renewal (default: 'reset')
   * - 'reset': Set balance to allocation (unused wallet balance expires, negative is forgiven)
   * - 'add': Add allocation to current balance (balance accumulates, negative is paid back)
   */
  onRenewal?: "reset" | "add";
};

export type Plan = {
  id?: string;
  name: string;
  description?: string;
  price: Price[];
  /**
   * Billing features with credits, top-ups, and/or usage tracking.
   * Each key is a feature identifier (e.g., "api_calls", "storage_gb").
   */
  features?: Record<string, FeatureConfig>;
  /**
   * Wallet configuration for monetary balance.
   * Currency is determined by the plan's price currency.
   */
  wallet?: WalletConfig;
  /**
   * Custom bullet points shown on pricing page.
   * Use this for features that aren't credit-based.
   * @example highlights: ["Priority support", "Custom integrations", "Unlimited exports"]
   */
  highlights?: string[];
  /**
   * Enable per-seat billing for this plan.
   * When true, addSeat/removeSeat will update Stripe subscription quantity.
   * Stripe automatically prorates charges when quantity changes.
   */
  perSeat?: boolean;
};

export type BillingConfig = {
  test?: {
    plans?: Plan[];
  };
  production?: {
    plans?: Plan[];
  };
};

export function defineConfig<const T extends BillingConfig>(config: T): T {
  return config;
}

/**
 * Check if a plan has any features with credit allocations.
 */
export function planHasCredits(plan: Plan | null | undefined): boolean {
  console.log("[planHasCredits] checking plan:", { planName: plan?.name, hasFeatures: !!plan?.features, features: plan?.features });
  if (!plan?.features) {
    console.log("[planHasCredits] no features, returning false");
    return false;
  }
  const result = Object.values(plan.features).some(
    (f) => f.credits?.allocation !== undefined && f.credits.allocation > 0
  );
  console.log("[planHasCredits] result:", result);
  return result;
}

/**
 * Check if a feature has usage tracking enabled.
 */
export function isUsageTrackingEnabled(feature: FeatureConfig): boolean {
  return feature.trackUsage === true && feature.pricePerCredit !== undefined;
}
