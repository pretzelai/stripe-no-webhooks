import { Billing } from "stripe-no-webhooks";
import billingConfig from "../billing.config";
import type { Stripe } from "stripe";

// Initialize once, use everywhere (for credits/subscriptions API access)
export const billing = new Billing({
  billingConfig,
  // Keys and database URL are read from environment variables by default:
  // - STRIPE_SECRET_KEY
  // - STRIPE_WEBHOOK_SECRET
  // - DATABASE_URL

  // OPTIONAL: Add callbacks for subscription/credit events
  callbacks: {
    onSubscriptionCreated: async (subscription: Stripe.Subscription) => {
      console.log("New subscription:", subscription.id);
    },
    onSubscriptionCancelled: async (subscription: Stripe.Subscription) => {
      console.log("Subscription cancelled:", subscription.id);
    },
    onCreditsGranted: ({ userId, creditType, amount }) => {
      console.log(`Granted ${amount} ${creditType} to ${userId}`);
    },
  },
});
