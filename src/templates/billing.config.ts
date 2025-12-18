import type { BillingConfig } from "stripe-no-webhooks";

const billingConfig: BillingConfig = {
  /*
    plans: [
      {
        name: "Premium",
        description: "Access to all features",
        price: [
          {
            amount: 1000, // in cents, 1000 = $10.00
            currency: "usd",
            interval: "month",
          },
          {
            amount: 10000, // in cents, 10000 = $100.00
            currency: "usd",
            interval: "year",
          },
        ],
      },
    ],
  */
};

export default billingConfig;
