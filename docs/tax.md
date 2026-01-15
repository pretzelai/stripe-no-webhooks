# Tax Configuration

This guide covers automatic tax calculation with Stripe Tax.

## Do You Need Tax Collection?

**You likely need tax collection if:**

- You're selling to customers in the EU, UK, Australia, Canada, or US states with sales tax
- Your business has crossed revenue thresholds that require tax registration
- You're selling to businesses who need VAT/GST invoices

**You can skip tax collection if:**

- You're only selling to customers in regions where you're not required to collect tax
- Your revenue is below tax registration thresholds
- You're handling tax calculation/filing separately

> **Not sure?** Consult a tax professional or check [Stripe's tax documentation](https://docs.stripe.com/tax).

## Pricing Impact

Enabling tax adds Stripe fees:

| Feature          | Fee                   | When charged                                            |
| ---------------- | --------------------- | ------------------------------------------------------- |
| Stripe Tax       | 0.5% of transaction   | Only in regions where you're registered                 |
| Stripe Invoicing | ~0.4-0.5% per invoice | When tax is enabled (invoices required for tax records) |

**No tax config = no extra fees.** If you don't need tax calculation, simply don't add the `tax` config.

## Quick Start

### 1. Add tax config

```typescript
const billing = new Billing({
  billingConfig,
  tax: {
    automaticTax: true,
  },
});
```

### 2. Set up Stripe Dashboard

Before tax calculation works, you must:

1. **Enable Stripe Tax**: [Dashboard → Settings → Tax](https://dashboard.stripe.com/settings/tax)
2. **Add tax registrations**:
   - Follow the instructions in the dashboard to add tax registrations
   - Add each country/region where you're registered to collect tax
   - Without a registration, tax shows as $0 for that region
3. **Set business address**: Dashboard → Settings → Business details

That's it! Customers will now see tax calculated at checkout based on their location in their invoices.

## Configuration Options

Choose the setup that matches your business:

### No Tax (Default)

```typescript
const billing = new Billing({
  billingConfig,
  // No tax config
});
```

- No tax calculation
- Credit top-ups use `PaymentIntent` (cheapest, no additional fees for invoice creation)
- Top-ups won't appear in Stripe Customer Portal (your users can see the link for this portal in the `PricingPage` component - it's called "Manage Subscription")
- **Best for:** Apps where you don't need to collect tax

### B2C with Tax

```typescript
const billing = new Billing({
  billingConfig,
  tax: {
    automaticTax: true,
  },
});
```

- Tax calculated based on customer location
- Credit top-ups use Invoices (required for tax records, invoices cost ~0.4-0.5% of the invoice amount)
- Top-ups appear in Customer Portal invoice history
- **Best for:** Consumer apps where you need to collect sales tax/VAT

### B2B with Tax IDs

```typescript
const billing = new Billing({
  billingConfig,
  tax: {
    automaticTax: true,
    taxIdCollection: true,
    billingAddressCollection: "required",
  },
});
```

Everything in B2C, plus:

- Customers can enter their business tax ID (VAT, GST, EIN, etc.)
- Valid tax IDs enable reverse charge for cross-border EU transactions
- Tax IDs appear on invoices
- **Best for:** SaaS selling to businesses

## How Tax Calculation Works

1. **Customer enters address** at checkout (collected automatically when tax is enabled)
2. **Stripe calculates tax** based on:
   - Your tax registrations
   - Customer's location
   - Product type
3. **Tax is applied:**
   - **Consumers** → Standard tax rate (e.g., 19% in Germany, sales tax in the US)
   - **Businesses with tax ID (cross-border)** → Reverse charge (0% tax, buyer handles tax)
   - **Businesses with tax ID (same country)** → Standard tax rate still applies

> **Important:** Reverse charge only applies to cross-border B2B within regions like the EU. If your business and customer are both in Germany, VAT is charged even if they have a valid tax ID.

### Why Tax Requires Invoices

When you enable `automaticTax`, `stripe-no-webhooks` automatically uses Stripe Invoices instead of `PaymentIntents` for credit top-ups. This is because:

- **You** need invoices with tax breakdown for tax reporting and accounting
- **Customers** need receipts showing the tax they paid
- `PaymentIntents` don't support automatic tax calculation

This happens automatically—no extra configuration needed.

## Customer Portal

Customers can manage their billing information in Stripe's Customer Portal:

```tsx
import { customerPortal } from "stripe-no-webhooks/client";

<button onClick={() => customerPortal()}>Manage Billing</button>;
```

This link also appears in the `PricingPage` component (see the [README](../README.md) under the section "Build Your Pricing Page UI" for more details) by default.

To enable tax-related features, configure in [Stripe Dashboard → Customer Portal](https://dashboard.stripe.com/settings/billing/portal):

- **Billing address** - Let customers update their address
- **Tax IDs** - Let customers add/remove tax IDs (if `taxIdCollection` enabled)

## Testing

### Test tax calculation

1. Add a test tax registration in [Stripe Dashboard](https://dashboard.stripe.com/test/settings/tax/registrations) (e.g., Germany)
2. Complete checkout with an address in that region
3. Verify tax is calculated (e.g., 19% for Germany)

### Test tax IDs

| Type   | Valid         | Invalid       |
| ------ | ------------- | ------------- |
| EU VAT | `DE123456789` | `DE000000000` |
| UK VAT | `GB123456789` | `GB000000000` |

See [Stripe's test tax IDs](https://docs.stripe.com/billing/customer/tax-ids#test-tax-ids) for more.

## Reference

### All Options

| Option                     | Type                     | Default  | Description                     |
| -------------------------- | ------------------------ | -------- | ------------------------------- |
| `automaticTax`             | `boolean`                | `false`  | Enable Stripe Tax               |
| `taxIdCollection`          | `boolean`                | `false`  | Let customers enter tax IDs     |
| `billingAddressCollection` | `'auto'` \| `'required'` | `'auto'` | When to collect billing address |
| `customerUpdate.address`   | `'auto'` \| `'never'`    | `'auto'` | Save address to customer record |
| `customerUpdate.name`      | `'auto'` \| `'never'`    | `'auto'` | Save name to customer record    |

### Supported Tax ID Types

- EU VAT (`eu_vat`)
- UK VAT (`gb_vat`)
- US EIN (`us_ein`)
- Australian ABN (`au_abn`)
- Canadian GST/HST (`ca_gst_hst`)
- [Full list](https://docs.stripe.com/billing/customer/tax-ids#supported-tax-id-types)

## Further Reading

- [Stripe Tax Overview](https://stripe.com/tax)
- [Stripe Tax Documentation](https://docs.stripe.com/tax)
