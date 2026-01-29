import type { HandlerContext } from "../types";
import { jsonResponse } from "./utils";

/**
 * Check if a checkout session has been processed and subscription is active.
 * Polled by the loading page to determine when to redirect.
 */
export async function handleCheckoutStatus(
  request: Request,
  ctx: HandlerContext
): Promise<Response> {
  const sessionId = new URL(request.url).searchParams.get("session_id");

  if (!sessionId) {
    // No session ID - let them proceed
    return jsonResponse({ status: "ready" });
  }

  try {
    // Get the checkout session from Stripe to find the subscription ID
    const session = await ctx.stripe.checkout.sessions.retrieve(sessionId);

    if (!session.subscription) {
      // No subscription (could be a one-time payment) - ready to proceed
      return jsonResponse({ status: "ready" });
    }

    const subscriptionId = typeof session.subscription === 'string'
      ? session.subscription
      : session.subscription.id;

    if (!ctx.pool) {
      // No DB connection - can't check if synced, let them proceed
      return jsonResponse({ status: "ready" });
    }

    // Check if subscription is synced to local database with active status
    const result = await ctx.pool.query(
      `SELECT status FROM ${ctx.schema}.subscriptions WHERE id = $1 AND status IN ('active', 'trialing')`,
      [subscriptionId]
    );

    if (result.rows.length > 0) {
      return jsonResponse({ status: "ready" });
    }

    return jsonResponse({ status: "pending" });
  } catch (err) {
    // On error, let them proceed (graceful degradation)
    console.error("Error checking checkout status:", err);
    return jsonResponse({ status: "ready" });
  }
}
