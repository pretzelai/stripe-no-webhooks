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

Creates:

- `billing.config.ts` - Your plans
- `lib/billing.ts` - Initialize the client once
- `app/api/stripe/[...all]/route.ts` - HTTP handler

Also sets up webhook and adds secrets to `.env`.

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

## 6. Initialize the Client

Create once in `lib/billing.ts`:

```typescript
import { Billing } from "stripe-no-webhooks";
import billingConfig from "../billing.config";

export const billing = new Billing({
  billingConfig,
  // Keys and database URL are read from environment variables by default:
  // - STRIPE_SECRET_KEY
  // - STRIPE_WEBHOOK_SECRET
  // - DATABASE_URL

  // Optional: Add callbacks for subscription/credit events
  callbacks: {
    onSubscriptionCreated: (subscription) => {
      console.log("New subscription:", subscription.id);
    },
    onCreditsGranted: ({ userId, creditType, amount }) => {
      console.log(`Granted ${amount} ${creditType} to ${userId}`);
    },
  },
});
```

## 7. Create the API Route

**Next.js App Router** (`app/api/stripe/[...all]/route.ts`):

```typescript
import { billing } from "@/lib/billing";
import { auth } from "@clerk/nextjs/server"; // or your auth library

export const POST = billing.createHandler({
  // REQUIRED: Resolve the authenticated user from the request
  resolveUser: async () => {
    const { userId } = await auth();
    return userId ? { id: userId } : null;
  },
});
```

The `resolveUser` function securely extracts the authenticated user from the request. This is required for checkout and customer portal to work.

## 8. Generate a Pricing Page

```bash
npx stripe-no-webhooks generate pricing-page
```

This creates `components/PricingPage.tsx` with:

- Loading spinners on buttons
- Error display
- Monthly/yearly interval toggle
- Current plan highlighting

Use it in your page:

```tsx
import { PricingPage } from "@/components/PricingPage";
import billingConfig from "@/billing.config";

export default function Pricing() {
  const plans = billingConfig.test?.plans || [];

  // Pass the user's current plan ID to highlight it
  return <PricingPage plans={plans} currentPlanId="free" />;
}
```

The component handles checkout and customer portal automatically. Users on a plan see "Manage Subscription" which opens Stripe's billing portal.

> For manual implementation with custom UI, see [Frontend Client Reference](./reference.md#frontend-client).

## How User Mapping Works

The `resolveUser` function you provide is called on every checkout and portal request. The library then:

1. Uses your resolver to get the authenticated user
2. Looks up or creates a Stripe customer for that user
3. Stores the mapping in the `user_stripe_customer_map` table

No user info is read from the request body—it all comes from your resolver, ensuring requests can't be spoofed.

## Next Steps

- [Credits](./credits.md) - Give users consumable credits
- [Team Billing](./team-billing.md) - Org subscriptions with seats
