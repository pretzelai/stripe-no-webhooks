# stripe-no-webhooks

Opinionated library to help you implement payments with Stripe. It syncs Stripe data to your database and gives you useful helpers to implement subscriptions and credits.

## Why this library?

This library is a wrapper on Stripe SDK (with some bells and whistles). It gives you an opinionated and clear path to implement payments:

1. Define plans in code which sync to Stripe
2. No manual webhook setup - the library handles webhooks and syncs Stripe data to your DB
3. Simple APIs for subscriptions and credits
4. Optional callbacks (`onSubscriptionCreated`, etc.) for custom logic

## Quick Start

This guide assumes you have a Next.js app and a PostgreSQL database. We start with a `test mode` Stripe API key so you can test your setup locally. Then, the guide covers how to set up your app for production.

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

### 6. Test your setup

Start your Next.js app, then in another terminal, forward Stripe webhooks:

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

Your setup is complete! Now let's use it.

---

## Using the Library

### Trigger a checkout

From your frontend, redirect users to Stripe Checkout:

```typescript
import { checkout } from "stripe-no-webhooks/client";

// In a button click handler
<button onClick={() => checkout({ planName: "Pro", interval: "month" })}>
  Upgrade to Pro
</button>;
```

Use `planName` (matches your billing config) and `interval` (month/year). No need to deal with Stripe price IDs directly.

You can test the checkout flow by running by using a stripe test card number:

- Card number: `4242 4242 4242 4242`
- Expiry date: Any future date
- CVC: Any 3 digits

**Note:** We recommend using our pre-built Pricing Table component instead of manually building your own checkout flow. See [Generate a pricing table](#option-a-generate-a-pricing-page) below.

### Check subscription status and usage credits

On the server, check if a user has an active subscription and how many credits (if enabled) they have:

```typescript
import { billing } from "@/lib/billing";

// Get the subscription
const subscription = await billing.subscriptions.get(userId);

if (subscription?.status === "active") {
  // User has an active subscription
  console.log("Plan:", subscription.plan.name);

  // Check credits for a specific type (if enabled in your config)
  const apiCredits = await billing.credits.getBalance(userId, "api_calls");
  console.log("API credits remaining:", apiCredits);

  // Or get all credit balances at once
  const allCredits = await billing.credits.getAllBalances(userId);
  console.log("All credits:", allCredits); // { api_calls: 100, ... }
}
```

### What happens behind the scenes

When a user completes checkout:

1. Stripe sends a webhook to your app
2. The library receives it and syncs the data to your database. If credits are enabled, it will also update the credits balance
3. `billing.subscriptions.get(userId)` now returns the subscription

You can verify this by checking your database's `stripe.subscriptions` table.

---

## Build Your UI

### Option A: Generate a pricing page

```bash
npx stripe-no-webhooks generate pricing-page
```

This creates a ready-to-use component at `components/PricingPage.tsx`:

```tsx
import { PricingPage } from "@/components/PricingPage";
import billingConfig from "@/billing.config";

export default function Pricing() {
  return <PricingPage plans={billingConfig.test.plans} />;
}
```

### Option B: Build your own

Use the `checkout` function with any UI:

```tsx
import { checkout } from "stripe-no-webhooks/client";
import billingConfig from "@/billing.config";

export default function Pricing() {
  const plans = billingConfig.test.plans;

  return (
    <div>
      {plans.map((plan) => (
        <div key={plan.name}>
          <h3>{plan.name}</h3>
          <button
            onClick={() => checkout({ planName: plan.name, interval: "month" })}
          >
            Subscribe
          </button>
        </div>
      ))}
    </div>
  );
}
```

---

## Going to Production

When you're ready to deploy, you need to:

1. Add a `production` section to your billing config
2. Sync with your live Stripe key
3. Add the webhook secret to your production environment

### 1. Add production plans

Update `billing.config.ts`:

```typescript
const billingConfig: BillingConfig = {
  test: {
    plans: [
      /* your test plans */
    ],
  },
  production: {
    plans: [
      // Same structure as test - IDs get filled in when you sync
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

### 2. Sync and create webhook

Run sync and choose "Set up for production":

```bash
npx stripe-no-webhooks sync
```

You'll be prompted for:

- Your **live** Stripe key (`sk_live_...`)
- Your production URL

This creates the products in Stripe and sets up the webhook endpoint.

### 3. Add webhook secret

The CLI displays your webhook secret. Add it to your production environment:

```
STRIPE_WEBHOOK_SECRET=whsec_...
```

> Secrets are also saved to `.stripe-webhook-secrets` (gitignored) for reference.

---

## Callbacks

React to subscription events in `lib/billing.ts`:

```typescript
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
