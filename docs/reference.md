# API Reference

Complete reference for all APIs.

## Contents

- [Billing Client](#billing-client)
- [HTTP Routes](#http-routes)
- [Subscriptions API](#subscriptions-api)
- [Credits API](#credits-api)
- [Wallet API](#wallet-api)
- [Usage API](#usage-api)
- [Seats API](#seats-api)
- [Callbacks](#callbacks)
- [BillingConfig Types](#billingconfig-types)
- [Frontend Client](#frontend-client)
- [CLI Commands](#cli-commands)

---

## Billing Client

```typescript
import { Billing } from "stripe-no-webhooks";

const billing = new Billing({
  // Connection (default to env vars)
  stripeSecretKey?: string,      // Default: STRIPE_SECRET_KEY
  stripeWebhookSecret?: string,  // Default: STRIPE_WEBHOOK_SECRET
  databaseUrl?: string,          // Default: DATABASE_URL
  schema?: string,               // Default: "stripe"

  // Required
  billingConfig: BillingConfig,
  successUrl: string,
  cancelUrl: string,
  resolveUser: (request: Request) => User | null | Promise<User | null>,

  // Optional
  resolveOrg?: (request: Request) => string | null | Promise<string | null>,
  callbacks?: StripeWebhookCallbacks,
  tax?: TaxConfig,
  credits?: { grantTo: "subscriber" | "organization" | "seat-users" | "manual" },
  mapUserIdToStripeCustomerId?: (userId: string) => string | null | Promise<string | null>,
});

// Properties
billing.mode  // "test" | "production" - based on STRIPE_SECRET_KEY
billing.getPlans()  // Returns plans for current mode

// Create HTTP handler
const handler = billing.createHandler();

// Assign user to a free plan (useful on login/signup)
await billing.assignFreePlan({
  userId: string,
  planName?: string,     // Optional - auto-detects if only one free plan
  interval?: "month" | "year" | "week",  // Default: "month"
}): Promise<Stripe.Subscription | null>  // null if user already has subscription
```

---

## HTTP Routes

The handler responds to these endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/checkout` | POST | Create checkout session |
| `/webhook` | POST | Handle Stripe webhooks |
| `/customer_portal` | POST | Open billing portal |
| `/billing` | POST | Get plans and current subscription |
| `/recovery` | GET | Redirect to Customer Portal for payment recovery |

### Browser Usage

Send `Accept: application/json` header to get JSON response (avoids CORS issues):

```typescript
const res = await fetch("/api/stripe/checkout", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Accept": "application/json",
  },
  body: JSON.stringify({ planName: "Pro", interval: "month" }),
});
const { url } = await res.json();
window.location.href = url;
```

---

## Subscriptions API

```typescript
// Check if user has active subscription
await billing.subscriptions.isActive({ userId }): Promise<boolean>

// Get current subscription
await billing.subscriptions.get({ userId }): Promise<Subscription | null>

// List all subscriptions
await billing.subscriptions.list({ userId }): Promise<Subscription[]>

// Check payment status (for showing warnings)
await billing.subscriptions.getPaymentStatus({ userId }): Promise<SubscriptionPaymentStatus>
```

### Types

```typescript
type Subscription = {
  id: string;
  status: "active" | "trialing" | "past_due" | "canceled" | "unpaid" | "incomplete" | "paused";
  plan: {
    id: string;
    name: string;
    priceId: string;
  } | null;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
};

type SubscriptionPaymentStatus = {
  status: "ok" | "past_due" | "unpaid" | "no_subscription";
  failedInvoice?: {
    id: string;
    amountDue: number;
    currency: string;
    attemptCount: number;
    nextPaymentAttempt: Date | null;
    hostedInvoiceUrl: string | null;
  };
};
```

---

## Credits API

### Read Methods

```typescript
// Get balance for one credit type
await billing.credits.getBalance({ userId, key }): Promise<number>

// Get all balances
await billing.credits.getAllBalances({ userId }): Promise<Record<string, number>>

// Check if user has enough
await billing.credits.hasCredits({ userId, key, amount }): Promise<boolean>

// Get transaction history
await billing.credits.getHistory({ userId, key?, limit?, offset? }): Promise<CreditTransaction[]>

// Check for saved payment method
await billing.credits.hasPaymentMethod({ userId }): Promise<boolean>

// Check auto top-up status
await billing.credits.getAutoTopUpStatus({ userId, key }): Promise<AutoTopUpStatus | null>
```

### Write Methods

```typescript
// Consume credits (always succeeds, balance can go negative)
await billing.credits.consume({
  userId,
  key,
  amount,
  description?,
  metadata?,
  idempotencyKey?,
}): Promise<{ success: true, balance: number }>

// Grant credits (ledger operation - doesn't charge anyone)
await billing.credits.grant({
  userId,
  key,
  amount,
  source?,
  sourceId?,
  description?,
  idempotencyKey?,
}): Promise<number>  // Returns new balance

// Purchase credits (charges customer's card)
await billing.credits.topUp({
  userId,
  key,
  amount,
  idempotencyKey?,
}): Promise<TopUpResult>

// Revoke credits
await billing.credits.revoke({
  userId,
  key,
  amount,
  source?,
  sourceId?,
}): Promise<{ balance: number, amountRevoked: number }>

// Revoke all of a credit type
await billing.credits.revokeAll({ userId, key }): Promise<{ amountRevoked: number }>

// Set exact balance
await billing.credits.setBalance({
  userId,
  key,
  balance,
  reason?,
}): Promise<{ previousBalance: number }>

// Unblock auto top-up
await billing.credits.unblockAutoTopUp({ userId, key }): Promise<void>
await billing.credits.unblockAllAutoTopUps({ userId }): Promise<void>
```

---

## Wallet API

```typescript
// Get balance (returns null if no wallet)
await billing.wallet.getBalance({ userId }): Promise<WalletBalance | null>

// Add funds (ledger operation - doesn't charge anyone)
await billing.wallet.add({
  userId,
  amount,         // cents
  currency?,      // default: "usd"
  source?,
  sourceId?,
  description?,
  idempotencyKey?,
}): Promise<{ balance: WalletBalance }>

// Consume (balance can go negative)
await billing.wallet.consume({
  userId,
  amount,         // cents
  description?,
  idempotencyKey?,
}): Promise<{ balance: WalletBalance }>

// Get transaction history
await billing.wallet.getHistory({ userId, limit?, offset? }): Promise<WalletEvent[]>

// Purchase wallet balance (charges customer's card)
await billing.wallet.topUp({
  userId,
  amount,         // cents to add
  idempotencyKey?,
}): Promise<WalletTopUpResult>
```

### Types

```typescript
type WalletBalance = {
  amount: number;      // cents (can be negative)
  formatted: string;   // "$3.50" or "-$1.50"
  currency: string;
};

type WalletEvent = {
  id: string;
  amount: number;
  balanceAfter: number;
  type: "add" | "consume" | "adjust" | "revoke";
  source: string;
  sourceId?: string;
  description?: string;
  createdAt: Date;
};

type WalletTopUpResult =
  | { success: true; balance: WalletBalance; sourceId: string }
  | { success: false; error: { code: string; message: string; recoveryUrl?: string } };
```

---

## Usage API

```typescript
// Record usage (sends to Stripe Meter + stores locally)
await billing.usage.record({
  userId,
  key,           // Feature key (must have trackUsage: true)
  amount,        // Units to record (required)
  timestamp?,    // Optional timestamp (defaults to now)
}): Promise<RecordUsageResult>

// Get usage summary for current billing period
await billing.usage.getSummary({ userId, key }): Promise<UsageSummary>

// Get usage event history
await billing.usage.getHistory({
  userId,
  key,
  limit?,        // Default: 50
  offset?,
}): Promise<UsageEvent[]>

// Enable usage billing for existing subscriber
// (adds metered price to subscription if not already present)
await billing.usage.enableForUser({ userId, key }): Promise<void>
```

### Types

```typescript
type RecordUsageResult = {
  event: UsageEvent;
  meterEventId: string;
};

type UsageEvent = {
  id: string;
  userId: string;
  key: string;
  amount: number;
  stripeMeterEventId: string;
  periodStart: Date;
  periodEnd: Date;
  createdAt: Date;
};

type UsageSummary = {
  totalAmount: number;    // Units consumed this period
  eventCount: number;     // Number of usage events
  estimatedCost: number;  // totalAmount × pricePerCredit (cents)
  currency: string;       // e.g., "usd"
  periodStart: Date;
  periodEnd: Date;
};
```

---

## Seats API

For team billing with per-seat credit grants:

```typescript
// Add user as seat
await billing.seats.add({
  userId,
  orgId,
}): Promise<{ success: true, creditsGranted: Record<string, number> }
          | { success: false, error: string }>

// Remove user as seat
await billing.seats.remove({
  userId,
  orgId,
}): Promise<{ success: true, creditsRevoked: Record<string, number> }
          | { success: false, error: string }>
```

---

## Callbacks

```typescript
const billing = new Billing({
  billingConfig,
  callbacks: {
    // Subscription events
    onSubscriptionCreated?: (subscription: Stripe.Subscription) => void,
    onSubscriptionCancelled?: (subscription: Stripe.Subscription) => void,
    onSubscriptionRenewed?: (subscription: Stripe.Subscription) => void,
    onSubscriptionPlanChanged?: (params: {
      subscription: Stripe.Subscription,
      previousPlanId: string,
      newPlanId: string,
    }) => void,
    onSubscriptionPaymentFailed?: (params: {
      userId: string,
      stripeCustomerId: string,
      subscriptionId: string,
      invoiceId: string,
      amountDue: number,
      currency: string,
      stripeDeclineCode?: string,
      failureMessage?: string,
      attemptCount: number,
      nextPaymentAttempt: Date | null,
      willRetry: boolean,
      planName?: string,
      priceId: string,
    }) => void,

    // Credit events
    onCreditsGranted?: (params: {
      userId: string,
      key: string,
      amount: number,
      newBalance: number,
      source: TransactionSource,
      sourceId?: string,
    }) => void,
    onCreditsRevoked?: (params: {
      userId: string,
      key: string,
      amount: number,
      previousBalance: number,
      newBalance: number,
      source: "cancellation" | "manual" | "seat_revoke",
    }) => void,
    onCreditsLow?: (params: {
      userId: string,
      key: string,
      balance: number,
      threshold: number,
    }) => void,

    // Top-up events
    onTopUpCompleted?: (params: {
      userId: string,
      key: string,
      creditsAdded: number,
      amountCharged: number,
      currency: string,
      newBalance: number,
      sourceId: string,
    }) => void,
    onAutoTopUpFailed?: (params: {
      userId: string,
      stripeCustomerId: string,
      key: string,
      trigger: "stripe_declined_payment" | "waiting_for_retry_cooldown"
             | "blocked_until_card_updated" | "no_payment_method"
             | "monthly_limit_reached" | "unexpected_error",
      status: "will_retry" | "action_required",
      nextAttemptAt?: Date,
      failureCount: number,
      stripeDeclineCode?: string,
    }) => void,

    // Usage events
    onUsageRecorded?: (params: {
      userId: string,
      key: string,
      amount: number,
      totalForPeriod: number,
      estimatedCost: number,
      currency: string,
      periodStart: Date,
      periodEnd: Date,
    }) => void | Promise<void>,

    // Wallet events
    onWalletLow?: (params: {
      userId: string,
      balance: number,
      threshold: number,
    }) => void | Promise<void>,
    onWalletTopUpCompleted?: (params: {
      userId: string,
      amountAdded: number,
      amountCharged: number,
      currency: string,
      newBalance: WalletBalance,
      sourceId: string,
    }) => void | Promise<void>,
    onWalletAutoTopUpFailed?: (params: {
      userId: string,
      stripeCustomerId: string,
      trigger: string,
      status: "will_retry" | "action_required",
      nextAttemptAt?: Date,
      failureCount: number,
      stripeDeclineCode?: string,
    }) => void | Promise<void>,
  },
});
```

---

## BillingConfig Types

```typescript
type BillingConfig = {
  test?: { plans?: Plan[] };
  production?: { plans?: Plan[] };
};

type Plan = {
  id?: string;           // Set by sync
  name: string;
  description?: string;
  price: Price[];
  features?: Record<string, FeatureConfig>;
  wallet?: WalletConfig;
  highlights?: string[];  // Bullet points for pricing page
  perSeat?: boolean;
};

type Price = {
  id?: string;           // Set by sync
  amount: number;        // cents
  currency: string;
  interval: "month" | "year" | "week" | "one_time";
};

type FeatureConfig = {
  displayName?: string;
  pricePerCredit?: number;       // cents (enables top-ups and/or usage billing)
  minPerPurchase?: number;
  maxPerPurchase?: number;
  autoTopUp?: AutoTopUpConfig;
  credits?: CreditAllocation;
  trackUsage?: boolean;          // Enable usage-based billing
  meteredPriceId?: string;       // Set by sync when trackUsage is true
};

type CreditAllocation = {
  allocation: number;
  onRenewal?: "reset" | "add";   // Default: "reset"
};

type AutoTopUpConfig = {
  threshold: number;
  amount: number;
  maxPerMonth?: number;          // Default: 10
};

type WalletConfig = {
  allocation: number;            // cents
  displayName?: string;
  onRenewal?: "reset" | "add";   // Default: "reset"
};
```

### Example

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
      pricePerCredit: 10,
      trackUsage: true,
    },
  },
  wallet: {
    allocation: 500,
    displayName: "AI Usage",
  },
}
```

---

## Frontend Client

### Generated Component (Recommended)

```bash
npx stripe-no-webhooks generate pricing-page
```

```tsx
import { PricingPage } from "@/components/PricingPage";

<PricingPage />

// With options
<PricingPage
  currentPlanId="pro"
  currentInterval="year"
  onError={(err) => {}}
/>
```

### Manual Implementation

```typescript
import { createCheckoutClient } from "stripe-no-webhooks/client";

const { checkout, customerPortal } = createCheckoutClient({
  checkoutEndpoint?: string,
  customerPortalEndpoint?: string,
  onLoading?: (isLoading: boolean) => void,
  onError?: (error: Error) => void,
  onRedirect?: (url: string) => void,
});

// Start checkout
checkout({
  planName: string,
  interval: "month" | "year",
  quantity?: number,
  metadata?: Record<string, string>,
});

// Open billing portal
customerPortal();
```

### Simple Usage

```typescript
import { checkout, customerPortal } from "stripe-no-webhooks/client";

checkout({ planName: "Pro", interval: "month" });
customerPortal();
```

---

## CLI Commands

```bash
npx stripe-no-webhooks init        # Create config files and .env
npx stripe-no-webhooks migrate     # Create database tables
npx stripe-no-webhooks sync        # Sync plans to Stripe
npx stripe-no-webhooks generate pricing-page  # Generate pricing component
npx stripe-no-webhooks backfill    # Import existing Stripe data
```
