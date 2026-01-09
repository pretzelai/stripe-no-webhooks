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

export function createSeatHandler(config: Config) {
  const { stripe, pool, schema, billingConfig, mode, grantTo, callbacks } = config;

  // Local wrappers that use closure variables
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

  /**
   * Grant credits to a seat user based on the org's subscription plan.
   * Internal function used by both addSeat and lifecycle hooks.
   */
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

  /**
   * Add a user as a seat of an org's subscription.
   * - In "seat-users" mode: grants credits to the individual user
   * - In "subscriber" mode: grants credits to the org (shared pool)
   * - In "manual" mode: no credit granting
   * - If plan.perSeat is true: increments Stripe subscription quantity
   * This operation is idempotent.
   */
  async function addSeat(params: AddSeatParams): Promise<AddSeatResult> {
    const { userId, orgId } = params;

    // Look up org's Stripe customer
    const customerId = await resolveStripeCustomerId(orgId);
    if (!customerId) {
      return { success: false, error: "Org has no Stripe customer" };
    }

    // Get org's active subscription
    const subscription = await resolveActiveSubscription(customerId);
    if (!subscription) {
      return { success: false, error: "No active subscription found for org" };
    }

    // Get plan from subscription
    const plan = resolvePlan(subscription);
    if (!plan) {
      return { success: false, error: "Could not resolve plan from subscription" };
    }

    let creditsGranted: Record<string, number> = {};
    let alreadyProcessed = false;

    // Handle credits based on grantTo mode
    if (grantTo !== "manual" && plan.credits) {
      // Determine who gets the credits
      const creditRecipient = grantTo === "seat-users" ? userId : orgId;
      const idempotencyPrefix = `seat_${orgId}_${userId}_${subscription.id}`;

      // In seat-users mode, check for conflicts (user can only be seat of one subscription)
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

    // Handle per-seat billing (if configured)
    // Always attempt the Stripe call - it has its own idempotency key
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

  /**
   * Remove a user as a seat of an org's subscription.
   * - In "seat-users" mode: revokes credits from the user
   * - In "subscriber" mode: revokes credits from the org (shared pool)
   * - In "manual" mode: no credit revocation
   * - If plan.perSeat is true: decrements Stripe subscription quantity
   * This operation is idempotent.
   */
  async function removeSeat(params: RemoveSeatParams): Promise<RemoveSeatResult> {
    const { userId, orgId } = params;

    // Look up org's Stripe customer
    const customerId = await resolveStripeCustomerId(orgId);
    if (!customerId) {
      return { success: false, error: "Org has no Stripe customer" };
    }

    // Get org's active subscription
    const subscription = await resolveActiveSubscription(customerId);
    if (!subscription) {
      return { success: false, error: "No active subscription found for org" };
    }

    // Get plan from subscription
    const plan = resolvePlan(subscription);
    if (!plan) {
      return { success: false, error: "Could not resolve plan from subscription" };
    }

    const creditsRevoked: Record<string, number> = {};

    // Handle credits based on grantTo mode
    if (grantTo !== "manual" && plan.credits) {
      // Determine who to revoke from (same entity that received credits in addSeat)
      const creditHolder = grantTo === "seat-users" ? userId : orgId;
      const grantsFromSeat = await getCreditsGrantedBySource(creditHolder, subscription.id);

      for (const [creditType, grantedAmount] of Object.entries(grantsFromSeat)) {
        if (grantedAmount > 0) {
          const currentBalance = await credits.getBalance(creditHolder, creditType);
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

    // Handle per-seat billing
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

  return {
    addSeat,
    removeSeat,
  };
}
