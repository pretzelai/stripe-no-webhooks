import type Stripe from "stripe";
import type { Pool } from "pg";
import type { BillingConfig, PriceInterval } from "./BillingConfig";
import type { TransactionSource } from "./credits";
import type { CreditsGrantTo } from "./credits/lifecycle";
import type { AutoTopUpFailedCallbackParams } from "./credits/topup";

export interface User {
  id: string;
  name?: string;
  email?: string;
}

export interface StripeWebhookCallbacks {
  onSubscriptionCreated?: (
    subscription: Stripe.Subscription
  ) => void | Promise<void>;

  onSubscriptionCancelled?: (
    subscription: Stripe.Subscription
  ) => void | Promise<void>;

  onSubscriptionRenewed?: (
    subscription: Stripe.Subscription
  ) => void | Promise<void>;

  onSubscriptionPlanChanged?: (
    subscription: Stripe.Subscription,
    previousPriceId: string
  ) => void | Promise<void>;

  onSubscriptionPaymentFailed?: (params: {
    userId: string;
    stripeCustomerId: string;
    subscriptionId: string;
    invoiceId: string;
    amountDue: number;
    currency: string;
    stripeDeclineCode?: string;
    failureMessage?: string;
    attemptCount: number;
    nextPaymentAttempt: Date | null;
    willRetry: boolean;
    planName?: string;
    priceId: string;
  }) => void | Promise<void>;

  onCreditsGranted?: (params: {
    userId: string;
    key: string;
    amount: number;
    newBalance: number;
    source: TransactionSource;
    sourceId?: string;
  }) => void | Promise<void>;

  onCreditsRevoked?: (params: {
    userId: string;
    key: string;
    amount: number;
    previousBalance: number;
    newBalance: number;
    source:
      | "cancellation"
      | "manual"
      | "seat_revoke"
      | "renewal"
      | "plan_change";
  }) => void | Promise<void>;

  onTopUpCompleted?: (params: {
    userId: string;
    key: string;
    creditsAdded: number;
    amountCharged: number;
    currency: string;
    newBalance: number;
    sourceId: string; // PaymentIntent ID (B2C) or Invoice ID (B2B)
  }) => void | Promise<void>;

  onAutoTopUpFailed?: (
    params: AutoTopUpFailedCallbackParams
  ) => void | Promise<void>;

  onCreditsLow?: (params: {
    userId: string;
    key: string;
    balance: number;
    threshold: number;
  }) => void | Promise<void>;
}

/**
 * Tax configuration for checkout sessions.
 * Configure at the Billing constructor level for consistent behavior.
 */
export interface TaxConfig {
  /**
   * Enable Stripe Tax for automatic tax calculation.
   * Requires Stripe Tax to be enabled in your Stripe dashboard.
   * @default false
   */
  automaticTax?: boolean;

  /**
   * Collect billing address at checkout.
   * - 'auto': Only collect when required for tax calculation
   * - 'required': Always collect billing address
   * @default 'auto' when automaticTax is enabled
   */
  billingAddressCollection?: "auto" | "required";

  /**
   * Enable tax ID collection at checkout (VAT, GST, etc.).
   * Useful for B2B sales where customers need to provide tax IDs.
   * @default false
   */
  taxIdCollection?: boolean;

  /**
   * Update customer record with collected information.
   * When enabled, billing address and name are saved to the Stripe customer.
   * @default { address: 'auto', name: 'auto' } when billingAddressCollection or taxIdCollection is enabled
   */
  customerUpdate?: {
    address?: "auto" | "never";
    name?: "auto" | "never";
  };
}

export interface CreditsConfig {
  grantTo?: CreditsGrantTo;
  onTopUpCompleted?: (params: {
    userId: string;
    key: string;
    creditsAdded: number;
    amountCharged: number;
    currency: string;
    newBalance: number;
    sourceId: string; // PaymentIntent ID (B2C) or Invoice ID (B2B)
  }) => void | Promise<void>;
  onAutoTopUpFailed?: (
    params: AutoTopUpFailedCallbackParams
  ) => void | Promise<void>;
  onCreditsLow?: (params: {
    userId: string;
    key: string;
    balance: number;
    threshold: number;
  }) => void | Promise<void>;
  onCreditsGranted?: (params: {
    userId: string;
    key: string;
    amount: number;
    newBalance: number;
    source: TransactionSource;
    sourceId?: string;
  }) => void | Promise<void>;
  onCreditsRevoked?: (params: {
    userId: string;
    key: string;
    amount: number;
    previousBalance: number;
    newBalance: number;
    source:
      | "cancellation"
      | "manual"
      | "seat_revoke"
      | "renewal"
      | "plan_change";
  }) => void | Promise<void>;
}

export interface StripeConfig {
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  databaseUrl?: string;
  schema?: string;
  billingConfig?: BillingConfig;
  successUrl?: string;
  cancelUrl?: string;
  credits?: CreditsConfig;
  callbacks?: StripeWebhookCallbacks;

  /**
   * Tax configuration for checkout sessions.
   * @see TaxConfig
   */
  tax?: TaxConfig;

  /**
   * Resolve the current user from an incoming request.
   * Used by the HTTP handler to determine who is making the request.
   * @example
   * resolveUser: async (req) => {
   *   const session = await auth(); // Your auth library
   *   return session?.user ? { id: session.user.id, email: session.user.email } : null;
   * }
   */
  resolveUser?: (
    request: Request
  ) => User | Promise<User> | null | Promise<User | null>;

  /**
   * Resolve the organization ID from an incoming request (optional).
   * Used for multi-tenant setups where subscriptions are per-organization.
   */
  resolveOrg?: (
    request: Request
  ) => string | Promise<string> | null | Promise<string | null>;

  mapUserIdToStripeCustomerId?: (
    userId: string
  ) => string | Promise<string> | null | Promise<string | null>;

  /**
   * URL to redirect to when resolveUser returns null (user not logged in).
   * If not set, handlers will return a 401 error response instead.
   */
  loginUrl?: string;
}

/**
 * Optional overrides for createHandler().
 * Most config should be set in the Billing constructor.
 * Use this only if you need route-specific overrides.
 */
export interface HandlerConfig {
  /** Override resolveUser for this handler (rarely needed) */
  resolveUser?: (
    request: Request
  ) => User | Promise<User> | null | Promise<User | null>;

  /** Override resolveOrg for this handler (rarely needed) */
  resolveOrg?: (
    request: Request
  ) => string | Promise<string> | null | Promise<string | null>;

  /** Override callbacks for this handler (rarely needed) */
  callbacks?: StripeWebhookCallbacks;
}

export type StripeHandlerConfig = StripeConfig & HandlerConfig;

export interface CheckoutRequestBody {
  planName?: string;
  planId?: string;
  interval?: PriceInterval;
  priceId?: string;
  successUrl?: string;
  cancelUrl?: string;
  quantity?: number;
  metadata?: Record<string, string>;
}

export interface CustomerPortalRequestBody {
  returnUrl?: string;
}

export interface HandlerContext {
  stripe: Stripe;
  pool: Pool | null;
  schema: string;
  billingConfig?: BillingConfig;
  mode: "test" | "production";
  grantTo: CreditsGrantTo;
  defaultSuccessUrl?: string;
  defaultCancelUrl?: string;
  tax: TaxConfig;
  resolveUser?: HandlerConfig["resolveUser"];
  resolveOrg?: HandlerConfig["resolveOrg"];
  loginUrl?: string;
  resolveStripeCustomerId: (options: {
    user: User;
    createIfNotFound?: boolean;
  }) => Promise<string | null>;
}
