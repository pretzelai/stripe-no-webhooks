# Credits & Wallet

Track consumable balances that renew with subscriptions.

## Which Should I Use?

| | Credits | Wallet | Usage |
|---|---------|--------|-------|
| **Unit** | Arbitrary (API calls, exports) | Money | Arbitrary |
| **Payment** | Pre-paid | Pre-paid | Post-paid |
| **On insufficient balance** | Consume fails | Consume succeeds (goes negative) | N/A (always records) |
| **Best for** | Feature quotas, rate limits | Pay-as-you-go with limits | True metered billing |

**Use credits** for discrete units with hard limits: "1,000 API calls/month", "50 exports/month"

**Use wallet** for monetary spending with soft limits: "$5.00/month for AI usage" where costs vary per operation

**Use usage** for post-paid metered billing: charge for exactly what customers use, billed at period end. See [Usage-Based Billing](./usage.md).

Credits and wallet are pre-paid and support the same lifecycle features: yearly scaling, `onRenewal` modes, plan changes.

---

## Configuration

### Credits

```typescript
{
  name: "Pro",
  price: [
    { amount: 2000, currency: "usd", interval: "month" },
    { amount: 20000, currency: "usd", interval: "year" },
  ],
  features: {
    api_calls: {
      displayName: "API Calls",
      credits: { allocation: 1000 },
    },
    storage_mb: {
      displayName: "Storage (MB)",
      credits: { allocation: 5000 },
    },
  },
}
```

### Wallet

```typescript
{
  name: "Pro",
  price: [
    { amount: 2000, currency: "usd", interval: "month" },
    { amount: 20000, currency: "usd", interval: "year" },
  ],
  wallet: {
    allocation: 500,  // $5.00 per month
    displayName: "AI Usage",  // Optional: shown on pricing page
  },
}
```

On the pricing page, wallet displays as `$5.00 AI Usage/mo`. If `displayName` is omitted, it shows `$5.00 usage credit/mo`.

### Renewal Behavior

By default, balances reset each billing cycle. Use `onRenewal: "add"` to accumulate instead:

```typescript
features: {
  api_calls: {
    displayName: "API Calls",
    credits: {
      allocation: 1000,
      onRenewal: "add",  // Balance accumulates instead of resetting
    },
  },
}

wallet: {
  allocation: 500,
  onRenewal: "add",
},
```

---

## Using Credits

```typescript
import { billing } from "@/lib/billing";

// Check balance
const balance = await billing.credits.getBalance({ userId, key: "api_calls" });

// Check if user has enough
const hasEnough = await billing.credits.hasCredits({ userId, key: "api_calls", amount: 10 });

// Consume (fails if insufficient)
const result = await billing.credits.consume({
  userId,
  key: "api_calls",
  amount: 1,
});

if (!result.success) {
  console.log(`Only ${result.balance} credits available`);
}
```

## Using Wallet

```typescript
import { wallet } from "stripe-no-webhooks";

// Check balance
const balance = await wallet.getBalance({ userId });
// { amount: 350, formatted: "$3.50", currency: "usd" }

// Consume (always succeeds, can go negative)
const result = await wallet.consume({
  userId,
  amount: 500,
  description: "GPT-4 usage",
});
// { balance: { amount: -150, formatted: "-$1.50", currency: "usd" } }

// Add funds manually
await wallet.add({
  userId,
  amount: 1000,
  currency: "usd",
  description: "Manual top-up",
});
```

### Wallet Negative Balances

Wallet consumption always succeeds. This enables post-pay billing:

```
User has $3.00
User runs operation costing $5.00
Balance = -$2.00 (operation completes)
```

On renewal with negative balance:

| Mode | Behavior | Example |
|------|----------|---------|
| `"reset"` (default) | Forgive debt, grant fresh allocation | -$2 → $5 |
| `"add"` | Add allocation to current balance | -$2 + $5 = $3 |

### Wallet Sub-Cent Precision

Wallet supports micro-cent precision for AI token pricing:

```typescript
// Charge $0.00015 per token
await wallet.consume({
  userId,
  amount: 0.00015 * tokenCount,
});
```

---

## Yearly Plans

Credits and wallet allocations **scale automatically** with billing interval:

| Interval | Scaling | Example ($5/mo or 1000 credits) |
|----------|---------|--------------------------------|
| Month | 1× | $5.00 or 1,000 |
| Year | 12× | $60.00 or 12,000 |
| Week | ÷4 | $1.25 or 250 |

Users on yearly plans get 12× the monthly allocation upfront.

**Why upfront?** Stripe only fires renewal webhooks once per year. Users paid for a full year, so they get a full year's worth.

### Monthly Drip for Yearly Plans

If you want to grant monthly even for yearly subscribers, you'll need a cron job:

- **Vercel Cron** / **pg_cron** / **Custom scheduler**
- Call `billing.credits.grant()` or `wallet.add()` monthly

---

## Top-Ups (Credits Only)

Let users buy more credits when they run out:

```typescript
features: {
  api_calls: {
    displayName: "API Calls",
    credits: { allocation: 1000 },
    pricePerCredit: 1,           // $0.01 per credit
    minPerPurchase: 100,
    maxPerPurchase: 10000,
    autoTopUp: {                 // Optional
      threshold: 100,            // When balance drops below 100
      amount: 500,               // Buy 500 more
      maxPerMonth: 5,
    },
  },
}
```

```typescript
const result = await billing.credits.topUp({
  userId,
  key: "api_calls",
  amount: 500,
});

if (!result.success && result.error?.recoveryUrl) {
  // Payment failed - redirect to add card
  return redirect(result.error.recoveryUrl);
}
```

### Auto Top-Up Failure Handling

The library automatically:
- **Rate-limits retries** - 24h cooldown for soft declines
- **Stops after 3 failures** - Blocks until user updates card
- **Distinguishes decline types** - Hard declines block immediately

See [Payment Failures](./payment-failures.md) for details.

---

## Plan Changes

When users upgrade, downgrade, or cancel, balances are handled to prevent abuse while remaining fair.

### Upgrades (Immediate)

Old balance preserved + new allocation granted:

```
Basic (1,000/mo) → Pro (10,000/mo)
User has 400 remaining
After: 400 + 10,000 = 10,400
```

**Exception:** Free → Paid revokes free balance first (no monetary value).

### Downgrades (At Period End)

User keeps current balance until period ends, then follows `onRenewal` setting:

| Setting | Behavior |
|---------|----------|
| `"reset"` (default) | Revoke all, grant new allocation |
| `"add"` | Keep balance, add new allocation |

**Why wait?** Prevents abuse where users consume credits then immediately downgrade.

### Interval Changes

| Change | Treated As |
|--------|------------|
| Monthly → Yearly | Upgrade (immediate, +12× new) |
| Yearly → Monthly | Downgrade (at period end) |

### Cancellation

All balances revoked immediately (credits and wallet).

### Summary

| Event | Behavior | Timing |
|-------|----------|--------|
| Upgrade | Keep old + grant new | Immediate |
| Free → Paid | Revoke old, grant new | Immediate |
| Downgrade | Keep until period end | Period end |
| Monthly → Yearly | Keep + grant 12× | Immediate |
| Yearly → Monthly | Keep until period end | Period end |
| Cancellation | Revoke all | Immediate |

---

## Transaction History

### Credits

```typescript
const history = await billing.credits.getHistory({
  userId,
  key: "api_calls",
  limit: 50,
});
```

### Wallet

```typescript
const history = await wallet.getHistory({ userId, limit: 50 });

// Each event:
{
  id: "uuid",
  amount: -500,
  balanceAfter: 350,
  type: "add" | "consume" | "revoke" | "adjust",
  source: "usage",
  description: "GPT-4 usage",
  createdAt: Date,
}
```

| Type | Meaning |
|------|---------|
| `add` / `grant` | Funds added |
| `consume` | Funds spent |
| `revoke` | Funds removed (cancellation, expiration) |
| `adjust` | Balance correction (debt forgiveness) |

---

## Displaying in Your UI

### Pricing Page

The generated `PricingPage` component automatically scales for yearly plans:
- Monthly: "1,000 API Calls/mo"
- Yearly: "12,000 API Calls/yr"

### Dashboard

Scale the allocation for display:

```typescript
const interval = /* from subscription */;
const baseAllocation = plan.features?.api_calls?.credits?.allocation ?? 0;

const scaledAllocation = baseAllocation * (
  interval === "year" ? 12 :
  interval === "week" ? 0.25 :
  1
);

// Display: "8,500 / 12,000 credits"
```

For wallet, just display the `formatted` field:

```typescript
const balance = await wallet.getBalance({ userId });
// balance.formatted = "$3.50" or "-$1.50"
```

---

## Callbacks

```typescript
const billing = new Billing({
  billingConfig,
  callbacks: {
    onCreditsGranted: ({ userId, key, amount }) => {},
    onCreditsRevoked: ({ userId, key, amount }) => {},
    onCreditsLow: ({ userId, key, balance, threshold }) => {},
    onTopUpCompleted: ({ userId, key, creditsAdded, amountCharged }) => {},
    onAutoTopUpFailed: ({ userId, key, trigger, status }) => {
      // See docs/payment-failures.md
    },
  },
});
```

Wallet uses the same underlying ledger as credits, so `onCreditsGranted` and `onCreditsRevoked` fire for wallet operations too (with `key: "wallet"`).

---

## Combining with Usage Billing

You can include credits in a plan and charge for overages via usage billing. Users consume their included credits first, then get billed for additional usage at the end of the period.

See [Usage-Based Billing](./usage.md) for the full guide, including the hybrid billing pattern.
