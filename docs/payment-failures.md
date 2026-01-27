# Handling Payment Failures

Payments fail all the time. Cards expire, banks decline transactions, users forget to update their payment info. This is normal, and the good news is: **Stripe handles most of the hard work for you**.

This guide explains what happens when payments fail, what Stripe takes care of automatically, and what (little) you need to do.

---

## The TL;DR

**For subscription payments**: Stripe automatically retries failed payments and emails your customers. You don't need to do anything unless you want custom notifications.

**For top-ups (credits/wallet)**: The library returns a recovery URL. Redirect users there to fix their payment method.

**For auto top-ups**: The library handles retry logic and blocks repeated failures automatically. Users fix it by updating their card in Customer Portal.

---

## Subscription Payment Failures

When a user's subscription renewal fails (e.g., their card expired), here's what happens:

### What Stripe Does Automatically

1. **Retries the payment** - Stripe will retry several times over days/weeks (configurable)
2. **Emails the customer** - "Your payment failed, please update your card"
3. **Marks subscription as `past_due`** - User still has access while Stripe retries
4. **Eventually cancels** - If all retries fail, subscription is canceled

You can configure all of this in **Stripe Dashboard → Settings → Billing → Manage failed payments**.

### What You Might Want to Do

Most apps don't need to do anything beyond Stripe's automatic handling. But if you want custom behavior:

```typescript
const billing = new Billing({
  billingConfig,
  callbacks: {
    onSubscriptionPaymentFailed: async (params) => {
      // Only notify on final failure (don't spam during retries)
      if (!params.willRetry) {
        await sendSlackAlert(`User ${params.userId} subscription failing`);
        // Or send a custom email, show an in-app banner, etc.
      }
    },
  },
});
```

**Practical tip**: Don't send emails on every failure—Stripe is already emailing them, and `willRetry: true` means Stripe will try again. Only act on `willRetry: false` (final attempt failed).

### Showing Payment Status in Your UI

If you want to show a warning banner like "Your payment failed - please update your card":

```typescript
const status = await billing.subscriptions.getPaymentStatus({ userId });

if (status.status === "past_due") {
  // Show a non-blocking warning
  // User can still use your app while Stripe retries
}

if (status.status === "unpaid") {
  // All retries exhausted - subscription will cancel soon
  // Show a more urgent warning
}
```

### How Users Can Fix It

Users update their payment method in the **Stripe Customer Portal**:

```typescript
import { customerPortal } from "stripe-no-webhooks/client";

// In your settings page
<button onClick={() => customerPortal()}>Manage Billing</button>
```

Once they update their card, Stripe automatically retries the failed payment. You don't need to do anything.

---

## On-Demand Top-Up Failures

When a user explicitly clicks "Buy more credits" or "Add funds to wallet" and the payment fails:

### What Happens

The `topUp()` function returns an error with a `recoveryUrl`. This URL takes them to a Stripe Checkout page where they can enter a new card and complete the purchase.

```typescript
// Credits
const result = await billing.credits.topUp({
  userId,
  key: "api_calls",
  amount: 500,
});

if (!result.success) {
  if (result.error?.recoveryUrl) {
    // Redirect them to fix their payment and complete the purchase
    redirect(result.error.recoveryUrl);
  } else {
    // Some other error (no subscription, invalid amount, etc.)
    showError(result.error.message);
  }
}
```

```typescript
// Wallet
const result = await billing.wallet.topUp({ userId, amount: 1000 });

if (!result.success && result.error?.recoveryUrl) {
  redirect(result.error.recoveryUrl);
}
```

### What the Recovery Flow Does

1. User lands on Stripe Checkout
2. They enter a new card
3. Payment completes
4. New card is saved as their default (so future payments work)
5. They're redirected back to your app
6. Credits/wallet balance is updated

**You don't need to handle any of this**—just redirect to the `recoveryUrl`.

---

## Auto Top-Up Failures

Auto top-ups happen in the background when a user's credit/wallet balance drops below a threshold. Since the user isn't actively clicking a button, failed payments need special handling.

### The Problem We Solve

If a user's card keeps failing and we keep retrying immediately, bad things happen:

- Card networks flag it as potential fraud
- The user's bank might block their card
- Stripe might flag your account

### What the Library Does Automatically

The library has smart retry logic built in:

| Failure Type                                           | What Happens                                     |
| ------------------------------------------------------ | ------------------------------------------------ |
| **Soft decline** (insufficient funds, temporary issue) | Waits 24 hours, then retries on next `consume()` |
| **Hard decline** (expired card, stolen card)           | Stops retrying until user updates their card     |
| **3 soft declines in a row**                           | Escalates to hard decline behavior               |

**This is automatic—you don't need to do anything.** Consider emailing users when their card fails, since otherwise they won't know (see below).

### Getting Notified

If you want to know when auto top-ups fail (e.g., to send a custom email or show an in-app alert):

```typescript
const billing = new Billing({
  billingConfig,
  callbacks: {
    // For credit auto top-ups
    onAutoTopUpFailed: async (params) => {
      if (params.status === "action_required") {
        // User needs to update their card - consider notifying them
        await sendEmail(
          params.userId,
          "Your auto top-up failed. Please update your payment method.",
        );
      }
      // "will_retry" means we'll try again in 24h - probably don't spam them
    },

    // For wallet auto top-ups
    onWalletAutoTopUpFailed: async (params) => {
      if (params.status === "action_required") {
        await sendEmail(
          params.userId,
          "Your auto top-up failed. Please update your payment method.",
        );
      }
    },
  },
});
```

**Practical tip**: Only notify on `action_required`. If status is `will_retry`, the library will automatically try again later—don't spam users about temporary issues.

### How Users Fix It

Same as subscription failures: they update their card in **Stripe Customer Portal**.

```typescript
<button onClick={() => customerPortal()}>Update Payment Method</button>
```

When they update their card, the library **automatically unblocks** auto top-ups. The next time they consume credits/wallet and drop below the threshold, auto top-up will work again.

### Checking Auto Top-Up Status (Optional)

For credits, you can check if auto top-up is blocked:

```typescript
const status = await billing.credits.getAutoTopUpStatus({
  userId,
  key: "api_calls",
});

if (status?.disabled) {
  // Show in your UI: "Auto top-up is paused. Update your payment method to resume."
}
```

This is optional—most apps just rely on the callback notifications.

---

## Summary: What You Actually Need to Do

| Scenario               | What Stripe/Library Handles                     | What You Might Do                                 |
| ---------------------- | ----------------------------------------------- | ------------------------------------------------- |
| **Subscription fails** | Retries, emails customer, eventually cancels    | Optionally: custom notifications, in-app warnings |
| **Top-up fails**       | Provides recovery URL                           | Redirect user to `recoveryUrl`                    |
| **Auto top-up fails**  | Smart retry logic, auto-unblocks on card update | Optionally: notify user when `action_required`    |

**The most important thing**: Make sure users can access Customer Portal to update their payment method. Everything else is handled for you.

```typescript
import { customerPortal } from "stripe-no-webhooks/client";

// Put this somewhere accessible in your app (settings page, billing page, etc.)
<button onClick={() => customerPortal()}>Manage Billing</button>
```
