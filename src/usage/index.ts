import Stripe from "stripe";
import type { Pool } from "pg";
import type { BillingConfig } from "../BillingConfig";
import { isUsageTrackingEnabled } from "../BillingConfig";
import {
  getStripeCustomerId,
  findPlanByPriceId,
  getActiveSubscription,
  getPlanFromSubscription,
} from "../helpers";
import {
  setPool as setUsagePool,
  insertUsageEvent,
  getUsageSummary as dbGetUsageSummary,
  getUsageHistory as dbGetUsageHistory,
  UsageEvent,
  UsageSummary,
} from "./db";

export type { UsageEvent, UsageSummary };

let stripeClient: Stripe | null = null;
let pool: Pool | null = null;
let schema = "stripe";
let billingConfig: BillingConfig | null = null;
let currentMode: "test" | "production" = "test";

export function initUsage(params: {
  stripe: Stripe;
  pool: Pool | null;
  schema?: string;
  billingConfig: BillingConfig;
  mode: "test" | "production";
}) {
  stripeClient = params.stripe;
  pool = params.pool;
  schema = params.schema || "stripe";
  billingConfig = params.billingConfig;
  currentMode = params.mode;
  setUsagePool(params.pool, schema);
}

function ensureInitialized(): { stripe: Stripe; pool: Pool; config: BillingConfig } {
  if (!stripeClient) {
    throw new Error("Usage module not initialized. Call initUsage() first.");
  }
  if (!pool) {
    throw new Error("Usage module requires a database pool.");
  }
  if (!billingConfig) {
    throw new Error("Usage module not initialized. Call initUsage() first.");
  }
  return { stripe: stripeClient, pool, config: billingConfig };
}

type SubscriptionData = {
  id: string;
  status: string;
  currentPeriodStart: number;
  currentPeriodEnd: number;
  priceId: string;
};

async function getActiveSubscriptionFromDb(
  dbPool: Pool,
  dbSchema: string,
  customerId: string
): Promise<SubscriptionData | null> {
  const result = await dbPool.query<{
    id: string;
    status: string;
    current_period_start: number;
    current_period_end: number;
    items: { data: Array<{ price: { id: string } }> };
  }>(
    `SELECT id, status, current_period_start, current_period_end, items
     FROM ${dbSchema}.subscriptions
     WHERE customer = $1 AND status IN ('active', 'trialing')
     ORDER BY created DESC
     LIMIT 1`,
    [customerId]
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  const priceId = row.items?.data?.[0]?.price?.id;

  return {
    id: row.id,
    status: row.status,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    priceId: priceId || "",
  };
}

function normalizeEventName(featureKey: string): string {
  return featureKey
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .substring(0, 40);
}

export class UsageError extends Error {
  constructor(
    public code:
      | "NOT_INITIALIZED"
      | "TRACKING_NOT_ENABLED"
      | "INVALID_AMOUNT"
      | "NO_CUSTOMER"
      | "NO_SUBSCRIPTION"
      | "METERED_PRICE_NOT_CONFIGURED"
      | "STRIPE_ERROR",
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "UsageError";
  }
}

export type RecordUsageParams = {
  userId: string;
  key: string;
  amount: number;
  timestamp?: Date;
};

export type RecordUsageResult = {
  event: UsageEvent;
  meterEventId: string;
};

/**
 * Record usage for a user.
 *
 * @example
 * await usage.record({ userId: "user_123", key: "api_calls", amount: 10 });
 */
export async function record(params: RecordUsageParams): Promise<RecordUsageResult> {
  const { userId, key, amount, timestamp = new Date() } = params;

  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    throw new UsageError(
      "INVALID_AMOUNT",
      "Amount must be a positive number",
      { amount }
    );
  }

  const { stripe, pool: dbPool, config } = ensureInitialized();

  const stripeCustomerId = await getStripeCustomerId(dbPool, schema, userId);
  if (!stripeCustomerId) {
    throw new UsageError(
      "NO_CUSTOMER",
      `No Stripe customer found for user "${userId}"`,
      { userId }
    );
  }

  const subscription = await getActiveSubscriptionFromDb(dbPool, schema, stripeCustomerId);
  if (!subscription) {
    throw new UsageError(
      "NO_SUBSCRIPTION",
      `No active subscription found for user "${userId}"`,
      { userId, stripeCustomerId }
    );
  }

  const plan = findPlanByPriceId(config, currentMode, subscription.priceId);
  if (!plan) {
    throw new UsageError(
      "TRACKING_NOT_ENABLED",
      `Could not identify plan for user's subscription`,
      { userId, subscriptionId: subscription.id }
    );
  }

  const feature = plan.features?.[key];
  if (!feature) {
    throw new UsageError(
      "TRACKING_NOT_ENABLED",
      `Feature "${key}" not found in plan "${plan.name}"`,
      { key, planName: plan.name }
    );
  }

  if (!isUsageTrackingEnabled(feature)) {
    const missing = [];
    if (!feature.trackUsage) missing.push("trackUsage: true");
    if (feature.pricePerCredit === undefined) missing.push("pricePerCredit");
    throw new UsageError(
      "TRACKING_NOT_ENABLED",
      `Usage tracking not enabled for feature "${key}". Add ${missing.join(" and ")} to the feature config.`,
      { key, missingConfig: missing }
    );
  }

  const periodStart = new Date(subscription.currentPeriodStart * 1000);
  const periodEnd = new Date(subscription.currentPeriodEnd * 1000);

  if (timestamp < periodStart || timestamp > periodEnd) {
    throw new UsageError(
      "INVALID_AMOUNT",
      `Timestamp must be within current billing period (${periodStart.toISOString()} to ${periodEnd.toISOString()})`,
      { timestamp: timestamp.toISOString(), periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString() }
    );
  }

  const eventName = normalizeEventName(key);

  let meterEvent: Stripe.Billing.MeterEvent;
  try {
    meterEvent = await stripe.billing.meterEvents.create({
      event_name: eventName,
      payload: {
        value: String(amount),
        stripe_customer_id: stripeCustomerId,
      },
      timestamp: Math.floor(timestamp.getTime() / 1000),
    });
  } catch (err) {
    const error = err as Error;
    throw new UsageError(
      "STRIPE_ERROR",
      `Failed to send meter event to Stripe: ${error.message}`,
      { stripeError: error.message }
    );
  }

  // If DB insert fails, meter event was already sent to Stripe - billing still works
  let event: UsageEvent;
  try {
    event = await insertUsageEvent({
      userId,
      key,
      amount,
      stripeMeterEventId: meterEvent.identifier,
      periodStart,
      periodEnd,
    });
  } catch (dbError) {
    console.error(
      `Warning: Usage event sent to Stripe but failed to store locally. ` +
      `User ${userId} will be billed but local summary may be incomplete. ` +
      `Meter event ID: ${meterEvent.identifier}`,
      dbError
    );
    event = {
      id: "",
      userId,
      key,
      amount,
      stripeMeterEventId: meterEvent.identifier,
      periodStart,
      periodEnd,
      createdAt: new Date(),
    };
  }

  return {
    event,
    meterEventId: meterEvent.identifier,
  };
}

export type GetSummaryParams = {
  userId: string;
  key: string;
};

export type GetSummaryResult = {
  totalAmount: number;
  eventCount: number;
  estimatedCost: number;
  currency: string;
  periodStart: Date;
  periodEnd: Date;
};

/**
 * Get usage summary for the current billing period.
 *
 * @example
 * const summary = await usage.getSummary({ userId: "user_123", key: "api_calls" });
 */
export async function getSummary(params: GetSummaryParams): Promise<GetSummaryResult> {
  const { userId, key } = params;

  const { pool: dbPool, config } = ensureInitialized();

  const stripeCustomerId = await getStripeCustomerId(dbPool, schema, userId);
  if (!stripeCustomerId) {
    throw new UsageError("NO_CUSTOMER", `No Stripe customer found for user "${userId}"`);
  }

  const subscription = await getActiveSubscriptionFromDb(dbPool, schema, stripeCustomerId);
  if (!subscription) {
    throw new UsageError("NO_SUBSCRIPTION", `No active subscription found for user "${userId}"`);
  }

  const plan = findPlanByPriceId(config, currentMode, subscription.priceId);
  if (!plan) {
    throw new UsageError("TRACKING_NOT_ENABLED", `Could not identify plan for user's subscription`);
  }

  const feature = plan.features?.[key];
  if (!feature) {
    throw new UsageError(
      "TRACKING_NOT_ENABLED",
      `Feature "${key}" not found in plan "${plan.name}"`,
      { key, planName: plan.name }
    );
  }
  if (!isUsageTrackingEnabled(feature)) {
    const missing = [];
    if (!feature.trackUsage) missing.push("trackUsage: true");
    if (feature.pricePerCredit === undefined) missing.push("pricePerCredit");
    throw new UsageError(
      "TRACKING_NOT_ENABLED",
      `Usage tracking not enabled for feature "${key}". Add ${missing.join(" and ")} to the feature config.`,
      { key, missingConfig: missing }
    );
  }

  const periodStart = new Date(subscription.currentPeriodStart * 1000);
  const periodEnd = new Date(subscription.currentPeriodEnd * 1000);

  const summary = await dbGetUsageSummary({ userId, key, periodStart, periodEnd });

  const pricePerUnit = feature.pricePerCredit || 0;
  const estimatedCost = summary.totalAmount * pricePerUnit;
  const currency = plan.price?.[0]?.currency || "usd";

  return {
    totalAmount: summary.totalAmount,
    eventCount: summary.eventCount,
    estimatedCost,
    currency,
    periodStart,
    periodEnd,
  };
}

export type GetUsageHistoryParams = {
  userId: string;
  key: string;
  limit?: number;
  offset?: number;
};

export async function getUsageHistory(params: GetUsageHistoryParams): Promise<UsageEvent[]> {
  ensureInitialized();
  return dbGetUsageHistory(params);
}

export type EnableUsageParams = {
  userId: string;
  key: string;
};

/**
 * Enable usage billing for an existing subscriber.
 * Adds the metered price to their subscription if not already present.
 *
 * Use this for migrating existing subscribers who subscribed before
 * usage tracking was enabled for a feature.
 *
 * @example
 * await usage.enableForUser({ userId: "user_123", key: "api_calls" });
 */
export async function enableForUser(params: EnableUsageParams): Promise<void> {
  const { userId, key } = params;

  const { stripe, pool: dbPool, config } = ensureInitialized();

  const stripeCustomerId = await getStripeCustomerId(dbPool, schema, userId);
  if (!stripeCustomerId) {
    throw new UsageError("NO_CUSTOMER", `No Stripe customer found for user "${userId}"`);
  }

  const subscription = await getActiveSubscription(stripe, stripeCustomerId);
  if (!subscription) {
    throw new UsageError("NO_SUBSCRIPTION", `No active subscription found for user "${userId}"`);
  }

  const plan = getPlanFromSubscription(subscription, config, currentMode);
  if (!plan) {
    throw new UsageError("TRACKING_NOT_ENABLED", `Could not identify plan for user's subscription`);
  }

  const feature = plan.features?.[key];
  if (!feature) {
    throw new UsageError(
      "TRACKING_NOT_ENABLED",
      `Feature "${key}" not found in plan "${plan.name}"`,
      { key, planName: plan.name }
    );
  }
  if (!isUsageTrackingEnabled(feature)) {
    const missing = [];
    if (!feature.trackUsage) missing.push("trackUsage: true");
    if (feature.pricePerCredit === undefined) missing.push("pricePerCredit");
    throw new UsageError(
      "TRACKING_NOT_ENABLED",
      `Usage tracking not enabled for feature "${key}". Add ${missing.join(" and ")} to the feature config.`,
      { key, missingConfig: missing }
    );
  }

  if (!feature.meteredPriceId) {
    throw new UsageError(
      "METERED_PRICE_NOT_CONFIGURED",
      `Metered price not configured for feature "${key}". Run "npx stripe-no-webhooks sync" first.`
    );
  }

  const hasMeteredPrice = subscription.items.data.some(
    (item) => item.price.id === feature.meteredPriceId
  );
  if (hasMeteredPrice) return;

  // Handle race condition: concurrent request may have already added the price
  try {
    await stripe.subscriptions.update(subscription.id, {
      items: [
        ...subscription.items.data.map((item) => ({ id: item.id })),
        { price: feature.meteredPriceId },
      ],
      proration_behavior: "none",
    });
  } catch (err) {
    const updatedSub = await getActiveSubscription(stripe, stripeCustomerId);
    const nowHasPrice = updatedSub?.items.data.some(
      (item) => item.price.id === feature.meteredPriceId
    );
    if (nowHasPrice) return;
    throw new UsageError(
      "STRIPE_ERROR",
      `Failed to add metered price to subscription: ${(err as Error).message}`,
      { stripeError: (err as Error).message }
    );
  }
}

export const usage = {
  record,
  getSummary,
  getHistory: getUsageHistory,
  enableForUser,
};
