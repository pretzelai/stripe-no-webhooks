import { StripeSync } from "@pretzelai/stripe-sync-engine";
import Stripe from "stripe";
import { Pool } from "pg";
import { getMode } from "../utils";
import { initCredits, credits, type ConsumeResult } from "../credits";
import { createCreditLifecycle, type CreditsGrantTo } from "../credits/lifecycle";
import {
  createTopUpHandler,
  type TopUpParams,
  type TopUpResult,
  type TopUpPending,
  type AutoTopUpResult,
  type AutoTopUpFailedReason,
} from "../credits/topup";
import {
  createSeatHandler,
  type AddSeatParams,
  type AddSeatResult,
  type RemoveSeatParams,
  type RemoveSeatResult,
} from "../credits/seats";
import {
  createSubscriptionsApi,
  type Subscription,
  type SubscriptionStatus,
} from "../subscriptions";

import type {
  User,
  StripeConfig,
  HandlerConfig,
  HandlerContext,
} from "./types";
import { handleCheckout, handleCustomerPortal } from "./routes";
import { handleWebhook } from "./webhook";

// Re-export types
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

// Keep old name as alias for backwards compatibility
export { createStripe as createStripeHandler };

// ============================================================================
// Main Factory
// ============================================================================

export function createStripe(config: StripeConfig = {}) {
  const {
    stripeSecretKey = process.env.STRIPE_SECRET_KEY!,
    stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET!,
    databaseUrl = process.env.DATABASE_URL,
    schema = "stripe",
    billingConfig,
    successUrl: defaultSuccessUrl,
    cancelUrl: defaultCancelUrl,
    credits: creditsConfig,
    mapUserIdToStripeCustomerId,
  } = config;

  const stripe = new Stripe(stripeSecretKey);
  const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
  const mode = getMode(stripeSecretKey);
  const grantTo = creditsConfig?.grantTo ?? "subscriber";

  // Initialize shared modules
  initCredits(pool, schema);

  const sync = databaseUrl
    ? new StripeSync({
        poolConfig: { connectionString: databaseUrl },
        schema,
        stripeSecretKey,
        stripeWebhookSecret,
      })
    : null;

  const subscriptionsApi = createSubscriptionsApi({
    pool,
    schema,
    billingConfig,
    mode,
  });

  // ============================================================================
  // Customer Resolution
  // ============================================================================

  async function resolveStripeCustomerId(options: {
    user: User;
    createIfNotFound?: boolean;
  }): Promise<string | null> {
    const { user, createIfNotFound } = options;
    const { id: userId, name, email } = user;

    // Check user_stripe_customer_map table
    if (pool) {
      const result = await pool.query(
        `SELECT stripe_customer_id FROM ${schema}.user_stripe_customer_map WHERE user_id = $1`,
        [userId]
      );
      if (result.rows.length > 0) {
        return result.rows[0].stripe_customer_id;
      }
    }

    // Try mapUserIdToStripeCustomerId fallback
    if (mapUserIdToStripeCustomerId) {
      const customerId = await mapUserIdToStripeCustomerId(userId);
      if (customerId) {
        return customerId;
      }
    }

    // Create a new Stripe customer if requested
    if (createIfNotFound) {
      const customerParams: Stripe.CustomerCreateParams = {
        metadata: { user_id: userId },
      };
      if (name) customerParams.name = name;
      if (email) customerParams.email = email;

      const customer = await stripe.customers.create(customerParams);

      // Save mapping
      if (pool) {
        await pool.query(
          `INSERT INTO ${schema}.user_stripe_customer_map (user_id, stripe_customer_id)
           VALUES ($1, $2)
           ON CONFLICT (user_id) DO UPDATE SET stripe_customer_id = $2, updated_at = now()`,
          [userId, customer.id]
        );
      }

      return customer.id;
    }

    return null;
  }

  // ============================================================================
  // Credits API with Auto Top-Up
  // ============================================================================

  function createCreditsApi(callbacks?: {
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
      stripe,
      pool,
      schema,
      billingConfig,
      mode,
      successUrl: defaultSuccessUrl || "",
      cancelUrl: defaultCancelUrl || "",
      onAutoTopUpFailed: callbacks?.onAutoTopUpFailed,
      onTopUpCompleted: callbacks?.onTopUpCompleted,
      onCreditsLow: callbacks?.onCreditsLow,
    });

    async function consumeCredits(params: {
      userId: string;
      creditType: string;
      amount: number;
      description?: string;
      metadata?: Record<string, unknown>;
      idempotencyKey?: string;
    }): Promise<ConsumeResult> {
      const result = await credits.consume(params);

      if (result.success) {
        // Fire-and-forget: trigger auto top-up check
        topUpHandler
          .triggerAutoTopUpIfNeeded({
            userId: params.userId,
            creditType: params.creditType,
            currentBalance: result.balance,
          })
          .catch((err) => {
            const message = err instanceof Error ? err.message : "Unknown error";
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
    }

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

  // Create credits API with callbacks from config
  const creditsApi = createCreditsApi({
    onTopUpCompleted: creditsConfig?.onTopUpCompleted,
    onAutoTopUpFailed: creditsConfig?.onAutoTopUpFailed,
    onCreditsLow: creditsConfig?.onCreditsLow,
  });

  // ============================================================================
  // Seat Management
  // ============================================================================

  const seatHandler = createSeatHandler({
    stripe,
    pool,
    schema,
    billingConfig,
    mode,
    grantTo,
    callbacks: {
      onCreditsGranted: creditsConfig?.onCreditsGranted,
      onCreditsRevoked: creditsConfig?.onCreditsRevoked,
    },
  });

  // ============================================================================
  // Handler Factory
  // ============================================================================

  function createHandler(handlerConfig: HandlerConfig = {}) {
    const {
      resolveUser,
      resolveOrg,
      callbacks,
      automaticTax = false,
    } = handlerConfig;

    // Create lifecycle and handlers with callbacks
    const creditLifecycle = createCreditLifecycle({
      pool,
      schema,
      billingConfig,
      mode,
      grantTo,
      callbacks,
    });

    const topUpHandler = createTopUpHandler({
      stripe,
      pool,
      schema,
      billingConfig,
      mode,
      successUrl: defaultSuccessUrl || "",
      cancelUrl: defaultCancelUrl || "",
      onCreditsGranted: callbacks?.onCreditsGranted,
      onTopUpCompleted: callbacks?.onTopUpCompleted,
      onAutoTopUpFailed: callbacks?.onAutoTopUpFailed,
      onCreditsLow: callbacks?.onCreditsLow,
    });

    const routeContext: HandlerContext = {
      stripe,
      pool,
      schema,
      billingConfig,
      mode,
      grantTo,
      defaultSuccessUrl,
      defaultCancelUrl,
      automaticTax,
      resolveUser,
      resolveOrg,
      resolveStripeCustomerId,
    };

    const webhookContext = {
      stripe,
      stripeWebhookSecret,
      sync,
      creditLifecycle,
      topUpHandler,
      callbacks,
    };

    // The actual request handler
    async function handler(request: Request): Promise<Response> {
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
        default:
          return new Response(
            JSON.stringify({
              error: `Unknown action: ${action}. Supported: checkout, webhook, customer_portal`,
            }),
            { status: 404, headers: { "Content-Type": "application/json" } }
          );
      }
    }

    return handler;
  }

  // ============================================================================
  // Return Client Object
  // ============================================================================

  return {
    /** Create an HTTP request handler for checkout, webhooks, and customer portal */
    createHandler,

    /** Subscription status and info */
    subscriptions: subscriptionsApi,

    /** Credit balance and operations */
    credits: creditsApi,

    /** Add a user as a seat in an org subscription */
    addSeat: seatHandler.addSeat,

    /** Remove a user as a seat from an org subscription */
    removeSeat: seatHandler.removeSeat,
  };
}
