import type { BillingConfig } from "stripe-no-webhooks";

const billingConfig: BillingConfig = {
  /*
    plans: [
      {
        name: "Premium",
        description: "Access to all features",
        price: 3000, // in cents 3000 = $30.00
        interval: "month",
        currency: "USD",
      },
    ],
  */
};

export default billingConfig;
