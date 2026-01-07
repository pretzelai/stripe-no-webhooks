# stripe-no-webhooks

Opinionated library to help you implement payments with Stripe. It syncs Stripe data to your database and gives you useful helpers to implement subscriptions and credits.

## Why this library?

This library is a wrapper on Stripe SDK (with some bells and whistles). It gives you an opinionated and clear path to implement payments:

1. Define plans in code which sync to Stripe
2. No need for webhook listerners - the library syncs all Stripe data locally in you DB
3. Use simple APIs to create subscriptions and manages credits
4. Use a handful of callbacks (for eg, `onSubscriptionCreated`) for custom logic as needed

## Setup

### 1. Install

```bash
npm install stripe-no-webhooks stripe
```

Note: make sure you also have `.env` or `.env.local` in your project so it can save the generated secrets there.

### 2. Create tables where all Stripe data will be automatically synced

```bash
npx stripe-no-webhooks migrate postgresql://postgres.[USER]:[PASSWORD]@[DB_URL]/postgres
```

### 3. Run `config` to generate files & webhook

```bash
npx stripe-no-webhooks config
```

### 4. Create your plans

```javascript
// billing.config.ts (automatically created during config)
import type { BillingConfig } from "stripe-no-webhooks";
const billingConfig: BillingConfig = {
  test: {
    plans: [
      {
        name: "Premium",
        description: "Access to all features",
        price: [
          { amount: 1000, currency: "usd", interval: "month" },
          { amount: 10000, currency: "usd", interval: "year" },
        ],
        // Optional: give subscribers credits each billing cycle
        credits: {
          api_calls: { allocation: 1000 },
        },
      },
    ],
  },
};
export default billingConfig;
```

Run sync:

```bash
npx stripe-no-webhooks sync
```

### 5. Implement a checkout button in your frontend:

```javascript
"use client";
import { checkout } from "stripe-no-webhooks/client";

export default function Home() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <button
        className="bg-blue-500 text-white px-4 py-2 rounded-md cursor-pointer"
        onClick={() =>
          checkout({
            planName: "Premium",
            interval: "month",
          })
        }
      >
        Checkout
      </button>
    </div>
  );
}
```

### 6. Use credits in your app (if configured):

```typescript
import { createStripeHandler } from "stripe-no-webhooks";

const stripe = createStripeHandler({ billingConfig });

// Consume credits
const result = await stripe.credits.consume({
  userId: "user_123",
  creditType: "api_calls",
  amount: 1,
});

if (!result.success) {
  throw new Error("Insufficient credits");
}
```

## Documentation

- [Getting Started](docs/getting-started.md) - Full setup walkthrough
- [Credits](docs/credits.md) - Allocate, consume, and top-up credits
- [Team Billing](docs/team-billing.md) - Org subscriptions & per-seat credits
- [API Reference](docs/reference.md) - Quick lookup
