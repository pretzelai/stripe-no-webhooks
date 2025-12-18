// pages/api/stripe/[...all].ts
import { createStripeHandler } from "stripe-no-webhooks";
import type { NextApiRequest, NextApiResponse } from "next";
import billingConfig from "../../../billing.config";

const handler = createStripeHandler({
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

// Disable body parsing, we need the raw body for webhook verification
export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function stripeHandler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Convert NextApiRequest to Request for the handler
  const body = await new Promise<string>((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
  });

  const request = new Request(`https://${req.headers.host}${req.url}`, {
    method: req.method || "POST",
    headers: new Headers(req.headers as Record<string, string>),
    body,
  });

  const response = await handler(request);
  res.status(response.status).send(await response.text());
}
