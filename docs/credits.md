# Credits

Give users credits (API calls, emails, tokens, etc.) that renew with their subscription.

## Add Credits to a Plan

```typescript
{
  name: "Pro",
  price: [
    { amount: 2000, currency: "usd", interval: "month" },
    { amount: 20000, currency: "usd", interval: "year" },
  ],
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

## Yearly Plans and Credit Allocation

When a plan supports both monthly and yearly billing, credits are **automatically scaled** based on the billing interval:

| Interval | Allocation Formula | Example (1000 base) |
|----------|-------------------|---------------------|
| Month | Base allocation | 1,000 credits |
| Year | Base × 12 | 12,000 credits |
| Week | Base ÷ 4 (rounded up) | 250 credits |

This means a user on a yearly plan receives 12× the monthly allocation upfront when they subscribe and at each yearly renewal.

**Why give all credits upfront for yearly plans?**
- Stripe only sends a renewal webhook once per year
- Users paid for a full year, so they should get a full year's worth of credits
- Simple and predictable for users

**Example:**
```
Pro Monthly ($20/mo):  1,000 API calls/month → 12,000/year total
Pro Yearly ($200/yr):  12,000 API calls upfront → same value, discounted price
```

### Note on Monthly Drip for Yearly Plans

Some apps want to grant credits monthly even for yearly subscribers (e.g., 1,000/month instead of 12,000 upfront). This requires a scheduled task (cron job) since Stripe only fires webhooks at renewal.

Options for monthly drip:
- **Vercel Cron** - Add a daily/weekly cron job
- **pg_cron** (Neon/Supabase) - Database-level scheduling
- **Custom scheduler** - External service that calls your API monthly

This is outside the scope of the library's core functionality, but you can use `billing.credits.grant()` in your cron handler.

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

Let users buy more credits. Add `pricePerCreditCents` to enable top-ups:

```typescript
credits: {
  api_calls: {
    allocation: 1000,
    pricePerCreditCents: 1,
    minPerPurchase: 100,
    maxPerPurchase: 10000,
    autoTopUp: {        // (optional)
      threshold: 100,   // Trigger when balance drops below 100
      amount: 500,      // Buy 500 more
      maxPerMonth: 5,   // Up to 5 times each calendar month
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
  return redirect(result.error.recoveryUrl);
}
```

### Auto Top-Up Failure Handling

When auto top-ups are enabled, the library automatically:
- **Rate-limits retries** - Waits 24h before retrying soft declines (insufficient funds)
- **Stops after 3 failures** - Blocks auto top-up until user updates their card
- **Distinguishes decline types** - Hard declines (expired card) block immediately

This protects your users' cards from being flagged for fraud by card networks.

Use `onAutoTopUpFailed` to notify users when their card needs attention. See [Payment Failures](./payment-failures.md) for the complete guide.

### Top-Up Payment Mode

Top-ups use different Stripe payment flows depending on your tax configuration:

| Tax Config                                    | Payment Method | Stripe Fee | Shows in Portal |
| --------------------------------------------- | -------------- | ---------- | --------------- |
| Disabled (default)                            | PaymentIntent  | Standard   | No              |
| Enabled (`automaticTax` or `taxIdCollection`) | Invoice        | +0.4-0.5%  | Yes             |

**When to use each:**

- **B2C apps** (consumer-facing): Leave tax config disabled for lower fees. Top-ups won't appear in Customer Portal's invoice history, but customers typically don't need invoices for personal purchases.

- **B2B apps** (business customers): Enable tax config to create proper invoices. Business customers need invoices for accounting/expense reports, and they'll appear in the Customer Portal.

```typescript
// B2B mode - creates invoices for top-ups
const billing = new Billing({
  billingConfig,
  tax: {
    automaticTax: true, // This enables invoice-based top-ups
  },
});
```

## Plan Changes (Upgrades & Downgrades)

When users change plans, credits are handled differently for upgrades vs downgrades to prevent abuse while remaining fair to users.

### Upgrades (Immediate)

When a user upgrades (e.g., Basic → Pro):

1. **Old credits are preserved** - Users keep their remaining credits from the old plan
2. **New credits are granted** - Users receive the new plan's full allocation (scaled for interval)
3. **Result:** User has old_balance + new_allocation

**Why preserve old credits?** Stripe doesn't prorate subscription upgrades by default. If a user upgrades mid-cycle, they've already paid for their remaining Basic credits. Revoking them would be unfair since they're not getting a refund.

```
Example: User on Basic (1,000 credits/month) upgrades to Pro (10,000 credits/month)
- Day 15: User has 400 credits remaining
- After upgrade: User has 400 + 10,000 = 10,400 credits
- This is fair: they paid for those 400 credits
```

**Exception: Free → Paid upgrades** revoke the free credits first, then grant paid credits. Free tier credits have no monetary value, so there's nothing to preserve.

### Same-Plan Interval Changes

Switching between monthly and yearly on the **same plan** follows upgrade/downgrade rules:

**Monthly → Yearly (Upgrade)**
- Treated as an upgrade (immediate)
- Old credits preserved + new yearly allocation (12×) granted

```
Example: Pro Monthly → Pro Yearly
- User has 700 credits remaining from monthly
- After switch: 700 + 120,000 = 120,700 credits
```

**Yearly → Monthly (Downgrade)**
- Treated as a downgrade (scheduled for period end)
- User keeps yearly credits until period ends
- At renewal: resets to monthly allocation

```
Example: Pro Yearly → Pro Monthly
- User has 80,000 credits remaining from yearly
- Credits unchanged until period ends
- At period end: resets to 10,000 (monthly allocation)
```

### Cross-Plan Upgrades with Interval Changes

When upgrading to a different plan AND changing interval:

```
Example: Basic Monthly → Pro Yearly
- User has 400 Basic credits remaining
- After upgrade: 400 + 120,000 = 120,400 credits
- Also gets new credit types (e.g., storage_gb: 1,200)
```

```
Example: Free → Pro Yearly
- Free credits revoked (no monetary value)
- Pro yearly credits granted: 120,000
```

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

| Setting             | Behavior                         | Use Case         |
| ------------------- | -------------------------------- | ---------------- |
| `"reset"` (default) | Revoke all, grant new allocation | Most SaaS apps   |
| `"add"`             | Keep balance, add new allocation | Rollover credits |

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

| Event                      | Credits Behavior                           | Timing     |
| -------------------------- | ------------------------------------------ | ---------- |
| Upgrade (Paid → Paid)      | Keep old + grant new (scaled)              | Immediate  |
| Upgrade (Free → Paid)      | Revoke old, grant new (scaled)             | Immediate  |
| Monthly → Yearly (same plan) | Keep old + grant 12× new                 | Immediate  |
| Yearly → Monthly (same plan) | Keep until period end, then reset to 1×  | Period end |
| Cross-plan + interval      | Same as upgrade/downgrade rules (scaled)   | Depends    |
| Downgrade                  | Keep current until period end, then adjust | Period end |
| Cancellation               | Revoke all                                 | Immediate  |

## Displaying Credits in Your UI

### Pricing Page

The generated `PricingPage` component automatically scales credits for yearly plans:
- Monthly plan shows: "1,000 API Calls/mo"
- Yearly plan shows: "12,000 API Calls/yr"

### Dashboard / Account Page

For custom dashboards, you need to scale the allocation yourself based on the billing interval. Here's how:

```typescript
import billingConfig from "@/billing.config";

// Get subscription
const subscription = await billing.subscriptions.get(userId);
const priceId = subscription?.plan?.priceId;

// Find the plan and price to get the interval
const plans = billingConfig.test.plans; // or production
const plan = plans.find(p => p.price.some(pr => pr.id === priceId));
const price = plan?.price.find(pr => pr.id === priceId);
const interval = price?.interval ?? "month";

// Get credit balance
const balance = await billing.credits.getBalance(userId, "api_calls");
const baseAllocation = plan?.credits?.api_calls?.allocation ?? 0;

// Scale allocation based on interval
const scaledAllocation = baseAllocation * (
  interval === "year" ? 12 :
  interval === "week" ? 0.25 :
  1
);

// Now you can display:
// - Balance: 8,500 / 12,000 yearly
// - Or calculate bonus credits from top-ups:
const bonusCredits = Math.max(0, balance - scaledAllocation);
```

**Why manual scaling?** The `allocation` in your config is the base (monthly) value. The library automatically scales when granting credits, but your UI needs to scale for display purposes.

**Tip:** Create a helper function to avoid repeating this logic:

```typescript
function getScaledAllocation(plan: Plan, interval: string, creditType: string): number {
  const base = plan.credits?.[creditType]?.allocation ?? 0;
  if (interval === "year") return base * 12;
  if (interval === "week") return Math.ceil(base / 4);
  return base;
}
```

### Top-Ups on Yearly Plans

Top-up pricing is **per-credit** and does NOT scale with billing interval:
- `pricePerCreditCents: 10` means $0.10 per credit, whether monthly or yearly
- Auto top-up works the same regardless of interval
- Top-up credits are "bonus" credits on top of the scaled subscription allocation

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
    onTopUpCompleted: ({ userId, creditType, creditsAdded, amountCharged }) => {},
    onAutoTopUpFailed: ({ userId, creditType, trigger, status }) => {
      // trigger: "stripe_declined_payment" | "blocked_until_card_updated" | ...
      // status: "will_retry" | "action_required"
      // See docs/payment-failures.md for full details
    },
  },
});
```
