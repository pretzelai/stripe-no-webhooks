import { StripeSync } from "@supabase/stripe-sync-engine";
import Stripe from "stripe";
import type { BillingConfig, PriceInterval } from "./BillingConfig";
import { getMode } from "./utils";

// ============================================================================
// Types
// ============================================================================

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
   * Additional metadata to attach to the session
   */
  metadata?: Record<string, string>;
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
  } = config;

  const stripe = new Stripe(stripeSecretKey);

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

      const priceId = resolvePriceId(body, getMode(stripeSecretKey));
      const mode = await getPriceMode(priceId);

      const sessionParams: Stripe.Checkout.SessionCreateParams = {
        line_items: [
          {
            price: priceId,
            quantity: body.quantity ?? 1,
          },
        ],
        mode,
        success_url: successUrl,
        cancel_url: cancelUrl,
        automatic_tax: { enabled: automaticTax },
      };

      if (body.customerEmail) {
        sessionParams.customer_email = body.customerEmail;
      }

      if (body.customerId) {
        sessionParams.customer = body.customerId;
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
      const signature = request.headers.get("stripe-signature");

      if (!signature) {
        return new Response("Missing stripe-signature header", { status: 400 });
      }

      let event: Stripe.Event;
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

      if (sync) {
        await sync.processWebhook(body, signature);
      }

      if (callbacks) {
        await handleCallbacks(event, callbacks);
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
  // Main Handler
  // ============================================================================

  return async function handler(request: Request): Promise<Response> {
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
      default:
        return new Response(
          JSON.stringify({
            error: `Unknown action: ${action}. Supported: checkout, webhook`,
          }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        );
    }
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

async function handleCallbacks(
  event: Stripe.Event,
  callbacks: StripeWebhookCallbacks
): Promise<void> {
  const { onSubscriptionCreated, onSubscriptionCancelled } = callbacks;

  switch (event.type) {
    case "customer.subscription.created":
      if (onSubscriptionCreated) {
        await onSubscriptionCreated(event.data.object as Stripe.Subscription);
      }
      break;

    case "customer.subscription.deleted":
      if (onSubscriptionCancelled) {
        await onSubscriptionCancelled(event.data.object as Stripe.Subscription);
      }
      break;

    case "customer.subscription.updated":
      const subscription = event.data.object as Stripe.Subscription;
      const previousAttributes = event.data.previous_attributes as
        | Partial<Stripe.Subscription>
        | undefined;

      if (
        onSubscriptionCancelled &&
        subscription.status === "canceled" &&
        previousAttributes?.status &&
        previousAttributes.status !== "canceled"
      ) {
        await onSubscriptionCancelled(subscription);
      }
      break;
  }
}
