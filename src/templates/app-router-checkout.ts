// app/api/checkout/route.ts
import { createCheckoutHandler } from "stripe-no-webhooks";
import billingConfig from "../../../../billing.config";

export const POST = createCheckoutHandler({
  billingConfig,
});
