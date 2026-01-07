# Team Billing

Bill organizations instead of individuals.

## Org Checkout

Pass `orgId` to bill an organization:

```typescript
checkout({
  planName: "Team",
  interval: "month",
  orgId: "org_456",
  user: { id: "admin_123", email: "admin@acme.com" },
});
```

## Credit Distribution

Two modes via `grantTo` config:

| Mode                     | Credits go to                 |
| ------------------------ | ----------------------------- |
| `"subscriber"` (default) | Org (shared pool)             |
| `"seat-users"`           | Each team member individually |

### Shared Pool

```typescript
const stripe = createStripeHandler({ billingConfig });

// All team members consume from org's balance
await stripe.credits.consume({
  userId: "org_456", // org ID
  creditType: "api_calls",
  amount: 1,
});
```

### Per-Seat Credits

```typescript
const stripe = createStripeHandler({
  billingConfig,
  credits: { grantTo: "seat-users" },
});
```

Each team member gets their own credit allocation automatically when you add seats:

**Add members:**

```typescript
await stripe.addSeat({ userId: "user_123", orgId: "org_456" });
```

**Remove members:**

```typescript
await stripe.removeSeat({ userId: "user_123", orgId: "org_456" });
```

**Consume individual credits:**

```typescript
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

`addSeat` increments subscription quantity (prorated). `removeSeat` decrements it.
