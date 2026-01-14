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
} from "./types";
import { handleCheckout } from "./handlers/checkout";
import { handleCustomerPortal } from "./handlers/customer-portal";
import { handleWebhook } from "./handlers/webhook";
import { handleBilling } from "./handlers/billing";

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
      paymentIntentId: string;
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
      automaticTax = false,
    } = handlerConfig;

    // Merge callbacks: handler-level overrides instance-level
    const callbacks = { ...this.callbacks, ...handlerCallbacks };

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
      automaticTax,
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
