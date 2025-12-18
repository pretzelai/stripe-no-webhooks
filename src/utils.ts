export const getMode = (stripeKey: string) => {
  if (stripeKey.includes("_test_")) {
    return "test";
  } else if (stripeKey.includes("_live_")) {
    return "production";
  } else {
    throw new Error("Invalid Stripe key");
  }
};
