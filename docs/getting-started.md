# Getting Started

This guide walks you through setting up stripe-no-webhooks from scratch.

## Prerequisites

- **Next.js app** (App Router recommended)
- **PostgreSQL database** (Neon, Supabase, or any Postgres)
- **Stripe account** with API keys

## Installation

```bash
npm install stripe-no-webhooks stripe
```

## Step 1: Initialize

Run the setup wizard:

```bash
npx stripe-no-webhooks init
```

You'll be asked for three things:

| Prompt | What to enter |
|--------|---------------|
| **Stripe Secret Key** | Your test key (`sk_test_...`) from [Stripe Dashboard](https://dashboard.stripe.com/apikeys) |
| **Database URL** | PostgreSQL connection string |
| **Site URL** | `http://localhost:3000` for local development |

The wizard creates three files:

```
billing.config.ts      # Define your plans here
lib/billing.ts         # Billing client instance
app/api/stripe/[...all]/route.ts  # Webhook & API handler
```

## Step 2: Create Database Tables

```bash
npx stripe-no-webhooks migrate
```

This creates the `stripe` schema with tables for syncing Stripe data and tracking credits.

## Step 3: Define Your Plans

Open `billing.config.ts` and define your subscription plans:

```typescript
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
          { amount: 2000, currency: "usd", interval: "month" },  // $20/month
          { amount: 20000, currency: "usd", interval: "year" },  // $200/year (save $40)
        ],
      },
      {
        name: "Enterprise",
        price: [
          { amount: 10000, currency: "usd", interval: "month" }, // $100/month
        ],
      },
    ],
  },
};

export default billingConfig;
```

**Notes:**
- `amount` is in cents (2000 = $20.00)
- Each plan can have multiple prices (e.g., monthly + yearly)
- Plan names should be unique
- Plans can include [credits](./credits.md) with monthly allocations and top-ups

## Step 4: Sync to Stripe

```bash
npx stripe-no-webhooks sync
```

This does two things:
1. Creates products and prices in your Stripe account
2. Updates `billing.config.ts` with the Stripe IDs

After syncing, your config will have IDs filled in:

```typescript
{
  name: "Pro",
  id: "prod_ABC123",  // ← Added automatically
  price: [
    { id: "price_XYZ789", amount: 2000, currency: "usd", interval: "month" },
  ],
}
```

**Commit this file** - the IDs ensure your code references the correct Stripe objects.

## Step 5: Connect Your Auth

Open `app/api/stripe/[...all]/route.ts` and connect your authentication:

```typescript
import { billing } from "@/lib/billing";
import { auth } from "@clerk/nextjs/server"; // Example: Clerk

export const POST = billing.createHandler({
  resolveUser: async () => {
    const { userId } = await auth();
    return userId ? { id: userId } : null;
  },
});
```

The `resolveUser` function tells the library who the current user is. This is used to:
- Create Stripe customers linked to your users
- Ensure checkout sessions are for the authenticated user
- Look up subscriptions by user ID

**Other auth examples:**

```typescript
// NextAuth.js
import { getServerSession } from "next-auth";
resolveUser: async () => {
  const session = await getServerSession();
  return session?.user?.id ? { id: session.user.id } : null;
}

// Supabase Auth
import { createClient } from "@/utils/supabase/server";
resolveUser: async () => {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user ? { id: user.id } : null;
}
```

## Step 6: Test Locally

Start your Next.js app:

```bash
npm run dev
```

In another terminal, forward Stripe webhooks using the [Stripe CLI](https://stripe.com/docs/stripe-cli):

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

> **No webhook secret needed!** The library automatically skips signature verification on localhost for easier development.

Now you can:
- Create test checkouts
- Receive webhook events
- See data sync to your database

## Next: Build Your UI

You have two options:

### Option A: Generate a Pricing Page

```bash
npx stripe-no-webhooks generate pricing-page
```

This creates a ready-to-use component at `components/PricingPage.tsx`:

```tsx
import { PricingPage } from "@/components/PricingPage";

export default function Pricing() {
  return <PricingPage />;
}
```

That's it! The component automatically fetches plans and detects the user's current subscription.

### Option B: Use the Client APIs

```typescript
// Client-side: trigger checkout
import { checkout } from "stripe-no-webhooks/client";

<button onClick={() => checkout({ planName: "Pro", interval: "month" })}>
  Subscribe to Pro
</button>

// Server-side: check subscription status
import { billing } from "@/lib/billing";

const subscription = await billing.subscriptions.get(userId);
if (subscription?.status === "active") {
  // User has active subscription
  console.log("Plan:", subscription.plan.name);
}
```

---

## Going to Production

When you're ready to deploy, the `sync` command handles everything interactively.

### Staging Environment

Run `sync` and choose **"Set up for staging"**:

```bash
npx stripe-no-webhooks sync
```

- Enter your staging URL
- Uses your existing test key (Stripe test mode)
- Creates a webhook endpoint
- Displays the webhook secret → add to staging env vars

### Production Environment

Run `sync` and choose **"Set up for production"**:

```bash
npx stripe-no-webhooks sync
```

- Enter your **live** Stripe key (`sk_live_...`)
- Enter your production URL
- Syncs the `production` section of billing.config.ts
- Creates a webhook endpoint
- Displays the webhook secret → add to production env vars

Before going live, add a `production` section to your config:

```typescript
const billingConfig: BillingConfig = {
  test: {
    plans: [/* your test plans */],
  },
  production: {
    plans: [
      // Same structure as test - IDs filled in when you sync
      { name: "Free", price: [{ amount: 0, currency: "usd", interval: "month" }] },
      { name: "Pro", price: [{ amount: 2000, currency: "usd", interval: "month" }] },
    ],
  },
};
```

---

## What's Next?

- [Credits System](./credits.md) - Add consumable credits to plans
- [Team Billing](./team-billing.md) - Organization subscriptions with seats
- [API Reference](./reference.md) - Full API documentation
