import { Billing } from "stripe-no-webhooks";
import billingConfig from "../billing.config";

// Initialize once, use everywhere (for credits/subscriptions API access)
// If you only need the webhook handler, you can skip this file and use
// createHandler() directly in your API route.
export const billing = new Billing({
  billingConfig,
  // Keys and database URL are read from environment variables by default:
  // - STRIPE_SECRET_KEY
  // - STRIPE_WEBHOOK_SECRET
  // - DATABASE_URL
});
