# stripe-no-webhooks

Opinionated library to help you implement payments with Stripe. It syncs Stripe data to your database and gives you useful helpers to implement subscriptions and credits.

## Why this library?

This library is a wrapper on Stripe SDK (with some bells and whistles). It gives you an opinionated and clear path to implement payments:

1. Define plans in code which sync to Stripe
2. No manual webhook setup - the library handles webhooks and syncs Stripe data to your DB
3. Simple APIs for subscriptions and credits
4. Optional callbacks (`onSubscriptionCreated`, etc.) for custom logic

## Quick Start

This guide assumes you have a Next.js app and a PostgreSQL database. We start with a _test mode_ Stripe API key so you can test your setup locally. Then, we can move to a _live mode_ Stripe API key for your production environment.

```bash
npm install stripe-no-webhooks stripe
```

### 1. Initialize

```bash
npx stripe-no-webhooks init
```

You'll be prompted for:

- **Stripe test key** (for eg, `sk_test_...`) - get it from [Stripe dashboard](https://dashboard.stripe.com/apikeys)
- **Database URL** - PostgreSQL connection string
- **Site URL** - For eg, `http://localhost:3000` for local dev

This will update your `.env` file with your credentials and create the following files:

- `billing.config.ts`: Your config file with your plans
- `lib/billing.ts`: Your core billing client instance
- `app/api/stripe/[...all]/route.ts`: Your webhook handler and API routes

### 2. Set up database

```bash
npx stripe-no-webhooks migrate
```

This will create the `stripe` schema in your database with the necessary tables for syncing Stripe data and tracking credits.

### 3. Define your plans

Edit `billing.config.ts`:

```typescript
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
          { amount: 2000, currency: "usd", interval: "month" }, // $20/mo
          { amount: 20000, currency: "usd", interval: "year" }, // $200/yr
        ],
        // Optional: add credits to plans
        credits: {
          api_calls: { allocation: 1000 },
        },
      },
    ],
  },
};
```

### 4. Sync to Stripe

```bash
npx stripe-no-webhooks sync
```

This will create the products/prices in Stripe and update your config with their IDs.

### 5. Update your billing client

Specify how to get the `userId` in the `resolveUser` function. For example, with Clerk:

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

There are many other options you can specify for the createHandler function. See [API Reference](./docs/reference.md) for more details.

### 6. Test locally

Start your app and use [Stripe CLI](https://stripe.com/docs/stripe-cli) to forward webhooks:

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

That's it! Your billing is ready to test.

---

## Going to Production

The `sync` command handles staging and production setup interactively. No need to edit `.env` files.

### Staging (test mode, public URL)

```bash
npx stripe-no-webhooks sync
# Choose "Set up for staging"
# Enter your staging URL (e.g., https://staging.myapp.com)
```

Uses your existing test key. Add the displayed webhook secret to your staging environment.

### Production (live mode)

```bash
npx stripe-no-webhooks sync
# Choose "Set up for production"
# Enter your live Stripe key (sk_live_...)
# Enter your production URL
```

This syncs the `production` section of your billing.config.ts:

```typescript
const billingConfig: BillingConfig = {
  test: {
    plans: [
      /* ... */
    ],
  },
  production: {
    plans: [
      // Copy your plans here - IDs get filled in automatically when you sync
      {
        name: "Free",
        price: [{ amount: 0, currency: "usd", interval: "month" }],
      },
      {
        name: "Pro",
        price: [{ amount: 2000, currency: "usd", interval: "month" }],
      },
    ],
  },
};
```

Add the displayed webhook secret to your production environment.

> Webhook secrets are saved to `.stripe-webhook-secrets` (gitignored) for reference.

---

## Optional: Generate a Pricing Page

```bash
npx stripe-no-webhooks generate pricing-page
```

Creates a ready-to-use `PricingPage` component:

```tsx
import { PricingPage } from "@/components/PricingPage";
import billingConfig from "@/billing.config";

export default function Pricing() {
  return <PricingPage plans={billingConfig.test.plans} />;
}
```

---

## Callbacks

React to subscription events:

```typescript
// lib/billing.ts
export const billing = new Billing({
  billingConfig,
  callbacks: {
    onSubscriptionCreated: async (subscription) => {
      // Send welcome email, provision resources, etc.
    },
    onSubscriptionCancelled: async (subscription) => {
      // Clean up, send feedback survey, etc.
    },
  },
});
```

Available callbacks: `onSubscriptionCreated`, `onSubscriptionCancelled`, `onSubscriptionRenewed`, `onSubscriptionPlanChanged`, `onCreditsGranted`, `onCreditsRevoked`, `onTopUpCompleted`, `onAutoTopUpFailed`, `onCreditsLow`

---

## CLI Reference

| Command                 | Description                             |
| ----------------------- | --------------------------------------- |
| `init`                  | Create config files, set up `.env`      |
| `migrate`               | Create database tables                  |
| `sync`                  | Sync plans to Stripe, set up webhooks   |
| `generate pricing-page` | Generate a PricingPage component        |
| `backfill`              | Import existing Stripe data to database |

---

## Learn More

- [Credits System](./docs/credits.md) - Consumable credits with auto top-up
- [Team Billing](./docs/team-billing.md) - Organization subscriptions with seats
- [API Reference](./docs/reference.md) - Full API documentation
