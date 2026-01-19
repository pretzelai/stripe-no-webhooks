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

  onCreditsGranted?: (params: {
    userId: string;
    creditType: string;
    amount: number;
    newBalance: number;
    source: TransactionSource;
    sourceId?: string;
  }) => void | Promise<void>;

  onCreditsRevoked?: (params: {
    userId: string;
    creditType: string;
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
    creditType: string;
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
    creditType: string;
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
    creditType: string;
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
    creditType: string;
    balance: number;
    threshold: number;
  }) => void | Promise<void>;
  onCreditsGranted?: (params: {
    userId: string;
    creditType: string;
    amount: number;
    newBalance: number;
    source: TransactionSource;
    sourceId?: string;
  }) => void | Promise<void>;
  onCreditsRevoked?: (params: {
    userId: string;
    creditType: string;
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

  mapUserIdToStripeCustomerId?: (
    userId: string
  ) => string | Promise<string> | null | Promise<string | null>;
}

export interface HandlerConfig {
  resolveUser?: (
    request: Request
  ) => User | Promise<User> | null | Promise<User | null>;

  resolveOrg?: (
    request: Request
  ) => string | Promise<string> | null | Promise<string | null>;

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
  resolveStripeCustomerId: (options: {
    user: User;
    createIfNotFound?: boolean;
  }) => Promise<string | null>;
}
