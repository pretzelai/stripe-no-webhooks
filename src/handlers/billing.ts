import type { Pool } from "pg";
import type { HandlerContext } from "../types";
import type { Plan, PriceInterval } from "../BillingConfig";
import { getStripeCustomerId } from "../helpers";

interface SubscriptionInfo {
  planId: string;
  planName: string;
  interval: PriceInterval;
  status: string;
}

interface BillingResponse {
  plans: Plan[];
  subscription: SubscriptionInfo | null;
}

interface SubscriptionRow {
  id: string;
  status: string;
  items: {
    data: Array<{
      price: {
        id: string;
      };
    }>;
  };
}

function findPlanAndIntervalFromPriceId(
  plans: Plan[],
  priceId: string
): { planId: string; planName: string; interval: PriceInterval } | null {
  for (const plan of plans) {
    const price = plan.price?.find((p) => p.id === priceId);
    if (price) {
      return {
        planId: plan.id || plan.name.toLowerCase().replace(/\s+/g, "-"),
        planName: plan.name,
        interval: price.interval,
      };
    }
  }
  return null;
}

async function getSubscriptionForUser(
  pool: Pool,
  schema: string,
  userId: string,
  plans: Plan[]
): Promise<SubscriptionInfo | null> {
  const customerId = await getStripeCustomerId(pool, schema, userId);
  if (!customerId) return null;

  // Get active/trialing subscription first, fall back to most recent
  let result = await pool.query<SubscriptionRow>(
    `SELECT id, status, items
     FROM ${schema}.subscriptions
     WHERE customer = $1 AND status IN ('active', 'trialing')
     ORDER BY current_period_end DESC
     LIMIT 1`,
    [customerId]
  );

  if (result.rows.length === 0) {
    result = await pool.query<SubscriptionRow>(
      `SELECT id, status, items
       FROM ${schema}.subscriptions
       WHERE customer = $1
       ORDER BY current_period_end DESC
       LIMIT 1`,
      [customerId]
    );
  }

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  const priceId = row.items?.data?.[0]?.price?.id;
  if (!priceId) return null;

  const planInfo = findPlanAndIntervalFromPriceId(plans, priceId);
  if (!planInfo) return null;

  return {
    planId: planInfo.planId,
    planName: planInfo.planName,
    interval: planInfo.interval,
    status: row.status,
  };
}

export async function handleBilling(
  request: Request,
  ctx: HandlerContext
): Promise<Response> {
  try {
    // Get plans for current mode
    const plans = ctx.billingConfig?.[ctx.mode]?.plans || [];

    // Try to get user (may be null if not logged in)
    const user = ctx.resolveUser ? await ctx.resolveUser(request) : null;

    let subscription: SubscriptionInfo | null = null;

    if (user && ctx.pool) {
      subscription = await getSubscriptionForUser(
        ctx.pool,
        ctx.schema,
        user.id,
        plans
      );
    }

    const response: BillingResponse = { plans, subscription };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Billing endpoint error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to fetch billing data" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
