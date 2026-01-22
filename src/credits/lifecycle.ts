import type Stripe from "stripe";
import type { Pool } from "pg";
import type { BillingConfig, Plan, PriceInterval, CreditConfig, WalletConfig } from "../BillingConfig";
import type { TransactionSource } from "./types";
import { credits } from "./index";
import { getActiveSeatUsers, getCreditsGrantedBySource, checkIdempotencyKeyPrefix, atomicAdd, atomicSet } from "./db";
import {
  planHasCredits,
  findPlanByPriceId,
  getPlanFromSubscription,
  getUserIdFromCustomer,
  getCustomerIdFromSubscription,
} from "../helpers";
import { centsToMilliCents } from "../wallet";

function getSubscriptionInterval(subscription: Stripe.Subscription): PriceInterval {
  const interval = subscription.items.data[0]?.price?.recurring?.interval;
  return (interval as PriceInterval) || "month";
}

function scaleAllocation(config: CreditConfig, interval: PriceInterval): number {
  const base = config.allocation;
  if (interval === "year") return base * 12;
  if (interval === "week") return Math.ceil(base / 4);
  return base;
}

function scaleWalletAllocation(config: WalletConfig, interval: PriceInterval): number {
  const baseCents = config.allocation;
  let scaledCents = baseCents;

  if (interval === "year") scaledCents = baseCents * 12;
  else if (interval === "week") scaledCents = Math.ceil(baseCents / 4);

  return centsToMilliCents(scaledCents);
}

function getSubscriptionCurrency(subscription: Stripe.Subscription): string {
  return subscription.currency || "usd";
}

const WALLET_KEY = "wallet";

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
    key: string;
    amount: number;
    newBalance: number;
    source: TransactionSource;
    sourceId?: string;
  }) => void | Promise<void>;

  onCreditsRevoked?: (params: {
    userId: string;
    key: string;
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

    for (const [key, creditConfig] of Object.entries(plan.credits)) {
      const idempotencyKey = idempotencyPrefix
        ? `${idempotencyPrefix}:${key}`
        : undefined;
      const scaledAmount = scaleAllocation(creditConfig, effectiveInterval);
      const newBalance = await credits.grant({
        userId,
        key,
        amount: scaledAmount,
        source,
        sourceId: subscriptionId,
        idempotencyKey,
      });
      await callbacks?.onCreditsGranted?.({
        userId,
        key,
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

    for (const [key, creditConfig] of Object.entries(plan.credits)) {
      const idempotencyKey = idempotencyPrefix
        ? `${idempotencyPrefix}:${key}`
        : undefined;

      // Use seat_grant for seat-users mode, otherwise use the provided source
      const actualSource = grantTo === "seat-users" ? "seat_grant" : source;
      const scaledAmount = scaleAllocation(creditConfig, effectiveInterval);

      // For renewals with 'reset', use setBalance to wipe slate clean
      // This handles negative balances correctly (user starts fresh with full allocation)
      if (source === "renewal" && (creditConfig.onRenewal ?? "reset") === "reset") {
        const result = await credits.setBalance({
          userId,
          key,
          balance: scaledAmount,
          source: actualSource,
          sourceId: subscriptionId,
          idempotencyKey,
        });
        await callbacks?.onCreditsGranted?.({
          userId,
          key,
          amount: scaledAmount,
          newBalance: scaledAmount,
          source: actualSource,
          sourceId: subscriptionId,
        });
      } else {
        const newBalance = await credits.grant({
          userId,
          key,
          amount: scaledAmount,
          source: actualSource,
          sourceId: subscriptionId,
          idempotencyKey,
        });
        await callbacks?.onCreditsGranted?.({
          userId,
          key,
          amount: scaledAmount,
          newBalance,
          source: actualSource,
          sourceId: subscriptionId,
        });
      }
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
    const netFromSubscription = await getCreditsGrantedBySource(userId, subscriptionId);

    for (const [key, netAmount] of Object.entries(netFromSubscription)) {
      if (netAmount > 0) {
        const currentBalance = await credits.getBalance({ userId, key });
        const amountToRevoke = Math.min(netAmount, currentBalance);

        if (amountToRevoke > 0) {
          const result = await credits.revoke({
            userId,
            key,
            amount: amountToRevoke,
            source,
            sourceId: subscriptionId,
          });

          await callbacks?.onCreditsRevoked?.({
            userId,
            key,
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
    const newPlanCredits = new Set(Object.keys(newPlan?.credits ?? {}));

    // First, revoke credits for types NOT in new plan
    for (const [key, balance] of Object.entries(allBalances)) {
      if (!newPlanCredits.has(key) && balance > 0) {
        const result = await credits.revoke({
          userId,
          key,
          amount: balance,
          source: "plan_change",
          sourceId: subscriptionId,
        });
        await callbacks?.onCreditsRevoked?.({
          userId,
          key,
          amount: result.amountRevoked,
          previousBalance: balance,
          newBalance: result.balance,
          source: "plan_change",
        });
      }
    }

    // Then handle credits for types IN new plan based on onRenewal setting
    if (newPlan?.credits) {
      for (const [key, creditConfig] of Object.entries(newPlan.credits)) {
        const idempotencyKey = `${idempotencyPrefix}:${key}`;
        const scaledAmount = scaleAllocation(creditConfig, effectiveInterval);
        const shouldReset = (creditConfig.onRenewal ?? "reset") === "reset";

        if (shouldReset) {
          // "reset": Use setBalance to wipe slate clean (handles negative balances)
          await credits.setBalance({
            userId,
            key,
            balance: scaledAmount,
            source: "plan_change",
            sourceId: subscriptionId,
            idempotencyKey,
          });
          await callbacks?.onCreditsGranted?.({
            userId,
            key,
            amount: scaledAmount,
            newBalance: scaledAmount,
            source: "plan_change",
            sourceId: subscriptionId,
          });
        } else {
          // "add": keep current balance, add new allocation
          const newBalance = await credits.grant({
            userId,
            key,
            amount: scaledAmount,
            source: "plan_change",
            sourceId: subscriptionId,
            idempotencyKey,
          });
          await callbacks?.onCreditsGranted?.({
            userId,
            key,
            amount: scaledAmount,
            newBalance,
            source: "plan_change",
            sourceId: subscriptionId,
          });
        }
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

    for (const [key, balance] of Object.entries(allBalances)) {
      if (balance > 0) {
        const result = await credits.revoke({
          userId,
          key,
          amount: balance,
          source: "cancellation",
          sourceId: subscriptionId,
        });

        await callbacks?.onCreditsRevoked?.({
          userId,
          key,
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
      const interval = getSubscriptionInterval(subscription);
      const currency = getSubscriptionCurrency(subscription);

      if (plan?.credits) {
        if (grantTo === "seat-users") {
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
        } else {
          const userId = await resolveUserId(subscription);
          if (userId) {
            await grantPlanCredits(userId, plan, subscription.id, "subscription", subscription.id, interval);
          }
        }
      }

      if (plan?.wallet && grantTo !== "seat-users") {
        const userId = await resolveUserId(subscription);
        if (userId) {
          const scaledAmount = scaleWalletAllocation(plan.wallet, interval);
          await atomicAdd(userId, WALLET_KEY, scaledAmount, {
            transactionType: "grant",
            source: "subscription",
            sourceId: subscription.id,
            idempotencyKey: `wallet_${subscription.id}`,
            currency,
          });
        }
      }
    },

    async onSubscriptionRenewed(
      subscription: Stripe.Subscription,
      invoiceId: string
    ): Promise<void> {
      if (grantTo === "manual") return;

      const plan = resolvePlan(subscription);
      const interval = getSubscriptionInterval(subscription);
      const currency = getSubscriptionCurrency(subscription);

      if (plan?.credits && grantTo === "seat-users") {
        const seatUsers = await getActiveSeatUsers(subscription.id);
        for (const userId of seatUsers) {
          const alreadyProcessed = await checkIdempotencyKeyPrefix(`renewal_${invoiceId}_${userId}`);
          if (alreadyProcessed) continue;
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

      const userId = await resolveUserId(subscription);
      if (!userId) return;

      const alreadyProcessed = await checkIdempotencyKeyPrefix(invoiceId);
      if (alreadyProcessed) return;

      if (plan?.credits) {
        for (const [key, creditConfig] of Object.entries(plan.credits)) {
          const scaledAmount = scaleAllocation(creditConfig, interval);
          const idempotencyKey = `${invoiceId}:${key}`;

          if ((creditConfig.onRenewal ?? "reset") === "reset") {
            await credits.setBalance({
              userId,
              key,
              balance: scaledAmount,
              source: "renewal",
              sourceId: subscription.id,
              idempotencyKey,
            });
            await callbacks?.onCreditsGranted?.({
              userId,
              key,
              amount: scaledAmount,
              newBalance: scaledAmount,
              source: "renewal",
              sourceId: subscription.id,
            });
          } else {
            const newBalance = await credits.grant({
              userId,
              key,
              amount: scaledAmount,
              source: "renewal",
              sourceId: subscription.id,
              idempotencyKey,
            });
            await callbacks?.onCreditsGranted?.({
              userId,
              key,
              amount: scaledAmount,
              newBalance,
              source: "renewal",
              sourceId: subscription.id,
            });
          }
        }
      }

      if (plan?.wallet) {
        const scaledAmount = scaleWalletAllocation(plan.wallet, interval);
        const walletIdempotencyKey = `${invoiceId}:wallet`;

        if ((plan.wallet.onRenewal ?? "reset") === "reset") {
          await atomicSet(userId, WALLET_KEY, scaledAmount, {
            transactionType: "adjust",
            source: "renewal",
            sourceId: subscription.id,
            idempotencyKey: walletIdempotencyKey,
            currency,
          });
        } else {
          await atomicAdd(userId, WALLET_KEY, scaledAmount, {
            transactionType: "grant",
            source: "renewal",
            sourceId: subscription.id,
            idempotencyKey: walletIdempotencyKey,
            currency,
          });
        }
      }
    },

    async onSubscriptionCancelled(subscription: Stripe.Subscription): Promise<void> {
      if (grantTo === "manual") return;

      const plan = resolvePlan(subscription);

      if (grantTo === "seat-users") {
        const seatUsers = await getActiveSeatUsers(subscription.id);
        for (const userId of seatUsers) {
          await revokeAllCredits(userId, subscription.id);
        }
        return;
      }

      const userId = await resolveUserId(subscription);
      if (!userId) return;

      await revokeAllCredits(userId, subscription.id);

      if (plan?.wallet) {
        await atomicSet(userId, WALLET_KEY, 0, {
          transactionType: "revoke",
          source: "cancellation",
          sourceId: subscription.id,
        });
      }
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
      const idempotencyKey = `plan_change_${subscription.id}_${previousPriceId}_to_${newPriceId}`;

      if (!newPlan?.credits && !oldPlan?.credits) return;

      const upgradeFromAmount = subscription.metadata?.upgrade_from_price_amount;
      const isUpgradeViaMetadata = upgradeFromAmount !== undefined;
      const isFreeUpgrade = upgradeFromAmount === "0";
      const bothHaveCredits = planHasCredits(oldPlan) && planHasCredits(newPlan);
      const shouldRevokeOnUpgrade = isFreeUpgrade || !bothHaveCredits;

      if (grantTo === "seat-users") {
        const seatUsers = await getActiveSeatUsers(subscription.id);
        for (const seatUserId of seatUsers) {
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

      const userId = await resolveUserId(subscription);
      if (!userId) return;

      if (oldPlan?.credits && (!isUpgradeViaMetadata || shouldRevokeOnUpgrade)) {
        await revokeSubscriptionCredits(userId, subscription.id, "plan_change");
      }

      if (newPlan?.credits) {
        await grantPlanCredits(userId, newPlan, subscription.id, "subscription", idempotencyKey, newInterval);
      }

      const currency = getSubscriptionCurrency(subscription);
      const oldHasWallet = !!oldPlan?.wallet;
      const newHasWallet = !!newPlan?.wallet;

      if (oldHasWallet && !newHasWallet) {
        await atomicSet(userId, WALLET_KEY, 0, {
          transactionType: "revoke",
          source: "plan_change",
          sourceId: subscription.id,
        });
      } else if (newHasWallet) {
        const scaledAmount = scaleWalletAllocation(newPlan!.wallet!, newInterval);
        await atomicAdd(userId, WALLET_KEY, scaledAmount, {
          transactionType: "grant",
          source: "plan_change",
          sourceId: subscription.id,
          idempotencyKey: `${idempotencyKey}:wallet`,
          currency,
        });
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

      if (grantTo === "seat-users") {
        const seatUsers = await getActiveSeatUsers(subscription.id);
        for (const seatUserId of seatUsers) {
          await applyDowngradeCredits(seatUserId, newPlan, subscription.id, `${idempotencyKey}:${seatUserId}`, interval);
        }
        return;
      }

      const userId = await resolveUserId(subscription);
      if (!userId) return;

      await applyDowngradeCredits(userId, newPlan, subscription.id, idempotencyKey, interval);

      const currency = getSubscriptionCurrency(subscription);
      if (newPlan?.wallet) {
        const scaledAmount = scaleWalletAllocation(newPlan.wallet, interval);
        const walletIdempotencyKey = `${idempotencyKey}:wallet`;

        if ((newPlan.wallet.onRenewal ?? "reset") === "reset") {
          await atomicSet(userId, WALLET_KEY, scaledAmount, {
            transactionType: "adjust",
            source: "plan_change",
            sourceId: subscription.id,
            idempotencyKey: walletIdempotencyKey,
            currency,
          });
        } else {
          await atomicAdd(userId, WALLET_KEY, scaledAmount, {
            transactionType: "grant",
            source: "plan_change",
            sourceId: subscription.id,
            idempotencyKey: walletIdempotencyKey,
            currency,
          });
        }
      } else {
        await atomicSet(userId, WALLET_KEY, 0, {
          transactionType: "revoke",
          source: "plan_change",
          sourceId: subscription.id,
        });
      }
    },
  };
}
