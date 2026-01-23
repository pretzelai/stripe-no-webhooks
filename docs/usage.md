# Usage-Based Billing

Charge customers for what they actually use, billed at the end of each billing period.

## When to Use Usage Billing

| Billing Model | How It Works | Best For |
|---------------|--------------|----------|
| **Credits** | Pre-paid units, fails when exhausted | Feature quotas, rate limits |
| **Wallet** | Pre-paid money, can go negative | Pay-as-you-go with spending limits |
| **Usage** | Post-paid, charged at period end | True metered billing (API calls, compute time) |

**Use usage billing when:**
- You want customers to pay for exactly what they use
- Usage is unpredictable and you don't want to block access
- You're comfortable with post-paid billing (charge after consumption)

**Use credits/wallet instead when:**
- You want to limit spending upfront
- Customers prefer knowing costs in advance
- You need to block access when balance runs out

---

## Quick Start

### 1. Configure your plan

Add `trackUsage: true` to any feature that should be metered:

```typescript
// billing.config.ts
{
  name: "Pro",
  price: [
    { amount: 2000, currency: "usd", interval: "month" },  // $20/mo base
  ],
  features: {
    api_calls: {
      displayName: "API Calls",
      pricePerCredit: 10,    // 10 cents per call
      trackUsage: true,      // Enable usage billing
    },
  },
}
```

### 2. Sync to Stripe

```bash
npx stripe-no-webhooks sync
```

This creates a Stripe Meter and metered price for the feature.

### 3. Record usage

```typescript
import { billing } from "@/lib/billing";

// Record usage when the action happens
await billing.usage.record({
  userId,
  key: "api_calls",
  amount: 1,
});
```

### 4. Check usage

```typescript
const summary = await billing.usage.getSummary({ userId, key: "api_calls" });
// { totalAmount: 150, estimatedCost: 1500, period: { start: Date, end: Date } }
// 150 calls × 10 cents = $15.00 estimated
```

At the end of the billing period, Stripe automatically charges for recorded usage.

---

## How It Works

```
User action → usage.record() → Stripe Meter → Invoice at period end
                    ↓
              Local storage → getSummary() (real-time queries)
```

1. **You call `usage.record()`** when the billable action happens
2. **Event sent to Stripe** via their Meters API
3. **Event stored locally** for real-time queries (Stripe's meter query API has delays)
4. **At billing period end**, Stripe totals the usage and adds it to the invoice

### What Users See

On their invoice:
```
Pro                     1 × $20.00    $20.00
API Calls (Jan-Feb)   150 × $0.10    $15.00
-------------------------------------------
Total                                 $35.00
```

Each usage feature gets its own line item with a clear name (from `displayName`).

---

## Configuration Options

```typescript
features: {
  api_calls: {
    displayName: "API Calls",      // Shown on invoices
    pricePerCredit: 10,            // Price per unit in cents (required for usage)
    trackUsage: true,              // Enable usage billing

    // Optional: Pre-paid allocation
    credits: {
      allocation: 100,             // 100 free calls included
      onRenewal: "reset",          // Reset each period
    },
  },
}
```

### Usage Only (Pure Pay-As-You-Go)

```typescript
{
  name: "Pay As You Go",
  price: [{ amount: 0, currency: "usd", interval: "month" }],  // Free base
  features: {
    api_calls: {
      displayName: "API Calls",
      pricePerCredit: 5,      // 5 cents per call
      trackUsage: true,
    },
  },
}
```

### Hybrid: Credits + Usage

Include credits that users consume first, then overflow to usage billing:

```typescript
{
  name: "Pro",
  price: [{ amount: 2000, currency: "usd", interval: "month" }],
  features: {
    api_calls: {
      displayName: "API Calls",
      pricePerCredit: 10,
      trackUsage: true,
      credits: {
        allocation: 100,       // 100 calls included
      },
    },
  },
}
```

See [Hybrid Billing](#hybrid-billing-credits--usage) below for how to implement this.

---

## API Reference

### Record Usage

```typescript
await billing.usage.record({
  userId: string,
  key: string,           // Feature key from config
  amount: number,        // Units consumed (default: 1)
});
```

Call this every time the billable action occurs. Events are sent to Stripe immediately.

**Error handling:** Throws if `trackUsage` is not enabled for the feature.

### Get Usage Summary

```typescript
const summary = await billing.usage.getSummary({
  userId: string,
  key: string,
});

// Returns:
{
  totalAmount: number,      // Total units consumed this period
  estimatedCost: number,    // totalAmount × pricePerCredit (in cents)
  period: {
    start: Date,
    end: Date,
  },
}
```

This queries local storage, so it's real-time (no Stripe API delays).

---

## Hybrid Billing: Credits + Wallet + Usage

A common pattern: include some usage in the subscription, charge overages to wallet, then bill remaining usage at period end.

**The library doesn't enforce this automatically.** You control the logic:

### Simple: Credits → Usage

```typescript
async function handleApiCall(userId: string) {
  // 1. Try to use included credits first
  const result = await billing.credits.consume({
    userId,
    key: "api_calls",
    amount: 1,
  });

  if (result.success) {
    // Used included credits, no usage charge
    return;
  }

  // 2. Credits exhausted, record as usage (charged at period end)
  await billing.usage.record({
    userId,
    key: "api_calls",
    amount: 1,
  });
}
```

### Full: Credits → Wallet → Usage

Use all three primitives together for maximum flexibility:

```typescript
async function handleApiCall(userId: string, units: number) {
  const pricePerUnit = 10; // cents, from your config
  let remainingCost = units * pricePerUnit;

  // 1. Use credits first (free included units)
  const creditBalance = await billing.credits.getBalance({ userId, key: "api_calls" });
  if (creditBalance > 0) {
    const creditsToUse = Math.min(creditBalance, units);
    await billing.credits.consume({ userId, key: "api_calls", amount: creditsToUse });
    remainingCost -= creditsToUse * pricePerUnit;
  }

  if (remainingCost === 0) return;

  // 2. Use wallet next (pre-paid balance)
  const walletBalance = await billing.wallet.getBalance({ userId });
  if (walletBalance && walletBalance.amount > 0) {
    const walletToUse = Math.min(walletBalance.amount, remainingCost);
    await billing.wallet.consume({ userId, amount: walletToUse });
    remainingCost -= walletToUse;
  }

  if (remainingCost === 0) return;

  // 3. Record remainder as usage (post-paid, charged at period end)
  const unitsForUsage = remainingCost / pricePerUnit;
  await billing.usage.record({ userId, key: "api_calls", amount: unitsForUsage });
}
```

This pattern gives users the best experience:
- **Credits**: Free included units from their plan
- **Wallet**: Pre-paid buffer they control
- **Usage**: Overflow charged at period end (no interruption)

---

## Displaying Usage in Your UI

### Current Period Usage

```typescript
const summary = await billing.usage.getSummary({ userId, key: "api_calls" });

// Format for display
const formatted = `${summary.totalAmount} calls (${formatCurrency(summary.estimatedCost)})`;
// "150 calls ($15.00)"
```

### With Included Credits

```typescript
const credits = await billing.credits.getBalance({ userId, key: "api_calls" });
const usage = await billing.usage.getSummary({ userId, key: "api_calls" });

// Show both
// "Credits: 25 remaining"
// "Overage: 150 calls ($15.00)"
```

---

## Testing Usage Billing

Usage charges only appear on invoices at the end of a billing period. To test without waiting a month, use [Stripe Test Clocks](https://docs.stripe.com/billing/testing/test-clocks).

### Manual Testing

1. Create a test clock in Stripe Dashboard → Developers → Test Clocks
2. Create a customer attached to that clock
3. Subscribe them to your plan
4. Record some usage via your app
5. Advance the test clock past the billing period
6. Check the generated invoice for usage line items

### Using Stripe CLI

```bash
# Create test clock
stripe test_helpers.test_clocks create --frozen-time=$(date +%s)

# Create customer with test clock
stripe customers create --test-clock=clock_xxx

# ... subscribe customer, record usage via your app ...

# Advance time by 1 month
stripe test_helpers.test_clocks advance --frozen-time=$(date -v+1m +%s)
```

---

## Callbacks

```typescript
const billing = new Billing({
  billingConfig,
  callbacks: {
    onUsageRecorded: ({ userId, key, amount }) => {
      // Called after each usage.record()
      // Use for logging, analytics, or real-time notifications
    },
  },
});
```

---

## Important Notes

### Auto Top-Ups Don't Work with Usage

If a feature has `trackUsage: true`, auto top-ups are disabled for that feature. This is intentional—usage billing is post-paid, so there's no balance to top up.

Use credits (with auto top-ups) OR usage billing, not both on the same feature.

### Usage Events Are Immutable

Once recorded, usage events cannot be modified or deleted. If you need to adjust:
- Grant credits to offset the charge
- Issue a refund after the invoice is paid

### Stripe Meter Limits

Stripe Meters have rate limits. For high-volume usage (thousands of events per second), consider batching:

```typescript
// Instead of recording each event immediately
await billing.usage.record({ userId, key: "api_calls", amount: 1 });

// Batch and record periodically
let pendingUsage = 0;
// ... accumulate usage ...
await billing.usage.record({ userId, key: "api_calls", amount: pendingUsage });
```
