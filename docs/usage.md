# Usage-Based Billing

You're building something where users consume resources—API calls, AI tokens, storage, compute time. Now you need to figure out how to charge for it.

This guide helps you decide between **pre-paid** (credits), **post-paid** (usage billing), or a **hybrid** of both.

---

## Choosing Your Pricing Model

### The Three Approaches

**Pre-paid (Credits/Wallet)** — Users have a visible balance

> "You have 847 API calls remaining" → User buys more when low, or auto top-up kicks in

- Users see exactly what they have and control their spending
- You get paid before or during usage (low risk)
- You decide what happens at zero: prompt to buy more, auto top-up, or let balance go negative

**Post-paid (Usage Billing)** — No balance, invoice at end of month

> "January Invoice: 1,500 API calls × $0.10 = $150.00"

- Frictionless "just use it" experience
- Users don't think about limits—they get a bill later
- You can't enforce hard limits (that's what credits are for)

**Hybrid** — Include credits, bill overages as usage

> "1,000 API calls included with your plan. You used 1,500, so we're billing $50 for the extra 500."

- Predictable value: users know what they're getting
- No hard ceiling: power users keep going and pay for overages
- This is what most SaaS companies do

### Which Should You Choose?

**Choose pre-paid credits if:**

- You want zero risk of non-payment (they've already paid)
- Your users want to see a credit/wallet balance and control their spending
- You want the option to enforce limits (or let them top up / auto top-up)
- You're selling to consumers or budget-conscious teams

**Choose post-paid usage if:**

- Your users expect to "just use it" without thinking about balances
- You're selling to businesses who are used to getting invoices
- You're comfortable with some non-payment risk

**Choose hybrid if:**

- You want to give predictable value ("1,000 API calls included, $0.50 per additional API call")
- But also let power users scale without hard limits
- This is the most common SaaS model—familiar to users

### The Risk Tradeoff

|                            | Your Risk                        | User Experience                                         |
| -------------------------- | -------------------------------- | ------------------------------------------------------- |
| **Pre-paid**               | None—already paid                | Visible balance, user controls spending, manual top-ups |
| **Pre-paid + auto top-up** | Low—card on file                 | Seamless, never runs out                                |
| **Post-paid**              | Higher—invoice might not be paid | No friction, "just works"                               |
| **Hybrid**                 | Low—base subscription guaranteed | Predictable value + flexibility for power users         |

**Practical tip**: If you're unsure, start with hybrid. Users get predictable value from their subscription, power users aren't blocked, and your base revenue is guaranteed.

---

## Implementing Usage Billing

Decided on post-paid or hybrid? Here's how to set it up. (For pre-paid credits only, see [Credits & Wallet](./credits.md).)

#### 1. Add to your config

```typescript
// billing.config.ts
{
  name: "Pro",
  price: [{ amount: 2000, currency: "usd", interval: "month" }],
  features: {
    api_calls: {
      displayName: "API Calls",
      pricePerCredit: 10,   // 10 cents per unit
      trackUsage: true,     // Enable usage billing
    },
  },
}
```

Two things enable usage billing:

- `pricePerCredit` — how much to charge per unit (in cents)
- `trackUsage: true` — tells the library to track and bill usage, also tells the library to create Stripe usage price and meters.

#### 2. Sync to Stripe

```bash
npx stripe-no-webhooks sync
```

This creates a **Stripe Meter** for tracking usage and a **metered price** for billing.

#### 3. Record usage when it happens

```typescript
import { billing } from "@/lib/billing";

// Call this every time a billable action occurs
await billing.usage.record({
  userId,
  key: "api_calls",
  amount: 1,
});
```

That's it. The library sends the event to Stripe's meter and stores it locally (so you can query it in real-time).

#### 4. Stripe handles the rest

At the end of each billing period, Stripe automatically:

1. Totals up all usage events for the period
2. Adds a line item to the invoice
3. Charges the customer's card

```
Pro                        1 × $20.00    $20.00
API Calls (Jan 1-31)     150 × $0.10     $15.00
------------------------------------------------
Total                                    $35.00
```

---

## Showing Usage in Your App

Users want to know what they've used and what their bill will be. Query current period usage in real-time:

```typescript
const summary = await billing.usage.getSummary({ userId, key: "api_calls" });

// Returns:
{
  totalAmount: 150,        // Units consumed this period
  estimatedCost: 1500,     // 150 × 10 cents = $15.00 (in cents)
  period: {
    start: Date,           // Start of current billing period
    end: Date,             // End of current billing period
  },
}
```

Display it in your UI:

```typescript
const formatted = `${summary.totalAmount} calls ($${(summary.estimatedCost / 100).toFixed(2)})`;
// "150 calls ($15.00)"
```

**Why this works in real-time**: The library stores usage events locally (not just in Stripe). This lets you query usage instantly without waiting for Stripe's meter API.

---

## Common Pricing Models

### Pure Pay-As-You-Go

No monthly fee—just pay for usage. Great for getting users started with zero commitment.

```typescript
{
  name: "Pay As You Go",
  price: [{ amount: 0, currency: "usd", interval: "month" }],  // $0 base
  features: {
    api_calls: {
      displayName: "API Calls",
      pricePerCredit: 5,   // 5 cents per call
      trackUsage: true,
    },
  },
}
```

### Base + Usage

Monthly subscription that includes platform access, plus pay-per-use for consumption based product lines. Most B2B SaaS apps use this model (make sure you trust your users to pay for their usage).

```typescript
{
  name: "Pro",
  price: [{ amount: 2000, currency: "usd", interval: "month" }],  // $20 base
  features: {
    api_calls: {
      displayName: "API Calls",
      pricePerCredit: 10,  // 10 cents per call
      trackUsage: true,
    },
  },
}
```

### Credits + Usage (Hybrid)

Include some calls free, bill for overages. This is the "best of both worlds"—users get predictable value from their subscription, but power users aren't blocked. Companies like Cursor use this model - you get some fixed AI Completion calls included, then you get charged for extra usage.

```typescript
{
  name: "Pro",
  price: [{ amount: 2000, currency: "usd", interval: "month" }],
  features: {
    api_calls: {
      credits: {
        allocation: 100,  // 100 calls included free
      },
      displayName: "API Calls",
      pricePerCredit: 10,  // 10 cents per call
      trackUsage: true,
    },
  },
}
```

See [Hybrid Billing](#hybrid-billing) for how to implement the consumption logic, starting with consuming credits first, then wallet (if exists), then usage billing.

---

## Hybrid Billing

The most user-friendly model: include credits with the subscription, then bill for overages. **"100 API calls included, then $0.10 each"**

### Why This Is Great

- **Predictable value**: Users know what they're getting for their subscription
- **No hard blocks**: Power users can keep going (and pay more)
- **Fair pricing**: Light users don't subsidize heavy users

### How to Implement

The library doesn't automatically decide when to use credits vs. usage billing—**you control the logic**. This is intentional: different apps have different rules.

Here's the basic pattern:

```typescript
async function handleApiCall(userId: string) {
  // 1. Check if user has included credits
  const hasCredits = await billing.credits.hasCredits({
    userId,
    key: "api_calls",
    amount: 1,
  });

  if (hasCredits) {
    // Use included credits (free to the user)
    await billing.credits.consume({ userId, key: "api_calls", amount: 1 });
    return;
  }

  // 2. No credits left—record as usage (billed at period end)
  await billing.usage.record({ userId, key: "api_calls", amount: 1 });
}
```

### Credits → Wallet → Usage

If you also have a wallet (pre-paid monetary balance), you might want: free credits first, then wallet balance, then usage billing.

```typescript
async function handleApiCall(userId: string, units: number) {
  const pricePerUnit = 10; // cents, get this from your billing.config.ts
  let remaining = units;

  // 1. Credits first (free included units)
  const creditBalance = await billing.credits.getBalance({
    userId,
    key: "api_calls",
  });
  if (creditBalance > 0) {
    const use = Math.min(creditBalance, remaining);
    await billing.credits.consume({ userId, key: "api_calls", amount: use });

    // if the usage was more than the available credits, we can fall back to wallets / usage billing
    remaining -= use;
  }
  if (remaining === 0) return;

  // 2. Wallet next, if exists (pre-paid balance available to the user)
  const wallet = await billing.wallet.getBalance({ userId });
  if (wallet && wallet.amount > 0) {
    const cost = remaining * pricePerUnit;
    const walletToUse = Math.min(wallet.amount, cost);
    await billing.wallet.consume({ userId, amount: walletToUse });

    // if wallet didn't have enough money to cover the usage, we can fall back to usage billing
    remaining -= Math.floor(walletToUse / pricePerUnit);
  }
  if (remaining === 0) return;

  // 3. Usage last (post-paid, billed at period end)
  await billing.usage.record({ userId, key: "api_calls", amount: remaining });
}
```

---

## Testing Usage Billing

Usage charges appear at the end of the billing period. To test without waiting a month, use Stripe's simulation feature:

1. Create a subscription in test mode
2. Record some usage in your app
3. Go to the subscription in Stripe Dashboard
4. Click **"Run simulation"** in the purple banner at the top
5. Click **"+ 1 month"** and then **"+ 1 day"** to advance time to next billing period + 1 day
6. Check the newly created invoice for usage charges

---

## Callbacks

Get notified when usage is recorded:

```typescript
const billing = new Billing({
  billingConfig,
  callbacks: {
    onUsageRecorded: ({ userId, key, amount }) => {
      // Called after each usage.record()
      // Useful for: analytics, logging, real-time dashboards
    },
  },
});
```

---

## Good to Know

### Auto Top-Ups Are Disabled with Usage Billing

When `trackUsage: true` is set, **auto top-ups** are disabled for that feature. This makes sense—usage billing already handles the "overflow" case automatically.

**On-demand top-ups still work.** This lets merchants support customers who want spending control:

```typescript
if (await billing.credits.hasCredits({ userId, key, amount: 1 })) {
  await billing.credits.consume({ userId, key, amount: 1 });
} else if (customer.allowUsageBilling) {
  // allowUsageBilling might be a flag in your DB at the customer level
  await billing.usage.record({ userId, key, amount: 1 });
} else {
  // Customer wants control - prompt to top up manually
  throw new Error("Out of credits. Please top up to continue.");
}
```

### Usage Events Are Permanent

Once you call `usage.record()`, the event is sent to Stripe and can't be undone. If you need to adjust:

- **Before invoice is paid**: Grant credits to offset the charge
- **After invoice is paid**: Issue a refund through Stripe Dashboard

### Very High-Volume Usage

For very high-throughput applications (thousands of events per second), batch your usage instead of recording each event individually:

```typescript
// Instead of calling record() on every request...
// Accumulate in memory, then flush periodically:
await billing.usage.record({
  userId,
  key: "api_calls",
  amount: batchedTotal, // e.g., 1000 calls at once
});
```

Stripe meters are optimized for batched events. The library stores events locally, so your real-time queries are still accurate but your DB might not be able to handle the load if you have very high throughput (e.g. 1000s of events per second) therefore batching is recommended if you have any issues.

---

## Summary

| What You Need to Do                                 | What Stripe/Library Handles                                   |
| --------------------------------------------------- | ------------------------------------------------------------- |
| Add `pricePerCredit` + `trackUsage: true` to config | Creates Stripe meter and metered price                        |
| Run `sync` command                                  | —                                                             |
| Call `usage.record()` when billable actions happen  | Sends to Stripe, stores locally                               |
| Show usage in your UI with `getSummary()`           | Calculates totals and estimated cost                          |
| —                                                   | Totals usage at period end, adds to invoice, charges customer |

**The most important thing**: Call `usage.record()` every time a billable action happens. Everything else flows from there.
