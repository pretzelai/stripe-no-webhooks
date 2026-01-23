# stripe-no-webhooks

## Why this library?

This is an opinionated library to help you implement payments with Stripe.

1. Define plans in code which sync to Stripe
2. No manual webhook setup - the library handles webhooks and syncs Stripe data to your DB
3. Simple APIs for subscriptions, credits, wallet balances, top-ups, and usage-based billing
4. Support for seat based billing, tax collection, plan upgrades and downgrades (including sane handling of credits)
5. Optional callbacks (`onSubscriptionCreated`, etc.) for custom logic

## Quick Start

This guide assumes you have a Next.js app and a PostgreSQL database. We recommend starting with a `test mode` Stripe API key so you can test your setup locally in your dev environment. Then, the guide will walk you through how to set up your app for production.

### 1. Install and initialize

```bash
npm install stripe-no-webhooks stripe
```

```bash
npx stripe-no-webhooks init
```

You'll be prompted for:

- **Stripe test key** (for eg, `sk_test_...`) - get it from [Stripe dashboard](https://dashboard.stripe.com/apikeys)
- **Database URL** – PostgreSQL connection string (for example: `postgresql://postgres:password@localhost:5432/app_db`)
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

Edit `billing.config.ts` to define your plans for the test environment. Here's an example:

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
        // Optional: feature quotas and usage billing
        features: {
          api_calls: {
            displayName: "API Calls",
            credits: { allocation: 1000 },  // 1000 included per month
            pricePerCredit: 10,             // 10 cents for overages
            trackUsage: true,               // Bill overages at period end
          },
        },
        // Optional: wallet (for pay-as-you-go spending)
        wallet: {
          allocation: 500,  // $5.00/month included
        },
        // Optional: custom highlights (just text for the pricing table)
        highlights: ["Priority support", "Custom integrations"],
      },
    ],
  },
  production: {
    // Leave empty for now, you can add plans later by
    // copying the test plans and syncing again - see the "Going to Production"
    // section below in this README for more details
    plans: [],
  },
};
```

### 4. Sync to Stripe

```bash
npx stripe-no-webhooks sync
```

This will create the products/prices in Stripe and update your config with their IDs.

### 5. Update your billing client

Update `lib/billing.ts` to specify how to get the `userId` in the `resolveUser` function. For example, with Clerk:

```typescript
// lib/billing.ts
import { Billing } from "stripe-no-webhooks";
import { auth } from "@clerk/nextjs/server"; // or your auth library
import billingConfig from "../billing.config";

export const billing = new Billing({
  billingConfig,
  successUrl: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
  cancelUrl: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
  resolveUser: async () => {
    const { userId } = await auth();
    return userId ? { id: userId } : null;
  },
});
```

Then your route handler is zero-config:

```typescript
// app/api/stripe/[...all]/route.ts
import { billing } from "@/lib/billing";

const handler = billing.createHandler();

export const POST = handler;
export const GET = handler;
```

See [API Reference](./docs/reference.md) for more options.

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

**Yearly plans:** When a plan has both monthly and yearly prices, the `PricingPage` shows a toggle. For yearly subscriptions, credits are automatically scaled (12× monthly allocation upfront). Switching between monthly/yearly on the same plan is handled automatically - see [Credits](./docs/credits.md) for details on all upgrade/downgrade scenarios.

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
const subscription = await billing.subscriptions.get({ userId });

if (subscription?.status === "active") {
  // User has an active subscription
  console.log("Plan:", subscription.plan.name);

  // Check credits for a specific type (if enabled in your config)
  const apiCredits = await billing.credits.getBalance({ userId, key: "api_calls" });
  console.log("API credits remaining:", apiCredits);

  // Consume credits when user performs an action
  const creditsResult = await billing.credits.consume({
    userId,
    key: "api_calls",
    amount: 1,
  });

  if (!creditsResult.success) {
    // User has insufficient credits
    console.log(`Only ${result.balance} credits available`);
  }
}

// Or use usage-based billing (billed at period end)
await billing.usage.record({ userId, key: "api_calls", amount: 1 });
```

### What happens behind the scenes

When a user completes checkout:

1. Stripe sends a webhook to your app
2. The library receives it and syncs the data to your database. If credits are enabled, it will also update the credits balance
3. `billing.subscriptions.get({ userId })` now returns the subscription based on the Stripe data that's synced to your database
4. Credits are tracked automatically through a credit balance and a ledger of transactions via the library's internal APIs. These APIs are all idempotent and you don't have to worry about double counting or missing transactions

You can verify this by checking your database's `stripe.subscriptions` and `stripe.credit_balances` and `stripe.credit_ledger` tables.

---

## Build Your Pricing Page UI

### Option A: Generate a pricing page (recommended)

```bash
npx stripe-no-webhooks generate pricing-page
```

This creates a fully customizable pricing page component at `components/PricingPage.tsx`:

```tsx
import { PricingPage } from "@/components/PricingPage";

export default function Pricing() {
  return <PricingPage />;
}
```

That's it! The component automatically:

- Fetches plans from your server (based on your `STRIPE_SECRET_KEY` mode)
- Detects the user's current subscription (if logged in)
- Highlights their current plan and defaults the interval toggle
- Shows monthly/yearly toggle with discount badge (e.g., "Save 17%")
- Disables checkout for plans that don't support the selected interval
- Shows a loading skeleton while fetching

### Option B: Build your own

Use the `checkout` function with any UI:

```tsx
"use client";
import { checkout } from "stripe-no-webhooks/client";

export default function Pricing({ plans }) {
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

Run sync and choose **"Set up for production"**:

```bash
npx stripe-no-webhooks sync
```

You'll be prompted for:

- Your **live** Stripe key (`sk_live_...`)
- Your production URL

This creates the products in your **live mode** Stripe account and sets up the webhook endpoint.

### 3. Add webhook secret

The CLI displays your webhook secret. Add it to your production environment (for eg, in your Vercel production environment variables):

```
STRIPE_WEBHOOK_SECRET=whsec_...
```

> Secrets are also saved to `.stripe-webhook-secrets` (gitignored) for reference in case you forget to copy it.

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

Available callbacks: `onSubscriptionCreated`, `onSubscriptionCancelled`, `onSubscriptionRenewed`, `onSubscriptionPlanChanged`, `onSubscriptionPaymentFailed`, `onCreditsGranted`, `onCreditsRevoked`, `onTopUpCompleted`, `onAutoTopUpFailed`, `onCreditsLow`

See [API Reference](./docs/reference.md) for more details.

---

## Handling Payment Failures

Payments fail. Cards expire, get declined, or run out of funds. The library helps you handle this gracefully:

**Subscription failures:** Use `onSubscriptionPaymentFailed` callback to send custom emails when renewal payments fail. Stripe handles retries automatically.

**On-demand top-ups:** When `topUp()` fails, it returns a `recoveryUrl`. Redirect users there to enter a new card.

**Auto top-ups:** If you enable auto top-ups, be aware that failed payments are automatically rate-limited (24h cooldown, max 3 retries) to protect your users' cards from being flagged for fraud. Use `onAutoTopUpFailed` to notify users when their card needs attention.

See [Payment Failures](./docs/payment-failures.md) for the complete guide.

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

This README only covers the basics. The library supports more features than what is covered here. For more details, see the following docs:

- [Credits & Wallet](./docs/credits.md) - Consumable credits and prepaid wallet balances
- [Usage-Based Billing](./docs/usage.md) - Metered billing charged at period end
- [Payment Failures](./docs/payment-failures.md) - Handle declined cards and failed payments
- [Team Billing](./docs/team-billing.md) - Organization subscriptions with seats
- [Tax & Business Billing](./docs/tax.md) - Automatic tax calculation and VAT/tax ID collection
- [API Reference](./docs/reference.md) - Full API documentation
