import type Stripe from "stripe";
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

export interface SubscriptionPaymentStatus {
  status: "ok" | "past_due" | "unpaid" | "no_subscription";
  failedInvoice?: {
    id: string;
    amountDue: number;
    currency: string;
    attemptCount: number;
    nextPaymentAttempt: Date | null;
    hostedInvoiceUrl: string | null;
  };
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
  stripe?: Stripe;
  pool: Pool | null;
  schema: string;
  billingConfig?: BillingConfig;
  mode: "test" | "production";
}) {
  const { stripe, pool, schema, billingConfig, mode } = deps;

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

  /**
   * Get the payment status for a user's subscription.
   * Returns 'ok' if payments are current, or details about failed payments.
   */
  async function getPaymentStatus(
    userId: string
  ): Promise<SubscriptionPaymentStatus> {
    const subscription = await get(userId);

    if (!subscription) {
      return { status: "no_subscription" };
    }

    if (
      subscription.status === "active" ||
      subscription.status === "trialing"
    ) {
      return { status: "ok" };
    }

    if (
      subscription.status === "past_due" ||
      subscription.status === "unpaid"
    ) {
      // Try to get failed invoice details from Stripe API
      if (stripe) {
        try {
          const invoices = await stripe.invoices.list({
            subscription: subscription.id,
            status: "open",
            limit: 1,
          });

          const failedInvoice = invoices.data[0];
          if (failedInvoice) {
            return {
              status: subscription.status,
              failedInvoice: {
                id: failedInvoice.id,
                amountDue: failedInvoice.amount_due,
                currency: failedInvoice.currency,
                attemptCount: failedInvoice.attempt_count ?? 1,
                nextPaymentAttempt: failedInvoice.next_payment_attempt
                  ? new Date(failedInvoice.next_payment_attempt * 1000)
                  : null,
                hostedInvoiceUrl: failedInvoice.hosted_invoice_url ?? null,
              },
            };
          }
        } catch {
          // Fall through to return status without invoice details
        }
      }

      return { status: subscription.status };
    }

    // Other statuses (canceled, incomplete, etc.) - treat as no active subscription
    return { status: "no_subscription" };
  }

  return { isActive, get, list, getPaymentStatus };
}
