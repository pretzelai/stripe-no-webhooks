# Tax & Business Billing

This guide covers how to enable tax calculation and collect business information (VAT, GST, etc.) at checkout.

## Overview

stripe-no-webhooks integrates with [Stripe Tax](https://stripe.com/tax) to automatically calculate and collect taxes. When enabled, customers see accurate tax amounts during checkout based on their location.

**What Stripe Tax provides:**
- Automatic tax calculation for 50+ countries
- Support for VAT, GST, sales tax, and other tax types
- Tax ID validation (VAT numbers, etc.)
- Tax-compliant invoices and receipts

**Pricing:** Stripe Tax costs 0.5% per transaction (on top of regular Stripe fees). See [Stripe Tax pricing](https://stripe.com/tax#pricing) for details.

## Quick Start

### Basic Tax Setup

Enable automatic tax calculation:

```typescript
const billing = new Billing({
  billingConfig,
  tax: {
    automaticTax: true,
  },
});
```

This enables:
- Tax calculated based on customer's billing address
- Billing address collection at checkout (required for tax calculation)

**Prerequisites:**
1. Enable Stripe Tax in your [Stripe Dashboard](https://dashboard.stripe.com/settings/tax)
2. Configure your tax registrations (countries where you're registered to collect tax)

### B2B / Company Billing

For business customers who need to provide tax IDs (VAT, GST, EIN, etc.):

```typescript
const billing = new Billing({
  billingConfig,
  tax: {
    automaticTax: true,
    taxIdCollection: true,
    billingAddressCollection: 'required',
  },
});
```

Customers can now:
- Enter their business tax ID at checkout
- See tax-exempt pricing when applicable (e.g., reverse charge for EU B2B)
- Manage tax IDs in the Customer Portal after purchase

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `automaticTax` | `boolean` | `false` | Enable Stripe Tax for automatic calculation |
| `billingAddressCollection` | `'auto'` \| `'required'` | `'auto'` when tax enabled | When to collect billing address |
| `taxIdCollection` | `boolean` | `false` | Let customers enter tax IDs (VAT, GST, etc.) |
| `customerUpdate.address` | `'auto'` \| `'never'` | `'auto'` | Save collected address to customer record |
| `customerUpdate.name` | `'auto'` \| `'never'` | `'auto'` | Save collected name to customer record |

### Option Details

#### `automaticTax`

When enabled, Stripe calculates tax based on:
- Your tax registrations (configured in Stripe Dashboard)
- Customer's billing address
- Product tax codes (if configured)

```typescript
tax: {
  automaticTax: true,
}
```

#### `billingAddressCollection`

Controls when billing address is collected at checkout:

- `'auto'` (default when tax enabled): Collect only when needed for tax calculation
- `'required'`: Always collect billing address, even if not needed for tax

```typescript
tax: {
  automaticTax: true,
  billingAddressCollection: 'required',  // Always collect
}
```

#### `taxIdCollection`

When enabled, customers can enter their business tax ID during checkout:

```typescript
tax: {
  taxIdCollection: true,
}
```

**Supported tax ID types include:**
- EU VAT numbers (`eu_vat`)
- UK VAT (`gb_vat`)
- US EIN (`us_ein`)
- Australian ABN (`au_abn`)
- Canadian GST/HST (`ca_gst_hst`)
- And [many more](https://docs.stripe.com/billing/customer/tax-ids#supported-tax-id-types)

#### `customerUpdate`

Controls whether collected information is saved to the Stripe customer record:

```typescript
tax: {
  automaticTax: true,
  customerUpdate: {
    address: 'auto',  // Save billing address to customer
    name: 'auto',     // Save name to customer
  },
}
```

This is enabled by default when collecting address or tax IDs, so future checkouts can pre-fill the information.

## Configuration Examples

### Individual Purchases (No Tax)

Default behavior - no tax calculation:

```typescript
const billing = new Billing({
  billingConfig,
});
```

### Individual Purchases with Tax

Tax calculated based on location:

```typescript
const billing = new Billing({
  billingConfig,
  tax: {
    automaticTax: true,
  },
});
```

### B2B with Tax IDs

Full business billing support:

```typescript
const billing = new Billing({
  billingConfig,
  tax: {
    automaticTax: true,
    billingAddressCollection: 'required',
    taxIdCollection: true,
  },
});
```

### Tax ID Collection Only (No Automatic Tax)

Collect tax IDs for invoicing, but calculate tax manually:

```typescript
const billing = new Billing({
  billingConfig,
  tax: {
    automaticTax: false,
    billingAddressCollection: 'required',
    taxIdCollection: true,
  },
});
```

## Managing Billing After Checkout

Customers can update their billing information via Stripe's Customer Portal:

```tsx
import { customerPortal } from "stripe-no-webhooks/client";

<button onClick={() => customerPortal()}>
  Manage Billing
</button>
```

### Enable Portal Features

Configure these features in your [Stripe Dashboard > Customer Portal settings](https://dashboard.stripe.com/settings/billing/portal):

1. **Customer information > Billing address** - Let customers update their address
2. **Customer information > Tax IDs** - Let customers add/remove tax IDs

Once enabled, customers can:
- Update their billing address
- Add new tax IDs
- Remove existing tax IDs
- View their invoice history

## How Tax Calculation Works

1. **At Checkout**: Customer enters billing address (collected automatically or via form)
2. **Tax Calculation**: Stripe determines applicable taxes based on:
   - Your tax registrations
   - Customer location
   - Product type
3. **Tax ID Validation**: If customer enters a tax ID, Stripe validates it
4. **Tax Application**:
   - Valid business tax ID in applicable region → May qualify for reverse charge (no tax)
   - Individual or invalid tax ID → Standard tax rates apply
5. **Invoice**: Tax details appear on the invoice/receipt

## Testing

### Test Tax Calculation

1. Enable Stripe Tax in test mode
2. Configure a test tax registration
3. Complete checkout with an address in that region
4. Verify tax amount is calculated

### Test Tax IDs

Use these test tax ID values:

| Type | Valid Test Value | Invalid Test Value |
|------|------------------|-------------------|
| EU VAT | `DE123456789` | `DE000000000` |
| UK VAT | `GB123456789` | `GB000000000` |

See [Stripe's test tax IDs](https://docs.stripe.com/billing/customer/tax-ids#test-tax-ids) for more.

## Further Reading

- [Stripe Tax Overview](https://stripe.com/tax)
- [Stripe Tax Documentation](https://docs.stripe.com/tax)
- [Supported Tax ID Types](https://docs.stripe.com/billing/customer/tax-ids#supported-tax-id-types)
- [Customer Portal Configuration](https://docs.stripe.com/customer-management/integrate-customer-portal)
