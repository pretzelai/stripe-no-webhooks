# stripe-no-webhooks

Opinionated & Open Source library that automatically syncs Stripe to your database and gives you useful helpers to implement subscriptions.

## Why this library?

Stripe documentation lacks the ability to clearly point you to an easy way to implement Stripe. Depending on what you google you might end up in a weird place and shoot yourself in the foot.

## Setup

### 1. Install

```bash
npm install stripe-no-webhooks stripe
```

Note: make sure you also have `.env` or `.env.local` in your project so it can save the generated secrets there.

### 2. Create tables where all Stripe data will be automatically synced

```bash
npx stripe-no-webhooks migrate postgresql://postgres.[USER]:[PASSWORD]@[DB_URL]/postgres
```

### 3. Run `config` to generate files & webhook

```bash
npx stripe-no-webhooks config
```

### 4. Create your plans

```javascript
// billing.config.ts (automatically created during config)
import type { BillingConfig } from "stripe-no-webhooks";
const billingConfig: BillingConfig = {
  test: {
    plans: [
      {
        name: "Premium",
        description: "Access to all features",
        price: [
          {
            amount: 1000, // $10
            currency: "usd",
            interval: "month",
          },
          {
            amount: 10000, // $100
            currency: "usd",
            interval: "year",
          },
        ],
      },
    ],
  },
};
export default billingConfig;
```

Run sync:

```bash
npx stripe-no-webhooks sync
```

### 5. Implement a checkout button in your frontend:

```javascript
"use client";
import { checkout } from "stripe-no-webhooks/client";

export default function Home() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <button
        className="bg-blue-500 text-white px-4 py-2 rounded-md cursor-pointer"
        onClick={() =>
          checkout({
            planName: "Premium",
            interval: "month",
          })
        }
      >
        Checkout
      </button>
    </div>
  );
}
```
