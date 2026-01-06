import type Stripe from "stripe";
import type { Pool } from "pg";
import type { BillingConfig, Plan } from "../BillingConfig";
import type { TransactionSource } from "./types";
import { credits } from "./index";

export type CreditsGrantTo = "subscriber" | "manual";

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
    source: "cancellation" | "manual";
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

  return {
    async onSubscriptionCreated(subscription: Stripe.Subscription): Promise<void> {
      if (grantTo === "manual") return;

      const userId = await resolveUserId(subscription);
      if (!userId) return;

      const plan = resolvePlan(subscription);
      if (!plan?.credits) return;

      await grantPlanCredits(userId, plan, subscription.id, "subscription", subscription.id);
    },

    async onSubscriptionRenewed(
      subscription: Stripe.Subscription,
      invoiceId: string
    ): Promise<void> {
      if (grantTo === "manual") return;

      const userId = await resolveUserId(subscription);
      if (!userId) return;

      const plan = resolvePlan(subscription);
      if (!plan?.credits) return;

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

      const userId = await resolveUserId(subscription);
      if (!userId) return;

      const plan = resolvePlan(subscription);
      if (!plan?.credits) return;

      for (const creditType of Object.keys(plan.credits)) {
        const result = await credits.revokeAll({
          userId,
          creditType,
          source: "cancellation",
        });

        if (result.amountRevoked > 0) {
          await callbacks?.onCreditsRevoked?.({
            userId,
            creditType,
            amount: result.amountRevoked,
            previousBalance: result.previousBalance,
            newBalance: 0,
            source: "cancellation",
          });
        }
      }
    },
  };
}
