import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { Pool } from "pg";
import {
  setupTestDb,
  teardownTestDb,
  seedCustomer,
  seedPrice,
  seedSubscription,
  seedUserMap,
  cleanupAllTestData,
} from "./setup";
import { initCredits, credits } from "../src/credits";
import { createTopUpHandler } from "../src/credits/topup";
import type { BillingConfig } from "../src/BillingConfig";
import StripeMock from "./stripe-mock";

let pool: Pool;
let stripe: StripeMock;

// =============================================================================
// Test Billing Config with Top-Up Settings
// =============================================================================

const TEST_BILLING_CONFIG: BillingConfig = {
  test: {
    plans: [
      {
        id: "basic",
        name: "Basic",
        price: [{ id: "price_basic_monthly", amount: 999, currency: "usd", interval: "month" }],
        credits: {
          api_calls: {
            allocation: 1000,
            onRenewal: "reset",
            topUp: {
              mode: "on_demand",
              pricePerCreditCents: 1, // $0.01 per credit
              minPerPurchase: 100,
              maxPerPurchase: 10000,
            },
          },
        },
      },
      {
        id: "pro",
        name: "Pro",
        price: [{ id: "price_pro_monthly", amount: 2999, currency: "usd", interval: "month" }],
        credits: {
          api_calls: {
            allocation: 10000,
            onRenewal: "reset",
            topUp: {
              mode: "auto",
              pricePerCreditCents: 1,
              balanceThreshold: 500,
              purchaseAmount: 1000,
              maxPerMonth: 3,
            },
          },
          storage_gb: {
            allocation: 100,
            onRenewal: "add",
            // No top-up for storage
          },
        },
      },
      {
        id: "no_topup",
        name: "No Top-Up",
        price: [{ id: "price_no_topup", amount: 499, currency: "usd", interval: "month" }],
        credits: {
          api_calls: {
            allocation: 500,
            onRenewal: "reset",
            // No topUp configured
          },
        },
      },
    ],
  },
};

// =============================================================================
// Test Setup
// =============================================================================

beforeAll(async () => {
  pool = await setupTestDb();
  initCredits(pool, "stripe");
});

beforeEach(async () => {
  await cleanupAllTestData();
  stripe = new StripeMock("sk_test_mock");
});

afterAll(async () => {
  await teardownTestDb();
});

// =============================================================================
// Helper: Setup user with subscription
// =============================================================================

async function setupUserWithSubscription(
  userId: string,
  customerId: string,
  subscriptionId: string,
  priceId: string,
  paymentMethodId?: string
): Promise<void> {
  // Seed price
  await seedPrice({ id: priceId, productId: "prod_test", unitAmount: 999 });

  // Seed customer with payment method
  await seedCustomer({
    id: customerId,
    metadata: { user_id: userId },
    invoiceSettings: paymentMethodId ? { default_payment_method: paymentMethodId } : undefined,
  });

  // Seed subscription
  await seedSubscription({ id: subscriptionId, customerId, priceId });

  // Map user to customer
  await seedUserMap({ userId, stripeCustomerId: customerId });
}

// =============================================================================
// Tests: On-Demand Top-Up
// =============================================================================

describe("TopUp: On-Demand", () => {
  test("successfully tops up credits with payment method", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_basic_1", "price_basic_monthly", "pm_card_visa");

    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    const result = await topUpHandler.topUp({
      userId: "user_1",
      creditType: "api_calls",
      amount: 500,
    });

    expect(result.success).toBe(true);
    if (result.success && "balance" in result) {
      expect(result.balance).toBe(500);
      expect(result.charged.amountCents).toBe(500); // 500 credits * $0.01
      expect(result.charged.currency).toBe("usd");
    }

    // Verify credits were granted
    expect(await credits.getBalance("user_1", "api_calls")).toBe(500);
  });

  test("fails without payment method and returns recovery URL", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_basic_1", "price_basic_monthly"); // No payment method

    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    const result = await topUpHandler.topUp({
      userId: "user_1",
      creditType: "api_calls",
      amount: 500,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("NO_PAYMENT_METHOD");
      expect(result.error.recoveryUrl).toBeDefined();
      expect(result.error.recoveryUrl).toContain("checkout.stripe.com");
    }
  });

  test("fails if amount below minimum", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_basic_1", "price_basic_monthly", "pm_card_visa");

    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    const result = await topUpHandler.topUp({
      userId: "user_1",
      creditType: "api_calls",
      amount: 50, // Min is 100
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("INVALID_AMOUNT");
      expect(result.error.message).toContain("Minimum");
    }
  });

  test("fails if amount above maximum", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_basic_1", "price_basic_monthly", "pm_card_visa");

    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    const result = await topUpHandler.topUp({
      userId: "user_1",
      creditType: "api_calls",
      amount: 50000, // Max is 10000
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("INVALID_AMOUNT");
      expect(result.error.message).toContain("Maximum");
    }
  });

  test("fails if top-up not configured for credit type", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_no_topup", "price_no_topup", "pm_card_visa");

    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    const result = await topUpHandler.topUp({
      userId: "user_1",
      creditType: "api_calls",
      amount: 500,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("TOPUP_NOT_CONFIGURED");
    }
  });

  test("fails if user has no subscription", async () => {
    // Only create customer mapping, no subscription
    await seedCustomer({
      id: "cus_user_1",
      metadata: { user_id: "user_1" },
      invoiceSettings: { default_payment_method: "pm_card_visa" },
    });
    await seedUserMap({ userId: "user_1", stripeCustomerId: "cus_user_1" });

    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    const result = await topUpHandler.topUp({
      userId: "user_1",
      creditType: "api_calls",
      amount: 500,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("NO_SUBSCRIPTION");
    }
  });

  test("idempotent: same idempotency key returns same result", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_basic_1", "price_basic_monthly", "pm_card_visa");

    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    // First top-up
    const result1 = await topUpHandler.topUp({
      userId: "user_1",
      creditType: "api_calls",
      amount: 500,
      idempotencyKey: "topup_123",
    });

    // Second top-up with same key
    const result2 = await topUpHandler.topUp({
      userId: "user_1",
      creditType: "api_calls",
      amount: 500,
      idempotencyKey: "topup_123",
    });

    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);

    // Should only have one top-up worth of credits
    expect(await credits.getBalance("user_1", "api_calls")).toBe(500);
  });
});

// =============================================================================
// Tests: Auto Top-Up
// =============================================================================

describe("TopUp: Auto Top-Up", () => {
  test("triggers auto top-up when balance drops below threshold", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_pro_1", "price_pro_monthly", "pm_card_visa");

    // Give user some initial credits
    await credits.grant({
      userId: "user_1",
      creditType: "api_calls",
      amount: 400, // Below threshold of 500
      source: "subscription",
      sourceId: "sub_pro_1",
    });

    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    const result = await topUpHandler.triggerAutoTopUpIfNeeded({
      userId: "user_1",
      creditType: "api_calls",
      currentBalance: 400,
    });

    expect(result.triggered).toBe(true);
    if (result.triggered) {
      expect(result.status).toBe("succeeded");
    }

    // Should have 400 + 1000 (auto top-up amount) = 1400
    expect(await credits.getBalance("user_1", "api_calls")).toBe(1400);
  });

  test("does not trigger when balance above threshold", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_pro_1", "price_pro_monthly", "pm_card_visa");

    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    const result = await topUpHandler.triggerAutoTopUpIfNeeded({
      userId: "user_1",
      creditType: "api_calls",
      currentBalance: 600, // Above threshold of 500
    });

    expect(result.triggered).toBe(false);
    if (!result.triggered) {
      expect(result.reason).toBe("balance_above_threshold");
    }
  });

  test("respects max per month limit", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_pro_1", "price_pro_monthly", "pm_card_visa");

    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    // Trigger 3 auto top-ups (the max)
    for (let i = 0; i < 3; i++) {
      const result = await topUpHandler.triggerAutoTopUpIfNeeded({
        userId: "user_1",
        creditType: "api_calls",
        currentBalance: 100,
      });
      expect(result.triggered).toBe(true);
    }

    // Fourth should be blocked
    const result = await topUpHandler.triggerAutoTopUpIfNeeded({
      userId: "user_1",
      creditType: "api_calls",
      currentBalance: 100,
    });

    expect(result.triggered).toBe(false);
    if (!result.triggered) {
      expect(result.reason).toBe("max_per_month_reached");
    }
  });

  test("does not trigger without payment method", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_pro_1", "price_pro_monthly"); // No payment method

    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    const result = await topUpHandler.triggerAutoTopUpIfNeeded({
      userId: "user_1",
      creditType: "api_calls",
      currentBalance: 100,
    });

    expect(result.triggered).toBe(false);
    if (!result.triggered) {
      expect(result.reason).toBe("no_payment_method");
    }
  });
});

// =============================================================================
// Tests: Webhook Handlers
// =============================================================================

describe("TopUp: Payment Intent Webhook", () => {
  test("grants credits on payment_intent.succeeded", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_basic_1", "price_basic_monthly", "pm_card_visa");

    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    // Simulate payment intent succeeded webhook
    const paymentIntent = {
      id: "pi_test_123",
      object: "payment_intent",
      amount: 500,
      currency: "usd",
      status: "succeeded",
      metadata: {
        top_up_credit_type: "api_calls",
        top_up_amount: "500",
        user_id: "user_1",
      },
    };

    await topUpHandler.handlePaymentIntentSucceeded(paymentIntent as any);

    expect(await credits.getBalance("user_1", "api_calls")).toBe(500);
  });

  test("idempotent: duplicate webhook does not double-grant", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_basic_1", "price_basic_monthly", "pm_card_visa");

    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    const paymentIntent = {
      id: "pi_test_456",
      object: "payment_intent",
      amount: 500,
      currency: "usd",
      status: "succeeded",
      metadata: {
        top_up_credit_type: "api_calls",
        top_up_amount: "500",
        user_id: "user_1",
      },
    };

    // Process same webhook twice
    await topUpHandler.handlePaymentIntentSucceeded(paymentIntent as any);
    await topUpHandler.handlePaymentIntentSucceeded(paymentIntent as any);

    // Should only have 500 credits
    expect(await credits.getBalance("user_1", "api_calls")).toBe(500);
  });

  test("ignores payment intents without top-up metadata", async () => {
    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    const paymentIntent = {
      id: "pi_test_789",
      object: "payment_intent",
      amount: 1000,
      currency: "usd",
      status: "succeeded",
      metadata: {}, // No top-up metadata
    };

    // Should not throw
    await topUpHandler.handlePaymentIntentSucceeded(paymentIntent as any);
  });
});

describe("TopUp: Checkout Session Webhook", () => {
  test("grants credits on checkout.session.completed", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_basic_1", "price_basic_monthly", "pm_card_visa");

    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    // Simulate checkout session completed webhook
    const session = {
      id: "cs_test_123",
      object: "checkout.session",
      customer: "cus_user_1",
      payment_status: "paid",
      payment_intent: "pi_checkout_123",
      amount_total: 500,
      currency: "usd",
      metadata: {
        top_up_credit_type: "api_calls",
        top_up_amount: "500",
      },
    };

    await topUpHandler.handleTopUpCheckoutCompleted(session as any);

    expect(await credits.getBalance("user_1", "api_calls")).toBe(500);
  });

  test("ignores unpaid checkout sessions", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_basic_1", "price_basic_monthly", "pm_card_visa");

    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    const session = {
      id: "cs_test_456",
      object: "checkout.session",
      customer: "cus_user_1",
      payment_status: "unpaid", // Not paid
      metadata: {
        top_up_credit_type: "api_calls",
        top_up_amount: "500",
      },
    };

    await topUpHandler.handleTopUpCheckoutCompleted(session as any);

    // No credits granted
    expect(await credits.getBalance("user_1", "api_calls")).toBe(0);
  });
});

// =============================================================================
// Tests: Callbacks
// =============================================================================

describe("TopUp: Callbacks", () => {
  test("fires onCreditsGranted callback on successful top-up", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_basic_1", "price_basic_monthly", "pm_card_visa");

    let grantedParams: any = null;

    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
      onCreditsGranted: (params) => {
        grantedParams = params;
      },
    });

    await topUpHandler.topUp({
      userId: "user_1",
      creditType: "api_calls",
      amount: 500,
    });

    expect(grantedParams).not.toBeNull();
    expect(grantedParams.userId).toBe("user_1");
    expect(grantedParams.creditType).toBe("api_calls");
    expect(grantedParams.amount).toBe(500);
    expect(grantedParams.source).toBe("topup");
  });

  test("fires onTopUpCompleted callback", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_basic_1", "price_basic_monthly", "pm_card_visa");

    let completedParams: any = null;

    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
      onTopUpCompleted: (params) => {
        completedParams = params;
      },
    });

    await topUpHandler.topUp({
      userId: "user_1",
      creditType: "api_calls",
      amount: 500,
    });

    expect(completedParams).not.toBeNull();
    expect(completedParams.userId).toBe("user_1");
    expect(completedParams.creditType).toBe("api_calls");
    expect(completedParams.creditsAdded).toBe(500);
    expect(completedParams.amountCharged).toBe(500);
  });

  test("fires onCreditsLow callback when auto top-up triggers", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_pro_1", "price_pro_monthly", "pm_card_visa");

    let lowParams: any = null;

    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
      onCreditsLow: (params) => {
        lowParams = params;
      },
    });

    await topUpHandler.triggerAutoTopUpIfNeeded({
      userId: "user_1",
      creditType: "api_calls",
      currentBalance: 100,
    });

    expect(lowParams).not.toBeNull();
    expect(lowParams.userId).toBe("user_1");
    expect(lowParams.creditType).toBe("api_calls");
    expect(lowParams.balance).toBe(100);
    expect(lowParams.threshold).toBe(500);
  });

  test("fires onAutoTopUpFailed callback when auto top-up fails", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_pro_1", "price_pro_monthly"); // No payment method

    let failedParams: any = null;

    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
      onAutoTopUpFailed: (params) => {
        failedParams = params;
      },
    });

    await topUpHandler.triggerAutoTopUpIfNeeded({
      userId: "user_1",
      creditType: "api_calls",
      currentBalance: 100,
    });

    expect(failedParams).not.toBeNull();
    expect(failedParams.userId).toBe("user_1");
    expect(failedParams.creditType).toBe("api_calls");
    expect(failedParams.reason).toBe("no_payment_method");
  });
});

// =============================================================================
// Tests: hasPaymentMethod
// =============================================================================

describe("TopUp: hasPaymentMethod", () => {
  test("returns true when user has payment method", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_basic_1", "price_basic_monthly", "pm_card_visa");

    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    const has = await topUpHandler.hasPaymentMethod("user_1");
    expect(has).toBe(true);
  });

  test("returns false when user has no payment method", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_basic_1", "price_basic_monthly"); // No payment method

    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    const has = await topUpHandler.hasPaymentMethod("user_1");
    expect(has).toBe(false);
  });

  test("returns false for non-existent user", async () => {
    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    const has = await topUpHandler.hasPaymentMethod("nonexistent");
    expect(has).toBe(false);
  });
});

// =============================================================================
// Tests: Boundary Cases
// =============================================================================

describe("TopUp: Boundary Cases", () => {
  test("succeeds with amount exactly at minPerPurchase", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_basic_1", "price_basic_monthly", "pm_card_visa");

    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    const result = await topUpHandler.topUp({
      userId: "user_1",
      creditType: "api_calls",
      amount: 100, // Exactly at minPerPurchase
    });

    expect(result.success).toBe(true);
    expect(await credits.getBalance("user_1", "api_calls")).toBe(100);
  });

  test("succeeds with amount exactly at maxPerPurchase", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_basic_1", "price_basic_monthly", "pm_card_visa");

    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    const result = await topUpHandler.topUp({
      userId: "user_1",
      creditType: "api_calls",
      amount: 10000, // Exactly at maxPerPurchase
    });

    expect(result.success).toBe(true);
    expect(await credits.getBalance("user_1", "api_calls")).toBe(10000);
  });

  test("fails with amount one below minPerPurchase", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_basic_1", "price_basic_monthly", "pm_card_visa");

    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    const result = await topUpHandler.topUp({
      userId: "user_1",
      creditType: "api_calls",
      amount: 99, // One below min
    });

    expect(result.success).toBe(false);
  });

  test("fails with amount one above maxPerPurchase", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_basic_1", "price_basic_monthly", "pm_card_visa");

    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    const result = await topUpHandler.topUp({
      userId: "user_1",
      creditType: "api_calls",
      amount: 10001, // One above max
    });

    expect(result.success).toBe(false);
  });

  test("auto top-up does NOT trigger when balance equals threshold", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_pro_1", "price_pro_monthly", "pm_card_visa");

    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    // Threshold is 500, balance equals threshold
    const result = await topUpHandler.triggerAutoTopUpIfNeeded({
      userId: "user_1",
      creditType: "api_calls",
      currentBalance: 500, // Exactly at threshold
    });

    expect(result.triggered).toBe(false);
    if (!result.triggered) {
      expect(result.reason).toBe("balance_above_threshold");
    }
  });

  test("auto top-up triggers when balance is one below threshold", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_pro_1", "price_pro_monthly", "pm_card_visa");

    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    // Threshold is 500, balance is 499 (one below)
    const result = await topUpHandler.triggerAutoTopUpIfNeeded({
      userId: "user_1",
      creditType: "api_calls",
      currentBalance: 499,
    });

    expect(result.triggered).toBe(true);
  });
});
