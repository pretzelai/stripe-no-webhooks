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
            pricePerCreditCents: 1, // $0.01 per credit
            minPerPurchase: 100,
            maxPerPurchase: 10000,
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
            pricePerCreditCents: 1,
            autoTopUp: {
              threshold: 500,
              amount: 1000,
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
            // No pricePerCreditCents configured
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
// Tests: B2B Mode (Invoice-based Top-Ups)
// =============================================================================

describe("TopUp: B2B Mode (with tax config)", () => {
  test("uses invoices when automaticTax is enabled", async () => {
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
      tax: { automaticTax: true },
      onTopUpCompleted: (params) => {
        completedParams = params;
      },
    });

    const result = await topUpHandler.topUp({
      userId: "user_1",
      creditType: "api_calls",
      amount: 500,
    });

    expect(result.success).toBe(true);
    if (result.success && "balance" in result) {
      expect(result.balance).toBe(500);
      // sourceId should be an invoice ID (starts with "in_")
      expect(result.sourceId).toMatch(/^in_/);
    }

    // Callback should receive invoice ID as sourceId
    expect(completedParams).not.toBeNull();
    expect(completedParams.sourceId).toMatch(/^in_/);
  });

  test("uses invoices when taxIdCollection is enabled", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_basic_1", "price_basic_monthly", "pm_card_visa");

    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
      tax: { taxIdCollection: true },
    });

    const result = await topUpHandler.topUp({
      userId: "user_1",
      creditType: "api_calls",
      amount: 500,
    });

    expect(result.success).toBe(true);
    if (result.success && "balance" in result) {
      // sourceId should be an invoice ID
      expect(result.sourceId).toMatch(/^in_/);
    }
  });

  test("uses PaymentIntent when no tax config", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_basic_1", "price_basic_monthly", "pm_card_visa");

    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
      // No tax config
    });

    const result = await topUpHandler.topUp({
      userId: "user_1",
      creditType: "api_calls",
      amount: 500,
    });

    expect(result.success).toBe(true);
    if (result.success && "balance" in result) {
      // sourceId should be a PaymentIntent ID (starts with "pi_")
      expect(result.sourceId).toMatch(/^pi_/);
    }
  });

  test("B2B auto top-up uses invoices", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_pro_1", "price_pro_monthly", "pm_card_visa");

    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
      tax: { automaticTax: true },
    });

    const result = await topUpHandler.triggerAutoTopUpIfNeeded({
      userId: "user_1",
      creditType: "api_calls",
      currentBalance: 100,
    });

    expect(result.triggered).toBe(true);
    if (result.triggered) {
      expect(result.status).toBe("succeeded");
      // sourceId should be an invoice ID
      expect(result.sourceId).toMatch(/^in_/);
    }
  });

  test("B2B recovery returns hosted invoice URL", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_basic_1", "price_basic_monthly"); // No payment method

    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
      tax: { automaticTax: true },
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
      // B2B recovery URL should be hosted invoice URL
      expect(result.error.recoveryUrl).toContain("invoice.stripe.com");
    }
  });

  test("B2C recovery returns checkout session URL", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_basic_1", "price_basic_monthly"); // No payment method

    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
      // No tax config = B2C mode
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
      // B2C recovery URL should be checkout session
      expect(result.error.recoveryUrl).toContain("checkout.stripe.com");
    }
  });
});

// =============================================================================
// Tests: Invoice Webhook Handler
// =============================================================================

describe("TopUp: Invoice Paid Webhook (B2B)", () => {
  test("grants credits on invoice.paid with top-up metadata", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_basic_1", "price_basic_monthly", "pm_card_visa");

    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
      tax: { automaticTax: true },
    });

    // Simulate invoice.paid webhook
    const invoice = {
      id: "in_test_123",
      object: "invoice",
      customer: "cus_user_1",
      status: "paid",
      paid: true,
      amount_paid: 500,
      currency: "usd",
      metadata: {
        top_up_credit_type: "api_calls",
        top_up_amount: "500",
        user_id: "user_1",
      },
    };

    await topUpHandler.handleInvoicePaid(invoice as any);

    expect(await credits.getBalance("user_1", "api_calls")).toBe(500);
  });

  test("idempotent: duplicate invoice.paid does not double-grant", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_basic_1", "price_basic_monthly", "pm_card_visa");

    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
      tax: { automaticTax: true },
    });

    const invoice = {
      id: "in_test_456",
      object: "invoice",
      customer: "cus_user_1",
      status: "paid",
      paid: true,
      amount_paid: 500,
      currency: "usd",
      metadata: {
        top_up_credit_type: "api_calls",
        top_up_amount: "500",
        user_id: "user_1",
      },
    };

    // Process same webhook twice
    await topUpHandler.handleInvoicePaid(invoice as any);
    await topUpHandler.handleInvoicePaid(invoice as any);

    // Should only have 500 credits
    expect(await credits.getBalance("user_1", "api_calls")).toBe(500);
  });

  test("ignores invoices without top-up metadata", async () => {
    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
      tax: { automaticTax: true },
    });

    const invoice = {
      id: "in_test_789",
      object: "invoice",
      customer: "cus_user_1",
      status: "paid",
      paid: true,
      amount_paid: 1000,
      currency: "usd",
      metadata: {}, // No top-up metadata (regular subscription invoice)
    };

    // Should not throw
    await topUpHandler.handleInvoicePaid(invoice as any);
  });

  test("handles auto top-up invoices correctly", async () => {
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
      tax: { automaticTax: true },
      onCreditsGranted: (params) => {
        grantedParams = params;
      },
    });

    const invoice = {
      id: "in_auto_123",
      object: "invoice",
      customer: "cus_user_1",
      status: "paid",
      paid: true,
      amount_paid: 1000,
      currency: "usd",
      metadata: {
        top_up_credit_type: "api_calls",
        top_up_amount: "1000",
        user_id: "user_1",
        top_up_auto: "true",
      },
    };

    await topUpHandler.handleInvoicePaid(invoice as any);

    expect(await credits.getBalance("user_1", "api_calls")).toBe(1000);
    expect(grantedParams).not.toBeNull();
    expect(grantedParams.source).toBe("auto_topup");
  });
});

// =============================================================================
// Tests: Payment Failure and Error Handling
// =============================================================================

describe("TopUp: Payment Failure Handling", () => {
  test("B2B mode voids invoice on payment failure", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_basic_1", "price_basic_monthly", "pm_card_visa");

    // Create a custom mock object with the methods we need
    let voidCalled = false;
    const failingStripe = {
      invoices: {
        create: async (params: any) => ({
          id: `in_fail_${Date.now()}`,
          object: "invoice",
          customer: params.customer,
          status: "draft",
          metadata: params.metadata || {},
        }),
        pay: async () => {
          throw { type: "card_error", code: "card_declined", message: "Card declined" };
        },
        voidInvoice: async (id: string) => {
          voidCalled = true;
          return { id, status: "void" };
        },
        finalizeInvoice: async (id: string) => ({
          id,
          status: "open",
          hosted_invoice_url: "https://invoice.stripe.com/test",
        }),
      },
      invoiceItems: {
        create: async (params: any) => ({
          id: `ii_${Date.now()}`,
          object: "invoiceitem",
          invoice: params.invoice,
        }),
      },
      checkout: {
        sessions: {
          create: async () => ({
            id: `cs_${Date.now()}`,
            url: "https://checkout.stripe.com/test",
          }),
        },
      },
    };

    const topUpHandler = createTopUpHandler({
      stripe: failingStripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
      tax: { automaticTax: true },
    });

    const result = await topUpHandler.topUp({
      userId: "user_1",
      creditType: "api_calls",
      amount: 500,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("PAYMENT_FAILED");
      expect(result.error.recoveryUrl).toBeDefined();
    }
    expect(voidCalled).toBe(true);
  });

  test("B2C mode returns pending status when payment is processing", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_basic_1", "price_basic_monthly", "pm_card_visa");

    // Create a custom mock that returns processing status
    const processingStripe = {
      paymentIntents: {
        create: async (params: any) => ({
          id: `pi_processing_${Date.now()}`,
          object: "payment_intent",
          amount: params.amount,
          currency: params.currency,
          status: "processing",
          metadata: params.metadata,
        }),
      },
      checkout: {
        sessions: {
          create: async () => ({
            id: `cs_${Date.now()}`,
            url: "https://checkout.stripe.com/test",
          }),
        },
      },
    };

    const topUpHandler = createTopUpHandler({
      stripe: processingStripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
      // No tax config = B2C mode
    });

    const result = await topUpHandler.topUp({
      userId: "user_1",
      creditType: "api_calls",
      amount: 500,
    });

    expect(result.success).toBe(true);
    if (result.success && "status" in result) {
      expect(result.status).toBe("pending");
      expect(result.message).toContain("processing");
    }
  });

  test("returns PAYMENT_FAILED for card errors with recovery URL", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_basic_1", "price_basic_monthly", "pm_card_visa");

    const failingStripe = {
      paymentIntents: {
        create: async () => {
          throw { type: "card_error", code: "insufficient_funds", message: "Insufficient funds" };
        },
      },
      checkout: {
        sessions: {
          create: async () => ({
            id: `cs_${Date.now()}`,
            url: "https://checkout.stripe.com/test",
          }),
        },
      },
    };

    const topUpHandler = createTopUpHandler({
      stripe: failingStripe as any,
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
      expect(result.error.code).toBe("PAYMENT_FAILED");
      expect(result.error.message).toContain("Insufficient funds");
      expect(result.error.recoveryUrl).toBeDefined();
    }
  });

  test("returns INVALID_AMOUNT for invalid_request_error", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_basic_1", "price_basic_monthly", "pm_card_visa");

    const failingStripe = {
      paymentIntents: {
        create: async () => {
          throw { type: "invalid_request_error", code: "amount_too_small", message: "Amount too small" };
        },
      },
      checkout: {
        sessions: {
          create: async () => ({
            id: `cs_${Date.now()}`,
            url: "https://checkout.stripe.com/test",
          }),
        },
      },
    };

    const topUpHandler = createTopUpHandler({
      stripe: failingStripe as any,
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
      amount: 100,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("INVALID_AMOUNT");
    }
  });
});

// =============================================================================
// Tests: Stripe Minimum Charge
// =============================================================================

describe("TopUp: Stripe Minimum Charge", () => {
  test("fails when total is below Stripe minimum (60 cents)", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_basic_1", "price_basic_monthly", "pm_card_visa");

    // Our basic plan has pricePerCreditCents = 1, so 50 credits = 50 cents < 60 cents
    // But minPerPurchase is 100, so we need a config with lower minPerPurchase
    const lowMinConfig: BillingConfig = {
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
                pricePerCreditCents: 1,
                minPerPurchase: 10, // Allow smaller purchases
                maxPerPurchase: 10000,
              },
            },
          },
        ],
      },
    };

    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: lowMinConfig,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    const result = await topUpHandler.topUp({
      userId: "user_1",
      creditType: "api_calls",
      amount: 50, // 50 cents < 60 cents minimum
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("INVALID_AMOUNT");
      expect(result.error.message).toContain("60 cents");
    }
  });
});

// =============================================================================
// Tests: Deleted Customer
// =============================================================================

describe("TopUp: Deleted Customer", () => {
  test("fails if customer is deleted", async () => {
    // Seed a deleted customer
    await seedPrice({ id: "price_basic_monthly", productId: "prod_test", unitAmount: 999 });
    await seedCustomer({
      id: "cus_deleted",
      metadata: { user_id: "user_deleted" },
      invoiceSettings: { default_payment_method: "pm_card_visa" },
      deleted: true,
    });
    await seedUserMap({ userId: "user_deleted", stripeCustomerId: "cus_deleted" });

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
      userId: "user_deleted",
      creditType: "api_calls",
      amount: 500,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("USER_NOT_FOUND");
      expect(result.error.message).toContain("deleted");
    }
  });
});

// =============================================================================
// Tests: Auto Top-Up Failure Scenarios
// =============================================================================

describe("TopUp: Auto Top-Up Failure Scenarios", () => {
  test("B2B auto top-up voids invoice on payment failure", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_pro_1", "price_pro_monthly", "pm_card_visa");

    let voidCalled = false;
    const failingStripe = {
      invoices: {
        create: async (params: any) => ({
          id: `in_fail_${Date.now()}`,
          object: "invoice",
          customer: params.customer,
          status: "draft",
          metadata: params.metadata || {},
        }),
        pay: async () => {
          throw { type: "card_error", code: "card_declined", message: "Card declined" };
        },
        voidInvoice: async () => {
          voidCalled = true;
          return { id: "in_voided", status: "void" };
        },
      },
      invoiceItems: {
        create: async (params: any) => ({
          id: `ii_${Date.now()}`,
          object: "invoiceitem",
          invoice: params.invoice,
        }),
      },
    };

    let failedParams: any = null;

    const topUpHandler = createTopUpHandler({
      stripe: failingStripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
      tax: { automaticTax: true },
      onAutoTopUpFailed: (params) => {
        failedParams = params;
      },
    });

    const result = await topUpHandler.triggerAutoTopUpIfNeeded({
      userId: "user_1",
      creditType: "api_calls",
      currentBalance: 100,
    });

    expect(result.triggered).toBe(false);
    if (!result.triggered && "error" in result) {
      expect(result.reason).toBe("payment_failed");
    }
    expect(voidCalled).toBe(true);
    expect(failedParams).not.toBeNull();
    expect(failedParams.reason).toBe("payment_failed");
  });

  test("B2C auto top-up fails with requires_action status", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_pro_1", "price_pro_monthly", "pm_card_visa");

    const actionRequiredStripe = {
      paymentIntents: {
        create: async (params: any) => ({
          id: `pi_action_${Date.now()}`,
          object: "payment_intent",
          amount: params.amount,
          currency: params.currency,
          status: "requires_action",
          metadata: params.metadata,
        }),
      },
    };

    let failedParams: any = null;

    const topUpHandler = createTopUpHandler({
      stripe: actionRequiredStripe as any,
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

    const result = await topUpHandler.triggerAutoTopUpIfNeeded({
      userId: "user_1",
      creditType: "api_calls",
      currentBalance: 100,
    });

    expect(result.triggered).toBe(false);
    if (!result.triggered) {
      expect(result.reason).toBe("payment_requires_action");
    }
    expect(failedParams).not.toBeNull();
    expect(failedParams.reason).toBe("payment_requires_action");
  });

  test("auto top-up returns user_not_found for non-existent user", async () => {
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
      userId: "nonexistent_user",
      creditType: "api_calls",
      currentBalance: 100,
    });

    expect(result.triggered).toBe(false);
    if (!result.triggered) {
      expect(result.reason).toBe("user_not_found");
    }
  });

  test("auto top-up returns not_configured when autoTopUp not configured", async () => {
    // Basic plan has pricePerCreditCents but no autoTopUp config
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

    const result = await topUpHandler.triggerAutoTopUpIfNeeded({
      userId: "user_1",
      creditType: "api_calls",
      currentBalance: 100,
    });

    expect(result.triggered).toBe(false);
    if (!result.triggered) {
      expect(result.reason).toBe("not_configured");
    }
  });
});

// =============================================================================
// Tests: Credit Type Without Top-Up
// =============================================================================

describe("TopUp: Credit Type Without Top-Up", () => {
  test("auto top-up fails for credit type without top-up config", async () => {
    // Pro plan has storage_gb without top-up configured
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
      creditType: "storage_gb",
      currentBalance: 10,
    });

    expect(result.triggered).toBe(false);
    if (!result.triggered) {
      expect(result.reason).toBe("not_configured");
    }
  });

  test("on-demand top-up fails for non-existent credit type", async () => {
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
      creditType: "nonexistent_credits",
      amount: 500,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("TOPUP_NOT_CONFIGURED");
    }
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

// =============================================================================
// Tests: Both On-Demand and Auto Top-Up Enabled (Dual Mode)
// =============================================================================

describe("TopUp: Dual Mode (On-Demand + Auto)", () => {
  test("on-demand top-up works when auto top-up is also configured", async () => {
    // Pro plan has BOTH pricePerCreditCents AND autoTopUp configured
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

    // Should be able to do on-demand top-up even though auto is configured
    const result = await topUpHandler.topUp({
      userId: "user_1",
      creditType: "api_calls",
      amount: 500,
    });

    expect(result.success).toBe(true);
    if (result.success && "balance" in result) {
      expect(result.balance).toBe(500);
    }
  });

  test("on-demand uses default min/max when not specified", async () => {
    // Pro plan has pricePerCreditCents but no explicit minPerPurchase/maxPerPurchase
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

    // Should succeed with amount of 1 (default min is 1)
    // But need to ensure it meets Stripe's 60 cent minimum
    const result = await topUpHandler.topUp({
      userId: "user_1",
      creditType: "api_calls",
      amount: 100, // 100 * $0.01 = $1.00, above Stripe minimum
    });

    expect(result.success).toBe(true);
  });

  test("manual top-up brings balance above auto threshold, auto does not trigger", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_pro_1", "price_pro_monthly", "pm_card_visa");

    // Start with low balance
    await credits.grant({
      userId: "user_1",
      creditType: "api_calls",
      amount: 100, // Below threshold of 500
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

    // User manually tops up 500 credits
    const manualResult = await topUpHandler.topUp({
      userId: "user_1",
      creditType: "api_calls",
      amount: 500,
    });

    expect(manualResult.success).toBe(true);

    // Now balance is 600, which is above threshold of 500
    const currentBalance = await credits.getBalance("user_1", "api_calls");
    expect(currentBalance).toBe(600);

    // Auto top-up should NOT trigger since balance is above threshold
    const autoResult = await topUpHandler.triggerAutoTopUpIfNeeded({
      userId: "user_1",
      creditType: "api_calls",
      currentBalance: currentBalance,
    });

    expect(autoResult.triggered).toBe(false);
    if (!autoResult.triggered) {
      expect(autoResult.reason).toBe("balance_above_threshold");
    }
  });

  test("manual top-up does not count against auto top-up monthly limit", async () => {
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

    // Do 5 manual top-ups
    for (let i = 0; i < 5; i++) {
      const result = await topUpHandler.topUp({
        userId: "user_1",
        creditType: "api_calls",
        amount: 100,
      });
      expect(result.success).toBe(true);
    }

    // Auto top-up should still work (max is 3 per month for auto, but manual doesn't count)
    const autoResult = await topUpHandler.triggerAutoTopUpIfNeeded({
      userId: "user_1",
      creditType: "api_calls",
      currentBalance: 100, // Below threshold of 500
    });

    expect(autoResult.triggered).toBe(true);
    if (autoResult.triggered) {
      expect(autoResult.status).toBe("succeeded");
    }
  });

  test("auto top-up and manual top-up tracked separately", async () => {
    await setupUserWithSubscription("user_1", "cus_user_1", "sub_pro_1", "price_pro_monthly", "pm_card_visa");

    let grantedCalls: any[] = [];

    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
      onCreditsGranted: (params) => {
        grantedCalls.push(params);
      },
    });

    // Manual top-up
    await topUpHandler.topUp({
      userId: "user_1",
      creditType: "api_calls",
      amount: 200,
    });

    // Auto top-up
    await topUpHandler.triggerAutoTopUpIfNeeded({
      userId: "user_1",
      creditType: "api_calls",
      currentBalance: 100,
    });

    expect(grantedCalls.length).toBe(2);
    expect(grantedCalls[0].source).toBe("topup");
    expect(grantedCalls[1].source).toBe("auto_topup");
  });

  test("on-demand respects minPerPurchase even on dual-mode plan without explicit limits", async () => {
    // Create a config where Pro plan would have implicit defaults
    const configWithDefaults: BillingConfig = {
      test: {
        plans: [
          {
            id: "pro_defaults",
            name: "Pro Defaults",
            price: [{ id: "price_pro_defaults", amount: 2999, currency: "usd", interval: "month" }],
            credits: {
              api_calls: {
                allocation: 10000,
                pricePerCreditCents: 10, // $0.10 per credit
                // No minPerPurchase - should default to 1
                // No maxPerPurchase - should have no limit
                autoTopUp: {
                  threshold: 500,
                  amount: 100,
                  maxPerMonth: 3,
                },
              },
            },
          },
        ],
      },
    };

    // Properly set up user with the new price/subscription
    await setupUserWithSubscription("user_defaults", "cus_defaults", "sub_defaults", "price_pro_defaults", "pm_card_visa");

    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: configWithDefaults,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    // Should fail with amount=1 since 1 credit * $0.10 = $0.10 < $0.60 Stripe minimum
    const result = await topUpHandler.topUp({
      userId: "user_defaults",
      creditType: "api_calls",
      amount: 1,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("INVALID_AMOUNT");
      expect(result.error.message).toContain("60 cents");
    }

    // Should succeed with amount=10 ($1.00)
    const result2 = await topUpHandler.topUp({
      userId: "user_defaults",
      creditType: "api_calls",
      amount: 10,
    });

    expect(result2.success).toBe(true);
  });
});

// =============================================================================
// Tests: Auto Top-Up with Custom Configs
// =============================================================================

describe("TopUp: Auto Top-Up with Custom Configs", () => {
  test("auto top-up succeeds with valid custom config", async () => {
    // Create a config where auto top-up amount * price >= 60 cents
    const validAmountConfig: BillingConfig = {
      test: {
        plans: [
          {
            id: "valid_auto",
            name: "Valid Auto",
            price: [{ id: "price_valid_auto", amount: 999, currency: "usd", interval: "month" }],
            credits: {
              api_calls: {
                allocation: 1000,
                pricePerCreditCents: 1, // $0.01 per credit
                autoTopUp: {
                  threshold: 100,
                  amount: 100, // 100 * $0.01 = $1.00 >= $0.60 minimum
                  maxPerMonth: 10,
                },
              },
            },
          },
        ],
      },
    };

    // Properly set up user with the new price/subscription
    await setupUserWithSubscription("user_valid", "cus_valid", "sub_valid", "price_valid_auto", "pm_card_visa");

    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: validAmountConfig,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    const result = await topUpHandler.triggerAutoTopUpIfNeeded({
      userId: "user_valid",
      creditType: "api_calls",
      currentBalance: 50,
    });

    expect(result.triggered).toBe(true);
    if (result.triggered) {
      expect(result.status).toBe("succeeded");
    }
  });

  test("auto top-up with different threshold and amount values", async () => {
    const customConfig: BillingConfig = {
      test: {
        plans: [
          {
            id: "custom_auto",
            name: "Custom Auto",
            price: [{ id: "price_custom_auto", amount: 1999, currency: "usd", interval: "month" }],
            credits: {
              api_calls: {
                allocation: 5000,
                pricePerCreditCents: 2, // $0.02 per credit
                autoTopUp: {
                  threshold: 200,
                  amount: 500, // 500 * $0.02 = $10.00
                  maxPerMonth: 5,
                },
              },
            },
          },
        ],
      },
    };

    await setupUserWithSubscription("user_custom", "cus_custom", "sub_custom", "price_custom_auto", "pm_card_visa");

    const topUpHandler = createTopUpHandler({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: customConfig,
      mode: "test",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    // Balance at 199 (below threshold of 200), should trigger
    const result = await topUpHandler.triggerAutoTopUpIfNeeded({
      userId: "user_custom",
      creditType: "api_calls",
      currentBalance: 199,
    });

    expect(result.triggered).toBe(true);

    // Verify 500 credits were added
    expect(await credits.getBalance("user_custom", "api_calls")).toBe(500);
  });
});
