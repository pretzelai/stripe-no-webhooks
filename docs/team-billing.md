# Team Billing

Bill organizations instead of individuals.

## Setup

Add `resolveOrg` to your billing config to enable org billing:

```typescript
// lib/billing.ts
import { Billing } from "stripe-no-webhooks";
import billingConfig from "../billing.config";

export const billing = new Billing({
  billingConfig,
  successUrl: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
  cancelUrl: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",

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

Then your route handler is zero-config:

```typescript
// app/api/stripe/[...all]/route.ts
import { billing } from "@/lib/billing";

const handler = billing.createHandler();

export const POST = handler;
export const GET = handler;
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
// lib/billing.ts - credits go to subscriber (org) by default
import { Billing } from "stripe-no-webhooks";

export const billing = new Billing({ billingConfig });
```

```typescript
// Anywhere in your app
import { billing } from "@/lib/billing";

// All team members consume from org's balance
await billing.credits.consume({
  userId: "org_456", // org ID
  creditType: "api_calls",
  amount: 1,
});
```

### Per-Seat Credits

```typescript
// lib/billing.ts
import { Billing } from "stripe-no-webhooks";

export const billing = new Billing({
  billingConfig,
  credits: { grantTo: "seat-users" },
});
```

Each team member gets their own credit allocation automatically when you add seats:

```typescript
import { billing } from "@/lib/billing";

// Add members
await billing.seats.add({ userId: "user_123", orgId: "org_456" });

// Remove members
await billing.seats.remove({ userId: "user_123", orgId: "org_456" });

// Consume individual credits
await billing.credits.consume({
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
