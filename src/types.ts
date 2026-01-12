import type Stripe from "stripe";
import type { Pool } from "pg";
import type { BillingConfig, PriceInterval } from "./BillingConfig";
import type { TransactionSource } from "./credits";
import type { CreditsGrantTo } from "./credits/lifecycle";
import type { AutoTopUpFailedReason } from "./credits/topup";

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
    paymentIntentId: string;
  }) => void | Promise<void>;

  onAutoTopUpFailed?: (params: {
    userId: string;
    creditType: string;
    reason: AutoTopUpFailedReason;
    error?: string;
  }) => void | Promise<void>;

  onCreditsLow?: (params: {
    userId: string;
    creditType: string;
    balance: number;
    threshold: number;
  }) => void | Promise<void>;
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
    paymentIntentId: string;
  }) => void | Promise<void>;
  onAutoTopUpFailed?: (params: {
    userId: string;
    creditType: string;
    reason:
      | "max_per_month_reached"
      | "no_payment_method"
      | "payment_failed"
      | "payment_requires_action"
      | "unexpected_error";
    error?: string;
  }) => void | Promise<void>;
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

  automaticTax?: boolean;
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
  automaticTax: boolean;
  resolveUser?: HandlerConfig["resolveUser"];
  resolveOrg?: HandlerConfig["resolveOrg"];
  resolveStripeCustomerId: (options: {
    user: User;
    createIfNotFound?: boolean;
  }) => Promise<string | null>;
}
