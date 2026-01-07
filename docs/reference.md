# API Reference

Quick lookup for all APIs.

## Handler

```typescript
import { createStripeHandler } from "stripe-no-webhooks";

const stripe = createStripeHandler({
  stripeSecretKey?: string,          // Default: STRIPE_SECRET_KEY env
  stripeWebhookSecret?: string,      // Default: STRIPE_WEBHOOK_SECRET env
  databaseUrl?: string,              // Default: DATABASE_URL env
  schema?: string,                   // Default: "stripe"
  billingConfig?: BillingConfig,
  successUrl?: string,
  cancelUrl?: string,
  automaticTax?: boolean,            // Default: true
  credits?: {
    grantTo?: "subscriber" | "organization" | "seat-users" | "manual",
  },
  callbacks?: StripeWebhookCallbacks,
  getUser?: (request: Request) => User | null,
  mapUserIdToStripeCustomerId?: (userId: string) => string | null,
});
```

## Routes

The handler responds to POST requests:

| Endpoint | Description |
|----------|-------------|
| `/checkout` | Create checkout session |
| `/webhook` | Handle Stripe webhooks |
| `/customer_portal` | Open billing portal |

## Credits API

All methods on `stripe.credits`:

### Read

```typescript
// Get balance for one credit type
await stripe.credits.getBalance(userId: string, creditType: string): Promise<number>

// Get all balances
await stripe.credits.getAllBalances(userId: string): Promise<Record<string, number>>

// Check if user has enough
await stripe.credits.hasCredits(userId: string, creditType: string, amount: number): Promise<boolean>

// Get transaction history
await stripe.credits.getHistory(userId: string, options?: {
  creditType?: string,
  limit?: number,
  offset?: number,
}): Promise<CreditTransaction[]>

// Check for saved payment method
await stripe.credits.hasPaymentMethod(userId: string): Promise<boolean>
```

### Write

```typescript
// Consume credits (with auto top-up if configured)
await stripe.credits.consume({
  userId: string,
  creditType: string,
  amount: number,
  description?: string,
  metadata?: Record<string, unknown>,
  idempotencyKey?: string,
}): Promise<{ success: true, balance: number } | { success: false, balance: number }>

// Grant credits
await stripe.credits.grant({
  userId: string,
  creditType: string,
  amount: number,
  source?: TransactionSource,
  sourceId?: string,
  description?: string,
  idempotencyKey?: string,
}): Promise<number>  // Returns new balance

// Revoke specific amount
await stripe.credits.revoke({
  userId: string,
  creditType: string,
  amount: number,
  source?: "cancellation" | "manual" | "seat_revoke",
  sourceId?: string,
}): Promise<{ balance: number, amountRevoked: number }>

// Revoke all of a credit type
await stripe.credits.revokeAll({
  userId: string,
  creditType: string,
}): Promise<{ amountRevoked: number }>

// Set exact balance
await stripe.credits.setBalance({
  userId: string,
  creditType: string,
  balance: number,
  reason?: string,
}): Promise<{ previousBalance: number }>

// Purchase credits
await stripe.credits.topUp({
  userId: string,
  creditType: string,
  amount: number,
}): Promise<TopUpResult>
```

## Seats API

```typescript
// Add user as seat
await stripe.addSeat({
  userId: string,
  orgId: string,
}): Promise<{ success: true, creditsGranted: Record<string, number> }
            | { success: false, error: string }>

// Remove user as seat
await stripe.removeSeat({
  userId: string,
  orgId: string,
}): Promise<{ success: true, creditsRevoked: Record<string, number> }
            | { success: false, error: string }>
```

## Callbacks

```typescript
callbacks: {
  onSubscriptionCreated?: (subscription: Stripe.Subscription) => void,
  onSubscriptionCancelled?: (subscription: Stripe.Subscription) => void,
  onSubscriptionRenewed?: (subscription: Stripe.Subscription) => void,

  onCreditsGranted?: (params: {
    userId: string,
    creditType: string,
    amount: number,
    newBalance: number,
    source: TransactionSource,
    sourceId?: string,
  }) => void,

  onCreditsRevoked?: (params: {
    userId: string,
    creditType: string,
    amount: number,
    previousBalance: number,
    newBalance: number,
    source: "cancellation" | "manual" | "seat_revoke",
  }) => void,

  onCreditsLow?: (params: {
    userId: string,
    creditType: string,
    balance: number,
    threshold: number,
  }) => void,

  onTopUpCompleted?: (params: {
    userId: string,
    creditType: string,
    creditsAdded: number,
    amountCharged: number,
    currency: string,
    newBalance: number,
    paymentIntentId: string,
  }) => void,

  onAutoTopUpFailed?: (params: {
    userId: string,
    creditType: string,
    reason: "no_payment_method" | "payment_failed" | "monthly_limit_reached" | "unexpected_error",
    error?: string,
  }) => void,
}
```

## BillingConfig

```typescript
type BillingConfig = {
  test?: { plans?: Plan[] },
  production?: { plans?: Plan[] },
};

type Plan = {
  id?: string,
  name: string,
  description?: string,
  price: Price[],
  credits?: Record<string, CreditConfig>,
  perSeat?: boolean,
};

type Price = {
  id?: string,                    // Set by sync command
  amount: number,                 // In cents
  currency: string,
  interval: "month" | "year" | "week" | "one_time",
};

type CreditConfig = {
  allocation: number,
  displayName?: string,
  onRenewal?: "reset" | "add",    // Default: "reset"
  topUp?: OnDemandTopUp | AutoTopUp,
};

type OnDemandTopUp = {
  mode: "on_demand",
  pricePerCreditCents: number,
  minPerPurchase?: number,        // Default: 1
  maxPerPurchase?: number,
};

type AutoTopUp = {
  mode: "auto",
  pricePerCreditCents: number,
  balanceThreshold: number,
  purchaseAmount: number,
  maxPerMonth?: number,           // Default: 10
};
```

## Client

```typescript
import { checkout, createCheckoutClient } from "stripe-no-webhooks/client";

// Default client (uses /api/stripe/checkout)
checkout({
  planName?: string,
  planId?: string,
  interval?: "month" | "year" | "week" | "one_time",
  priceId?: string,
  quantity?: number,
  customerEmail?: string,
  successUrl?: string,
  cancelUrl?: string,
  metadata?: Record<string, string>,
});

// Custom endpoint
const { checkout } = createCheckoutClient({
  checkoutEndpoint: "/my/custom/endpoint",
});
```

## Types

```typescript
type TransactionType = "grant" | "consume" | "revoke" | "adjust";

type TransactionSource =
  | "subscription"
  | "renewal"
  | "cancellation"
  | "topup"
  | "auto_topup"
  | "manual"
  | "usage"
  | "seat_grant"
  | "seat_revoke";

type CreditTransaction = {
  id: string,
  userId: string,
  creditType: string,
  amount: number,
  balanceAfter: number,
  transactionType: TransactionType,
  source: TransactionSource,
  sourceId?: string,
  description?: string,
  metadata?: Record<string, unknown>,
  createdAt: Date,
};

class CreditError extends Error {
  code: string;
  details?: Record<string, unknown>;
}
```

## CLI Commands

```bash
# Create database tables
npx stripe-no-webhooks migrate <database_url>

# Generate config files and webhook
npx stripe-no-webhooks config

# Sync plans to Stripe
npx stripe-no-webhooks sync

# Validate configuration
npx stripe-no-webhooks validate
```
