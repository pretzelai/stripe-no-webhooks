# Getting Started

## Prerequisites

- PostgreSQL database
- Stripe account with API keys

## 1. Install

```bash
npm install stripe-no-webhooks stripe
```

## 2. Create Database Tables

```bash
npx stripe-no-webhooks migrate postgresql://user:pass@host/db
```

## 3. Generate Config Files

```bash
npx stripe-no-webhooks config
```

Creates `billing.config.ts`, sets up webhook, adds secrets to `.env`.

## 4. Define Your Plans

```typescript
// billing.config.ts
import type { BillingConfig } from "stripe-no-webhooks";

const billingConfig: BillingConfig = {
  test: {
    plans: [
      {
        name: "Free",
        price: [{ amount: 0, currency: "usd", interval: "month" }],
      },
      {
        name: "Pro",
        price: [
          { amount: 2000, currency: "usd", interval: "month" },
          { amount: 20000, currency: "usd", interval: "year" },
        ],
      },
    ],
  },
};

export default billingConfig;
```

## 5. Sync to Stripe

```bash
npx stripe-no-webhooks sync
```

## 6. Create the API Route

**Next.js** (`app/api/stripe/[action]/route.ts`):

```typescript
import { createStripeHandler } from "stripe-no-webhooks";
import billingConfig from "@/billing.config";

const stripe = createStripeHandler({
  billingConfig,
  successUrl: "http://localhost:3000/success",
  cancelUrl: "http://localhost:3000/",
});

export async function POST(request: Request) {
  return stripe(request);
}
```

## 7. Add Checkout Button

```typescript
"use client";
import { checkout } from "stripe-no-webhooks/client";

<button onClick={() => checkout({ planName: "Pro", interval: "month" })}>
  Subscribe
</button>
```

## 8. Customer Portal (optional)

Let users manage their subscription via Stripe's hosted portal:

```typescript
async function openPortal() {
  const res = await fetch("/api/stripe/customer_portal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user: { id: currentUser.id } }),
  });
  const { url } = await res.json();
  window.location.href = url;
}
```

## Connecting Users

Pass user info in checkout to link subscriptions to your users:

```typescript
checkout({
  planName: "Pro",
  interval: "month",
  user: { id: user.id, email: user.email },
});
```

Or configure `getUser` in the handler to extract from the request automatically.

## Next Steps

- [Credits](./credits.md) - Give users consumable credits
- [Team Billing](./team-billing.md) - Org subscriptions with seats
