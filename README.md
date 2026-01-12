# stripe-no-webhooks

Opinionated library to help you implement payments with Stripe. It syncs Stripe data to your database and gives you useful helpers to implement subscriptions and credits.

## Why this library?

This library is a wrapper on Stripe SDK (with some bells and whistles). It gives you an opinionated and clear path to implement payments:

1. Define plans in code which sync to Stripe
2. No manual webhook setup - the library handles webhooks and syncs Stripe data to your DB
3. Simple APIs for subscriptions and credits
4. Optional callbacks (`onSubscriptionCreated`, etc.) for custom logic

## Setup

### 1. Install

```bash
npm install stripe-no-webhooks stripe
```

Note: make sure you also have `.env` or `.env.local` in your project so it can save the generated secrets there.

### 2. Create tables where all Stripe data will be automatically synced

```bash
npx stripe-no-webhooks migrate postgresql://[USER]:[PASSWORD]@[DB_URL]/postgres
```

### 3. Run `config` to generate files & webhook

```bash
npx stripe-no-webhooks config
```

This creates:

- `lib/billing.ts` - Billing instance (optional, for credits/subscriptions API)
- `app/api/stripe/[...all]/route.ts` - HTTP handler
- `billing.config.ts` - Your plans

### 4. Connect your auth

Open `app/api/stripe/[...all]/route.ts` and add your auth:

```typescript
import { billing } from "@/lib/billing";
import { auth } from "@clerk/nextjs/server"; // or your auth library

export const POST = billing.createHandler({
  resolveUser: async () => {
    const { userId } = await auth();
    return userId ? { id: userId } : null;
  },
});
```

**Simple alternative**: If you don't need credits/subscriptions API, skip `lib/billing.ts`:

```typescript
import { createHandler } from "stripe-no-webhooks";
import billingConfig from "@/billing.config";

export const POST = createHandler({
  billingConfig,
  resolveUser: async () => {
    const { userId } = await auth();
    return userId ? { id: userId } : null;
  },
});
```

### 5. Create your plans

```javascript
// billing.config.ts
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

### 6. (optional) Write custom logic for subscriptions

You probably want something to happen when a new user subscribes or a subscription cancels. Define callbacks when creating the `Billing` instance:

```typescript
// lib/billing.ts
import { Billing } from "stripe-no-webhooks";
import billingConfig from "../billing.config";
import type { Stripe } from "stripe";

export const billing = new Billing({
  billingConfig,
  callbacks: {
    onSubscriptionCreated: async (subscription: Stripe.Subscription) => {
      console.log("New subscription:", subscription.id);
    },
    onSubscriptionCancelled: async (subscription: Stripe.Subscription) => {
      console.log("Subscription cancelled:", subscription.id);
    },
  },
});
```

Supported callbacks:

- `onSubscriptionCreated`
- `onSubscriptionCancelled`
- `onSubscriptionRenewed`
- `onSubscriptionPlanChanged`
- `onCreditsGranted`
- `onCreditsRevoked`
- `onTopUpCompleted`
- `onAutoTopUpFailed`
- `onCreditsLow`

### 7. (optional) Generate a pricing page

```bash
npx stripe-no-webhooks generate pricing-page
```

This will create a `PricingPage` component in `@/components`. Feel free to edit styling manually or with AI.

It is ready-to-use with loading states, error handling, and styling. Import it whenever you want:

```tsx
import { PricingPage } from "@/components/PricingPage";
import billingConfig from "@/billing.config";

export default function Pricing() {
  const plans = billingConfig.test?.plans || [];
  return <PricingPage plans={plans} currentPlanId="free" />;
}
```

### 8. (optional) Backfill data

If you had data in Stripe before deploying `stripe-no-webhooks`, you can backfill your database by running:

```bash
npx stripe-no-webhooks backfill
```
