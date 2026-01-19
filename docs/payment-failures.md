# Handling Payment Failures

Payments fail. Cards expire, get lost, or run out of funds. This guide covers how to detect and recover from payment failures.

## Quick Reference

| Payment Type | How You Know | Recovery Path |
|--------------|--------------|---------------|
| Subscription renewal | `onSubscriptionPaymentFailed` callback | Customer Portal or hosted invoice URL |
| Auto top-up | `onAutoTopUpFailed` callback | Customer Portal |
| On-demand top-up | `topUp()` returns `recoveryUrl` | Redirect to `recoveryUrl` |

## Subscription Payment Failures

When a subscription renewal fails (card declined, expired, etc.), Stripe:
1. Sends automatic retry emails (configurable in Stripe Dashboard)
2. Retries the payment according to your dunning schedule
3. Eventually cancels the subscription if all retries fail

### Get Notified

```typescript
const billing = new Billing({
  billingConfig,
  callbacks: {
    onSubscriptionPaymentFailed: async (params) => {
      // params.willRetry: true if Stripe will retry, false if final attempt
      // params.attemptCount: which retry this is (1, 2, 3...)
      // params.nextPaymentAttempt: when Stripe will retry (null if final)

      if (!params.willRetry) {
        // Final attempt failed - subscription will be canceled
        await sendUrgentEmail(params.userId, "Update your payment method");
      }
    },
  },
});
```

### Check Status in Your UI

Show users when their subscription has payment issues:

```typescript
const status = await billing.subscriptions.getPaymentStatus(userId);

if (status.status === "past_due") {
  // Show warning banner
  // status.failedInvoice.hostedInvoiceUrl - direct link to pay
}
```

| Status | Meaning |
|--------|---------|
| `ok` | Payments current |
| `past_due` | Payment failed, Stripe is retrying |
| `unpaid` | All retries exhausted |
| `no_subscription` | No active subscription |

### Recovery Options

**Option 1: Customer Portal** - User updates their payment method, Stripe retries automatically.

```typescript
// Generate recovery URL for emails
const recoveryUrl = `${APP_URL}/api/stripe/recovery?userId=${userId}`;
```

**Option 2: Hosted Invoice URL** - User pays the specific failed invoice directly.

```typescript
const status = await billing.subscriptions.getPaymentStatus(userId);
const payUrl = status.failedInvoice?.hostedInvoiceUrl;
```

### Configure Dunning in Stripe

Go to **Stripe Dashboard → Settings → Billing → Subscriptions and emails → Manage failed payments** to configure:
- Number of retry attempts
- Time between retries
- What happens after all retries fail (cancel, mark unpaid, etc.)
- Automatic customer emails

## On-Demand Top-Up Failures

When you call `topUp()` and the payment fails:

```typescript
const result = await billing.credits.topUp({
  userId,
  creditType: "api_calls",
  amount: 500,
});

if (!result.success && result.error?.recoveryUrl) {
  // Redirect user to Stripe Checkout to enter a new card
  return redirect(result.error.recoveryUrl);
}
```

The `recoveryUrl` takes the user to a Stripe Checkout page where they can:
1. Enter a new card
2. Complete the purchase
3. The new card is saved as their default for future payments

## Auto Top-Up Failures

Auto top-ups happen automatically when credits drop below a threshold. If the payment fails, the library:

1. **Tracks failures** - Distinguishes between temporary issues (insufficient funds) and permanent ones (card expired)
2. **Applies cooldowns** - Waits 24 hours before retrying soft declines to avoid hammering the card
3. **Blocks after 3 failures** - Stops retrying until the user updates their payment method
4. **Notifies you** - Fires `onAutoTopUpFailed` callback

### Why This Matters

Without failure handling, a declined card would trigger a payment attempt on every API call. This causes:
- Card network violations (Visa/Mastercard have retry limits)
- Potential fraud flags on the customer's card
- Dozens of "payment failed" notifications to your user

### Get Notified

```typescript
const billing = new Billing({
  billingConfig,
  callbacks: {
    onAutoTopUpFailed: async (params) => {
      const recoveryUrl = `${APP_URL}/api/stripe/recovery?userId=${params.userId}`;

      switch (params.trigger) {
        case "stripe_declined_payment":
          // Payment was attempted and declined
          if (params.status === "action_required") {
            // Hard decline (expired, lost card) - user must update payment method
            await sendEmail(params.userId, "Update your payment method", { recoveryUrl });
          } else {
            // Soft decline (insufficient funds) - we'll retry in 24h
            // Maybe just log, don't spam the user
          }
          break;

        case "blocked_until_card_updated":
          // Too many failures - auto top-up disabled until card is updated
          await sendEmail(params.userId, "Auto top-up paused", { recoveryUrl });
          break;

        case "waiting_for_retry_cooldown":
          // In 24h cooldown period - just log, don't notify user
          break;

        case "no_payment_method":
          // No card on file
          break;

        case "monthly_limit_reached":
          // Hit maxPerMonth config limit - not a payment failure
          break;
      }
    },
  },
});
```

### Trigger Values

| Trigger | What Happened |
|---------|---------------|
| `stripe_declined_payment` | Payment attempted and declined |
| `waiting_for_retry_cooldown` | In 24h cooldown, will retry later |
| `blocked_until_card_updated` | Too many failures, user must update card |
| `no_payment_method` | No card on file |
| `monthly_limit_reached` | Hit `maxPerMonth` limit |

### Status Values

| Status | Meaning |
|--------|---------|
| `will_retry` | Temporary issue, will retry automatically |
| `action_required` | User must update payment method |

### Check and Reset Status

```typescript
// Check if auto top-up is blocked
const status = await billing.credits.getAutoTopUpStatus(userId, "api_calls");
if (status?.disabled) {
  // Show UI to update payment method
}

// Manually unblock (e.g., after user updates card via your own UI)
await billing.credits.unblockAutoTopUp(userId, "api_calls");
```

## Recovery Endpoint

The library includes a `/recovery` endpoint that generates a fresh Customer Portal link:

```
GET /api/stripe/recovery?userId=xxx
```

Use this in emails instead of pre-generating portal URLs (which expire quickly). When the user clicks, they get a fresh portal session.

## Best Practices

1. **Don't over-notify** - For soft declines with `will_retry`, consider just logging instead of emailing. The user likely knows their card is low on funds.

2. **Show status in your UI** - Use `getPaymentStatus()` and `getAutoTopUpStatus()` to show warnings before users hit issues.

3. **Use the Customer Portal** - It handles payment method updates, shows invoice history, and is maintained by Stripe.

4. **Configure Stripe's dunning** - Let Stripe handle subscription retries and automatic emails. Your callback is for custom logic on top of that.
