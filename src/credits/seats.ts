import type Stripe from "stripe";
import type { Pool } from "pg";
import type { BillingConfig, Plan } from "../BillingConfig";
import type { TransactionSource } from "./types";
import type { CreditsGrantTo } from "./lifecycle";
import { CreditError } from "./types";
import { credits } from "./index";
import { getUserSeatSubscription, getCreditsGrantedBySource } from "./db";
import {
  getPlanFromSubscription,
  getStripeCustomerId,
  getActiveSubscription,
} from "../helpers";

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
    source: "cancellation" | "manual" | "seat_revoke" | "renewal" | "plan_change";
  }) => void | Promise<void>;
};

type Config = {
  stripe: Stripe;
  pool: Pool | null;
  schema: string;
  billingConfig?: BillingConfig;
  mode: "test" | "production";
  grantTo: CreditsGrantTo;
  callbacks?: Callbacks;
};

export type AddSeatParams = {
  userId: string;
  orgId: string;
};

export type RemoveSeatParams = {
  userId: string;
  orgId: string;
};

export type AddSeatResult =
  | { success: true; creditsGranted: Record<string, number> }
  | { success: false; error: string };

export type RemoveSeatResult =
  | { success: true; creditsRevoked: Record<string, number> }
  | { success: false; error: string };

export function createSeatsApi(config: Config) {
  const { stripe, pool, schema, billingConfig, mode, grantTo, callbacks } = config;

  async function resolveStripeCustomerId(entityId: string): Promise<string | null> {
    if (!pool) return null;
    return getStripeCustomerId(pool, schema, entityId);
  }

  async function resolveActiveSubscription(customerId: string): Promise<Stripe.Subscription | null> {
    return getActiveSubscription(stripe, customerId);
  }

  function resolvePlan(subscription: Stripe.Subscription): Plan | null {
    return getPlanFromSubscription(subscription, billingConfig, mode);
  }

  async function grantSeatCredits(
    userId: string,
    plan: Plan,
    subscriptionId: string,
    idempotencyPrefix?: string
  ): Promise<Record<string, number>> {
    const creditsGranted: Record<string, number> = {};

    if (!plan.credits) return creditsGranted;

    for (const [creditType, creditConfig] of Object.entries(plan.credits)) {
      const idempotencyKey = idempotencyPrefix
        ? `${idempotencyPrefix}:${creditType}`
        : undefined;
      const newBalance = await credits.grant({
        userId,
        creditType,
        amount: creditConfig.allocation,
        source: "seat_grant",
        sourceId: subscriptionId,
        idempotencyKey,
      });
      creditsGranted[creditType] = creditConfig.allocation;
      await callbacks?.onCreditsGranted?.({
        userId,
        creditType,
        amount: creditConfig.allocation,
        newBalance,
        source: "seat_grant",
        sourceId: subscriptionId,
      });
    }

    return creditsGranted;
  }

  async function add(params: AddSeatParams): Promise<AddSeatResult> {
    const { userId, orgId } = params;

    const customerId = await resolveStripeCustomerId(orgId);
    if (!customerId) {
      return { success: false, error: "Org has no Stripe customer" };
    }

    const subscription = await resolveActiveSubscription(customerId);
    if (!subscription) {
      return { success: false, error: "No active subscription found for org" };
    }

    const plan = resolvePlan(subscription);
    if (!plan) {
      return { success: false, error: "Could not resolve plan from subscription" };
    }

    let creditsGranted: Record<string, number> = {};
    let alreadyProcessed = false;

    if (grantTo !== "manual" && plan.credits) {
      const creditRecipient = grantTo === "seat-users" ? userId : orgId;
      const idempotencyPrefix = `seat_${orgId}_${userId}_${subscription.id}`;

      // User can only be seat of one subscription
      if (grantTo === "seat-users") {
        const existingSubscription = await getUserSeatSubscription(userId);
        if (existingSubscription && existingSubscription !== subscription.id) {
          return {
            success: false,
            error: "User is already a seat of another subscription",
          };
        }
        if (existingSubscription === subscription.id) {
          alreadyProcessed = true;
        }
      }

      if (!alreadyProcessed) {
        try {
          creditsGranted = await grantSeatCredits(
            creditRecipient,
            plan,
            subscription.id,
            idempotencyPrefix
          );
        } catch (err) {
          if (err instanceof CreditError && err.code === "IDEMPOTENCY_CONFLICT") {
            alreadyProcessed = true;
          } else {
            throw err;
          }
        }
      }
    }

    if (plan.perSeat) {
      const item = subscription.items.data[0];
      if (item) {
        await stripe.subscriptions.update(
          subscription.id,
          {
            items: [{ id: item.id, quantity: (item.quantity ?? 1) + 1 }],
            proration_behavior: "create_prorations",
          },
          { idempotencyKey: `add_seat_${orgId}_${userId}_${subscription.id}` }
        );
      }
    }

    return { success: true, creditsGranted };
  }

  async function remove(params: RemoveSeatParams): Promise<RemoveSeatResult> {
    const { userId, orgId } = params;

    const customerId = await resolveStripeCustomerId(orgId);
    if (!customerId) {
      return { success: false, error: "Org has no Stripe customer" };
    }

    const subscription = await resolveActiveSubscription(customerId);
    if (!subscription) {
      return { success: false, error: "No active subscription found for org" };
    }

    const plan = resolvePlan(subscription);
    if (!plan) {
      return { success: false, error: "Could not resolve plan from subscription" };
    }

    const creditsRevoked: Record<string, number> = {};

    if (grantTo !== "manual" && plan.credits) {
      const creditHolder = grantTo === "seat-users" ? userId : orgId;
      const grantsFromSeat = await getCreditsGrantedBySource(creditHolder, subscription.id);

      for (const [creditType, grantedAmount] of Object.entries(grantsFromSeat)) {
        if (grantedAmount > 0) {
          const currentBalance = await credits.getBalance({ userId: creditHolder, creditType });
          const amountToRevoke = Math.min(grantedAmount, currentBalance);

          if (amountToRevoke > 0) {
            const result = await credits.revoke({
              userId: creditHolder,
              creditType,
              amount: amountToRevoke,
              source: "seat_revoke",
              sourceId: subscription.id,
            });
            creditsRevoked[creditType] = result.amountRevoked;

            await callbacks?.onCreditsRevoked?.({
              userId: creditHolder,
              creditType,
              amount: result.amountRevoked,
              previousBalance: currentBalance,
              newBalance: result.balance,
              source: "seat_revoke",
            });
          }
        }
      }
    }

    if (plan.perSeat) {
      const item = subscription.items.data[0];
      if (item) {
        const currentQuantity = item.quantity ?? 1;
        const newQuantity = Math.max(1, currentQuantity - 1);
        if (newQuantity !== currentQuantity) {
          await stripe.subscriptions.update(
            subscription.id,
            {
              items: [{ id: item.id, quantity: newQuantity }],
              proration_behavior: "create_prorations",
            },
            { idempotencyKey: `remove_seat_${orgId}_${userId}_${subscription.id}` }
          );
        }
      }
    }

    return { success: true, creditsRevoked };
  }

  return { add, remove };
}
