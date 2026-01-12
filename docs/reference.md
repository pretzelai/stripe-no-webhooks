# API Reference

Quick lookup for all APIs.

## Client

```typescript
import { createStripeHandler } from "stripe-no-webhooks";

// Create once in lib/stripe.ts
const stripe = createStripeHandler({
  stripeSecretKey?: string,          // Default: STRIPE_SECRET_KEY env
  stripeWebhookSecret?: string,      // Default: STRIPE_WEBHOOK_SECRET env
  databaseUrl?: string,              // Default: DATABASE_URL env
  schema?: string,                   // Default: "stripe"
  billingConfig?: BillingConfig,
  successUrl?: string,
  cancelUrl?: string,
  credits?: {
    grantTo?: "subscriber" | "organization" | "seat-users" | "manual",
  },

  // Map user ID to existing Stripe customer ID (for migrations)
  mapUserIdToStripeCustomerId?: (userId: string) => string | null | Promise<string | null>,
});
```

## Handler

```typescript
// Create HTTP handler with request-specific config
export const POST = stripe.createHandler({
  // REQUIRED: Resolve authenticated user from request
  resolveUser?: (request: Request) => User | null | Promise<User | null>,

  // OPTIONAL: Resolve org for team/org billing
  resolveOrg?: (request: Request) => string | null | Promise<string | null>,

  // OPTIONAL: Callbacks for subscription events
  callbacks?: StripeWebhookCallbacks,

  // OPTIONAL: Enable automatic tax calculation
  automaticTax?: boolean,            // Default: false
});

// User type
type User = {
  id: string;
  name?: string;
  email?: string;
};
```

## Routes

The handler responds to POST requests:

| Endpoint | Description |
|----------|-------------|
| `/checkout` | Create checkout session |
| `/webhook` | Handle Stripe webhooks |
| `/customer_portal` | Open billing portal |

### Calling from the browser

When using `fetch()` from the browser, send the `Accept: application/json` header to receive a JSON response with the URL. Without this header, the server returns a 303 redirect which causes CORS errors.

```typescript
// Checkout
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

// Customer Portal
const res = await fetch("/api/stripe/customer_portal", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Accept": "application/json",
  },
});
const { url } = await res.json();
window.location.href = url;
```

## Subscriptions API

```typescript
// Check if user has active subscription
await stripe.subscriptions.isActive(userId: string): Promise<boolean>

// Get current subscription
await stripe.subscriptions.get(userId: string): Promise<Subscription | null>

// List all subscriptions
await stripe.subscriptions.list(userId: string): Promise<Subscription[]>
```

```typescript
type SubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "incomplete"
  | "paused";

type Subscription = {
  id: string,
  status: SubscriptionStatus,
  plan: {
    id: string,
    name: string,
    priceId: string,
  } | null,
  currentPeriodStart: Date,
  currentPeriodEnd: Date,
  cancelAtPeriodEnd: boolean,
}
```

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
await stripe.seats.add({
  userId: string,
  orgId: string,
}): Promise<{ success: true, creditsGranted: Record<string, number> }
            | { success: false, error: string }>

// Remove user as seat
await stripe.seats.remove({
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

## Frontend Client

### Generated Pricing Page (Recommended)

Generate a ready-to-use pricing component:

```bash
npx stripe-no-webhooks generate pricing-page
```

Creates `components/PricingPage.tsx` with loading states, error handling, and styling built-in.

```tsx
import { PricingPage } from "@/components/PricingPage";
import billingConfig from "@/billing.config";

const plans = billingConfig.test?.plans || [];

<PricingPage
  plans={plans}
  currentPlanId="free"           // Highlights current plan
  currentInterval="month"        // Default interval selection
  onError={(err) => {}}          // Optional error callback
/>
```

### Manual Implementation

For full control over the UI, use `createCheckoutClient` with callbacks:

```typescript
import { createCheckoutClient } from "stripe-no-webhooks/client";

const { checkout, customerPortal } = createCheckoutClient({
  // Optional: Custom endpoints
  checkoutEndpoint: "/api/stripe/checkout",
  customerPortalEndpoint: "/api/stripe/customer_portal",

  // Callbacks for UI state management
  onLoading: (isLoading: boolean) => {
    // Update your loading state
    setIsLoading(isLoading);
  },
  onError: (error: Error) => {
    // Show error to user
    toast.error(error.message);
  },
  onRedirect: (url: string) => {
    // Called right before redirect - show a message, track analytics, etc.
    console.log("Redirecting to:", url);
  },
});
```

Example with React state:

```tsx
"use client";
import { useState } from "react";
import { createCheckoutClient } from "stripe-no-webhooks/client";

export function CheckoutButton({ planName }: { planName: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { checkout } = createCheckoutClient({
    onLoading: setLoading,
    onError: (err) => setError(err.message),
  });

  return (
    <>
      <button
        onClick={() => checkout({ planName, interval: "month" })}
        disabled={loading}
      >
        {loading ? "Loading..." : "Subscribe"}
      </button>
      {error && <p className="error">{error}</p>}
    </>
  );
}
```

### Checkout Options

```typescript
checkout({
  planName?: string,             // Plan name from billing config
  planId?: string,               // Plan ID from billing config
  interval?: "month" | "year" | "week" | "one_time",
  priceId?: string,              // Direct Stripe price ID (bypasses config)
  quantity?: number,             // Default: 1
  successUrl?: string,           // Override success redirect
  cancelUrl?: string,            // Override cancel redirect
  metadata?: Record<string, string>,
});

// Customer Portal - redirects to Stripe billing portal
customerPortal();
```

### Default Exports

For simple usage without callbacks:

```typescript
import { checkout, customerPortal } from "stripe-no-webhooks/client";

// These use default /api/stripe endpoints with no callbacks
<button onClick={() => checkout({ planName: "Pro" })}>Subscribe</button>
<button onClick={() => customerPortal()}>Manage Billing</button>
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

# Generate UI components
npx stripe-no-webhooks generate pricing-page
npx stripe-no-webhooks generate pricing-page --output src/components/Pricing.tsx
```
