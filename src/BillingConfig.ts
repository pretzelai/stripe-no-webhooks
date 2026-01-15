export type PriceInterval = "month" | "year" | "week" | "one_time";

export type Price = {
  id?: string;
  amount: number;
  currency: string;
  interval: PriceInterval;
};

export type OnDemandTopUp = {
  mode: "on_demand";
  pricePerCreditCents: number;
  minPerPurchase?: number; // default: 1
  maxPerPurchase?: number;
};

export type AutoTopUp = {
  mode: "auto";
  pricePerCreditCents: number;
  balanceThreshold: number;
  purchaseAmount: number;
  maxPerMonth?: number; // default: 10
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
  topUp?: OnDemandTopUp | AutoTopUp;
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
