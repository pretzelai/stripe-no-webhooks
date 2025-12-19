# stripe-no-webhooks

Stripe integration without dealing with webhooks. Automatically syncs Stripe data to your PostgreSQL database and provides simple callbacks for subscription events.

## Installation

```bash
npm install stripe-no-webhooks stripe
```

## Setup

### 1. Create `.env` or `.env.local` file

If any of these files exist it will automatically save all the necessary secrets during the setup process.

### 2. Create Stripe schema and tables

This step is optional but highly recommended. This will allow `stripe-no-webhooks` to automatically sync all your Stripe data to your database (one of the main reasons we made this library!)

**Option 1:** Run the migration command

```bash
npx stripe-no-webhooks migrate postgresql://postgres.[USER]:[PASSWORD]@[DB_URL]/postgres
```

**Option 2:** Copy `stripe_schema.sql` and run the query manually

### 3. Run the stripe-no-webhooks config

```bash
npx stripe-no-webhooks config
```

The config setup will ask you for `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_SITE_URL`

What does `config` do?

- Creates a Stripe webhook pointing at `NEXT_PUBLIC_SITE_URL` and saves `STRIPE_WEBHOOK_SECRET` to your `.env` file
- Creates `billing.config.ts` at the root of your app
- Creates a catch all Stripe handler at `api/stripe/[...all]` (takes care of webhooks, creating checkout sessions and creating customer portal sessions)

##

All Stripe webhook events are automatically synced to your PostgreSQL database in the `stripe` schema. This includes:

- Customers
- Subscriptions
- Products
- Prices
- Invoices
- Payment methods
- And more...

You can query this data directly from your database without making API calls to Stripe.

## Callbacks

| Callback                  | Event                                                           | Description                               |
| ------------------------- | --------------------------------------------------------------- | ----------------------------------------- |
| `onSubscriptionCreated`   | `customer.subscription.created`                                 | Called when a new subscription is created |
| `onSubscriptionCancelled` | `customer.subscription.deleted` or status changes to `canceled` | Called when a subscription is cancelled   |

Both callbacks receive the full Stripe `Subscription` object.
