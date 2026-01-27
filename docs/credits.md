# Credits & Wallet

Include consumable resources with your subscription plans.

| Type        | What it is                  | Example                          |
| ----------- | --------------------------- | -------------------------------- |
| **Credits** | Discrete units              | "1,000 API calls/month"          |
| **Wallet**  | Monetary balance (in cents) | "$5.00/month spending allowance" |

Both renew automatically with subscriptions and scale for yearly plans (12×).

---

## Credits

Credits are discrete units included with a subscription—like "1000 API calls/month". The library automatically grants credits when users subscribe and tracks the balance in your database.

### Configuration

Let's say we have a "Pro" plan that has two consumable features: "API Calls" and "Exports". The configuration for this plan would look like this:

```typescript
// billing.config.ts
{
  name: "Pro",
  price: [
    { amount: 2000, currency: "usd", interval: "month" },   // $20/month
    { amount: 20000, currency: "usd", interval: "year" },   // $200/year
  ],
  features: {
    api_calls: {                          // key used in billing.credits.*()
      displayName: "API Calls",           // shown on pricing page
      credits: {
        allocation: 1000,                 // 1000/month or 12000/year
        onRenewal: "reset",               // (optional) "reset" (default) or "add" to roll over
      },
    },
    exports: {
      displayName: "Exports",
      credits: { allocation: 50 },
    },
  },
}
```

### Basic Usage

```typescript
import { billing } from "@/lib/billing";

// Check balance
const balance = await billing.credits.getBalance({ userId, key: "api_calls" });
// Returns: number (e.g., 847)

// Check if user has enough
const hasEnough = await billing.credits.hasCredits({
  userId,
  key: "api_calls",
  amount: 10,
});
// Returns: boolean

// Consume credits
await billing.credits.consume({ userId, key: "api_calls", amount: 10 });
```

**Important:** `consume()` always succeeds. If the user has 5 credits and you consume 10, their balance becomes -5.

### Common Patterns

**1. Known amount upfront** (e.g., 1 API call = 1 credit)

```typescript
if (await billing.credits.hasCredits({ userId, key: "api_calls", amount: 1 })) {
  await billing.credits.consume({ userId, key: "api_calls", amount: 1 });
  doTheAction();
} else {
  return "No credits remaining";
}
```

**2. Unknown amount** (e.g., AI generation where token count varies)

```typescript
// Check they have SOME credits before starting
const balance = await billing.credits.getBalance({ userId, key: "tokens" });
if (balance <= 0) {
  return "No credits remaining";
}

// Do the action
const result = await generateWithAI(prompt);
const tokensUsed = result.usage.totalTokens;

// Consume afterward (balance may go negative - that's ok)
await billing.credits.consume({ userId, key: "tokens", amount: tokensUsed });
```

**3. Credits first, then usage billing** (hybrid model)

```typescript
const result = await generateWithAI(prompt); // run expensive AI operation
const tokensUsed = result.usage.totalTokens; // get the number of tokens used
const balance = await billing.credits.getBalance({ userId, key: "tokens" });

if (balance >= tokensUsed) {
  // user has enough credits
  await billing.credits.consume({ userId, key: "tokens", amount: tokensUsed });
} else if (balance > 0) {
  // user has some credits but not enough to cover the usage
  // partially consume the remaining credits
  await billing.credits.consume({ userId, key: "tokens", amount: balance });
  // then, record the remaining usage as usage billing
  await billing.usage.record({
    userId,
    key: "tokens",
    amount: tokensUsed - balance,
  });
} else {
  // user has no credits, record all the usage as usage billing
  await billing.usage.record({ userId, key: "tokens", amount: tokensUsed });
}
```

For a full example of Credits → Wallet → Usage fallback flow, see [Usage-Based Billing](./usage.md#hybrid-billing).

### Buying More Credits (Top-Ups)

Let users purchase additional credits beyond their plan allocation. Add `pricePerCredit` to enable:

```typescript
features: {
  api_calls: {
    displayName: "API Calls",
    credits: { allocation: 1000 },
    pricePerCredit: 1,               // 1 cent per credit (required for top-ups)
  },
}
```

```typescript
const result = await billing.credits.topUp({
  userId,
  key: "api_calls",
  amount: 500, // buy 500 credits, charges $5.00
});

if (!result.success && result.error?.recoveryUrl) {
  // Payment failed - redirect user to update their card
  redirect(result.error.recoveryUrl);
}
```

### Auto Top-Up

Automatically purchase credits when balance drops below a threshold. To enable auto top-up, you need to set `pricePerCredit` and `autoTopUp` in the configuration:

```typescript
features: {
  api_calls: {
    credits: { allocation: 1000 },
    pricePerCredit: 1,               // required for auto top-up
    autoTopUp: {
      threshold: 100,                // trigger when balance drops below 100
      amount: 500,                   // buy 500 credits ($5.00)
      maxPerMonth: 5,                // (optional) limit: 5 auto top-ups/month
    },
  },
}
```

**IMPORTANT**: Auto top-up triggers automatically when `credits.consume()` drops the balance below the threshold. This can be dangerous if there's an error with the user's payment method (for eg, low balance) - if we keep attempting to charge the card, it will keep failing and will trigger a fraud block from the user's bank and/or Stripe.

To prevent this, `stripe-no-webhooks` handles payment failures smartly (24 hours cooldowns, blocks until user updates card, etc.) - see [Payment Failures](./payment-failures.md) for failure handling.

---

## Wallet

A wallet is a **monetary balance** (in cents / lowest denomination of the currency) included with a subscription—like "$5.00/month for AI usage".

**When to use wallet vs credits:**

- **Credits**: Each action costs the same (1 API call = 1 credit)
- **Wallet**: Costs vary (for eg, if you have multiple AI model tokens that you need to charge for, you can use a wallet to charge for them)

### Configuration

```typescript
{
  name: "Pro",
  price: [{ amount: 2000, currency: "usd", interval: "month" }],
  wallet: {
    allocation: 500,              // 500 cents = $5.00/month
    displayName: "AI Usage",      // (optional) shown on pricing page
    onRenewal: "reset",           // (optional) "reset" (default) or "add" to roll over
  },
}
```

### Basic Usage

```typescript
import { billing } from "@/lib/billing";

// Get balance
const balance = await billing.wallet.getBalance({ userId });
// Returns: { amount: 350, formatted: "$3.50", currency: "usd" }
// Returns null if user has no wallet

// Consume from wallet
await billing.wallet.consume({
  userId,
  amount: 50, // 50 cents
  description: "GPT-4 usage", // (optional) shown in transaction history
});

// Add funds (ledger operation - does NOT charge card)
// Use for: promotional credits, refunds, manual adjustments
await billing.wallet.add({
  userId,
  amount: 1000, // $10.00
  description: "Promotional credit",
});
```

**Important:** `consume()` always succeeds. Balance can go negative.

### Sub-Cent Precision

Wallet supports fractional cents (up to micro-cent precision) for AI token pricing:

```typescript
const COST_PER_TOKEN = 0.00015; // $0.00015 per token
const tokenCount = 1500;
const amount = COST_PER_TOKEN * tokenCount; // 0.225 cents

await billing.wallet.consume({ userId, amount });
```

### Buying More (Top-Ups)

Let users add money to their wallet. Wallet top-ups are always available for plans with a wallet configured—pay `$10`, get `$10`.

```typescript
const result = await billing.wallet.topUp({
  userId,
  amount: 1000, // charge user's card $10.00 and add $10.00 to wallet
});

if (!result.success && result.error?.recoveryUrl) {
  redirect(result.error.recoveryUrl);
}
```

Optionally set purchase limits:

```typescript
wallet: {
  allocation: 500,
  minPerPurchase: 100,           // (optional) must add at least $1.00 (default: ~$0.50 Stripe minimum)
  maxPerPurchase: 10000,         // (optional) can't add more than $100.00
},
```

### Auto Top-Up

Automatically add funds when balance drops below a threshold:

```typescript
wallet: {
  allocation: 500,
  autoTopUp: {
    threshold: 100,              // trigger when balance drops below $1.00
    amount: 500,                 // add $5.00 when triggered
    maxPerMonth: 5,              // (optional) limit: 5 auto top-ups/month
  },
},
```

Auto top-up triggers automatically when `wallet.consume()` drops the balance below the threshold. See [Payment Failures](./payment-failures.md) for failure handling.

---

## Behavior

### Renewal

By default, balances **reset** each billing cycle. Use `onRenewal: "add"` to roll over unused balance:

```typescript
credits: {
  allocation: 1000,
  onRenewal: "add",  // unused credits accumulate
},

wallet: {
  allocation: 500,
  onRenewal: "add",  // unused balance accumulates
},
```

### Yearly Plans

Yearly subscribers get 12× the monthly allocation upfront:

| Interval | Multiplier | Example (1000/mo) |
| -------- | ---------- | ----------------- |
| Month    | 1×         | 1,000             |
| Year     | 12×        | 12,000            |

### Plan Changes

| Event         | What Happens                                       |
| ------------- | -------------------------------------------------- |
| **Upgrade**   | Keep current balance + grant new plan's allocation |
| **Downgrade** | Keep current balance until period ends, then reset |
| **Cancel**    | Revoke all balances immediately                    |

**Upgrade example:**

```
Basic (1,000/mo, $20/month) → Pro (10,000/mo, $200/month)
User has 400 remaining
After: 400 + 10,000 = 10,400
No refunds of the old plan. User paid amount ($20 + $200 = $220 ) == total credits they got overall (10,400 credits). Fair to the end user.
```

**Exception:** Free → Paid revokes free balance first (it had no monetary value).

**Interval changes:**

| Change           | Treatment                                 |
| ---------------- | ----------------------------------------- |
| Monthly → Yearly | Upgrade (immediate, +12× new allocation)  |
| Yearly → Monthly | Downgrade (keeps balance until year ends) |

### Negative Balances

Both `credits.consume()` and `wallet.consume()` always succeed—balances can go negative.

At renewal:

- **`onRenewal: "reset"`** (default): Debt is forgiven, fresh allocation granted
- **`onRenewal: "add"`**: New allocation added to negative balance

### Combining with Usage Billing

Include credits AND bill for overages. Users consume included credits first, then overages are billed at period end.

See [Usage-Based Billing](./usage.md) for the hybrid billing pattern.

---

## Developer Reference

### Transaction History

Every grant, consumption, and revocation is recorded:

```typescript
// Credit history
const history = await billing.credits.getHistory({
  userId,
  key: "api_calls",
  limit: 50,           // (optional) default: 50
});

// Wallet history
const walletHistory = await billing.wallet.getHistory({
  userId,
  limit: 50,           // (optional)
});

// Each entry:
{
  id: "abc123",
  amount: -10,           // negative = consumed, positive = granted
  balanceAfter: 990,
  type: "consume",       // "grant" | "consume" | "revoke" | "adjust"
  description: "API call",
  createdAt: Date,
}
```

### Callbacks

React to credit and wallet events:

```typescript
const billing = new Billing({
  billingConfig,
  callbacks: {
    // Credits
    onCreditsGranted: ({ userId, key, amount, newBalance }) => {},
    onCreditsRevoked: ({
      userId,
      key,
      amount,
      previousBalance,
      newBalance,
    }) => {},
    onCreditsLow: ({ userId, key, balance, threshold }) => {},
    onTopUpCompleted: ({ userId, key, creditsAdded, amountCharged }) => {},
    onAutoTopUpFailed: ({ userId, key, trigger, status, failureCount }) => {},

    // Wallet
    onWalletLow: ({ userId, balance, threshold }) => {},
    onWalletTopUpCompleted: ({
      userId,
      amountAdded,
      amountCharged,
      newBalance,
    }) => {},
    onWalletAutoTopUpFailed: ({ userId, trigger, status, failureCount }) => {},
  },
});
```
