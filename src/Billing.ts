import { StripeSync } from "@pretzelai/stripe-sync-engine";
import Stripe from "stripe";
import { Pool } from "pg";
import { getMode } from "./helpers";
import { initCredits, credits, type ConsumeResult } from "./credits";
import {
  createCreditLifecycle,
  type CreditsGrantTo,
} from "./credits/lifecycle";
import {
  createTopUpHandler,
  type TopUpParams,
  type TopUpResult,
  type TopUpPending,
  type AutoTopUpResult,
  type AutoTopUpFailedReason,
} from "./credits/topup";
import {
  createSeatsApi,
  type AddSeatParams,
  type AddSeatResult,
  type RemoveSeatParams,
  type RemoveSeatResult,
} from "./credits/seats";
import {
  createSubscriptionsApi,
  type Subscription,
  type SubscriptionStatus,
} from "./subscriptions";

import type {
  User,
  StripeConfig,
  HandlerConfig,
  HandlerContext,
  TaxConfig,
} from "./types";
import { handleCheckout } from "./handlers/checkout";
import { handleCustomerPortal } from "./handlers/customer-portal";
import { handleWebhook } from "./handlers/webhook";
import { handleBilling } from "./handlers/billing";
import { getActiveSubscription } from "./helpers";

export type { CreditsGrantTo };
export type {
  TopUpParams,
  TopUpResult,
  TopUpPending,
  AutoTopUpResult,
  ConsumeResult,
  AddSeatParams,
  AddSeatResult,
  RemoveSeatParams,
  RemoveSeatResult,
  Subscription,
  SubscriptionStatus,
};
export type {
  User,
  StripeConfig,
  HandlerConfig,
  StripeWebhookCallbacks,
  CreditsConfig,
  TaxConfig,
  CheckoutRequestBody,
  CustomerPortalRequestBody,
} from "./types";

export class Billing {
  readonly subscriptions: ReturnType<typeof createSubscriptionsApi>;
  readonly credits: ReturnType<typeof Billing.prototype.createCreditsApi>;
  readonly seats: ReturnType<typeof createSeatsApi>;

  private readonly stripe: Stripe;
  private readonly pool: Pool | null;
  private readonly schema: string;
  private readonly billingConfig: StripeConfig["billingConfig"];
  /** Current mode based on STRIPE_SECRET_KEY ("test" or "production") */
  readonly mode: "test" | "production";
  private readonly grantTo: CreditsGrantTo;
  private readonly defaultSuccessUrl?: string;
  private readonly defaultCancelUrl?: string;
  private readonly stripeWebhookSecret: string;
  private readonly sync: StripeSync | null;
  private readonly mapUserIdToStripeCustomerId?: StripeConfig["mapUserIdToStripeCustomerId"];
  private readonly creditsConfig?: StripeConfig["credits"];
  private readonly callbacks?: StripeConfig["callbacks"];
  private readonly tax: TaxConfig;

  constructor(config: StripeConfig = {}) {
    const {
      stripeSecretKey = process.env.STRIPE_SECRET_KEY!,
      stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET!,
      databaseUrl = process.env.DATABASE_URL,
      schema = "stripe",
      billingConfig,
      successUrl,
      cancelUrl,
      credits: creditsConfig,
      callbacks,
      mapUserIdToStripeCustomerId,
      tax,
    } = config;

    this.stripe = new Stripe(stripeSecretKey);
    this.pool = databaseUrl
      ? new Pool({ connectionString: databaseUrl })
      : null;
    this.schema = schema;
    this.billingConfig = billingConfig;
    this.mode = getMode(stripeSecretKey);
    this.grantTo = creditsConfig?.grantTo ?? "subscriber";
    this.defaultSuccessUrl = successUrl;
    this.defaultCancelUrl = cancelUrl;
    this.stripeWebhookSecret = stripeWebhookSecret;
    this.mapUserIdToStripeCustomerId = mapUserIdToStripeCustomerId;
    this.creditsConfig = creditsConfig;
    this.callbacks = callbacks;
    this.tax = tax ?? {};

    initCredits(this.pool, this.schema);

    this.sync = databaseUrl
      ? new StripeSync({
          poolConfig: { connectionString: databaseUrl },
          schema: this.schema,
          stripeSecretKey,
          stripeWebhookSecret,
        })
      : null;

    this.subscriptions = createSubscriptionsApi({
      pool: this.pool,
      schema: this.schema,
      billingConfig: this.billingConfig,
      mode: this.mode,
    });

    // Merge callbacks: top-level callbacks override creditsConfig callbacks
    const mergedCallbacks = {
      onTopUpCompleted: callbacks?.onTopUpCompleted ?? creditsConfig?.onTopUpCompleted,
      onAutoTopUpFailed: callbacks?.onAutoTopUpFailed ?? creditsConfig?.onAutoTopUpFailed,
      onCreditsLow: callbacks?.onCreditsLow ?? creditsConfig?.onCreditsLow,
    };

    this.credits = this.createCreditsApi(mergedCallbacks);

    this.seats = createSeatsApi({
      stripe: this.stripe,
      pool: this.pool,
      schema: this.schema,
      billingConfig: this.billingConfig,
      mode: this.mode,
      grantTo: this.grantTo,
      callbacks: {
        onCreditsGranted: callbacks?.onCreditsGranted ?? creditsConfig?.onCreditsGranted,
        onCreditsRevoked: callbacks?.onCreditsRevoked ?? creditsConfig?.onCreditsRevoked,
      },
    });
  }

  /**
   * Get plans for the current mode (based on STRIPE_SECRET_KEY).
   * Use this to pass plans to your pricing page component.
   */
  getPlans() {
    return this.billingConfig?.[this.mode]?.plans || [];
  }

  /**
   * Assign a user to a free plan if they don't already have a subscription.
   * Call this when a user logs in to ensure they have access to the free plan.
   * 
   * @param options.userId - The user ID to assign to the free plan
   * @param options.planName - Name of the free plan (optional - auto-detects if only one free plan exists)
   * @param options.interval - Billing interval for the free plan (default: "month")
   * @returns The created subscription, or null if user already has a subscription
   */
  async assignFreePlan(options: {
    userId: string;
    planName?: string;
    interval?: "month" | "year" | "week";
  }): Promise<Stripe.Subscription | null> {
    const { userId, planName, interval = "month" } = options;

    if (!this.pool) {
      throw new Error("Database connection required to assign free plan");
    }

    // Get or create Stripe customer
    const customerId = await this.resolveStripeCustomerId({
      user: { id: userId },
      createIfNotFound: true,
    });

    if (!customerId) {
      throw new Error("Failed to create Stripe customer");
    }

    // Check if user already has an active subscription
    const existingSubscription = await getActiveSubscription(
      this.stripe,
      customerId
    );

    if (existingSubscription) {
      // User already has a subscription, return null
      return null;
    }

    // Find the free plan
    const plans = this.billingConfig?.[this.mode]?.plans || [];
    let freePlan;

    if (planName) {
      // If planName is provided, find that specific plan
      freePlan = plans.find((p) => p.name === planName);
      if (!freePlan) {
        throw new Error(`Plan "${planName}" not found in billing config`);
      }
    } else {
      // Auto-detect free plans (plans with at least one price with amount: 0)
      const freePlans = plans.filter((p) =>
        p.price.some((pr) => pr.amount === 0)
      );

      if (freePlans.length === 0) {
        throw new Error(
          "No free plan found in billing config. Define a plan with price amount: 0"
        );
      }

      if (freePlans.length > 1) {
        const freeNames = freePlans.map((p) => p.name).join(", ");
        throw new Error(
          `Multiple free plans found (${freeNames}). Please specify planName to choose which one to assign.`
        );
      }

      freePlan = freePlans[0];
    }

    // Find a free price for the specified interval, or any free price
    let price = freePlan.price.find(
      (p) => p.interval === interval && p.amount === 0
    );

    // If no free price at the specified interval, try to find any free price
    if (!price) {
      price = freePlan.price.find((p) => p.amount === 0);
    }

    if (!price) {
      throw new Error(
        `No free price found for plan "${freePlan.name}". Ensure the plan has a price with amount: 0`
      );
    }

    if (!price.id) {
      throw new Error(
        `Price ID not set for plan "${freePlan.name}" with interval "${price.interval}". Run stripe-sync to sync price IDs.`
      );
    }

    // Create the subscription programmatically
    const subscription = await this.stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: price.id }],
      metadata: {
        user_id: userId,
        auto_assigned_free_plan: "true",
      },
    });

    return subscription;
  }

  private resolveStripeCustomerId = async (options: {
    user: User;
    createIfNotFound?: boolean;
  }): Promise<string | null> => {
    const { user, createIfNotFound } = options;
    const { id: userId, name, email } = user;

    if (this.pool) {
      const result = await this.pool.query(
        `SELECT stripe_customer_id FROM ${this.schema}.user_stripe_customer_map WHERE user_id = $1`,
        [userId]
      );
      if (result.rows.length > 0) {
        return result.rows[0].stripe_customer_id;
      }
    }

    if (this.mapUserIdToStripeCustomerId) {
      const customerId = await this.mapUserIdToStripeCustomerId(userId);
      if (customerId) {
        return customerId;
      }
    }

    if (createIfNotFound) {
      const customerParams: Stripe.CustomerCreateParams = {
        metadata: { user_id: userId },
      };
      if (name) customerParams.name = name;
      if (email) customerParams.email = email;

      const customer = await this.stripe.customers.create(customerParams);

      if (this.pool) {
        await this.pool.query(
          `INSERT INTO ${this.schema}.user_stripe_customer_map (user_id, stripe_customer_id)
           VALUES ($1, $2)
           ON CONFLICT (user_id) DO UPDATE SET stripe_customer_id = $2, updated_at = now()`,
          [userId, customer.id]
        );
      }

      return customer.id;
    }

    return null;
  };

  private createCreditsApi(callbacks?: {
    onAutoTopUpFailed?: (params: {
      userId: string;
      creditType: string;
      reason: AutoTopUpFailedReason;
      error?: string;
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
    onCreditsLow?: (params: {
      userId: string;
      creditType: string;
      balance: number;
      threshold: number;
    }) => void | Promise<void>;
  }) {
    const topUpHandler = createTopUpHandler({
      stripe: this.stripe,
      pool: this.pool,
      schema: this.schema,
      billingConfig: this.billingConfig,
      mode: this.mode,
      successUrl: this.defaultSuccessUrl || "",
      cancelUrl: this.defaultCancelUrl || "",
      tax: this.tax,
      onAutoTopUpFailed: callbacks?.onAutoTopUpFailed,
      onTopUpCompleted: callbacks?.onTopUpCompleted,
      onCreditsLow: callbacks?.onCreditsLow,
    });

    const consumeCredits = async (params: {
      userId: string;
      creditType: string;
      amount: number;
      description?: string;
      metadata?: Record<string, unknown>;
      idempotencyKey?: string;
    }): Promise<ConsumeResult> => {
      const result = await credits.consume(params);

      if (result.success) {
        topUpHandler
          .triggerAutoTopUpIfNeeded({
            userId: params.userId,
            creditType: params.creditType,
            currentBalance: result.balance,
          })
          .catch((err) => {
            const message =
              err instanceof Error ? err.message : "Unknown error";
            console.error("Auto top-up error:", err);
            callbacks?.onAutoTopUpFailed?.({
              userId: params.userId,
              creditType: params.creditType,
              reason: "unexpected_error",
              error: message,
            });
          });
      }

      return result;
    };

    return {
      consume: consumeCredits,
      grant: credits.grant,
      revoke: credits.revoke,
      revokeAll: credits.revokeAll,
      setBalance: credits.setBalance,
      getBalance: credits.getBalance,
      getAllBalances: credits.getAllBalances,
      hasCredits: credits.hasCredits,
      getHistory: credits.getHistory,
      topUp: topUpHandler.topUp,
      hasPaymentMethod: topUpHandler.hasPaymentMethod,
    };
  }

  createHandler(handlerConfig: HandlerConfig = {}) {
    const {
      resolveUser,
      resolveOrg,
      callbacks: handlerCallbacks,
    } = handlerConfig;

    // Merge callbacks: handler-level overrides instance-level
    const callbacks = { ...this.callbacks, ...handlerCallbacks };

    // Build tax config with sensible defaults
    const taxConfig: TaxConfig = { ...this.tax };

    // When automaticTax is enabled, default to collecting address
    if (taxConfig.automaticTax) {
      taxConfig.billingAddressCollection ??= "auto";
    }

    // When collecting address or tax IDs, save to customer
    if (taxConfig.billingAddressCollection || taxConfig.taxIdCollection) {
      taxConfig.customerUpdate ??= { address: "auto", name: "auto" };
    }

    const creditLifecycle = createCreditLifecycle({
      pool: this.pool,
      schema: this.schema,
      billingConfig: this.billingConfig,
      mode: this.mode,
      grantTo: this.grantTo,
      callbacks,
    });

    const topUpHandler = createTopUpHandler({
      stripe: this.stripe,
      pool: this.pool,
      schema: this.schema,
      billingConfig: this.billingConfig,
      mode: this.mode,
      successUrl: this.defaultSuccessUrl || "",
      cancelUrl: this.defaultCancelUrl || "",
      tax: taxConfig,
      onCreditsGranted: callbacks?.onCreditsGranted,
      onTopUpCompleted: callbacks?.onTopUpCompleted,
      onAutoTopUpFailed: callbacks?.onAutoTopUpFailed,
      onCreditsLow: callbacks?.onCreditsLow,
    });

    const routeContext: HandlerContext = {
      stripe: this.stripe,
      pool: this.pool,
      schema: this.schema,
      billingConfig: this.billingConfig,
      mode: this.mode,
      grantTo: this.grantTo,
      defaultSuccessUrl: this.defaultSuccessUrl,
      defaultCancelUrl: this.defaultCancelUrl,
      tax: taxConfig,
      resolveUser,
      resolveOrg,
      resolveStripeCustomerId: this.resolveStripeCustomerId,
    };

    const webhookContext = {
      stripe: this.stripe,
      stripeWebhookSecret: this.stripeWebhookSecret,
      sync: this.sync,
      creditLifecycle,
      topUpHandler,
      callbacks,
    };

    return async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      const action = url.pathname.split("/").filter(Boolean).pop();

      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
          status: 405,
          headers: { "Content-Type": "application/json" },
        });
      }

      switch (action) {
        case "checkout":
          return handleCheckout(request, routeContext);
        case "webhook":
          return handleWebhook(request, webhookContext);
        case "customer_portal":
          return handleCustomerPortal(request, routeContext);
        case "billing":
          return handleBilling(request, routeContext);
        default:
          return new Response(
            JSON.stringify({
              error: `Unknown action: ${action}. Supported: checkout, webhook, customer_portal, billing`,
            }),
            { status: 404, headers: { "Content-Type": "application/json" } }
          );
      }
    };
  }
}

/**
 * Simple handler for cases where you don't need credits/subscriptions APIs.
 * Combines initialization and handler creation in one step.
 */
export function createHandler(config: StripeConfig & HandlerConfig) {
  return new Billing(config).createHandler(config);
}
