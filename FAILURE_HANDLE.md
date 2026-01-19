# Payment Failure Handling

This document outlines failure modes in the credit top-up system and the implemented solutions.

## Summary

| Problem | Status | Solution |
|---------|--------|----------|
| 1. Recovery checkout doesn't save payment method | ✅ Implemented | Add `setup_future_usage`, update default in webhook |
| 2. No way to proactively update payment method | ✅ Already solved | Use Stripe Customer Portal (`manageSubscription()`) |
| 3. No auto top-up cooldown after failure | ✅ Implemented | Failure tracking, hard/soft classification, 24h cooldown |

---

## Problem 1: Recovery Checkout Doesn't Save Payment Method

### Current Behavior

When on-demand `topUp()` fails due to a card decline, we return a `recoveryUrl` pointing to a Stripe Checkout session. The user completes checkout with a new card, credits are granted, but:

- The new card is **not saved** for future use
- The old (failing) card remains the customer's default
- Next `topUp()` call will fail again with the same card

### Root Cause

The recovery checkout is created with `mode: "payment"` but without `setup_future_usage`:

```typescript
const session = await stripe.checkout.sessions.create({
  customer: customerId,
  mode: "payment",
  payment_method_types: ["card"],
  // Missing: payment_intent_data.setup_future_usage
});
```

### Implemented Solution

**Step 1:** Added `setup_future_usage` to checkout creation:

```typescript
const session = await stripe.checkout.sessions.create({
  customer: customerId,
  mode: "payment",
  payment_method_types: ["card"],
  payment_intent_data: {
    setup_future_usage: "off_session",
  },
  // ... rest
});
```

**Step 2:** Update default payment method in webhook handler:

```typescript
// In handleTopUpCheckoutCompleted()
if (session.payment_intent && session.customer) {
  const paymentIntent = await stripe.paymentIntents.retrieve(
    session.payment_intent as string
  );
  if (paymentIntent.payment_method) {
    await stripe.customers.update(session.customer as string, {
      invoice_settings: {
        default_payment_method: paymentIntent.payment_method as string,
      },
    });
  }
}
```

### B2B Mode Note

For B2B (invoice-based), businesses typically load funds rather than change cards. The soft decline cooldown handles this - after 24 hours, the next `consume()` will retry and likely succeed once funds are available.

---

## Problem 2: No Way to Proactively Update Payment Method

### Current Behavior

Users cannot update their payment method until a payment fails and they receive a `recoveryUrl`. There's no proactive path.

### Solution: Use Stripe Customer Portal

The portal already exists and handles this:

```typescript
// Frontend client
await billingClient.manageSubscription();

// Or backend
const session = await stripe.billingPortal.sessions.create({
  customer: customerId,
  return_url: returnUrl,
});
// Redirect to session.url
```

The portal allows users to:
- Add new payment methods
- Remove old payment methods
- Set a default payment method
- View billing history

### Configuration

Configure portal features in Stripe Dashboard → Settings → Billing → Customer Portal:
- Enable/disable subscription management
- Enable/disable invoice history
- Customize branding

### Documentation Needed

Make it clear in user-facing docs that `manageSubscription()` / portal is the way to:
- Update payment method proactively
- Add backup payment methods
- Fix billing issues before they cause failures

### Additional: Stripe Automatic Card Updater

Enable in Stripe Dashboard. When banks issue replacement cards (same account, new number), Stripe automatically updates the stored payment method. Handles most "card expired" cases with zero user friction.

---

## Problem 3: No Auto Top-Up Cooldown After Failure

### Current Behavior

When auto top-up fails, every subsequent `consume()` call triggers another payment attempt. There's no cooldown, no backoff, and no distinction between failure types.

**Consequences:**
- Card networks (Visa/Mastercard) have retry limits - violations result in fines
- Banks flag repeated declines as potential fraud
- Customer's card could get blocked entirely
- Stripe tracks merchant decline rates (affects standing)
- Customer might receive dozens of "payment failed" notifications

### Decline Classification

Source: [Stripe Decline Codes Documentation](https://docs.stripe.com/declines/codes)

**Hard Declines (stop immediately, card is unusable):**
- `expired_card` - card has expired
- `stolen_card`, `lost_card`, `pickup_card` - card reported lost/stolen
- `fraudulent` - flagged as potentially fraudulent
- `invalid_account` - card or account is invalid
- `restricted_card` - card cannot be used for this transaction
- `invalid_cvc`, `incorrect_cvc` - for stored cards, indicates bad card data
- `invalid_number`, `incorrect_number` - for stored cards, indicates bad card data

**Soft Declines (temporary, might succeed later):**
- `insufficient_funds` - not enough balance
- `card_velocity_exceeded` - spending limits exceeded
- `withdrawal_count_limit_exceeded` - transaction count limit
- `authentication_required` - needs 3D Secure verification
- `issuer_not_available` - issuer couldn't be contacted
- `processing_error` - temporary processing issue
- `try_again_later` - temporary rejection
- `do_not_honor` - unspecified reason (treat as soft)
- `generic_decline` - unknown reason (treat as soft, escalate after 3 failures)
- `call_issuer` - unspecified, contact issuer
- `duplicate_transaction` - recent identical transaction detected

**Default behavior:** Unknown decline codes → treat as soft.

### Implemented Solution

#### 1. Failure State Tracking

New table (separate from `stripe.customers` which is a sync table):

```sql
CREATE TABLE stripe.topup_failures (
  user_id TEXT NOT NULL,
  credit_type TEXT NOT NULL,
  payment_method_id TEXT,
  decline_type TEXT NOT NULL,        -- 'hard' or 'soft'
  decline_code TEXT,
  failure_count INTEGER DEFAULT 1,
  last_failure_at TIMESTAMPTZ DEFAULT NOW(),
  disabled BOOLEAN DEFAULT FALSE,
  PRIMARY KEY (user_id, credit_type)
);
```

#### 2. Retry Strategy

**Hard decline:**
- Set `disabled = true`
- No more attempts until payment method changes
- Fire callback with `status: "action_required"`

**Soft decline:**
- Set `disabled = true` with 24-hour cooldown
- After 24 hours, next `consume()` can retry
- After 3 soft declines, escalate to permanent block (same as hard decline)

#### 3. Recovery URL Endpoint

**Problem:** Stripe portal session URLs expire quickly. Can't pass them in callbacks for emails.

**Solution:** Added a new handler endpoint that generates a fresh portal URL on click:

```typescript
// GET /api/stripe/recovery?userId=xxx
// Generates fresh portal session and redirects
```

Library users include this URL in emails - it never expires because the portal session is created at click time.

#### 4. Callback API

```typescript
onAutoTopUpFailed?: (params: {
  userId: string;
  stripeCustomerId: string;
  creditType: string;

  trigger: AutoTopUpFailedTrigger;
  status: "will_retry" | "action_required";
  nextAttemptAt?: Date;

  failureCount: number;
  stripeDeclineCode?: string;
}) => void | Promise<void>;
```

**Trigger values:**

| Trigger | Description |
|---------|-------------|
| `stripe_declined_payment` | We charged, Stripe said no |
| `waiting_for_retry_cooldown` | In 24h cooldown, will retry after `nextAttemptAt` |
| `blocked_until_card_updated` | Permanently blocked, customer must update card |
| `no_payment_method` | No card on file |
| `monthly_limit_reached` | Hit max auto top-ups this month |
| `unexpected_error` | Unexpected error (network, code bug, etc.) |

**Status values:**

| Status | Meaning |
|--------|---------|
| `will_retry` | Temporary issue, we'll retry automatically |
| `action_required` | Customer must take action (update payment method) |

**Example usage:**

```typescript
onAutoTopUpFailed: async (params) => {
  const recoveryUrl = `${APP_URL}/api/stripe/recovery?userId=${params.userId}`;

  switch (params.trigger) {
    case "stripe_declined_payment":
      if (params.status === "action_required") {
        await sendEmail(params.userId, "Urgent: Update your payment method", { recoveryUrl });
      } else {
        await sendEmail(params.userId, "Payment failed - we'll retry automatically", { recoveryUrl });
      }
      break;

    case "waiting_for_retry_cooldown":
      // Just log, don't spam customer
      console.log(`Skipped auto top-up (cooldown) for ${params.userId}`);
      break;

    case "blocked_until_card_updated":
      // Maybe send weekly reminder
      break;
  }
}
```

#### 5. Re-enablement

| Trigger | How |
|---------|-----|
| Payment method changes | Webhook detects new `default_payment_method` different from `payment_method_id` in failure record |
| Successful payment | Webhook: `payment_intent.succeeded` or `invoice.paid` clears failure state |
| Manual reset | `billing.credits.resetTopUpFailure(userId, creditType)` |

#### 6. Manual Reset API

```typescript
// Reset failure for specific credit type
await billing.credits.resetTopUpFailure(userId, creditType);

// Reset all failures for user
await billing.credits.resetAllTopUpFailures(userId);

// Get current failure record
const failure = await billing.credits.getTopUpFailure(userId, creditType);
```

---

## PROGRESS

### Implementation Status

| Item | Status | Files Modified |
|------|--------|----------------|
| `topup_failures` table | ✅ Done | `bin/commands/migrate.js`, DB created via Neon |
| Problem 1: Recovery checkout saves payment method | ✅ Done | `src/credits/topup.ts` |
| Problem 3: Failure tracking & cooldown | ✅ Done | `src/credits/topup.ts`, `src/credits/db.ts` |
| `/recovery` endpoint | ✅ Done | `src/Billing.ts` |
| Callback API redesign | ✅ Done | `src/credits/topup.ts`, `src/types.ts`, `src/Billing.ts` |
| Clear failure on payment success | ✅ Done | `src/credits/topup.ts` (3 handlers) |
| Manual reset API | ✅ Done | `src/credits/db.ts`, `src/credits/index.ts`, `src/Billing.ts` |
| Callback fires on cooldown/disabled | ✅ Done | `src/credits/topup.ts` |

### Code Changes Summary

**`src/credits/topup.ts`:**
- Added `HARD_DECLINE_CODES` and `SOFT_DECLINE_CODES` sets
- Added `classifyDeclineCode()` helper
- Added `setup_future_usage: "off_session"` to recovery checkout
- `handleTopUpCheckoutCompleted`: Updates default payment method from PaymentIntent
- `handlePaymentIntentSucceeded`: Clears failure record on success
- `handleInvoicePaid`: Clears failure record on success, updates default payment method (B2B recovery)
- `handleCustomerUpdated`: Clears failure record when payment method changes
- `triggerAutoTopUpIfNeeded`: Full failure tracking with cooldown logic, idempotency key includes payment method suffix
- New type `AutoTopUpFailedTrigger` with descriptive trigger values
- New callback params: `AutoTopUpFailedCallbackParams` with `stripeCustomerId`, `trigger`, `status`, `nextAttemptAt`, `failureCount`, `stripeDeclineCode`

**`src/credits/db.ts`:**
- Added `TopUpFailureRecord` type
- Added `getTopUpFailure(userId, creditType)`
- Added `recordTopUpFailure(params)`
- Added `clearTopUpFailure(userId, creditType)`
- Added `clearAllTopUpFailuresForUser(userId)`

**`src/credits/index.ts`:**
- Exports: `resetTopUpFailure`, `resetAllTopUpFailures`, `getTopUpFailure`

**`src/Billing.ts`:**
- Added `/recovery` GET endpoint (generates fresh portal URL)
- Credits API exposes: `resetTopUpFailure`, `resetAllTopUpFailures`, `getTopUpFailure`
- Updated callback type to use `AutoTopUpFailedCallbackParams`

**`src/types.ts`:**
- Updated `onAutoTopUpFailed` to use `AutoTopUpFailedCallbackParams`

**`src/handlers/webhook.ts`:**
- Added `customer.updated` event handler to clear failures on payment method change

**`src/templates/app-router.ts`:**
- Added `GET` export for recovery endpoint support

**`src/templates/pages-router.ts`:**
- Fixed to not include body for GET requests

**`bin/commands/migrate.js`:**
- Added `stripe.topup_failures` table creation

### Testing Completed

**Test setup:**
- Neon project: `gentle-glade-02710402` (snw-test)
- Test customer: `cus_TnrVVJua556CZ1`
- Test user: `user_38LYpQt1RmjfDTMZ3jJrplqnCtQ`

**Tested scenarios:**

| Test | Result | Output |
|------|--------|--------|
| Auto top-up success with valid card | ✅ Pass | Credits granted |
| First soft decline (`insufficient_funds`) | ✅ Pass | `trigger: stripe_declined_payment`, `status: will_retry`, `failureCount: 1` |
| Consume during cooldown | ✅ Pass | `trigger: waiting_for_retry_cooldown`, `status: will_retry`, `nextAttemptAt: <24h>` |
| Second soft decline after cooldown | ✅ Pass | `trigger: stripe_declined_payment`, `status: will_retry`, `failureCount: 2` |
| Third soft decline (escalation) | ✅ Pass | `trigger: stripe_declined_payment`, `status: action_required`, `failureCount: 3` |
| Consume when permanently blocked | ✅ Pass | `trigger: blocked_until_card_updated`, `status: action_required` |
| Recovery endpoint redirect | ✅ Pass | `/api/stripe/recovery?userId=xxx` redirects to Stripe Customer Portal |
| Re-enablement on payment method change | ✅ Pass | `customer.updated` webhook clears failure record automatically |
| Hard decline (`lost_card`) | ✅ Pass | `status: action_required` on first failure, no 24h cooldown |
| Subsequent consume after hard decline | ✅ Pass | `trigger: blocked_until_card_updated` |
| Recovery → update card → auto top-up succeeds | ✅ Pass | Failure cleared, new card charged, credits granted |

**Sample callback output (first failure):**
```
=== AUTO TOP-UP FAILED ===
Trigger: stripe_declined_payment
Status: will_retry
User: user_38LYpQt1RmjfDTMZ3jJrplqnCtQ
Stripe Customer: cus_TnrVVJua556CZ1
Failure count: 1
Stripe decline code: insufficient_funds
Next attempt at: 2026-01-17T17:24:35.292Z
==========================
```

**Sample callback output (permanently blocked):**
```
=== AUTO TOP-UP FAILED ===
Trigger: blocked_until_card_updated
Status: action_required
User: user_38LYpQt1RmjfDTMZ3jJrplqnCtQ
Stripe Customer: cus_TnrVVJua556CZ1
Failure count: 3
Stripe decline code: insufficient_funds
==========================
```

**Test app callback config (`~/work/snw-test/lib/billing.ts`):**
```typescript
callbacks: {
  onAutoTopUpFailed: (params) => {
    console.log("=== AUTO TOP-UP FAILED ===");
    console.log("Trigger:", params.trigger);
    console.log("Status:", params.status);
    console.log("User:", params.userId);
    console.log("Stripe Customer:", params.stripeCustomerId);
    console.log("Failure count:", params.failureCount);
    if (params.stripeDeclineCode) {
      console.log("Stripe decline code:", params.stripeDeclineCode);
    }
    if (params.nextAttemptAt) {
      console.log("Next attempt at:", params.nextAttemptAt);
    }
    console.log("==========================");
  },
},
```

### Not Yet Tested

**Auto top-up scenarios:**
- [x] Hard decline (`lost_card`) → permanent disable on first failure ✅
- [x] Re-enablement after recovery → payment method change clears failure, auto top-up succeeds ✅
- [x] B2B (Invoice mode) soft decline → `status: will_retry`, failure recorded ✅
- [x] B2B recovery → update payment method via portal, auto top-up succeeds ✅

**On-demand top-up scenarios (B2C - PaymentIntent mode):**
- [ ] On-demand `topUp()` with failing card → returns `recoveryUrl`
- [ ] Recovery checkout completes → credits granted, new card saved as default

**On-demand top-up scenarios (B2B - Invoice mode):**
- [ ] On-demand `topUp()` with failing card → returns hosted invoice URL
- [ ] Invoice paid → credits granted, new card saved as default

**Management APIs:**
- [ ] Manual reset via `billing.credits.resetTopUpFailure()`
- [ ] Manual reset all via `billing.credits.resetAllTopUpFailures()`
- [ ] Get failure status via `billing.credits.getTopUpFailure()`

### How to Resume Testing

1. Build and link the library:
   ```bash
   cd ~/work/stripe-no-webhooks
   npm run build && npm link
   ```

2. Start webhook listener:
   ```bash
   stripe listen --forward-to localhost:3000/api/stripe/webhook
   ```

3. Start test app:
   ```bash
   cd ~/work/snw-test
   npm run dev
   ```

4. To test hard decline, update customer payment method in DB:
   ```sql
   UPDATE stripe.customers
   SET invoice_settings = jsonb_set(invoice_settings, '{default_payment_method}', '"pm_card_visa_chargeDeclinedExpiredCard"')
   WHERE id = 'cus_TnrVVJua556CZ1';
   ```

5. To clear failures for fresh test:
   ```sql
   DELETE FROM stripe.topup_failures;
   ```

6. Check failure records:
   ```sql
   SELECT * FROM stripe.topup_failures;
   ```

### Stripe Test Payment Methods

| Card | Decline Code | Type |
|------|--------------|------|
| `pm_card_visa_chargeDeclinedInsufficientFunds` | `insufficient_funds` | Soft |
| `pm_card_visa_chargeDeclinedExpiredCard` | `expired_card` | Hard |
| `pm_card_visa_chargeDeclinedFraudulent` | `fraudulent` | Hard |
| `pm_card_visa_chargeDeclinedGenericDecline` | `generic_decline` | Soft |
