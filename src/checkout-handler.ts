import Stripe from "stripe";
import type { BillingConfig, PriceInterval } from "./BillingConfig";

export interface CheckoutConfig {
  /**
   * Stripe secret key (sk_test_... or sk_live_...)
   */
  stripeSecretKey?: string;

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
   * Enable automatic tax calculation
   */
  automaticTax?: boolean;
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

export function createCheckoutHandler(config: CheckoutConfig) {
  const {
    stripeSecretKey,
    billingConfig,
    successUrl: defaultSuccessUrl,
    cancelUrl: defaultCancelUrl,
    automaticTax = true,
  } = config;

  const sk = stripeSecretKey ?? process.env.STRIPE_SECRET_KEY!;

  const stripe = new Stripe(sk);

  function resolvePriceId(body: CheckoutRequestBody): string {
    // Option 1: Direct priceId
    if (body.priceId) {
      return body.priceId;
    }

    // Options 2 & 3: planName or planId with interval
    if (!body.interval) {
      throw new Error("interval is required when using planName or planId");
    }

    if (!billingConfig?.plans) {
      throw new Error(
        "billingConfig with plans is required when using planName or planId"
      );
    }

    const plan = body.planName
      ? billingConfig.plans.find((p) => p.name === body.planName)
      : body.planId
      ? billingConfig.plans.find((p) => p.id === body.planId)
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

  return async function handler(request: Request): Promise<Response> {
    try {
      const body: CheckoutRequestBody = await request.json();

      // Validate that at least one identifier is provided
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

      const priceId = resolvePriceId(body);
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
  };
}
