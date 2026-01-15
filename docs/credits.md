# Credits

Give users a monthly allocation of credits (API calls, emails, tokens, etc.).

## Add Credits to a Plan

```typescript
{
  name: "Pro",
  price: [{ amount: 2000, currency: "usd", interval: "month" }],
  credits: {
    api_calls: { allocation: 1000 },
    ai_tokens: { allocation: 50000 },
  },
}
```

When a user subscribes, they get these credits. On each billing cycle, credits reset (or accumulate if you set `onRenewal: "add"`).

```typescript
credits: {
  api_calls: {
    allocation: 1000,
    onRenewal: "add",  // Credits stack instead of resetting
  },
}
```

## Consume Credits

```typescript
import { billing } from "@/lib/billing";

const result = await billing.credits.consume({
  userId: "user_123",
  creditType: "api_calls",
  amount: 1,
});

if (!result.success) {
  // User has insufficient credits
  console.log(`Only ${result.balance} credits available`);
}
```

## Check Balance

```typescript
const balance = await billing.credits.getBalance("user_123", "api_calls");
const allBalances = await billing.credits.getAllBalances("user_123");
const hasEnough = await billing.credits.hasCredits("user_123", "api_calls", 10);
```

## Top-Ups

Let users buy more credits. Choose one mode per credit type:

**On-demand** - user clicks a button to buy additional credits:

```typescript
credits: {
  api_calls: {
    allocation: 1000,
    topUp: {
      mode: "on_demand",
      pricePerCreditCents: 1,  // $0.01 per credit, currency comes from the Plan currency
      minPerPurchase: 100,
      maxPerPurchase: 10000,
    },
  },
}
```

```typescript
// In your API route
const result = await billing.credits.topUp({
  userId: "user_123",
  creditType: "api_calls",
  amount: 500,
});

if (result.success) {
  // Credits added, card charged
} else if (result.error?.recoveryUrl) {
  // No card or payment failed - redirect to Stripe Checkout
  // to manually purchase credits by putting in a new card
  return redirect(result.error.recoveryUrl);
}
```

**Auto** - charges automatically when balance is low:

```typescript
credits: {
  api_calls: {
    allocation: 1000,
    topUp: {
      mode: "auto",
      pricePerCreditCents: 1,
      balanceThreshold: 100,  // When below 100
      purchaseAmount: 500,    // Buy 500 more
      maxPerMonth: 5,         // Upto 5 times each calendar month
    },
  },
}
```

Auto top-up triggers automatically when using `billing.credits.consume()`.

### Top-Up Payment Mode

Top-ups use different Stripe payment flows depending on your tax configuration:

| Tax Config | Payment Method | Stripe Fee | Shows in Portal |
|------------|---------------|------------|-----------------|
| Disabled (default) | PaymentIntent | Standard | No |
| Enabled (`automaticTax` or `taxIdCollection`) | Invoice | +0.4-0.5% | Yes |

**When to use each:**

- **B2C apps** (consumer-facing): Leave tax config disabled for lower fees. Top-ups won't appear in Customer Portal's invoice history, but customers typically don't need invoices for personal purchases.

- **B2B apps** (business customers): Enable tax config to create proper invoices. Business customers need invoices for accounting/expense reports, and they'll appear in the Customer Portal.

```typescript
// B2B mode - creates invoices for top-ups
const billing = new Billing({
  billingConfig,
  tax: {
    automaticTax: true,  // This enables invoice-based top-ups
  },
});
```

## Plan Changes (Upgrades & Downgrades)

When users change plans, credits are handled differently for upgrades vs downgrades to prevent abuse while remaining fair to users.

### Upgrades (Immediate)

When a user upgrades (e.g., Basic → Pro):

1. **Old credits are preserved** - Users keep their remaining credits from the old plan
2. **New credits are granted** - Users receive the new plan's full allocation
3. **Result:** User has old_balance + new_allocation

**Why preserve old credits?** Stripe doesn't prorate subscription upgrades by default. If a user upgrades mid-cycle, they've already paid for their remaining Basic credits. Revoking them would be unfair since they're not getting a refund.

```
Example: User on Basic (1,000 credits/month) upgrades to Pro (10,000 credits/month)
- Day 15: User has 400 credits remaining
- After upgrade: User has 400 + 10,000 = 10,400 credits
- This is fair: they paid for those 400 credits
```

**Exception: Free → Paid upgrades** revoke the free credits first, then grant paid credits. Free tier credits have no monetary value, so there's nothing to preserve.

### Downgrades (At Period End)

When a user downgrades (e.g., Pro → Basic):

1. **Change is scheduled** for the end of the billing period
2. **User keeps current credits** until period ends
3. **At period end:** Credits are adjusted based on `onRenewal` setting

**Why wait until period end?** To prevent abuse:

```
Abuse scenario (if downgrades were immediate):
1. User subscribes to Pro (10,000 credits) for $50
2. User consumes 9,500 credits
3. User downgrades to Basic (1,000 credits) for $10
4. If we immediately granted 1,000 new credits:
   User effectively got 10,500 credits for $50 + $10 = $60
   (Should have paid $50 + $50 = $100 for that many credits)
```

By waiting until period end, users get what they paid for—no more, no less.

### Downgrade Credit Behavior

At period end, credits follow the `onRenewal` setting:

| Setting | Behavior | Use Case |
|---------|----------|----------|
| `"reset"` (default) | Revoke all, grant new allocation | Most SaaS apps |
| `"add"` | Keep balance, add new allocation | Rollover credits |

```typescript
credits: {
  api_calls: {
    allocation: 1000,
    onRenewal: "reset",  // Downgrade resets to new plan's allocation
  },
  storage_gb: {
    allocation: 100,
    onRenewal: "add",    // Downgrade adds to existing balance
  },
}
```

Credit types that don't exist in the new plan are always revoked.

### Cancellation

When a subscription is cancelled, **all credits are revoked** (including top-ups). Users lose access to the service, so credits have no value.

### Summary

| Event | Credits Behavior | Timing |
|-------|-----------------|--------|
| Upgrade (Paid → Paid) | Keep old + grant new | Immediate |
| Upgrade (Free → Paid) | Revoke old, grant new | Immediate |
| Downgrade | Keep current until period end, then adjust | Period end |
| Cancellation | Revoke all | Immediate |

## Callbacks

Define callbacks when creating the `Billing` instance:

```typescript
// lib/billing.ts
import { Billing } from "stripe-no-webhooks";
import billingConfig from "../billing.config";

export const billing = new Billing({
  billingConfig,
  callbacks: {
    onCreditsGranted: ({ userId, creditType, amount }) => {},
    onCreditsRevoked: ({ userId, creditType, amount }) => {},
    onCreditsLow: ({ userId, creditType, balance, threshold }) => {},
    onTopUpCompleted: ({
      userId,
      creditType,
      creditsAdded,
      amountCharged,
    }) => {},
    onAutoTopUpFailed: ({ userId, creditType, reason }) => {},
  },
});
```
