// app/api/stripe/[...all]/route.ts
import { createStripeHandler } from "stripe-no-webhooks";
import billingConfig from "../../../../../billing.config";

export const POST = createStripeHandler({
  billingConfig,
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
