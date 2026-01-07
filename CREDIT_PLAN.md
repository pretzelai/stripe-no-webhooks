# Credits System - Implementation Plan v2

## Overview

A credit system that tracks consumable units per user. Credits are stored entirely in the user's database (not Stripe). The system provides sensible defaults but allows full user control when needed.

**Design Principles:**
- Config is the source of truth for credit definitions
- Everything credit-related lives with the plan (no duplication)
- Sensible defaults that work for 80% of use cases
- Minimal config for simple cases, full control when needed

---

## Quick Start Examples

### Minimal Config (No Top-Ups)

Most users just want credits that reset each month:

```typescript
const billingConfig: BillingConfig = {
  test: {
    plans: [
      {
        name: "Pro",
        price: [{ amount: 2000, currency: "usd", interval: "month" }],
        credits: {
          email_credits: { allocation: 50 },
          linkedin_credits: { allocation: 100 }
        }
      }
    ]
  }
};
```

That's it. Credits reset each billing cycle (default). No top-ups. Library handles everything.

### With On-Demand Top-Ups

Users can click a button to buy more credits:

```typescript
credits: {
  email_credits: {
    allocation: 50,
    topUp: {
      mode: 'on_demand',
      pricePerCreditCents: 10   // $0.10 per credit
    }
  }
}
```

### With Auto Top-Ups

Automatically charge user when credits run low:

```typescript
credits: {
  email_credits: {
    allocation: 50,
    topUp: {
      mode: 'auto',
      pricePerCreditCents: 10,
      balanceThreshold: 10,    // When balance drops below 10
      purchaseAmount: 50       // Buy 50 more credits
    }
  }
}
```

---

## Config Structure

All credit configuration lives within the plan definition.

```typescript
type BillingConfig = {
  test?: {
    plans?: Plan[];
  };
  production?: { /* same */ };
};

type Plan = {
  id?: string;
  name: string;
  description?: string;
  price: Price[];
  credits?: Record<string, CreditConfig>;
};

type CreditConfig = {
  // How many credits granted per billing period (REQUIRED)
  allocation: number;

  // Display name (optional - auto-formatted from id if omitted)
  // "email_credits" → "Email Credits"
  displayName?: string;

  // What happens on subscription renewal (DEFAULT: 'reset')
  // - 'reset': Set balance to allocation (unused credits expire)
  // - 'add': Add allocation to current balance (credits accumulate)
  onRenewal?: 'reset' | 'add';

  // Top-up configuration (optional - omit to disable top-ups)
  // NOTE: Choose ONE mode - either 'on_demand' OR 'auto', not both
  topUp?: OnDemandTopUp | AutoTopUp;
};

// User clicks button to purchase credits
type OnDemandTopUp = {
  mode: 'on_demand';
  pricePerCreditCents: number;
  minPerPurchase?: number;     // Default: 1
  maxPerPurchase?: number;     // Default: no limit
};

// Automatically purchase when balance is low
type AutoTopUp = {
  mode: 'auto';
  pricePerCreditCents: number;
  balanceThreshold: number;    // REQUIRED: trigger when below this
  purchaseAmount: number;      // REQUIRED: how many to buy
  maxPerMonth?: number;        // Default: 10 (safety limit)
};

// NOTE: Currency is inherited from the plan's price - no need to specify separately
```

### Defaults Summary

| Field | Default | Notes |
|-------|---------|-------|
| `onRenewal` | `'reset'` | Credits expire each cycle |
| `topUp` | `undefined` | Top-ups disabled |
| `topUp.minPerPurchase` | `1` | On-demand only |
| `topUp.maxPerPurchase` | unlimited | On-demand only |
| `topUp.maxPerMonth` | `10` | Auto only, safety limit |
| `grantTo` | `'subscriber'` | Credits go to subscriber |

**Note:** Top-up currency is automatically inherited from the plan's price configuration.

### Full Example Config

```typescript
const billingConfig: BillingConfig = {
  test: {
    plans: [
      // Free tier: Limited credits, on-demand top-ups at higher price
      {
        name: "Free",
        price: [{ amount: 0, currency: "usd", interval: "month" }],
        credits: {
          email_credits: {
            allocation: 10,
            topUp: {
              mode: 'on_demand',
              pricePerCreditCents: 15,  // Higher price for free tier
              minPerPurchase: 10,
              maxPerPurchase: 100
            }
          }
        }
      },

      // Pro tier: More credits, auto top-up enabled
      {
        name: "Pro",
        price: [{ amount: 2000, currency: "usd", interval: "month" }],
        credits: {
          email_credits: {
            displayName: "Email Credits",
            allocation: 50,
            topUp: {
              mode: 'auto',
              pricePerCreditCents: 10,
              balanceThreshold: 10,
              purchaseAmount: 50,
              maxPerMonth: 5
            }
          },
          linkedin_credits: {
            displayName: "LinkedIn Search Credits",
            allocation: 100,
            topUp: {
              mode: 'auto',
              pricePerCreditCents: 15,
              balanceThreshold: 20,
              purchaseAmount: 100,
              maxPerMonth: 3
            }
          }
        }
      },

      // Enterprise tier: Credits accumulate, on-demand top-ups at best price
      {
        name: "Enterprise",
        price: [{ amount: 10000, currency: "usd", interval: "month" }],
        credits: {
          email_credits: {
            allocation: 500,
            onRenewal: 'add',  // Credits accumulate (don't reset)
            topUp: {
              mode: 'on_demand',
              pricePerCreditCents: 8,  // Best price
              minPerPurchase: 100,
              maxPerPurchase: 10000
            }
          },
          linkedin_credits: {
            allocation: 1000,
            onRenewal: 'add'
            // No top-up - enterprise gets enough credits
          }
        }
      }
    ]
  }
};
```

### Credits Without Subscription

For use cases where you only want to sell credits (no recurring subscription):

```typescript
{
  name: "Pay As You Go",
  price: [{ amount: 0, currency: "usd", interval: "month" }],  // Currency defined here
  credits: {
    email_credits: {
      allocation: 0,       // No free credits
      onRenewal: 'add',    // Don't reset purchased credits on "renewal"
      topUp: {
        mode: 'on_demand',
        pricePerCreditCents: 12,  // Uses USD from plan price
        minPerPurchase: 50
      }
    }
  }
}
```

User subscribes to this free "plan" (no charge), then purchases credits as needed.

---

## Database Schema

Just two tables:

```sql
-- Current balances (one row per user per credit type)
CREATE TABLE stripe.credit_balances (
  user_id text NOT NULL,
  credit_type_id text NOT NULL,
  balance bigint NOT NULL DEFAULT 0,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, credit_type_id)
);

-- Audit trail (append-only ledger)
CREATE TABLE stripe.credit_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  credit_type_id text NOT NULL,

  -- Transaction details
  amount bigint NOT NULL,           -- positive = added, negative = consumed
  balance_after bigint NOT NULL,    -- balance after this transaction

  -- Classification
  transaction_type text NOT NULL,   -- 'grant' | 'consume' | 'revoke' | 'reset' | 'adjust'
  source text NOT NULL,             -- 'subscription' | 'renewal' | 'topup' | 'auto_topup' | 'manual' | 'cancellation' | 'seat_grant' | 'seat_revoke'
  source_id text,                   -- subscription_id, payment_intent_id, etc.

  -- Metadata
  description text,
  metadata jsonb,
  idempotency_key text UNIQUE,

  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_credit_ledger_user_type_time
  ON stripe.credit_ledger(user_id, credit_type_id, created_at DESC);
```

**Note:** Auto top-up monthly limits (`maxPerMonth`) are enforced by querying the ledger:
```sql
SELECT COUNT(*) FROM stripe.credit_ledger
WHERE user_id = $1 AND credit_type_id = $2
  AND source = 'auto_topup'
  AND created_at >= date_trunc('month', now())
```

---

## Handler Configuration

```typescript
import { createStripeHandler } from "stripe-no-webhooks";

export const stripe = createStripeHandler({
  // ... existing config (stripeSecretKey, databaseUrl, billingConfig, etc.)

  credits: {
    // Who receives credits automatically?
    // - 'subscriber' (default): Credits go to whoever subscribes (user or org)
    // - 'seat-users': Credits go to individual seat users (use addSeat/removeSeat)
    // - 'manual': No automatic granting (full control via callbacks)
    grantTo: 'subscriber' | 'seat-users' | 'manual',
  },

  callbacks: {
    // ═══════════════════════════════════════════════════════════════════════
    // SUBSCRIPTION LIFECYCLE (existing + new)
    // ═══════════════════════════════════════════════════════════════════════

    onSubscriptionCreated?: (subscription: Stripe.Subscription) => Promise<void>,
    onSubscriptionUpdated?: (subscription: Stripe.Subscription) => Promise<void>,
    onSubscriptionCancelled?: (subscription: Stripe.Subscription) => Promise<void>,

    // NEW: Fires on each billing cycle renewal (invoice.paid with billing_reason=subscription_cycle)
    onSubscriptionRenewed?: (subscription: Stripe.Subscription) => Promise<void>,

    // ═══════════════════════════════════════════════════════════════════════
    // CREDIT EVENTS (all fire AFTER the operation completes)
    // ═══════════════════════════════════════════════════════════════════════

    onCreditsGranted?: (params: {
      userId: string;
      creditType: string;
      amount: number;
      newBalance: number;
      source: 'subscription' | 'renewal' | 'topup' | 'auto_topup' | 'manual';
      sourceId?: string;
    }) => Promise<void>;

    onCreditsConsumed?: (params: {
      userId: string;
      creditType: string;
      amount: number;
      newBalance: number;
    }) => Promise<void>;

    onCreditsRevoked?: (params: {
      userId: string;
      creditType: string;
      amount: number;
      previousBalance: number;
      newBalance: number;
      source: 'cancellation' | 'manual';
    }) => Promise<void>;

    // Fires when balance drops below autoTopUp.balanceThreshold (if configured)
    // Use this for notifications or custom auto-topup logic
    onCreditsLow?: (params: {
      userId: string;
      creditType: string;
      balance: number;
      threshold: number;
    }) => Promise<void>;

    // Auto top-up was triggered and succeeded
    onAutoTopUpTriggered?: (params: {
      userId: string;
      creditType: string;
      creditsPurchased: number;
      amountChargedCents: number;
      newBalance: number;
      paymentIntentId: string;
    }) => Promise<void>;

    // Auto top-up was triggered but failed
    onAutoTopUpFailed?: (params: {
      userId: string;
      creditType: string;
      error: CreditError;
      currentBalance: number;
    }) => Promise<void>;
  }
});
```

---

## Credit Lifecycle

### On Subscription Created

```
Webhook: customer.subscription.created
    ↓
If grantTo === 'manual' → skip, just fire onSubscriptionCreated
    ↓
Get subscription.customer (Stripe customer ID)
    ↓
Look up from user_stripe_customer_map table using customer ID
    ↓
Look up plan from config (match by price ID in subscription items)
    ↓
If grantTo === 'subscriber':
  → Grant credits to the subscriber (user_id from map)
  → Log to ledger: transaction_type='grant', source='subscription', source_id=sub_xxx
    ↓
If grantTo === 'seat-users':
  → Check checkout session metadata for first seat user
  → If first_seat_user_id exists: auto-call addSeat({ userId: first_seat_user_id, orgId })
  → Otherwise: no credits granted yet (developer calls addSeat manually)
    ↓
Fire onCreditsGranted callback (if credits were granted)
Fire onSubscriptionCreated callback
```

### On Subscription Renewed

```
Webhook: invoice.paid (with billing_reason = 'subscription_cycle')
    ↓
If grantTo === 'manual' → skip, just fire onSubscriptionRenewed
    ↓
Get invoice.customer (Stripe customer ID)
    ↓
Look up from user_stripe_customer_map table
    ↓
Get subscription from invoice.subscription
    ↓
Look up plan.credits config (match by price ID)
    ↓
If grantTo === 'subscriber':
  → Grant/reset credits to subscriber per onRenewal setting
    ↓
If grantTo === 'seat-users':
  → Query ledger to find all active seat users for this subscription
  → Grant/reset credits to each seat user per onRenewal setting
    ↓
Fire onCreditsGranted callback
Fire onSubscriptionRenewed callback
```

### On Subscription Cancelled

```
Webhook: customer.subscription.deleted
    ↓
If grantTo === 'manual' → skip, just fire onSubscriptionCancelled
    ↓
Get subscription.customer (Stripe customer ID)
    ↓
Look up from user_stripe_customer_map table
    ↓
If grantTo === 'subscriber':
  → Revoke all credits from subscriber
    ↓
If grantTo === 'seat-users':
  → Query ledger to find all active seat users
  → Revoke credits from each seat user
    ↓
Fire onCreditsRevoked callback
Fire onSubscriptionCancelled callback
```

### On Credit Consumption

```
App calls: credits.consume({ userId, creditType, amount })
    ↓
Validate idempotencyKey not already used (if provided)
    ↓
Check: currentBalance >= amount?
    ↓
If NO:
  → Return { success: false, error: { code: 'INSUFFICIENT_CREDITS', balance: X, required: Y } }
    ↓
If YES:
  → Deduct from balance (atomic)
  → Log: transaction_type='consume', source='usage'
  → Fire onCreditsConsumed callback
    ↓
If topUp.mode === 'auto' AND newBalance < balanceThreshold:
  → Fire onCreditsLow callback
  → Trigger auto top-up flow (async, non-blocking)
    ↓
Return { success: true, balance: newBalance }
```

### On-Demand Top-Up Flow

Only applicable when `topUp.mode === 'on_demand'`.

```
User clicks "Buy 50 credits"
    ↓
App calls: credits.topUp({ userId, creditType, amount: 50 })
    ↓
Look up Stripe customer ID from user_stripe_customer_map table
    ↓
Look up user's current subscription to get their plan
    ↓
Get topUp config from plan.credits
    ↓
Validate:
  - topUp is configured with mode: 'on_demand'
  - amount >= minPerPurchase
  - amount <= maxPerPurchase (if set)
    ↓
Calculate price: amount × pricePerCreditCents (currency from plan)
    ↓
Get default payment method
    ↓
If NO payment method:
  → Create a Checkout Session for adding card + completing purchase
  → Return {
      success: false,
      error: {
        code: 'NO_PAYMENT_METHOD',
        message: 'No payment method on file',
        recoveryUrl: 'https://checkout.stripe.com/...'
      }
    }
    ↓
Create PaymentIntent:
  - amount: calculated price
  - customer: stripe_customer_id
  - payment_method: default_payment_method
  - confirm: true
  - off_session: true
    ↓
If payment FAILS (card declined, expired, etc.):
  → Create a Checkout Session for retry with different card
  → Return {
      success: false,
      error: {
        code: 'PAYMENT_FAILED',
        message: 'Your card was declined',
        recoveryUrl: 'https://checkout.stripe.com/...'
      }
    }
    ↓
If payment SUCCEEDS:
  → Grant credits
  → Log: transaction_type='grant', source='topup', source_id=pi_xxx
  → Fire onCreditsGranted callback
  → Return {
      success: true,
      balance: newBalance,
      charged: { amountCents: 500, currency: 'usd' },
      paymentIntentId: 'pi_xxx'
    }
```

### Auto Top-Up Flow

Only applicable when `topUp.mode === 'auto'`. Triggered automatically, user doesn't call anything.

```
After consume() completes, check: newBalance < balanceThreshold?
    ↓
If NO: Done, no top-up needed
    ↓
If YES:
  → Fire onCreditsLow callback
  → Continue to auto top-up...
    ↓
Check monthly limit:
  → Query ledger for auto_topup count this month
  → If count >= maxPerMonth:
    → Fire onAutoTopUpFailed with code: 'MONTHLY_LIMIT_REACHED'
    → Exit
    ↓
Look up Stripe customer ID from user_stripe_customer_map table
    ↓
Get customer's default payment method
    ↓
If no payment method:
  → Fire onAutoTopUpFailed with code: 'NO_PAYMENT_METHOD'
  → Exit
    ↓
Calculate price: purchaseAmount × pricePerCreditCents (currency from plan)
    ↓
Create PaymentIntent (off-session, auto-confirm)
    ↓
If payment fails:
  → Fire onAutoTopUpFailed with error details
  → Exit
    ↓
If payment succeeds:
  → Grant purchaseAmount credits
  → Log: transaction_type='grant', source='auto_topup', source_id=pi_xxx
  → Fire onAutoTopUpTriggered callback
```

---

## API Reference

### Types

```typescript
type TransactionType = 'grant' | 'consume' | 'revoke' | 'adjust';
type TransactionSource = 'subscription' | 'renewal' | 'manual' | 'usage';

type CreditTransaction = {
  id: string;
  userId: string;
  creditType: string;
  amount: number;
  balanceAfter: number;
  transactionType: TransactionType;
  source: TransactionSource;
  sourceId?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
};

// Only consume has an expected failure (insufficient credits)
type ConsumeResult =
  | { success: true; balance: number }
  | { success: false; balance: number };

// Thrown for exceptional cases (idempotency conflict, invalid input, DB errors)
class CreditError extends Error {
  code: string;
  details?: Record<string, unknown>;
}
```

### Read Operations

```typescript
import { credits } from "stripe-no-webhooks";

// Get balance for one credit type
const balance = await credits.getBalance(userId, "email_credits");
// → 47

// Get all balances for a user
const balances = await credits.getAllBalances(userId);
// → { email_credits: 47, linkedin_credits: 100 }

// Check if user has enough credits
const hasEnough = await credits.hasCredits(userId, "email_credits", 10);
// → true | false

// Get transaction history
const history = await credits.getHistory(userId, {
  creditType: "email_credits",  // optional - omit for all types
  limit: 50,
  offset: 0
});
// → CreditTransaction[]

// Check if user has a saved payment method
const canTopUp = await credits.hasPaymentMethod(userId);
// → true | false
```

### Write Operations

```typescript
// Consume credits (only operation with expected failure)
const result = await credits.consume({
  userId: "user_123",
  creditType: "email_credits",
  amount: 1,
  description: "Sent email to john@example.com",  // optional
  metadata: { emailId: "email_456" },             // optional
  idempotencyKey: "consume_email_456",            // recommended
});
// Success: { success: true, balance: 46 }
// Insufficient: { success: false, balance: 0 }
// Throws CreditError on idempotency conflict or invalid input

// Grant credits (returns new balance, throws on error)
const balance = await credits.grant({
  userId: "user_123",
  creditType: "email_credits",
  amount: 50,
  source: "manual",               // optional, default: 'manual'
  sourceId: "bonus_campaign_123", // optional
  description: "Referral bonus",  // optional
});
// → 96

// Revoke credits (revokes up to amount available)
const { balance, amountRevoked } = await credits.revoke({
  userId: "user_123",
  creditType: "email_credits",
  amount: 50,
  description: "Abuse detected",
});
// → { balance: 46, amountRevoked: 50 }

// Set exact balance (for corrections)
const { balance, previousBalance } = await credits.setBalance({
  userId: "user_123",
  creditType: "email_credits",
  balance: 100,
  reason: "Manual correction by support",
});
// → { balance: 100, previousBalance: 46 }
```

### Top-Up Operations

```typescript
// On-demand top-up (charges saved payment method)
const result = await credits.topUp({
  userId: "user_123",
  creditType: "email_credits",
  amount: 50,
});

// Success:
// {
//   success: true,
//   balance: 96,
//   charged: { amountCents: 500, currency: 'usd' },
//   paymentIntentId: 'pi_xxx'
// }

// Failure (no payment method):
// {
//   success: false,
//   error: {
//     code: 'NO_PAYMENT_METHOD',
//     message: 'No payment method on file',
//     recoveryUrl: 'https://checkout.stripe.com/c/pay/cs_xxx'
//   }
// }

// Failure (payment declined):
// {
//   success: false,
//   error: {
//     code: 'PAYMENT_FAILED',
//     message: 'Your card was declined',
//     recoveryUrl: 'https://checkout.stripe.com/c/pay/cs_xxx'
//   }
// }
```

### Sync Operations

```typescript
// Manual sync from subscription (for handling webhook delays)
const result = await credits.syncFromSubscription({
  userId: "user_123",
  subscriptionId: "sub_xxx",
});
// → { success: true, credits: { email_credits: 50, linkedin_credits: 100 } }

// Use case: After checkout success, before webhook arrives
const checkoutResult = await stripe.checkout({ ... });
if (checkoutResult.success) {
  await credits.syncFromSubscription({
    userId,
    subscriptionId: checkoutResult.subscriptionId
  });
  // User can now use credits immediately
}
```

---

## Usage Examples

### Basic Credit Consumption

```typescript
async function sendEmail(userId: string, emailData: EmailData) {
  const result = await credits.consume({
    userId,
    creditType: "email_credits",
    amount: 1,
    idempotencyKey: `email_${emailData.id}`,
    description: `Email to ${emailData.recipient}`,
  });

  if (!result.success) {
    throw new InsufficientCreditsError(`Need 1 credit, have ${result.balance}`);
  }

  // Credit consumed, now send the email
  await emailService.send(emailData);
}
```

### Top-Up Button with Error Recovery

```typescript
// Frontend component
function TopUpButton({ creditType, amount }: Props) {
  const [loading, setLoading] = useState(false);

  const handleTopUp = async () => {
    setLoading(true);
    const result = await fetch('/api/credits/topup', {
      method: 'POST',
      body: JSON.stringify({ creditType, amount })
    }).then(r => r.json());

    if (result.success) {
      toast.success(`Added ${amount} credits!`);
      refreshBalance();
    } else if (result.error.recoveryUrl) {
      // Redirect to Stripe to fix payment issue
      window.location.href = result.error.recoveryUrl;
    } else {
      toast.error(result.error.message);
    }
    setLoading(false);
  };

  return (
    <button onClick={handleTopUp} disabled={loading}>
      Buy {amount} credits
    </button>
  );
}

// API route
export async function POST(request: Request) {
  const user = await getUser(request);
  const { creditType, amount } = await request.json();

  const result = await credits.topUp({
    userId: user.id,
    creditType,
    amount,
  });

  return Response.json(result);
}
```

### Manual Credit Management

```typescript
// Disable auto-management, handle everything yourself
export const stripe = createStripeHandler({
  credits: {
    grantTo: 'manual',
  },
  callbacks: {
    onSubscriptionCreated: async (subscription) => {
      const userId = subscription.metadata.user_id;
      const plan = getPlanFromSubscription(subscription);

      // Custom logic: apply welcome bonus multiplier
      const bonusMultiplier = await getUserBonusMultiplier(userId);

      for (const [creditType, config] of Object.entries(plan.credits ?? {})) {
        const amount = Math.floor(config.allocation * bonusMultiplier);
        await credits.grant({
          userId,
          creditType,
          amount,
          source: 'subscription',
          sourceId: subscription.id,
        });
      }
    },

    onSubscriptionRenewed: async (subscription) => {
      const userId = subscription.metadata.user_id;
      const plan = getPlanFromSubscription(subscription);

      for (const [creditType, config] of Object.entries(plan.credits ?? {})) {
        // Respect the onRenewal setting from config
        if (config.onRenewal === 'add') {
          await credits.grant({
            userId,
            creditType,
            amount: config.allocation,
            source: 'renewal',
            sourceId: subscription.id,
          });
        } else {
          // Default: reset
          await credits.setBalance({
            userId,
            creditType,
            balance: config.allocation,
            reason: 'Subscription renewal',
          });
        }
      }
    },

    onSubscriptionCancelled: async (subscription) => {
      const userId = subscription.metadata.user_id;
      const balances = await credits.getAllBalances(userId);

      for (const creditType of Object.keys(balances)) {
        await credits.revoke({
          userId,
          creditType,
          amount: balances[creditType],
          source: 'cancellation',
        });
      }
    },
  },
});
```

### Handling Auto Top-Up Failures

```typescript
export const stripe = createStripeHandler({
  callbacks: {
    onAutoTopUpFailed: async ({ userId, creditType, error, currentBalance }) => {
      // Notify user their auto top-up failed
      await sendEmail(userId, {
        template: 'auto_topup_failed',
        data: {
          creditType,
          error: error.message,
          recoveryUrl: error.recoveryUrl,
          currentBalance,
        }
      });

      // Maybe also notify internal team for high-value customers
      const user = await getUser(userId);
      if (user.plan === 'enterprise') {
        await notifySlack(`Auto top-up failed for enterprise user ${userId}`);
      }
    },
  },
});
```

---

## Seat-Based Credits

The library supports different credit distribution models controlled by `grantTo` config.

---

### Checkout API

The checkout API supports both individual and org-based subscriptions:

```typescript
export interface CheckoutRequestBody {
  // ... existing fields (planName, priceId, etc.) ...

  /**
   * The user initiating checkout (the actual human).
   * - For individual: this user gets billed and receives credits
   * - For org: this user becomes the first seat (in seat-users mode)
   */
  user?: User;

  /**
   * Organization ID for team/org checkouts.
   * When provided, the org is the billing entity.
   * The user automatically becomes the first seat in 'seat-users' mode.
   */
  orgId?: string;
}
```

**Behavior:**

| `user` | `orgId` | Billing entity | First seat (seat-users mode) |
|--------|---------|----------------|------------------------------|
| ✓ | ✗ | user.id | user.id |
| ✓ | ✓ | orgId | user.id (automatic) |
| ✗ | ✓ | orgId | None (call addSeat manually) |

---

### Model 1: Individual / Shared Pool (`grantTo: 'subscriber'`)

One entity subscribes and gets credits. This is the default.

**Individual user:**
```typescript
// User subscribes for themselves
await checkout({
  planName: "Pro",
  user: { id: "user_123", email: "john@example.com" },
});
// → Billing: user_123
// → Credits go to: user_123

await credits.consume({ userId: "user_123", creditType: "email", amount: 1 });
```

**Shared org pool:**
```typescript
// Admin subscribes for org, org gets credits (shared pool)
await checkout({
  planName: "Team",
  user: { id: "admin_456", email: "admin@acme.com" },
  orgId: "org_789",
});
// → Billing: org_789
// → Credits go to: org_789 (shared pool)

// All team members draw from the org's pool
await credits.consume({ userId: "org_789", creditType: "email", amount: 1 });
```

---

### Model 2: Per-Seat Credits (`grantTo: 'seat-users'`)

Multiple users share one subscription, but each gets their own credit allocation.

**Config:**
```typescript
const stripe = createStripeHandler({
  billingConfig,
  credits: {
    grantTo: 'seat-users',
  },
});
```

**Checkout with automatic first seat:**
```typescript
// Admin subscribes for org
await checkout({
  planName: "Team",
  user: { id: "admin_123", email: "admin@acme.com" },
  orgId: "org_456",
});
// → Billing: org_456
// → First seat: admin_123 (automatic - they get credits immediately)
```

**Adding more seats:**
```typescript
// In your team management code
async function inviteToTeam(orgId: string, userId: string) {
  await db.addTeamMember(orgId, userId);
  await credits.addSeat({ userId, orgId });
  // → User now has credits!
}
```

**Removing seats:**
```typescript
async function removeFromTeam(orgId: string, userId: string) {
  await db.removeTeamMember(orgId, userId);
  await credits.removeSeat({ userId });
  // → Credits revoked
}
```

---

### Seat API

```typescript
// Register a seat - grants credits based on org's subscription plan
await credits.addSeat({
  userId: string,  // Who gets the credits
  orgId: string,   // Which org (we look up subscription from this)
});

// Unregister a seat - revokes credits
await credits.removeSeat({
  userId: string,
});
```

**How `addSeat` works internally:**
```
addSeat({ userId, orgId })
  → Look up orgId in user_stripe_customer_map → customerId
  → Get customer's active subscription
  → Get plan from subscription → credit config
  → Grant credits to userId
  → Log to ledger: source='seat_grant', source_id=subscription_id
```

**How `removeSeat` works internally:**
```
removeSeat({ userId })
  → Query ledger to find user's subscription (most recent seat_grant)
  → Revoke all credits for userId
  → Log to ledger: source='seat_revoke', source_id=subscription_id
```

---

### Finding Active Seats (for Renewal)

On subscription renewal, we need to find all active seat users. We use a ledger query:

```sql
-- Find active seats: users whose last seat action was 'seat_grant' (not 'seat_revoke')
SELECT user_id FROM (
  SELECT DISTINCT ON (user_id) user_id, source
  FROM stripe.credit_ledger
  WHERE source_id = $subscription_id
    AND source IN ('seat_grant', 'seat_revoke')
  ORDER BY user_id, created_at DESC
) active
WHERE source = 'seat_grant'
```

This query:
1. Filters to seat-related entries for this subscription
2. Uses `DISTINCT ON` to get the most recent action per user
3. Keeps only users whose last action was `seat_grant` (not revoked)

**Note:** Requires an index for performance:
```sql
CREATE INDEX idx_credit_ledger_source_id ON stripe.credit_ledger(source_id);
```

---

### Validation Rules

The library enforces these validation rules:

**Checkout validation:**
| Scenario | Result |
|----------|--------|
| `grantTo: 'seat-users'` + no `orgId` + no `user` | ❌ Error: "seat-users mode requires orgId or user" |
| `grantTo: 'seat-users'` + `orgId` + no `user` | ✓ OK (no first seat, call addSeat manually) |
| `grantTo: 'seat-users'` + `orgId` + `user` | ✓ OK (user auto-added as first seat) |
| `grantTo: 'subscriber'` + `orgId` + `user` | ✓ OK (org gets credits, user ignored for credits) |

**addSeat validation:**
| Scenario | Result |
|----------|--------|
| `grantTo: 'subscriber'` | ❌ Error: "addSeat not available in subscriber mode" |
| User already a seat of SAME subscription | ✓ OK (idempotent, no-op) |
| User already a seat of DIFFERENT subscription | ❌ Error: "User is already a seat of another subscription" |
| `orgId` has no active subscription | ❌ Error: "No active subscription found for org" |
| Subscription's plan has no credits configured | ❌ Error: "No credits configured for this plan" |

**removeSeat validation:**
| Scenario | Result |
|----------|--------|
| `grantTo: 'subscriber'` | ❌ Error: "removeSeat not available in subscriber mode" |
| User is not a seat of any subscription | ⚠️ Warning logged, no-op |

---

### Top-Ups for Seat Users

**v1: Not supported.** Seat users don't have individual billing relationships.

If more credits are needed:
- Org admin upgrades the plan (more credits per seat)
- Org admin manually grants credits: `credits.grant({ userId, ... })`
- Build org-level top-up flow (admin buys, distributes to users)

---

### Complete Per-Seat Example

```typescript
// ═══════════════════════════════════════════════════════════════════
// 1. Config
// ═══════════════════════════════════════════════════════════════════
const stripe = createStripeHandler({
  billingConfig,
  credits: {
    grantTo: 'seat-users',
  },
});

// ═══════════════════════════════════════════════════════════════════
// 2. Admin subscribes for their org
// ═══════════════════════════════════════════════════════════════════
await checkout({
  planName: "Team",
  user: { id: currentUserId, email: currentUser.email },  // The human
  orgId: org.id,  // The billing entity
});
// → Billing: org.id
// → First seat: currentUserId (auto, gets credits immediately)

// ═══════════════════════════════════════════════════════════════════
// 3. Team members join (in your auth/team management code)
// ═══════════════════════════════════════════════════════════════════
async function inviteToTeam(orgId: string, inviteeId: string) {
  // Your auth logic
  await db.addTeamMember(orgId, inviteeId);

  // Grant credits
  await credits.addSeat({ userId: inviteeId, orgId });
}

// ═══════════════════════════════════════════════════════════════════
// 4. Team members leave
// ═══════════════════════════════════════════════════════════════════
async function removeFromTeam(orgId: string, userId: string) {
  await db.removeTeamMember(orgId, userId);
  await credits.removeSeat({ userId });
}

// ═══════════════════════════════════════════════════════════════════
// 5. Each member uses their own credits
// ═══════════════════════════════════════════════════════════════════
await credits.consume({
  userId: memberUserId,
  creditType: "ai_tokens",
  amount: 100,
});

// ═══════════════════════════════════════════════════════════════════
// 6. Renewal is automatic
// ═══════════════════════════════════════════════════════════════════
// Library automatically:
// → Finds all active seats via ledger query
// → Grants/resets credits to each per plan config
// → No developer action needed
```

---

### Summary

| Mode | Config | Who gets credits | First seat | Renewal |
|------|--------|------------------|------------|---------|
| Individual | `grantTo: 'subscriber'` | The user | Automatic | Automatic |
| Shared pool | `grantTo: 'subscriber'` + `orgId` | The org | Automatic | Automatic |
| Per-seat | `grantTo: 'seat-users'` + `orgId` | Each seat user | Auto if `user` provided | Automatic (all seats) |
| Manual | `grantTo: 'manual'` | Nobody (you control) | N/A | Via callbacks |

---

## Plan Changes

When a user changes plans (upgrade/downgrade):

**Default behavior:** Credit changes take effect on next renewal.
- User keeps current balance until renewal
- At renewal, new plan's allocation is applied per `onRenewal` setting

**For immediate effect:** Use `grantTo: 'manual'` and handle in `onSubscriptionUpdated`:

```typescript
onSubscriptionUpdated: async (subscription) => {
  const userId = subscription.metadata.user_id;
  const oldPlan = getPreviousPlan(subscription); // You'd need to track this
  const newPlan = getPlanFromSubscription(subscription);

  // Immediately adjust to new plan allocation
  for (const [creditType, config] of Object.entries(newPlan.credits ?? {})) {
    await credits.setBalance({
      userId,
      creditType,
      balance: config.allocation,
      reason: `Plan changed to ${newPlan.name}`,
    });
  }
}
```

---

## File Structure

```
src/
├── credits/
│   ├── index.ts          # Main export: credits object
│   ├── types.ts          # CreditResult, CreditError, CreditTransaction types
│   ├── balance.ts        # getBalance, getAllBalances, hasCredits
│   ├── consume.ts        # consume (with idempotency, triggers auto top-up)
│   ├── grant.ts          # grant, revoke, setBalance
│   ├── topup.ts          # topUp, createRecoveryCheckout, auto top-up logic
│   ├── history.ts        # getHistory
│   ├── sync.ts           # syncFromSubscription
│   └── db.ts             # Database operations (balance updates, ledger writes)
├── BillingConfig.ts      # Extended with CreditConfig type
├── handler.ts            # Extended with credit lifecycle hooks
└── index.ts              # Add credits export
```

---

## Migration

Add to existing migration:

```sql
-- Credit balances
CREATE TABLE IF NOT EXISTS stripe.credit_balances (
  user_id text NOT NULL,
  credit_type_id text NOT NULL,
  balance bigint NOT NULL DEFAULT 0,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, credit_type_id)
);

-- Credit ledger (audit trail)
CREATE TABLE IF NOT EXISTS stripe.credit_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  credit_type_id text NOT NULL,
  amount bigint NOT NULL,
  balance_after bigint NOT NULL,
  transaction_type text NOT NULL,
  source text NOT NULL,
  source_id text,
  description text,
  metadata jsonb,
  idempotency_key text UNIQUE,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_credit_ledger_user_type_time
  ON stripe.credit_ledger(user_id, credit_type_id, created_at DESC);

-- Index for seat queries (finding active seats by subscription)
CREATE INDEX IF NOT EXISTS idx_credit_ledger_source_id
  ON stripe.credit_ledger(source_id);
```

---

## Implementation Checklist

### Phase 1: Core
- [ ] Add CreditConfig types to BillingConfig.ts
- [ ] Create credit_balances and credit_ledger tables
- [ ] Implement credits.getBalance / getAllBalances
- [ ] Implement credits.hasCredits
- [ ] Implement credits.consume (with idempotency)
- [ ] Implement credits.grant
- [ ] Implement credits.revoke
- [ ] Implement credits.setBalance
- [ ] Implement credits.getHistory

### Phase 2: Subscription Lifecycle
- [ ] Handle customer.subscription.created → grant credits
- [ ] Handle invoice.paid (subscription_cycle) → renewal logic
- [ ] Handle customer.subscription.deleted → revoke credits
- [ ] Add grantTo config option ('subscriber' | 'manual')
- [ ] Fire credit callbacks (onCreditsGranted, onCreditsRevoked, onSubscriptionRenewed)

### Phase 3: Top-Up
- [ ] Implement credits.topUp (direct charge)
- [ ] Implement recovery checkout creation
- [ ] Handle checkout.session.completed for recovery flow
- [ ] Implement credits.hasPaymentMethod

### Phase 4: Auto Top-Up
- [ ] Implement auto top-up trigger in consume()
- [ ] Implement monthly limit check (query ledger)
- [ ] Fire onAutoTopUpTriggered / onAutoTopUpFailed callbacks
- [ ] Fire onCreditsLow callback

### Phase 5: Seat-Based Credits
- [ ] Add grantTo: 'seat-users' mode
- [ ] Add checkout support for orgId parameter
- [ ] Implement first seat auto-grant when user + orgId provided
- [ ] Implement credits.addSeat({ userId, orgId })
- [ ] Implement credits.removeSeat({ userId })
- [ ] Add seat_grant/seat_revoke source values to ledger
- [ ] Implement active seats query (DISTINCT ON)
- [ ] Add validation rules (mode checks, idempotency, etc.)
- [ ] Update renewal logic to handle seat-users mode

### Phase 6: Polish
- [ ] Implement credits.syncFromSubscription
- [ ] Add validation in sync command (credit types exist, etc.)
- [ ] Documentation
- [ ] Tests

---

## What's In v1 vs Future

| Feature | v1 | Future |
|---------|:--:|:------:|
| Credit allocation per plan | ✅ | |
| onRenewal: 'reset' \| 'add' | ✅ | |
| grantTo: 'subscriber' \| 'seat-users' \| 'manual' | ✅ | |
| consume/grant/revoke/setBalance | ✅ | |
| Credit ledger (audit trail) | ✅ | |
| Idempotency keys | ✅ | |
| Top-up (on_demand OR auto mode) | ✅ | |
| Per-plan top-up pricing | ✅ | |
| Auto top-up monthly limits | ✅ | |
| Recovery checkout URLs | ✅ | |
| Structured error types | ✅ | |
| syncFromSubscription helper | ✅ | |
| Seat-based credits (addSeat/removeSeat) | ✅ | |
| Checkout with orgId for org billing | ✅ | |
| Auto first-seat on checkout | ✅ | |
| Expiring credits (custom dates) | ❌ | v2 |
| Credit reservations | ❌ | v2 |
| Rollover caps | ❌ | v2 |
| Credit transfer between users | ❌ | v2 |
| Proration on plan change | ❌ | v2 |
| Both on-demand AND auto top-up | ❌ | v2 |
| Top-ups for seat users | ❌ | v2 |

---

## Open Questions

1. **Checkout recovery flow**: When user completes recovery checkout, we need to handle `checkout.session.completed` and grant the credits. Need to store pending top-up info in checkout session metadata.

2. **Race condition on consume**: If two requests try to consume the last credit simultaneously, one should fail. Need to ensure atomic balance updates (use transactions or row-level locking).

3. **Display names**: Should we auto-format credit type IDs ("email_credits" → "Email Credits") or require explicit displayName? Leaning toward auto-format with optional override.

---

## Design Decisions (Implementation Notes)

These decisions were made during implementation and differ from or clarify the original plan:

### 1. Auto Top-Up Lives in `handler.consumeCredits()`, Not `credits.consume()`

**Decision:** The `credits` module remains a pure ledger without Stripe dependencies. Auto top-up is triggered via `handler.consumeCredits()` wrapper, not inside `credits.consume()`.

**Rationale:**
- Separation of concerns: `credits` module handles ledger operations only
- No Stripe dependency in the credits module
- Users who want auto top-up explicitly opt-in by using `handler.consumeCredits()`
- Users who want pure ledger operations use `credits.consume()` directly

**Usage:**
```typescript
// With auto top-up (recommended for most use cases)
const result = await handler.consumeCredits({ userId, creditType, amount });

// Pure ledger operation (no auto top-up)
const result = await credits.consume({ userId, creditType, amount });
```

### 2. Single `onTopUpCompleted` Callback for Both Manual and Auto Top-Ups

**Decision:** We use one callback `onTopUpCompleted` for all top-ups instead of separate `onAutoTopUpTriggered` and manual top-up callbacks.

**Rationale:**
- Reduces callback proliferation
- The source (`"topup"` vs `"auto_topup"`) is tracked in the ledger
- `onTopUpCompleted` provides all relevant info (amount, charge, balance, paymentIntentId)
- Users can distinguish auto vs manual by checking the ledger if needed

**The callback fires for:**
- Manual top-ups via `handler.topUpCredits()`
- Auto top-ups triggered by `handler.consumeCredits()`

### 3. `onCreditsLow` Fires Before Auto Top-Up Attempt

**Decision:** The `onCreditsLow` callback fires when balance drops below threshold, before we attempt auto top-up (regardless of whether auto top-up succeeds or fails).

**Rationale:**
- Useful for sending notifications to users
- Fires even if auto top-up is skipped (no payment method, max reached, etc.)
- Allows apps to implement custom logic alongside auto top-up

### 4. Invalid Auto Top-Up Config Returns `"not_configured"`

**Decision:** If auto top-up config has invalid values (purchaseAmount ≤ 0, balanceThreshold ≤ 0, pricePerCreditCents ≤ 0), we log an error and return `{ triggered: false, reason: "not_configured" }`.

**Rationale:**
- Fail fast with clear console error
- Don't attempt Stripe API call with invalid values
- Same return shape as "not configured" for consistency

### 5. Unexpected Errors Fire `onAutoTopUpFailed` with `"unexpected_error"`

**Decision:** If auto top-up throws an unexpected error (DB failure, network issue, etc.), we fire `onAutoTopUpFailed` with `reason: "unexpected_error"` in addition to logging.

**Rationale:**
- Gives visibility into failures that would otherwise be swallowed
- Allows apps to alert on unexpected issues
- Consistent with other failure reasons

### 6. Idempotency Key for Auto Top-Up Based on Monthly Count

**Decision:** Auto top-up PaymentIntent uses idempotency key: `auto_topup_${userId}_${creditType}_${yearMonth}_${count+1}`

**Rationale:**
- Prevents duplicate charges from concurrent consume() calls
- Two concurrent triggers see same count, use same key, Stripe dedupes one
- If payment fails, same key for 24h prevents spam retries (feature, not bug)
- After 24h Stripe key expires, fresh retry possible
