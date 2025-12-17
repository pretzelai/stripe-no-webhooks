import { StripeSync } from "@supabase/stripe-sync-engine";
import Stripe from "stripe";

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

export interface StripeWebhookConfig {
  /**
   * PostgreSQL connection string for the Stripe sync database
   */
  databaseUrl: string;

  /**
   * Stripe secret key (sk_test_... or sk_live_...)
   */
  stripeSecretKey: string;

  /**
   * Stripe webhook signing secret (whsec_...)
   */
  stripeWebhookSecret: string;

  /**
   * Database schema name (defaults to 'stripe')
   */
  schema?: string;

  /**
   * Callbacks for subscription events
   */
  callbacks?: StripeWebhookCallbacks;
}

export function createStripeWebhookHandler(config: StripeWebhookConfig) {
  const {
    databaseUrl,
    stripeSecretKey,
    stripeWebhookSecret,
    schema = "stripe",
    callbacks,
  } = config;

  const sync = new StripeSync({
    poolConfig: {
      connectionString: databaseUrl,
    },
    schema,
    stripeSecretKey,
    stripeWebhookSecret,
  });

  const stripe = new Stripe(stripeSecretKey);

  return async function handler(request: Request): Promise<Response> {
    try {
      const body = await request.text();
      const signature = request.headers.get("stripe-signature");

      if (!signature) {
        return new Response("Missing stripe-signature header", { status: 400 });
      }

      // Verify and construct the event
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

      // Process the webhook with stripe-sync-engine to sync to database
      await sync.processWebhook(body, signature);

      // Handle subscription callbacks
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
  };
}

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
      // Handle cancellation via update (when cancel_at_period_end is set or status changes)
      const subscription = event.data.object as Stripe.Subscription;
      const previousAttributes = event.data.previous_attributes as
        | Partial<Stripe.Subscription>
        | undefined;

      // Check if subscription was just cancelled (status changed to 'canceled')
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
