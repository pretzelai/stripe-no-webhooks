import { defineConfig } from "stripe-no-webhooks";

export default defineConfig({
  test: {
    plans: [
      // // Example plan with monthly and yearly pricing:
      // {
      //   name: "Pro",
      //   description: "Access to all features",
      //   price: [
      //     { amount: 2000, currency: "usd", interval: "month" }, // $20/mo
      //     { amount: 20000, currency: "usd", interval: "year" }, // $200/yr (17% savings)
      //   ],
      //   // Optional: credits renew each billing cycle
      //   // Yearly subscribers get 12x monthly allocation upfront
      //   features: {
      //     api_calls: {
      //       credits: { allocation: 1000 }, // 1000/mo or 12000/yr
      //       displayName: "API Calls",
      //     },
      //   },
      // },
    ],
  },
  production: {
    plans: [],
  },
});
