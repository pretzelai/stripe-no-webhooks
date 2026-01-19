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

export type CreditConfig = {
  allocation: number;
  /**
   * Human-readable name shown on pricing page.
   * @example displayName: "API Calls" // Shows "100 API Calls/mo" instead of "100 api_calls/mo"
   */
  displayName?: string;
  /**
   * What happens on renewal (default: 'reset')
   * - 'reset': Set balance to allocation (unused credits expire)
   * - 'add': Add allocation to current balance (credits accumulate)
   */
  onRenewal?: "reset" | "add";
  /** Price per credit in cents. Currency comes from the Plan's price. */
  pricePerCreditCents?: number;
  /** Minimum credits per top-up purchase (default: 1) */
  minPerPurchase?: number;
  /** Maximum credits per top-up purchase */
  maxPerPurchase?: number;
  /** Configure automatic top-ups when balance drops below threshold */
  autoTopUp?: AutoTopUpConfig;
};

export type Plan = {
  id?: string;
  name: string;
  description?: string;
  price: Price[];
  credits?: Record<string, CreditConfig>;
  /**
   * Custom feature bullet points shown on pricing page.
   * Use this for features that aren't credit-based.
   * @example features: ["Priority support", "Custom integrations", "Unlimited exports"]
   */
  features?: string[];
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
