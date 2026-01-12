import type { Pool } from "pg";
import type { BillingConfig } from "./BillingConfig";
import { getStripeCustomerId } from "./helpers";

export type SubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "incomplete"
  | "incomplete_expired"
  | "paused";

export interface Subscription {
  id: string;
  status: SubscriptionStatus;
  plan: {
    id: string;
    name: string;
    priceId: string;
  } | null;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
}

interface SubscriptionRow {
  id: string;
  status: SubscriptionStatus;
  customer: string;
  current_period_start: number;
  current_period_end: number;
  cancel_at_period_end: boolean;
  items: {
    data: Array<{
      price: {
        id: string;
      };
    }>;
  };
}

export function createSubscriptionsApi(deps: {
  pool: Pool | null;
  schema: string;
  billingConfig?: BillingConfig;
  mode: "test" | "production";
}) {
  const { pool, schema, billingConfig, mode } = deps;

  function resolvePlanFromPriceId(priceId: string): { id: string; name: string } | null {
    const plans = billingConfig?.[mode]?.plans;
    if (!plans) return null;

    for (const plan of plans) {
      const matchingPrice = plan.price.find((p) => p.id === priceId);
      if (matchingPrice) {
        return { id: plan.id || plan.name, name: plan.name };
      }
    }
    return null;
  }

  function rowToSubscription(row: SubscriptionRow): Subscription {
    const priceId = row.items?.data?.[0]?.price?.id;
    const plan = priceId ? resolvePlanFromPriceId(priceId) : null;

    return {
      id: row.id,
      status: row.status,
      plan: plan ? { ...plan, priceId } : null,
      currentPeriodStart: new Date(row.current_period_start * 1000),
      currentPeriodEnd: new Date(row.current_period_end * 1000),
      cancelAtPeriodEnd: row.cancel_at_period_end,
    };
  }

  /**
   * Check if a user has an active subscription.
   */
  async function isActive(userId: string): Promise<boolean> {
    if (!pool) return false;

    const customerId = await getStripeCustomerId(pool, schema, userId);
    if (!customerId) return false;

    const result = await pool.query(
      `SELECT 1 FROM ${schema}.subscriptions
       WHERE customer = $1 AND status IN ('active', 'trialing')
       LIMIT 1`,
      [customerId]
    );
    return result.rows.length > 0;
  }

  /**
   * Get the current subscription for a user.
   * Returns the most recent active/trialing subscription, or most recent overall if none active.
   */
  async function get(userId: string): Promise<Subscription | null> {
    if (!pool) return null;

    const customerId = await getStripeCustomerId(pool, schema, userId);
    if (!customerId) return null;

    // First try to get active/trialing subscription
    let result = await pool.query<SubscriptionRow>(
      `SELECT id, status, customer, current_period_start, current_period_end,
              cancel_at_period_end, items
       FROM ${schema}.subscriptions
       WHERE customer = $1 AND status IN ('active', 'trialing')
       ORDER BY current_period_end DESC
       LIMIT 1`,
      [customerId]
    );

    // If no active subscription, get most recent one
    if (result.rows.length === 0) {
      result = await pool.query<SubscriptionRow>(
        `SELECT id, status, customer, current_period_start, current_period_end,
                cancel_at_period_end, items
         FROM ${schema}.subscriptions
         WHERE customer = $1
         ORDER BY current_period_end DESC
         LIMIT 1`,
        [customerId]
      );
    }

    if (result.rows.length === 0) return null;

    return rowToSubscription(result.rows[0]);
  }

  /**
   * List all subscriptions for a user.
   */
  async function list(userId: string): Promise<Subscription[]> {
    if (!pool) return [];

    const customerId = await getStripeCustomerId(pool, schema, userId);
    if (!customerId) return [];

    const result = await pool.query<SubscriptionRow>(
      `SELECT id, status, customer, current_period_start, current_period_end,
              cancel_at_period_end, items
       FROM ${schema}.subscriptions
       WHERE customer = $1
       ORDER BY current_period_end DESC`,
      [customerId]
    );

    return result.rows.map(rowToSubscription);
  }

  return { isActive, get, list };
}
