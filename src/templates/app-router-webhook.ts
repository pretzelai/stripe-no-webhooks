// app/api/stripe/webhook/route.ts
import { createStripeWebhookHandler } from "stripe-no-webhooks";

export const POST = createStripeWebhookHandler({
  databaseUrl: process.env.DATABASE_URL!,
  stripeSecretKey: process.env.STRIPE_SECRET_KEY!,
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
  callbacks: {
    onSubscriptionCreated: async (subscription) => {
      // Called when a new subscription is created
      console.log("New subscription:", subscription.id);
      // e.g., send welcome email, provision resources, etc.
    },
    onSubscriptionCancelled: async (subscription) => {
      // Called when a subscription is cancelled
      console.log("Subscription cancelled:", subscription.id);
      // e.g., send cancellation email, revoke access, etc.
    },
  },
});
