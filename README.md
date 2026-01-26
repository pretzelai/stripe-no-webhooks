# stripe-no-webhooks

## Why this library?

This is an opinionated library to help you implement payments with Stripe.

1. Define plans in code which sync to your Stripe account
2. No manual webhook setup - the library handles webhooks and syncs Stripe data to your DB
3. Simple APIs for subscriptions, credits, wallet balances, top-ups, and usage-based billing
4. Support for seat based billing, tax collection, plan upgrades and downgrades (including sane handling of credits)
5. Optional callbacks (`onSubscriptionCreated`, etc.) for custom logic

## Quick Start

This guide assumes you have a Next.js app and a PostgreSQL database. We recommend starting with a `test mode` Stripe API key so you can test your setup locally in your dev environment. Then, the guide will walk you through how to set up your app for production.

### 1. Install

```bash
npm install stripe-no-webhooks stripe
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

This will create the `stripe` schema in your database with the necessary tables for syncing Stripe data and tracking credits + usage.

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
      },
    ],
  },
  production: {
    plans: [], // Add when going live
  },
};
```

Plans can also include credits, wallet, and usage-based billing:

```typescript
{
  name: "Pro",
  price: [{ amount: 2000, currency: "usd", interval: "month" }],
  features: {
    api_calls: {
      credits: { allocation: 1000 },   // 1000 included/month
      pricePerCredit: 1,               // $0.01 per extra call (top-ups)
      trackUsage: true,                // enable usage-based billing for overages
    },
  },
  wallet: {
    allocation: 500,                   // $5.00 prepaid balance
  },
}
```

See [Credits](./docs/credits.md), [Wallet](./docs/credits.md#wallet), and [Usage Billing](./docs/usage.md) docs for details.

### 4. Sync to Stripe

```bash
npx stripe-no-webhooks sync
```

Creates products/prices in Stripe and updates your config with their IDs.

### 5. Update your billing client

Update `lib/billing.ts` to specify how to get the `userId` in the `resolveUser` function. For example, with Clerk:

```typescript
import { Billing } from "stripe-no-webhooks";
import { auth } from "@clerk/nextjs/server"; // or your auth
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

### 6. Test it

Start your Next.js app, then in another terminal, forward Stripe webhooks:

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

Your setup is complete! Now let's use it.

---

## Using the Library

### Trigger a checkout

You can [generate a full pricing page](#generate-a-pricing-page) with plan selection, monthly/yearly toggle, and checkout flow built-in. Or call `checkout()` directly:

```typescript
import { checkout } from "stripe-no-webhooks/client";

<button onClick={() => checkout({ planName: "Pro", interval: "month" })}>
  Upgrade to Pro
</button>;
```

Test card: `4242 4242 4242 4242`, any future MM/YY expiry, any CVC.

### Check subscription status

```typescript
import { billing } from "@/lib/billing";

const subscription = await billing.subscriptions.get({ userId });

if (subscription?.status === "active") {
  console.log("Plan:", subscription.plan?.name);
}
```

#### What happens behind the scenes

When a user completes checkout:

1. Stripe sends a webhook to your app
2. The library receives it and syncs the data to your database. If credits / wallet are enabled, it will also update the credits / wallet balances
3. `billing.subscriptions.get({ userId })` now returns the subscription based on the Stripe data that's synced to your database
4. Credits / wallet are tracked automatically through a credit balance and a ledger of transactions via the library's internal APIs. These APIs are all idempotent and you don't have to worry about double counting or missing transactions

You can verify this by checking your database's stripe.subscriptions and `stripe.credit_balances` and `stripe.credit_ledger`.

### Use credits, wallet, or usage billing

```typescript
// Credits: consume included units
if (await billing.credits.hasCredits({ userId, key: "api_calls", amount: 1 })) {
  await billing.credits.consume({ userId, key: "api_calls", amount: 1 });
}

// Wallet: deduct from prepaid balance (in cents)
await billing.wallet.consume({
  userId,
  amount: 50,
  description: "AI generation",
});

// Usage: record for end-of-period billing
await billing.usage.record({ userId, key: "api_calls", amount: 1 });
```

### Open billing portal

Let users manage their subscription:

```typescript
import { customerPortal } from "stripe-no-webhooks/client";

<button onClick={() => customerPortal()}>
  Manage Billing
</button>
```

### React to events

```typescript
export const billing = new Billing({
  billingConfig,
  callbacks: {
    onSubscriptionCreated: async (subscription) => {
      // Send welcome email
    },
    onSubscriptionCancelled: async (subscription) => {
      // Clean up resources
    },
    // List of full callbacks in docs/reference.md
  },
});
```

---

## Generate a Pricing Page

```bash
npx stripe-no-webhooks generate pricing-page
```

This creates a fully customizable pricing page component at `components/PricingPage.tsx`:

```tsx
// in your pricing page, for eg /pricing
import { PricingPage } from "@/components/PricingPage";

export default function Pricing() {
  return <PricingPage />;
}
```

Automatically handles: plan fetching, current subscription detection, monthly/yearly toggle, checkout flow, redirect handling, error handling, and more.

---

## Going to Production

1. Add plans to the `production` section of `billing.config.ts`
2. Run `npx stripe-no-webhooks sync` and choose "Set up for production". This will:

- Sync your plans to Stripe live mode
- Create a webhook endpoint for your app in Stripe
- Display the webhook URL and secret in the CLI output

3. Add the webhook secret to your production environment (for eg, Vercel environment variables):
   ```
   STRIPE_WEBHOOK_SECRET=whsec_...
   STRIPE_SECRET_KEY=sk_live_... # IMPORTANT: Your live Stripe secret key
   DATABASE_URL=postgresql://[username]:[password]@[production-db-url]:5432/[production-db-name]
   NEXT_PUBLIC_APP_URL=https://your-production-app.com
   ```

---

## More Features

| Feature                                        | Use Case                                             |
| ---------------------------------------------- | ---------------------------------------------------- |
| [Credits](./docs/credits.md)                   | "1000 API calls/month included" - consumable units   |
| [Wallet](./docs/credits.md#wallet)             | "$5/month for AI usage" - prepaid spending balance   |
| [Top-ups](./docs/credits.md#top-ups)           | Let users buy more credits on demand                 |
| [Usage Billing](./docs/usage.md)               | "Pay $0.10 per API call" - post-paid metered billing |
| [Team Billing](./docs/team-billing.md)         | Bill organizations, per-seat pricing                 |
| [Tax Collection](./docs/tax.md)                | Automatic VAT/GST calculation and ID collection      |
| [Payment Failures](./docs/payment-failures.md) | Handle declined cards, retry logic                   |

---

## CLI Commands

| Command                 | Description                    |
| ----------------------- | ------------------------------ |
| `init`                  | Set up config files and `.env` |
| `migrate`               | Create database tables         |
| `sync`                  | Sync plans to Stripe           |
| `generate pricing-page` | Generate pricing component     |
| `backfill`              | Import existing Stripe data    |

---

## API Reference

See [docs/reference.md](./docs/reference.md) for the complete API.
