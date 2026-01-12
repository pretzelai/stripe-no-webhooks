import { createStripeHandler } from "stripe-no-webhooks";
import billingConfig from "../billing.config";

// Initialize once, use everywhere
export const stripe = createStripeHandler({
  billingConfig,
  // Keys and database URL are read from environment variables by default:
  // - STRIPE_SECRET_KEY
  // - STRIPE_WEBHOOK_SECRET
  // - DATABASE_URL
});
