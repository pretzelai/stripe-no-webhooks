import type Stripe from "stripe";
import type { Pool } from "pg";
import type { BillingConfig, Plan, PriceInterval, CreditConfig } from "../BillingConfig";
import type { TransactionSource } from "./types";
import { credits } from "./index";
import { getActiveSeatUsers, getCreditsGrantedBySource, checkIdempotencyKeyPrefix } from "./db";
import {
  planHasCredits,
  findPlanByPriceId,
  getPlanFromSubscription,
  getUserIdFromCustomer,
  getCustomerIdFromSubscription,
} from "../helpers";

/**
 * Get the billing interval from a subscription
 */
function getSubscriptionInterval(subscription: Stripe.Subscription): PriceInterval {
  const interval = subscription.items.data[0]?.price?.recurring?.interval;
  return (interval as PriceInterval) || "month";
}

/**
 * Scale credit allocation based on billing interval.
 * Base allocation is assumed to be monthly.
 * - Yearly: 12× monthly
 * - Weekly: monthly ÷ 4 (rounded up)
 */
function scaleAllocation(config: CreditConfig, interval: PriceInterval): number {
  const base = config.allocation;

  // Auto-scale based on interval
  if (interval === "year") return base * 12;
  if (interval === "week") return Math.ceil(base / 4);
  return base;
}

/**
 * Who receives credits on subscription events:
 * - "subscriber" / "organization": The billing entity (user or org) receives credits (shared pool)
 * - "seat-users": Individual seat users receive their own credits
 * - "manual": No automatic granting, handle via callbacks
 */
export type CreditsGrantTo = "subscriber" | "organization" | "seat-users" | "manual";

export type CreditLifecycle = {
  onSubscriptionCreated: (subscription: Stripe.Subscription) => Promise<void>;
  onSubscriptionRenewed: (subscription: Stripe.Subscription, invoiceId: string) => Promise<void>;
  onSubscriptionCancelled: (subscription: Stripe.Subscription) => Promise<void>;
  onSubscriptionPlanChanged: (subscription: Stripe.Subscription, previousPriceId: string) => Promise<void>;
  /** Called when a scheduled downgrade is applied at period end */
  onDowngradeApplied: (subscription: Stripe.Subscription, newPriceId: string) => Promise<void>;
};

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
  pool: Pool | null;
  schema: string;
  billingConfig?: BillingConfig;
  mode: "test" | "production";
  grantTo: CreditsGrantTo;
  callbacks?: Callbacks;
};

export function createCreditLifecycle(config: Config) {
  const { pool, schema, billingConfig, mode, grantTo, callbacks } = config;

  // Local wrappers that use closure variables
  async function resolveUserId(subscription: Stripe.Subscription): Promise<string | null> {
    if (!pool) return null;
    const customerId = getCustomerIdFromSubscription(subscription);
    return getUserIdFromCustomer(pool, schema, customerId);
  }

  function resolvePlan(subscription: Stripe.Subscription): Plan | null {
    return getPlanFromSubscription(subscription, billingConfig, mode);
  }

  function resolvePlanByPriceId(priceId: string): Plan | null {
    return findPlanByPriceId(billingConfig, mode, priceId);
  }

  async function grantPlanCredits(
    userId: string,
    plan: Plan,
    subscriptionId: string,
    source: TransactionSource,
    idempotencyPrefix?: string,
    interval?: PriceInterval
  ): Promise<void> {
    if (!plan.credits) return;

    const effectiveInterval = interval || "month";

    for (const [creditType, creditConfig] of Object.entries(plan.credits)) {
      const idempotencyKey = idempotencyPrefix
        ? `${idempotencyPrefix}:${creditType}`
        : undefined;
      const scaledAmount = scaleAllocation(creditConfig, effectiveInterval);
      const newBalance = await credits.grant({
        userId,
        creditType,
        amount: scaledAmount,
        source,
        sourceId: subscriptionId,
        idempotencyKey,
      });
      await callbacks?.onCreditsGranted?.({
        userId,
        creditType,
        amount: scaledAmount,
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
    idempotencyPrefix?: string,
    interval?: PriceInterval
  ): Promise<void> {
    if (!plan.credits) return;

    const effectiveInterval = interval || "month";

    for (const [creditType, creditConfig] of Object.entries(plan.credits)) {
      // For renewals with 'reset', revoke first
      if (source === "renewal" && (creditConfig.onRenewal ?? "reset") === "reset") {
        const balance = await credits.getBalance({ userId, creditType });
        if (balance > 0) {
          await credits.revoke({ userId, creditType, amount: balance, source: "renewal" });
          await callbacks?.onCreditsRevoked?.({
            userId,
            creditType,
            amount: balance,
            previousBalance: balance,
            newBalance: 0,
            source: "renewal",
          });
        }
      }

      const idempotencyKey = idempotencyPrefix
        ? `${idempotencyPrefix}:${creditType}`
        : undefined;

      // Use seat_grant for seat-users mode, otherwise use the provided source
      const actualSource = grantTo === "seat-users" ? "seat_grant" : source;
      const scaledAmount = scaleAllocation(creditConfig, effectiveInterval);

      const newBalance = await credits.grant({
        userId,
        creditType,
        amount: scaledAmount,
        source: actualSource,
        sourceId: subscriptionId,
        idempotencyKey,
      });
      await callbacks?.onCreditsGranted?.({
        userId,
        creditType,
        amount: scaledAmount,
        newBalance,
        source: actualSource,
        sourceId: subscriptionId,
      });
    }
  }

  /**
   * Revoke credits that were granted by a specific subscription.
   * Only revokes the NET credits from this subscription (grants minus previous revocations),
   * preserving credits from other sources like top-ups.
   */
  async function revokeSubscriptionCredits(
    userId: string,
    subscriptionId: string,
    source: "seat_revoke" | "plan_change"
  ): Promise<void> {
    // Get NET credits from this subscription (grants - revocations)
    const netFromSubscription = await getCreditsGrantedBySource(userId, subscriptionId);

    for (const [creditType, netAmount] of Object.entries(netFromSubscription)) {
      if (netAmount > 0) {
        const currentBalance = await credits.getBalance({ userId, creditType });
        const amountToRevoke = Math.min(netAmount, currentBalance);

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

  /**
   * Apply downgrade credit changes following onRenewal settings.
   * - For credit types in new plan with "reset": revoke all, grant fresh
   * - For credit types in new plan with "add": keep balance, add allocation
   * - For credit types NOT in new plan: revoke them (no longer accessible)
   */
  async function applyDowngradeCredits(
    userId: string,
    newPlan: Plan | null,
    subscriptionId: string,
    idempotencyPrefix: string,
    interval?: PriceInterval
  ): Promise<void> {
    const effectiveInterval = interval || "month";
    const allBalances = await credits.getAllBalances({ userId });
    const newPlanCreditTypes = new Set(Object.keys(newPlan?.credits ?? {}));

    // First, revoke credits for types NOT in new plan
    for (const [creditType, balance] of Object.entries(allBalances)) {
      if (!newPlanCreditTypes.has(creditType) && balance > 0) {
        const result = await credits.revoke({
          userId,
          creditType,
          amount: balance,
          source: "plan_change",
          sourceId: subscriptionId,
        });
        await callbacks?.onCreditsRevoked?.({
          userId,
          creditType,
          amount: result.amountRevoked,
          previousBalance: balance,
          newBalance: result.balance,
          source: "plan_change",
        });
      }
    }

    // Then handle credits for types IN new plan based on onRenewal setting
    if (newPlan?.credits) {
      for (const [creditType, creditConfig] of Object.entries(newPlan.credits)) {
        const shouldReset = (creditConfig.onRenewal ?? "reset") === "reset";

        if (shouldReset) {
          // "reset": revoke current balance, then grant fresh allocation
          const currentBalance = await credits.getBalance({ userId, creditType });
          if (currentBalance > 0) {
            await credits.revoke({
              userId,
              creditType,
              amount: currentBalance,
              source: "plan_change",
              sourceId: subscriptionId,
            });
            await callbacks?.onCreditsRevoked?.({
              userId,
              creditType,
              amount: currentBalance,
              previousBalance: currentBalance,
              newBalance: 0,
              source: "plan_change",
            });
          }
        }
        // "add": keep current balance, just grant new allocation below

        // Grant new allocation (scaled for interval)
        const idempotencyKey = `${idempotencyPrefix}:${creditType}`;
        const scaledAmount = scaleAllocation(creditConfig, effectiveInterval);
        const newBalance = await credits.grant({
          userId,
          creditType,
          amount: scaledAmount,
          source: "subscription",
          sourceId: subscriptionId,
          idempotencyKey,
        });
        await callbacks?.onCreditsGranted?.({
          userId,
          creditType,
          amount: scaledAmount,
          newBalance,
          source: "subscription",
          sourceId: subscriptionId,
        });
      }
    }
  }

  /**
   * Revoke ALL credits for a user on subscription cancellation.
   * When a subscription is cancelled, user loses access to the service,
   * so all credits (including top-ups) are revoked.
   */
  async function revokeAllCredits(
    userId: string,
    subscriptionId: string
  ): Promise<void> {
    const allBalances = await credits.getAllBalances({ userId });

    for (const [creditType, balance] of Object.entries(allBalances)) {
      if (balance > 0) {
        const result = await credits.revoke({
          userId,
          creditType,
          amount: balance,
          source: "cancellation",
          sourceId: subscriptionId,
        });

        await callbacks?.onCreditsRevoked?.({
          userId,
          creditType,
          amount: result.amountRevoked,
          previousBalance: balance,
          newBalance: result.balance,
          source: "cancellation",
        });
      }
    }
  }

  return {
    async onSubscriptionCreated(subscription: Stripe.Subscription): Promise<void> {
      if (grantTo === "manual") return;

      const plan = resolvePlan(subscription);
      if (!plan?.credits) return;

      const interval = getSubscriptionInterval(subscription);

      if (grantTo === "seat-users") {
        // In seat-users mode, check for first_seat_user_id in metadata
        const firstSeatUserId = subscription.metadata?.first_seat_user_id;
        if (firstSeatUserId) {
          await grantOrResetCreditsForUser(
            firstSeatUserId,
            plan,
            subscription.id,
            "seat_grant",
            `seat_${firstSeatUserId}_${subscription.id}`,
            interval
          );
        }
        // If no first_seat_user_id, developer will call addSeat manually
        return;
      }

      // subscriber mode: grant to the billing entity
      const userId = await resolveUserId(subscription);
      if (!userId) return;

      await grantPlanCredits(userId, plan, subscription.id, "subscription", subscription.id, interval);
    },

    async onSubscriptionRenewed(
      subscription: Stripe.Subscription,
      invoiceId: string
    ): Promise<void> {
      if (grantTo === "manual") return;

      const plan = resolvePlan(subscription);
      if (!plan?.credits) return;

      const interval = getSubscriptionInterval(subscription);

      if (grantTo === "seat-users") {
        // Grant/reset credits to all active seat users
        const seatUsers = await getActiveSeatUsers(subscription.id);
        for (const userId of seatUsers) {
          // Check if already processed for this user - return gracefully to avoid webhook retry loops
          const alreadyProcessed = await checkIdempotencyKeyPrefix(`renewal_${invoiceId}_${userId}`);
          if (alreadyProcessed) {
            continue; // Skip this user, already processed
          }
          await grantOrResetCreditsForUser(
            userId,
            plan,
            subscription.id,
            "renewal",
            `renewal_${invoiceId}_${userId}`,
            interval
          );
        }
        return;
      }

      // subscriber mode: grant to the billing entity
      const userId = await resolveUserId(subscription);
      if (!userId) return;

      // Check if already processed - return gracefully to avoid webhook retry loops
      const alreadyProcessed = await checkIdempotencyKeyPrefix(invoiceId);
      if (alreadyProcessed) {
        return; // Already processed, nothing to do
      }

      for (const [creditType, creditConfig] of Object.entries(plan.credits)) {
        if ((creditConfig.onRenewal ?? "reset") === "reset") {
          const balance = await credits.getBalance({ userId, creditType });
          if (balance > 0) {
            await credits.revoke({ userId, creditType, amount: balance, source: "renewal" });
            await callbacks?.onCreditsRevoked?.({
              userId,
              creditType,
              amount: balance,
              previousBalance: balance,
              newBalance: 0,
              source: "renewal",
            });
          }
        }
      }

      await grantPlanCredits(userId, plan, subscription.id, "renewal", invoiceId, interval);
    },

    async onSubscriptionCancelled(subscription: Stripe.Subscription): Promise<void> {
      if (grantTo === "manual") return;

      if (grantTo === "seat-users") {
        // Revoke ALL credits from all active seat users
        const seatUsers = await getActiveSeatUsers(subscription.id);
        for (const userId of seatUsers) {
          await revokeAllCredits(userId, subscription.id);
        }
        return;
      }

      // subscriber mode: revoke ALL credits from the billing entity
      const userId = await resolveUserId(subscription);
      if (!userId) return;

      await revokeAllCredits(userId, subscription.id);
    },

    async onSubscriptionPlanChanged(
      subscription: Stripe.Subscription,
      previousPriceId: string
    ): Promise<void> {
      if (grantTo === "manual") return;

      // For downgrades, credits are adjusted at renewal, not immediately
      // This allows users to keep their credits until their paid period ends
      if (subscription.metadata?.pending_credit_downgrade === "true") {
        return;
      }

      const newPlan = resolvePlan(subscription);
      const oldPlan = resolvePlanByPriceId(previousPriceId);
      const newInterval = getSubscriptionInterval(subscription);

      const newPriceId = subscription.items.data[0]?.price?.id ?? "unknown";
      // Stable idempotency key - same across webhook retries
      const idempotencyKey = `plan_change_${subscription.id}_${previousPriceId}_to_${newPriceId}`;

      // If neither plan has credits, nothing to do
      if (!newPlan?.credits && !oldPlan?.credits) return;

      // Detect upgrade vs downgrade using metadata or price comparison
      // Routes.ts stores upgrade_from_price_amount during upgrades
      const upgradeFromAmount = subscription.metadata?.upgrade_from_price_amount;
      const isUpgradeViaMetadata = upgradeFromAmount !== undefined;
      const isFreeUpgrade = upgradeFromAmount === "0";

      // For upgrades where BOTH plans have credits (including same-plan interval changes):
      // - Don't revoke old credits (carry over as compensation for no proration)
      // - Grant new allocation (scaled for interval)
      // For Free → Paid upgrades: revoke Free credits, then grant new
      const bothHaveCredits = planHasCredits(oldPlan) && planHasCredits(newPlan);
      const shouldRevokeOnUpgrade = isFreeUpgrade || !bothHaveCredits;

      if (grantTo === "seat-users") {
        const seatUsers = await getActiveSeatUsers(subscription.id);
        for (const seatUserId of seatUsers) {
          // Only revoke if: (1) not an upgrade with both credits, or (2) Free upgrade
          if (oldPlan?.credits && (!isUpgradeViaMetadata || shouldRevokeOnUpgrade)) {
            await revokeSubscriptionCredits(seatUserId, subscription.id, "plan_change");
          }
          if (newPlan?.credits) {
            await grantOrResetCreditsForUser(
              seatUserId,
              newPlan,
              subscription.id,
              "subscription",
              `${idempotencyKey}:${seatUserId}`,
              newInterval
            );
          }
        }
        return;
      }

      // subscriber mode
      const userId = await resolveUserId(subscription);
      if (!userId) return;

      // Only revoke if: (1) not an upgrade with both credits, or (2) Free upgrade
      if (oldPlan?.credits && (!isUpgradeViaMetadata || shouldRevokeOnUpgrade)) {
        await revokeSubscriptionCredits(userId, subscription.id, "plan_change");
      }

      if (newPlan?.credits) {
        await grantPlanCredits(userId, newPlan, subscription.id, "subscription", idempotencyKey, newInterval);
      }
    },

    async onDowngradeApplied(
      subscription: Stripe.Subscription,
      newPriceId: string
    ): Promise<void> {
      if (grantTo === "manual") return;

      const newPlan = resolvePlanByPriceId(newPriceId);
      const idempotencyKey = `downgrade_${subscription.id}_to_${newPriceId}`;
      const interval = getSubscriptionInterval(subscription);

      // Downgrade at period end = fresh start on new plan
      // Behavior follows onRenewal setting:
      // - "reset": Revoke all credits, grant new allocation (balance = new_allocation)
      // - "add": Keep current credits, add new allocation (balance = current + new_allocation)
      // Credit types that don't exist in new plan are always revoked

      if (grantTo === "seat-users") {
        const seatUsers = await getActiveSeatUsers(subscription.id);
        for (const seatUserId of seatUsers) {
          await applyDowngradeCredits(seatUserId, newPlan, subscription.id, `${idempotencyKey}:${seatUserId}`, interval);
        }
        return;
      }

      // subscriber mode
      const userId = await resolveUserId(subscription);
      if (!userId) return;

      await applyDowngradeCredits(userId, newPlan, subscription.id, idempotencyKey, interval);
    },
  };
}
