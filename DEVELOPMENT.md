# Local Development

## Testing in a Next.js app

`npm link` doesn't work well with Next.js and subpath exports (e.g., `stripe-no-webhooks/client`). Use `npm pack` instead:

```bash
# 1. Build and pack the library
cd /path/to/stripe-no-webhooks
npm run build && npm pack

# 2. Install the tarball in your test app
cd /path/to/your-test-app
npm install ../stripe-no-webhooks/stripe-no-webhooks-0.0.9.tgz
```

To test changes, repeat both steps (rebuild, repack, reinstall).

## CLI testing

```bash
cd /path/to/your-test-app
stripe-no-webhooks config
```

## Running tests inside stripe-no-webhooks repository
```bash
npm run test:db:up
npm run test
```

## Testing Payment Failure Flows

### Prerequisites

1. Stripe CLI logged in: `stripe login`
2. Webhook forwarding running: `stripe listen --forward-to localhost:3000/api/stripe/webhook`
3. Test app running: `cd ~/work/snw-test && npm run dev`

### B2C Mode (PaymentIntent-based)

B2C mode is the default. Top-ups use `paymentIntents.create()` directly.

**To test:**

1. Update the customer's payment method in your local DB to a failing card:
   ```sql
   UPDATE stripe.customers
   SET invoice_settings = jsonb_set(invoice_settings::jsonb, '{default_payment_method}', '"pm_card_chargeCustomerFail"')
   WHERE id = 'cus_xxx';
   ```

2. Trigger a consume that causes auto top-up → should fail with soft decline

### B2B Mode (Invoice-based)

B2B mode is enabled when `tax.automaticTax` or `tax.taxIdCollection` is set in `Billing` config.

**Enable B2B mode in test app (`lib/billing.ts`):**
```typescript
export const billing = new Billing({
  billingConfig,
  tax: {
    automaticTax: true,
    taxIdCollection: true,
  },
});
```

**To test:**

B2B mode uses `invoices.pay()` which charges the customer's default payment method **on Stripe's side**, not from local DB. You must update the actual Stripe customer:

1. Attach a failing test card to the customer:
   ```bash
   stripe payment_methods attach pm_card_chargeCustomerFail --customer cus_xxx
   ```

2. Set it as default:
   ```bash
   stripe customers update cus_xxx -d "invoice_settings[default_payment_method]=pm_xxx"
   ```

3. Also update local DB to match:
   ```sql
   UPDATE stripe.customers
   SET invoice_settings = jsonb_set(invoice_settings::jsonb, '{default_payment_method}', '"pm_xxx"')
   WHERE id = 'cus_xxx';
   ```

4. Trigger a consume that causes auto top-up → should fail

### Test Cards

| Token | Behavior | Decline Type |
|-------|----------|--------------|
| `pm_card_chargeCustomerFail` | Fails on charge, attaches OK | Soft (`generic_decline`) |
| `pm_card_visa_chargeDeclinedInsufficientFunds` | Fails on charge | Soft |
| `pm_card_visa_chargeDeclinedLostCard` | Fails on attach AND charge | Hard |

Note: Cards like `pm_card_visa_chargeDeclinedLostCard` fail even when attaching, so use `pm_card_chargeCustomerFail` for most tests.

### Testing Recovery Flow

1. After a failure, get the recovery URL:
   ```
   GET http://localhost:3000/api/stripe/recovery?userId=user_xxx
   ```

2. This redirects to Stripe Customer Portal where user can update payment method

3. After updating, `customer.updated` webhook fires and clears the failure record

4. Next consume → auto top-up should succeed

### Useful SQL Queries

```sql
-- Check failure records
SELECT * FROM stripe.topup_failures;

-- Clear all failures (for fresh test)
DELETE FROM stripe.topup_failures;

-- Check customer's payment method
SELECT id, invoice_settings->>'default_payment_method' as pm
FROM stripe.customers WHERE id = 'cus_xxx';