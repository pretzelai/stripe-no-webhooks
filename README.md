# stripe-no-webhooks

Stripe integration without dealing with webhooks. Automatically syncs Stripe data to your PostgreSQL database and provides simple callbacks for subscription events.

## Installation

```bash
npm install stripe-no-webhooks stripe
```

## Setup

### 1. Create Stripe schema and tables

**Option 1:** Run the migration command

```bash
npx stripe-no-webhooks migrate postgresql://postgres.[USER]:[PASSWORD]@[DB_URL]/postgres
```

**Option 2:** Copy `stripe_schema.sql` and run the query manually

### 2. Set up the webhook handler

Create a webhook endpoint in your Next.js app:

#### App Router (recommended)

```ts
// app/api/stripe/webhook/route.ts
import { createStripeWebhookHandler } from "stripe-no-webhooks";

const handler = createStripeWebhookHandler({
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

export const POST = handler;
```

#### Pages Router

```ts
// pages/api/stripe/webhook.ts
import { createStripeWebhookHandler } from "stripe-no-webhooks";
import type { NextApiRequest, NextApiResponse } from "next";

const handler = createStripeWebhookHandler({
  databaseUrl: process.env.DATABASE_URL!,
  stripeSecretKey: process.env.STRIPE_SECRET_KEY!,
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
  callbacks: {
    onSubscriptionCreated: async (subscription) => {
      console.log("New subscription:", subscription.id);
    },
    onSubscriptionCancelled: async (subscription) => {
      console.log("Subscription cancelled:", subscription.id);
    },
  },
});

// Disable body parsing, we need the raw body for webhook verification
export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function webhookHandler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Convert NextApiRequest to Request for the handler
  const body = await new Promise<string>((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
  });

  const request = new Request(`https://${req.headers.host}${req.url}`, {
    method: "POST",
    headers: new Headers(req.headers as Record<string, string>),
    body,
  });

  const response = await handler(request);
  res.status(response.status).send(await response.text());
}
```

### 3. Configure Stripe webhook

In your Stripe Dashboard:

1. Go to **Developers → Webhooks**
2. Add an endpoint pointing to your webhook URL (e.g., `https://yourapp.com/api/stripe/webhook`)
3. Select the events you want to receive (at minimum: `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`)
4. Copy the signing secret and add it to your environment variables as `STRIPE_WEBHOOK_SECRET`

## Environment Variables

```env
DATABASE_URL=postgresql://user:pass@host:port/db
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

## What gets synced?

All Stripe webhook events are automatically synced to your PostgreSQL database in the `stripe` schema. This includes:

- Customers
- Subscriptions
- Products
- Prices
- Invoices
- Payment methods
- And more...

You can query this data directly from your database without making API calls to Stripe.

## Callbacks

| Callback                  | Event                                                           | Description                               |
| ------------------------- | --------------------------------------------------------------- | ----------------------------------------- |
| `onSubscriptionCreated`   | `customer.subscription.created`                                 | Called when a new subscription is created |
| `onSubscriptionCancelled` | `customer.subscription.deleted` or status changes to `canceled` | Called when a subscription is cancelled   |

Both callbacks receive the full Stripe `Subscription` object.
