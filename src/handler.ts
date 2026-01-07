import { StripeSync } from "@supabase/stripe-sync-engine";
import Stripe from "stripe";
import { Pool } from "pg";
import type { BillingConfig, PriceInterval } from "./BillingConfig";
import { getMode } from "./utils";
import { initCredits, type TransactionSource } from "./credits";
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
import { credits, type ConsumeResult } from "./credits";
export type { CreditsGrantTo };
export type {
  TopUpParams,
  TopUpResult,
  TopUpPending,
  AutoTopUpResult,
  ConsumeResult,
};

// ============================================================================
// Types
// ============================================================================

export interface User {
  id: string;
  name?: string;
  email?: string;
}

export interface StripeWebhookCallbacks {
  /**
   * Called when a new subscription is created
   */
  onSubscriptionCreated?: (
    subscription: Stripe.Subscription
  ) => void | Promise<void>;

  /**
   * Called when a subscription is cancelled
   */
  onSubscriptionCancelled?: (
    subscription: Stripe.Subscription
  ) => void | Promise<void>;

  /**
   * Called on each billing cycle renewal
   */
  onSubscriptionRenewed?: (
    subscription: Stripe.Subscription
  ) => void | Promise<void>;

  /**
   * Called after credits are granted
   */
  onCreditsGranted?: (params: {
    userId: string;
    creditType: string;
    amount: number;
    newBalance: number;
    source: TransactionSource;
    sourceId?: string;
  }) => void | Promise<void>;

  /**
   * Called after credits are revoked
   */
  onCreditsRevoked?: (params: {
    userId: string;
    creditType: string;
    amount: number;
    previousBalance: number;
    newBalance: number;
    source: "cancellation" | "manual";
  }) => void | Promise<void>;

  /**
   * Called when a credit top-up completes successfully
   */
  onTopUpCompleted?: (params: {
    userId: string;
    creditType: string;
    creditsAdded: number;
    amountCharged: number;
    currency: string;
    newBalance: number;
    paymentIntentId: string;
  }) => void | Promise<void>;

  /**
   * Called when an auto top-up fails or is skipped due to payment issues
   */
  onAutoTopUpFailed?: (params: {
    userId: string;
    creditType: string;
    reason: AutoTopUpFailedReason;
    error?: string;
  }) => void | Promise<void>;

  /**
   * Called when credit balance drops below the auto top-up threshold.
   * Fires before auto top-up is attempted. Use for notifications.
   */
  onCreditsLow?: (params: {
    userId: string;
    creditType: string;
    balance: number;
    threshold: number;
  }) => void | Promise<void>;
}

export interface CreditsConfig {
  /**
   * Who receives credits automatically on subscription events.
   * - 'subscriber': Credits go to the subscriber (default)
   * - 'manual': No automatic granting, use callbacks to handle manually
   */
  grantTo?: CreditsGrantTo;
}

export interface StripeHandlerConfig {
  /**
   * Stripe secret key (sk_test_... or sk_live_...)
   * Falls back to STRIPE_SECRET_KEY environment variable
   */
  stripeSecretKey?: string;

  /**
   * Stripe webhook signing secret (whsec_...)
   * Falls back to STRIPE_WEBHOOK_SECRET environment variable
   */
  stripeWebhookSecret?: string;

  /**
   * PostgreSQL connection string for the Stripe sync database
   * Falls back to DATABASE_URL environment variable
   */
  databaseUrl?: string;

  /**
   * Database schema name (defaults to 'stripe')
   */
  schema?: string;

  /**
   * Billing configuration containing plans and prices
   */
  billingConfig?: BillingConfig;

  /**
   * Default success URL (can be overridden per request)
   */
  successUrl?: string;

  /**
   * Default cancel URL (can be overridden per request)
   */
  cancelUrl?: string;

  /**
   * Enable automatic tax calculation (defaults to true)
   */
  automaticTax?: boolean;

  /**
   * Callbacks for subscription events
   */
  callbacks?: StripeWebhookCallbacks;

  /**
   * Credits system configuration
   */
  credits?: CreditsConfig;

  /**
   * Function to map a user ID to a Stripe customer ID.
   * Used as fallback when user is not found in user_stripe_customer_map table.
   */
  mapUserIdToStripeCustomerId?: (
    userId: string
  ) => string | Promise<string> | null | Promise<string | null>;

  /**
   * Function to extract user from the request.
   * Useful for extracting user from authentication middleware/session.
   */
  getUser?: (
    request: Request
  ) => User | Promise<User> | null | Promise<User | null>;
}

export interface CheckoutRequestBody {
  /**
   * Plan name to look up in billingConfig (use with interval)
   */
  planName?: string;

  /**
   * Plan ID to look up in billingConfig (use with interval)
   */
  planId?: string;

  /**
   * Price interval for plan lookup
   */
  interval?: PriceInterval;

  /**
   * Direct Stripe price ID (bypasses billingConfig lookup)
   */
  priceId?: string;

  /**
   * Override the success URL for this checkout
   */
  successUrl?: string;

  /**
   * Override the cancel URL for this checkout
   */
  cancelUrl?: string;

  /**
   * Quantity of the item (defaults to 1)
   */
  quantity?: number;

  /**
   * Customer email for prefilling checkout
   */
  customerEmail?: string;

  /**
   * Existing Stripe customer ID
   */
  customerId?: string;

  /**
   * User object to associate with this checkout.
   * Will be used to look up or create a Stripe customer.
   */
  user?: User;

  /**
   * Additional metadata to attach to the session
   */
  metadata?: Record<string, string>;
}

export interface CustomerPortalRequestBody {
  /**
   * Stripe customer ID (cus_...)
   */
  stripe_customer_id?: string;

  /**
   * User object to look up Stripe customer ID
   */
  user?: User;

  /**
   * URL to redirect to after the customer portal session ends
   */
  returnUrl?: string;
}

// ============================================================================
// Handler Factory
// ============================================================================

export function createStripeHandler(config: StripeHandlerConfig = {}) {
  const {
    stripeSecretKey = process.env.STRIPE_SECRET_KEY!,
    stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET!,
    databaseUrl = process.env.DATABASE_URL,
    schema = "stripe",
    billingConfig,
    successUrl: defaultSuccessUrl,
    cancelUrl: defaultCancelUrl,
    automaticTax = true,
    callbacks,
    credits: creditsConfig,
    mapUserIdToStripeCustomerId,
    getUser,
  } = config;

  const stripe = new Stripe(stripeSecretKey);

  const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;

  // Initialize credits module with the same pool
  initCredits(pool, schema);

  const sync = databaseUrl
    ? new StripeSync({
        poolConfig: {
          connectionString: databaseUrl,
        },
        schema,
        stripeSecretKey,
        stripeWebhookSecret,
      })
    : null;

  const mode = getMode(stripeSecretKey);

  const creditLifecycle = createCreditLifecycle({
    pool,
    schema,
    billingConfig,
    mode,
    grantTo: creditsConfig?.grantTo ?? "subscriber",
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

  // ============================================================================
  // Customer Resolution Logic
  // ============================================================================

  /**
   * Resolves a Stripe customer ID from a user.
   * 1. Looks up in user_stripe_customer_map table
   * 2. Falls back to mapUserIdToStripeCustomerId if configured
   * 3. (optionally) Creates a new Stripe customer if not found
   */
  async function resolveStripeCustomerId(options: {
    user: User;
    createIfNotFound?: boolean;
  }): Promise<string | null> {
    const { user, createIfNotFound } = options;
    const { id: userId, name, email } = user;

    // Step 1: Check user_stripe_customer_map table
    if (pool) {
      const result = await pool.query(
        `SELECT stripe_customer_id FROM ${schema}.user_stripe_customer_map WHERE user_id = $1`,
        [userId]
      );
      if (result.rows.length > 0) {
        return result.rows[0].stripe_customer_id;
      }
    }

    // Step 2: Try mapUserIdToStripeCustomerId fallback
    if (mapUserIdToStripeCustomerId) {
      const customerId = await mapUserIdToStripeCustomerId(userId);
      if (customerId) {
        return customerId;
      }
    }

    // Step 3: Create a new Stripe customer
    if (createIfNotFound) {
      const customerParams: Stripe.CustomerCreateParams = {
        metadata: { user_id: userId },
      };

      if (name) {
        customerParams.name = name;
      }

      if (email) {
        customerParams.email = email;
      }

      const customer = await stripe.customers.create(customerParams);

      // Step 4: Save the mapping to user_stripe_customer_map table
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
  // Checkout Logic
  // ============================================================================

  function resolvePriceId(
    body: CheckoutRequestBody,
    mode: "test" | "production"
  ): string {
    if (body.priceId) {
      return body.priceId;
    }

    if (!body.interval) {
      throw new Error("interval is required when using planName or planId");
    }

    if (!billingConfig?.[mode]?.plans) {
      throw new Error(
        "billingConfig with plans is required when using planName or planId"
      );
    }

    const plan = body.planName
      ? billingConfig[mode]?.plans?.find((p) => p.name === body.planName)
      : body.planId
      ? billingConfig[mode]?.plans?.find((p) => p.id === body.planId)
      : null;

    if (!plan) {
      const identifier = body.planName || body.planId;
      throw new Error(`Plan not found: ${identifier}`);
    }

    const price = plan.price.find((p) => p.interval === body.interval);
    if (!price) {
      throw new Error(
        `Price with interval "${body.interval}" not found for plan "${plan.name}"`
      );
    }

    if (!price.id) {
      throw new Error(
        `Price ID not set for plan "${plan.name}" with interval "${body.interval}". Run stripe-sync to sync price IDs.`
      );
    }

    return price.id;
  }

  async function getPriceMode(
    priceId: string
  ): Promise<"payment" | "subscription"> {
    const price = await stripe.prices.retrieve(priceId);
    return price.type === "recurring" ? "subscription" : "payment";
  }

  async function handleCheckout(request: Request): Promise<Response> {
    try {
      const body: CheckoutRequestBody = await request.json();

      if (!body.priceId && !body.planName && !body.planId) {
        return new Response(
          JSON.stringify({
            error:
              "Provide either priceId, planName+interval, or planId+interval",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      const origin = request.headers.get("origin") || "";
      const successUrl =
        body.successUrl ||
        defaultSuccessUrl ||
        `${origin}/success?session_id={CHECKOUT_SESSION_ID}`;
      const cancelUrl = body.cancelUrl || defaultCancelUrl || `${origin}/`;

      const priceId = resolvePriceId(body, mode);
      const priceMode = await getPriceMode(priceId);

      const sessionParams: Stripe.Checkout.SessionCreateParams = {
        line_items: [
          {
            price: priceId,
            quantity: body.quantity ?? 1,
          },
        ],
        mode: priceMode,
        success_url: successUrl,
        cancel_url: cancelUrl,
        automatic_tax: { enabled: automaticTax },
      };

      // Resolve customer ID from user or direct customerId
      let customerId: string | null = null;

      if (body.customerId) {
        // Direct customerId takes precedence
        customerId = body.customerId;
      } else {
        // Try to get user from body or from getUser function
        let user = body.user;
        if (!user && getUser) {
          user = (await getUser(request)) ?? undefined;
        }

        if (user) {
          customerId = await resolveStripeCustomerId({
            user,
            createIfNotFound: true,
          });
        }
      }

      if (customerId) {
        sessionParams.customer = customerId;
      } else if (body.customerEmail) {
        // Fall back to customer_email if no customer ID
        sessionParams.customer_email = body.customerEmail;
      }

      if (body.metadata) {
        sessionParams.metadata = body.metadata;
      }

      const session = await stripe.checkout.sessions.create(sessionParams);

      if (!session.url) {
        return new Response(
          JSON.stringify({ error: "Failed to create checkout session" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }

      const acceptHeader = request.headers.get("accept") || "";
      if (acceptHeader.includes("application/json")) {
        return new Response(JSON.stringify({ url: session.url }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return Response.redirect(session.url, 303);
    } catch (err) {
      console.error("Checkout error:", err);
      const message = err instanceof Error ? err.message : "Unknown error";
      const status =
        err && typeof err === "object" && "statusCode" in err
          ? (err.statusCode as number)
          : 500;
      return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // ============================================================================
  // Webhook Logic
  // ============================================================================

  async function handleWebhook(request: Request): Promise<Response> {
    try {
      const body = await request.text();
      const url = new URL(request.url);
      const isLocalhost =
        url.hostname === "localhost" || url.hostname === "127.0.0.1";
      const signature = request.headers.get("stripe-signature");

      let event: Stripe.Event;

      if (isLocalhost) {
        // Skip signature verification on localhost for easier local development
        event = JSON.parse(body) as Stripe.Event;
      } else {
        if (!signature) {
          return new Response("Missing stripe-signature header", {
            status: 400,
          });
        }

        try {
          event = stripe.webhooks.constructEvent(
            body,
            signature,
            stripeWebhookSecret
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          return new Response(
            `Webhook signature verification failed: ${message}`,
            { status: 400 }
          );
        }
      }

      if (sync) {
        await sync.processEvent(event);
      }

      switch (event.type) {
        case "customer.subscription.created": {
          const subscription = event.data.object as Stripe.Subscription;
          await creditLifecycle.onSubscriptionCreated(subscription);
          await callbacks?.onSubscriptionCreated?.(subscription);
          break;
        }

        case "customer.subscription.deleted": {
          const subscription = event.data.object as Stripe.Subscription;
          await creditLifecycle.onSubscriptionCancelled(subscription);
          await callbacks?.onSubscriptionCancelled?.(subscription);
          break;
        }

        case "customer.subscription.updated": {
          const subscription = event.data.object as Stripe.Subscription;
          const prev = event.data.previous_attributes as
            | Partial<Stripe.Subscription>
            | undefined;
          if (
            subscription.status === "canceled" &&
            prev?.status &&
            prev.status !== "canceled"
          ) {
            await creditLifecycle.onSubscriptionCancelled(subscription);
            await callbacks?.onSubscriptionCancelled?.(subscription);
          }
          break;
        }

        case "invoice.paid": {
          const invoice = event.data.object as Stripe.Invoice;
          if (
            invoice.billing_reason === "subscription_cycle" &&
            invoice.subscription
          ) {
            const subId =
              typeof invoice.subscription === "string"
                ? invoice.subscription
                : invoice.subscription.id;
            const subscription = await stripe.subscriptions.retrieve(subId);
            await creditLifecycle.onSubscriptionRenewed(
              subscription,
              invoice.id
            );
            await callbacks?.onSubscriptionRenewed?.(subscription);
          }
          break;
        }

        case "checkout.session.completed": {
          const session = event.data.object as Stripe.Checkout.Session;
          // We attempted to pull money from user's stored payment method but it failed
          // that lead to the "recovery" checkout flow. Here we handle it.
          if (session.metadata?.top_up_credit_type) {
            await topUpHandler.handleTopUpCheckoutCompleted(session);
          }
          break;
        }

        case "payment_intent.succeeded": {
          const paymentIntent = event.data.object as Stripe.PaymentIntent;
          // We attempted to charge the user's stored payment method for topup, it succeeded
          // It's idempotent so if the topup was already granted, we do nothing
          await topUpHandler.handlePaymentIntentSucceeded(paymentIntent);
          break;
        }
      }

      return new Response(JSON.stringify({ received: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      console.error("Stripe webhook error:", error);
      const message =
        error instanceof Error ? error.message : "Internal server error";
      return new Response(message, { status: 500 });
    }
  }

  // ============================================================================
  // Customer Portal Logic
  // ============================================================================

  async function handleCustomerPortal(request: Request): Promise<Response> {
    try {
      const body: CustomerPortalRequestBody = await request.json();

      let customerId: string | null = null;

      if (body.stripe_customer_id) {
        // Direct stripe_customer_id takes precedence
        customerId = body.stripe_customer_id;
      } else {
        // Try to get user from body or from getUser function
        let user = body.user;
        if (!user && getUser) {
          user = (await getUser(request)) ?? undefined;
        }

        if (user) {
          customerId = await resolveStripeCustomerId({
            user,
            createIfNotFound: false,
          });
        }
      }

      if (!customerId) {
        return new Response(
          JSON.stringify({
            error:
              "Provide either stripe_customer_id or user. Alternatively, configure getUser to extract user from the request.",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      const origin = request.headers.get("origin") || "";
      const returnUrl = body.returnUrl || `${origin}/`;

      const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl,
      });

      const acceptHeader = request.headers.get("accept") || "";
      if (acceptHeader.includes("application/json")) {
        return new Response(JSON.stringify({ url: session.url }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return Response.redirect(session.url, 303);
    } catch (err) {
      console.error("Customer portal error:", err);
      const message = err instanceof Error ? err.message : "Unknown error";
      const status =
        err && typeof err === "object" && "statusCode" in err
          ? (err.statusCode as number)
          : 500;
      return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // ============================================================================
  // Main Handler
  // ============================================================================

  async function handler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathSegments = url.pathname.split("/").filter(Boolean);

    // Get the last meaningful segment (checkout, webhook, etc.)
    const action = pathSegments[pathSegments.length - 1];

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json" },
      });
    }

    switch (action) {
      case "checkout":
        return handleCheckout(request);
      case "webhook":
        return handleWebhook(request);
      case "customer_portal":
        return handleCustomerPortal(request);
      default:
        return new Response(
          JSON.stringify({
            error: `Unknown action: ${action}. Supported: checkout, webhook, customer_portal`,
          }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        );
    }
  }

  /**
   * Consume credits and trigger auto top-up if balance drops below threshold.
   * Auto top-up runs in the background and doesn't block the return.
   */
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
      // Fire-and-forget: don't await, don't block the return
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

  // Return handler function with additional methods attached
  return Object.assign(handler, {
    /**
     * Purchase additional credits using the user's saved payment method.
     * Returns a recoveryUrl if payment fails or no payment method is on file.
     */
    topUpCredits: topUpHandler.topUp,

    /**
     * Check if a user has a saved payment method for top-ups.
     */
    hasPaymentMethod: topUpHandler.hasPaymentMethod,

    /**
     * Consume credits with automatic top-up when balance drops below threshold.
     * Use this instead of `credits.consume()` to enable auto top-up functionality.
     */
    consumeCredits,
  });
}
