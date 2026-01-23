import type Stripe from "stripe";
import type { Pool } from "pg";
import type { BillingConfig, Plan } from "./BillingConfig";

export function getMode(stripeKey: string): "test" | "production" {
  if (stripeKey.includes("_test_")) {
    return "test";
  } else if (stripeKey.includes("_live_")) {
    return "production";
  } else {
    throw new Error("Invalid Stripe key");
  }
}

export function findPlanByPriceId(
  billingConfig: BillingConfig | undefined,
  mode: "test" | "production",
  priceId: string
): Plan | null {
  const plans = billingConfig?.[mode]?.plans;
  return plans?.find((p) => p.price.some((pr) => pr.id === priceId)) ?? null;
}

export function getPlanFromSubscription(
  subscription: Stripe.Subscription,
  billingConfig: BillingConfig | undefined,
  mode: "test" | "production"
): Plan | null {
  const price = subscription.items.data[0]?.price;
  if (!price) return null;
  const priceId = typeof price === "string" ? price : price.id;
  return findPlanByPriceId(billingConfig, mode, priceId);
}

export function getCustomerIdFromSubscription(subscription: Stripe.Subscription): string {
  return typeof subscription.customer === "string"
    ? subscription.customer
    : subscription.customer.id;
}

export async function getActiveSubscription(
  stripe: Stripe,
  customerId: string
): Promise<Stripe.Subscription | null> {
  const subscriptions = await stripe.subscriptions.list({
    customer: customerId,
    limit: 10,
    expand: ["data.items.data.price"],
  });
  return (
    subscriptions.data.find(
      (s) => s.status === "active" || s.status === "trialing"
    ) ?? null
  );
}

export async function getStripeCustomerId(
  pool: Pool,
  schema: string,
  userId: string
): Promise<string | null> {
  const result = await pool.query(
    `SELECT stripe_customer_id FROM ${schema}.user_stripe_customer_map WHERE user_id = $1`,
    [userId]
  );
  return result.rows[0]?.stripe_customer_id ?? null;
}

export async function getUserIdFromCustomer(
  pool: Pool,
  schema: string,
  customerId: string
): Promise<string | null> {
  const result = await pool.query(
    `SELECT metadata->>'user_id' as user_id FROM ${schema}.customers WHERE id = $1`,
    [customerId]
  );
  return result.rows[0]?.user_id ?? null;
}

export async function getUserIdFromStripeCustomer(
  pool: Pool | null,
  schema: string,
  stripeCustomerId: string
): Promise<string | null> {
  if (!pool) return null;
  const result = await pool.query(
    `SELECT user_id FROM ${schema}.user_stripe_customer_map WHERE stripe_customer_id = $1`,
    [stripeCustomerId]
  );
  return result.rows[0]?.user_id ?? null;
}
