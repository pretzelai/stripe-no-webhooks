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

- `lib/stripe.ts` - Initialize the client once
- `app/api/stripe/[...all]/route.ts` - HTTP handler
- `billing.config.ts` - Your plans

### 4. Connect your auth

Open `app/api/stripe/[...all]/route.ts` and add your auth:

```typescript
import { stripe } from "@/lib/stripe";
import { auth } from "@clerk/nextjs/server"; // or your auth library

export const POST = stripe.createHandler({
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

### 6. Generate a pricing page

```bash
npx stripe-no-webhooks generate pricing-page
```

This creates a ready-to-use React component with loading states, error handling, and styling:

```tsx
import { PricingPage } from "@/components/PricingPage";
import billingConfig from "@/billing.config";

export default function Pricing() {
  const plans = billingConfig.test?.plans || [];
  return <PricingPage plans={plans} currentPlanId="free" />;
}
```

### 7. (optional) Backfill data

If you had data in Stripe before deploying `stripe-no-webhooks`, you can backfill your database by running:

```bash
npx stripe-no-webhooks backfill
```
