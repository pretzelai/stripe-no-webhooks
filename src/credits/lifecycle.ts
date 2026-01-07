import type Stripe from "stripe";
import type { Pool } from "pg";
import type { BillingConfig, Plan } from "../BillingConfig";
import type { TransactionSource } from "./types";
import { credits } from "./index";
import { getActiveSeatUsers, getCreditsGrantedBySource } from "./db";

/**
 * Who receives credits on subscription events:
 * - "subscriber" / "organization": The billing entity (user or org) receives credits (shared pool)
 * - "seat-users": Individual seat users receive their own credits
 * - "manual": No automatic granting, handle via callbacks
 */
export type CreditsGrantTo = "subscriber" | "organization" | "seat-users" | "manual";

type Callbacks = {
  onCreditsGranted?: (params: {
    userId: string;
    creditType: string;
    amount: number;
    newBalance: number;
    source: TransactionSource;
    sourceId?: string;
  }) => void | Promise<void>;

  onCreditsRevoked?: (params: {
    userId: string;
    creditType: string;
    amount: number;
    previousBalance: number;
    newBalance: number;
    source: "cancellation" | "manual" | "seat_revoke";
  }) => void | Promise<void>;
};

type Config = {
  pool: Pool | null;
  schema: string;
  billingConfig?: BillingConfig;
  mode: "test" | "production";
  grantTo: CreditsGrantTo;
  callbacks?: Callbacks;
};

export function createCreditLifecycle(config: Config) {
  const { pool, schema, billingConfig, mode, grantTo, callbacks } = config;

  async function resolveUserId(subscription: Stripe.Subscription): Promise<string | null> {
    if (!pool) return null;
    const customerId =
      typeof subscription.customer === "string"
        ? subscription.customer
        : subscription.customer.id;
    const result = await pool.query(
      `SELECT metadata->>'user_id' as user_id FROM ${schema}.customers WHERE id = $1`,
      [customerId]
    );
    return result.rows[0]?.user_id ?? null;
  }

  function resolvePlan(subscription: Stripe.Subscription): Plan | null {
    const price = subscription.items.data[0]?.price;
    if (!price) return null;
    const priceId = typeof price === "string" ? price : price.id;
    const plans = billingConfig?.[mode]?.plans;
    return plans?.find((p) => p.price.some((pr) => pr.id === priceId)) ?? null;
  }

  async function grantPlanCredits(
    userId: string,
    plan: Plan,
    subscriptionId: string,
    source: TransactionSource,
    idempotencyPrefix?: string
  ): Promise<void> {
    if (!plan.credits) return;

    for (const [creditType, creditConfig] of Object.entries(plan.credits)) {
      const idempotencyKey = idempotencyPrefix
        ? `${idempotencyPrefix}:${creditType}`
        : undefined;
      const newBalance = await credits.grant({
        userId,
        creditType,
        amount: creditConfig.allocation,
        source,
        sourceId: subscriptionId,
        idempotencyKey,
      });
      await callbacks?.onCreditsGranted?.({
        userId,
        creditType,
        amount: creditConfig.allocation,
        newBalance,
        source,
        sourceId: subscriptionId,
      });
    }
  }

  async function grantOrResetCreditsForUser(
    userId: string,
    plan: Plan,
    subscriptionId: string,
    source: TransactionSource,
    idempotencyPrefix?: string
  ): Promise<void> {
    if (!plan.credits) return;

    for (const [creditType, creditConfig] of Object.entries(plan.credits)) {
      // For renewals with 'reset', revoke first
      if (source === "renewal" && (creditConfig.onRenewal ?? "reset") === "reset") {
        const balance = await credits.getBalance(userId, creditType);
        if (balance > 0) {
          await credits.revoke({ userId, creditType, amount: balance, source: "renewal" });
        }
      }

      const idempotencyKey = idempotencyPrefix
        ? `${idempotencyPrefix}:${creditType}`
        : undefined;

      // Use seat_grant for seat-users mode, otherwise use the provided source
      const actualSource = grantTo === "seat-users" ? "seat_grant" : source;

      const newBalance = await credits.grant({
        userId,
        creditType,
        amount: creditConfig.allocation,
        source: actualSource,
        sourceId: subscriptionId,
        idempotencyKey,
      });
      await callbacks?.onCreditsGranted?.({
        userId,
        creditType,
        amount: creditConfig.allocation,
        newBalance,
        source: actualSource,
        sourceId: subscriptionId,
      });
    }
  }

  /**
   * Revoke credits that were granted by a specific subscription.
   * Only revokes credits from this subscription, not from other sources (top-ups, other subscriptions).
   */
  async function revokeCreditsFromSubscription(
    userId: string,
    subscriptionId: string,
    source: "cancellation" | "seat_revoke"
  ): Promise<void> {
    // Get credits that were granted by THIS subscription
    const grantsFromSubscription = await getCreditsGrantedBySource(userId, subscriptionId);

    for (const [creditType, grantedAmount] of Object.entries(grantsFromSubscription)) {
      if (grantedAmount > 0) {
        const currentBalance = await credits.getBalance(userId, creditType);
        // Revoke up to what was granted, but not more than current balance
        const amountToRevoke = Math.min(grantedAmount, currentBalance);

        if (amountToRevoke > 0) {
          const result = await credits.revoke({
            userId,
            creditType,
            amount: amountToRevoke,
            source,
            sourceId: subscriptionId,
          });

          await callbacks?.onCreditsRevoked?.({
            userId,
            creditType,
            amount: result.amountRevoked,
            previousBalance: currentBalance,
            newBalance: result.balance,
            source,
          });
        }
      }
    }
  }

  return {
    async onSubscriptionCreated(subscription: Stripe.Subscription): Promise<void> {
      if (grantTo === "manual") return;

      const plan = resolvePlan(subscription);
      if (!plan?.credits) return;

      if (grantTo === "seat-users") {
        // In seat-users mode, check for first_seat_user_id in metadata
        const firstSeatUserId = subscription.metadata?.first_seat_user_id;
        if (firstSeatUserId) {
          await grantOrResetCreditsForUser(
            firstSeatUserId,
            plan,
            subscription.id,
            "seat_grant",
            `seat_${firstSeatUserId}_${subscription.id}`
          );
        }
        // If no first_seat_user_id, developer will call addSeat manually
        return;
      }

      // subscriber mode: grant to the billing entity
      const userId = await resolveUserId(subscription);
      if (!userId) return;

      await grantPlanCredits(userId, plan, subscription.id, "subscription", subscription.id);
    },

    async onSubscriptionRenewed(
      subscription: Stripe.Subscription,
      invoiceId: string
    ): Promise<void> {
      if (grantTo === "manual") return;

      const plan = resolvePlan(subscription);
      if (!plan?.credits) return;

      if (grantTo === "seat-users") {
        // Grant/reset credits to all active seat users
        const seatUsers = await getActiveSeatUsers(subscription.id);
        for (const userId of seatUsers) {
          await grantOrResetCreditsForUser(
            userId,
            plan,
            subscription.id,
            "renewal",
            `renewal_${invoiceId}_${userId}`
          );
        }
        return;
      }

      // subscriber mode: grant to the billing entity
      const userId = await resolveUserId(subscription);
      if (!userId) return;

      for (const [creditType, creditConfig] of Object.entries(plan.credits)) {
        if ((creditConfig.onRenewal ?? "reset") === "reset") {
          const balance = await credits.getBalance(userId, creditType);
          if (balance > 0) {
            await credits.revoke({ userId, creditType, amount: balance, source: "renewal" });
          }
        }
      }

      await grantPlanCredits(userId, plan, subscription.id, "renewal", invoiceId);
    },

    async onSubscriptionCancelled(subscription: Stripe.Subscription): Promise<void> {
      if (grantTo === "manual") return;

      const plan = resolvePlan(subscription);
      if (!plan?.credits) return;

      if (grantTo === "seat-users") {
        // Revoke credits from all active seat users (only credits from this subscription)
        const seatUsers = await getActiveSeatUsers(subscription.id);
        for (const userId of seatUsers) {
          await revokeCreditsFromSubscription(userId, subscription.id, "seat_revoke");
        }
        return;
      }

      // subscriber mode: revoke from the billing entity (only credits from this subscription)
      const userId = await resolveUserId(subscription);
      if (!userId) return;

      await revokeCreditsFromSubscription(userId, subscription.id, "cancellation");
    },
  };
}
