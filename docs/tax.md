# Tax Collection

Automatic tax calculation with Stripe Tax.

## Do You Need This?

**You likely need tax collection if:**
- Selling to EU, UK, Australia, Canada, or US states with sales tax
- Revenue exceeds tax registration thresholds
- Selling to businesses who need VAT/GST invoices

**You can skip this if:**
- Only selling where you're not required to collect tax
- Below tax registration thresholds
- Handling tax separately

Not sure? Check [Stripe Tax docs](https://docs.stripe.com/tax) or consult a tax professional.

## Pricing

Enabling tax adds Stripe fees:

| Feature | Fee | When |
|---------|-----|------|
| Stripe Tax | 0.5% of transaction | Only in registered regions |
| Stripe Invoicing | ~0.4-0.5% per invoice | Required for tax records |

**No tax config = no extra fees.**

---

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

1. **Enable Stripe Tax**: [Dashboard → Settings → Tax](https://dashboard.stripe.com/settings/tax)
2. **Add tax registrations**: Add each country/region where you're registered
3. **Set business address**: Dashboard → Settings → Business details

That's it! Tax is calculated at checkout based on customer location.

---

## Configuration Options

### No Tax (Default)

```typescript
const billing = new Billing({
  billingConfig,
  // No tax config
});
```

- No tax calculation, no extra fees
- Best for apps where you don't need to collect tax

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
- Best for consumer apps with sales tax/VAT requirements

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

Everything above, plus:
- Customers can enter business tax IDs (VAT, GST, EIN)
- Valid tax IDs enable reverse charge for cross-border EU B2B
- Tax IDs appear on invoices
- Best for SaaS selling to businesses

---

## How Tax Works

1. **Customer enters address** at checkout
2. **Stripe calculates tax** based on your registrations + customer location
3. **Tax is applied:**
   - Consumers → Standard rate (19% Germany, sales tax US, etc.)
   - B2B cross-border with tax ID → Reverse charge (0%)
   - B2B same country with tax ID → Standard rate still applies

**Note:** Without a registration for a region, tax shows as $0.

---

## Testing

### Test tax calculation

1. Add test tax registration in [Stripe Dashboard](https://dashboard.stripe.com/test/settings/tax/registrations)
2. Complete checkout with address in that region
3. Verify tax is calculated

### Test tax IDs

| Type | Valid | Invalid |
|------|-------|---------|
| EU VAT | `DE123456789` | `DE000000000` |
| UK VAT | `GB123456789` | `GB000000000` |

See [Stripe test tax IDs](https://docs.stripe.com/billing/customer/tax-ids#test-tax-ids).

---

## Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `automaticTax` | `boolean` | `false` | Enable Stripe Tax |
| `taxIdCollection` | `boolean` | `false` | Let customers enter tax IDs |
| `billingAddressCollection` | `"auto"` \| `"required"` | `"auto"` | When to collect address |

### Customer Portal

Enable tax features in [Dashboard → Customer Portal](https://dashboard.stripe.com/settings/billing/portal):
- Billing address updates
- Tax ID management (if `taxIdCollection` enabled)

### Supported Tax ID Types

EU VAT, UK VAT, US EIN, Australian ABN, Canadian GST/HST, and [more](https://docs.stripe.com/billing/customer/tax-ids#supported-tax-id-types).
