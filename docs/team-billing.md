# Team Billing

Bill organizations instead of individuals.

## When to Use

- You want to bill a company/team, not individual users
- One subscription covers multiple team members
- Optionally charge per seat ($X/user/month)

---

## Setup

Add `resolveOrg` to your billing config:

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

  // Return org ID when doing org billing
  resolveOrg: async () => {
    const session = await getSession();
    return session.currentOrgId ?? null;  // null = bill user, string = bill org
  },
});
```

When `resolveOrg` returns an org ID:
- The org becomes the Stripe customer
- Subscriptions are tied to the org, not the user
- Credits/wallet go to the org (shared pool)

---

## Checkout

The frontend is the same—no org ID needed:

```typescript
checkout({ planName: "Team", interval: "month" });
```

The server uses your `resolveOrg` function to determine which org to bill.

---

## Check Org Subscription

```typescript
// Check if org has active subscription
const subscription = await billing.subscriptions.get({ userId: orgId });

if (subscription?.status === "active") {
  // Org is subscribed
}
```

Note: For org billing, pass the `orgId` as `userId` to subscription methods.

---

## Credit Distribution

Two modes via `grantTo` config:

| Mode | Credits go to | Use case |
|------|---------------|----------|
| `"subscriber"` (default) | The org (shared pool) | Team shares a quota |
| `"seat-users"` | Each team member | Individual quotas |

### Shared Pool (Default)

All team members consume from the org's balance:

```typescript
// Check org's balance
const balance = await billing.credits.getBalance({
  userId: orgId,  // org ID
  key: "api_calls",
});

// Consume from org's pool
await billing.credits.consume({
  userId: orgId,  // org ID
  key: "api_calls",
  amount: 1,
});
```

### Per-Seat Credits

Each team member gets their own allocation:

```typescript
// lib/billing.ts
export const billing = new Billing({
  billingConfig,
  credits: { grantTo: "seat-users" },
});
```

Manage seats:

```typescript
// Add member (grants them credits)
await billing.seats.add({ userId: "user_123", orgId: "org_456" });

// Remove member (revokes their credits)
await billing.seats.remove({ userId: "user_123", orgId: "org_456" });

// Consume from individual's balance
await billing.credits.consume({
  userId: "user_123",  // user ID, not org
  key: "api_calls",
  amount: 1,
});
```

---

## Per-Seat Pricing

Charge per team member ($X/user/month):

```typescript
{
  name: "Team",
  price: [{ amount: 1000, currency: "usd", interval: "month" }],  // $10/seat/month
  perSeat: true,
}
```

When `perSeat: true`:
- `seats.add()` increments subscription quantity (prorated)
- `seats.remove()` decrements subscription quantity (prorated)

The first seat is the user who subscribes.
