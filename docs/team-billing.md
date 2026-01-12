# Team Billing

Bill organizations instead of individuals.

## Setup

Add `resolveOrg` to your handler to enable org billing:

```typescript
// app/api/stripe/[...all]/route.ts
import { stripe } from "@/lib/stripe";

export const POST = stripe.createHandler({
  resolveUser: async () => {
    const { userId } = await auth();
    return userId ? { id: userId } : null;
  },

  // Enable org billing
  resolveOrg: async () => {
    // Return the org ID if this is an org checkout, null otherwise
    // You decide how to determine this (session state, user's current org, etc.)
    const session = await getSession();
    return session.currentOrgId ?? null;
  },
});
```

When `resolveOrg` returns an org ID:
- The org becomes the Stripe customer (billing entity)
- In `seat-users` mode, the user (from `resolveUser`) becomes the first seat

## Frontend

The frontend just requests the plan—no org ID needed:

```typescript
checkout({
  planName: "Team",
  interval: "month",
});
```

The server determines which org to bill via your `resolveOrg` function.

## Credit Distribution

Two modes via `grantTo` config:

| Mode                     | Credits go to                 |
| ------------------------ | ----------------------------- |
| `"subscriber"` (default) | Org (shared pool)             |
| `"seat-users"`           | Each team member individually |

### Shared Pool

```typescript
// lib/stripe.ts - credits go to subscriber (org) by default
import { createStripeHandler } from "stripe-no-webhooks";

export const stripe = createStripeHandler({ billingConfig });
```

```typescript
// Anywhere in your app
import { stripe } from "@/lib/stripe";

// All team members consume from org's balance
await stripe.credits.consume({
  userId: "org_456", // org ID
  creditType: "api_calls",
  amount: 1,
});
```

### Per-Seat Credits

```typescript
// lib/stripe.ts
import { createStripeHandler } from "stripe-no-webhooks";

export const stripe = createStripeHandler({
  billingConfig,
  credits: { grantTo: "seat-users" },
});
```

Each team member gets their own credit allocation automatically when you add seats:

```typescript
import { stripe } from "@/lib/stripe";

// Add members
await stripe.seats.add({ userId: "user_123", orgId: "org_456" });

// Remove members
await stripe.seats.remove({ userId: "user_123", orgId: "org_456" });

// Consume individual credits
await stripe.credits.consume({
  userId: "user_123", // individual user
  creditType: "api_calls",
  amount: 1,
});
```

## Per-Seat Billing

Charge per team member ($X/user/month):

```typescript
{
  name: "Team",
  price: [{ amount: 1000, currency: "usd", interval: "month" }],
  perSeat: true,
}
```

`seats.add` increments subscription quantity (prorated). `seats.remove` decrements it.
