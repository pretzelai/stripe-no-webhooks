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
const stripe = createStripeHandler({ billingConfig });

const result = await stripe.credits.consume({
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
const balance = await stripe.credits.getBalance("user_123", "api_calls");
const allBalances = await stripe.credits.getAllBalances("user_123");
const hasEnough = await stripe.credits.hasCredits("user_123", "api_calls", 10);
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
const result = await stripe.credits.topUp({
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

Auto top-up triggers automatically when using `stripe.credits.consume()`.

## Callbacks

```typescript
const stripe = createStripeHandler({
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
