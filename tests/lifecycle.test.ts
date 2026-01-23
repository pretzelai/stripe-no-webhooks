import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { Pool } from "pg";
import type Stripe from "stripe";
import {
  setupTestDb,
  cleanupTestData,
  teardownTestDb,
} from "./setup";
import { initCredits, credits } from "../src/credits";
import { createCreditLifecycle } from "../src/credits/lifecycle";
import type { BillingConfig, Plan } from "../src/BillingConfig";

let pool: Pool;

// =============================================================================
// Test Billing Config
// =============================================================================

const TEST_BILLING_CONFIG: BillingConfig = {
  test: {
    plans: [
      {
        id: "free",
        name: "Free",
        price: [{ id: "price_free_monthly", amount: 0, currency: "usd", interval: "month" }],
        features: {
          api_calls: { credits: { allocation: 100 } },
        },
      },
      {
        id: "basic",
        name: "Basic",
        price: [
          { id: "price_basic_monthly", amount: 999, currency: "usd", interval: "month" },
          { id: "price_basic_yearly", amount: 9990, currency: "usd", interval: "year" },
          { id: "price_basic_weekly", amount: 299, currency: "usd", interval: "week" },
        ],
        features: {
          api_calls: { credits: { allocation: 1000, onRenewal: "reset" } },
        },
      },
      {
        id: "pro",
        name: "Pro",
        price: [
          { id: "price_pro_monthly", amount: 2999, currency: "usd", interval: "month" },
          { id: "price_pro_yearly", amount: 29990, currency: "usd", interval: "year" },
        ],
        features: {
          api_calls: { credits: { allocation: 10000, onRenewal: "reset" } },
          storage_gb: { credits: { allocation: 100, onRenewal: "add" } },
        },
      },
      {
        id: "enterprise",
        name: "Enterprise",
        price: [{ id: "price_enterprise_monthly", amount: 9999, currency: "usd", interval: "month" }],
        features: {
          api_calls: { credits: { allocation: 100000, onRenewal: "reset" } },
          storage_gb: { credits: { allocation: 1000, onRenewal: "add" } },
          seats: { credits: { allocation: 50, onRenewal: "reset" } },
        },
      },
      {
        id: "no_credits",
        name: "No Credits Plan",
        price: [{ id: "price_no_credits", amount: 499, currency: "usd", interval: "month" }],
        // No features configured
      },
    ],
  },
};

// =============================================================================
// Helper Functions
// =============================================================================

function createMockSubscription(overrides: Partial<Stripe.Subscription> & {
  priceId: string;
  customerId?: string;
  interval?: "month" | "year" | "week";
}): Stripe.Subscription {
  const { priceId, customerId = "cus_test_user", interval = "month", ...rest } = overrides;

  return {
    id: `sub_${Math.random().toString(36).substring(7)}`,
    object: "subscription",
    customer: customerId,
    status: "active",
    items: {
      object: "list",
      data: [{
        id: "si_test",
        object: "subscription_item",
        price: {
          id: priceId,
          object: "price",
          currency: "usd",
          recurring: {
            interval: interval,
            interval_count: 1,
          },
        } as Stripe.Price,
        quantity: 1,
      }],
      has_more: false,
      url: "",
    },
    metadata: {},
    current_period_start: Math.floor(Date.now() / 1000),
    current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    ...rest,
  } as Stripe.Subscription;
}

async function setupTestUser(userId: string, customerId: string): Promise<void> {
  // Insert into stripe.customers table (created by stripe-sync-engine)
  await pool.query(`
    INSERT INTO stripe.customers (id, metadata)
    VALUES ($1, $2)
    ON CONFLICT (id) DO UPDATE SET metadata = $2
  `, [customerId, JSON.stringify({ user_id: userId })]);
}

async function cleanupAll(): Promise<void> {
  await pool.query(`TRUNCATE stripe.credit_balances, stripe.credit_ledger CASCADE`);
  await pool.query(`DELETE FROM stripe.customers WHERE id LIKE 'cus_test%'`);
}

// =============================================================================
// Test Setup
// =============================================================================

beforeAll(async () => {
  pool = await setupTestDb();
  initCredits(pool, "stripe");
});

beforeEach(async () => {
  await cleanupAll();
});

afterAll(async () => {
  await teardownTestDb();
});

// =============================================================================
// Tests: New Subscription
// =============================================================================

describe("Lifecycle: New Subscription", () => {
  test("grants credits when user subscribes to a plan with credits", async () => {
    await setupTestUser("user_1", "cus_test_user");

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "subscriber",
    });

    const subscription = createMockSubscription({
      id: "sub_new_1",
      priceId: "price_pro_monthly",
      customerId: "cus_test_user",
    });

    await lifecycle.onSubscriptionCreated(subscription);

    // Pro plan: 10,000 api_calls, 100 storage_gb
    const apiBalance = await credits.getBalance({ userId: "user_1", key: "api_calls" });
    const storageBalance = await credits.getBalance({ userId: "user_1", key: "storage_gb" });

    expect(apiBalance).toBe(10000);
    expect(storageBalance).toBe(100);
  });

  test("does not grant credits for plan without credits", async () => {
    await setupTestUser("user_1", "cus_test_user");

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "subscriber",
    });

    const subscription = createMockSubscription({
      id: "sub_no_credits",
      priceId: "price_no_credits",
      customerId: "cus_test_user",
    });

    await lifecycle.onSubscriptionCreated(subscription);

    const allBalances = await credits.getAllBalances({ userId: "user_1" });
    expect(Object.keys(allBalances).length).toBe(0);
  });

  test("grants multiple credit types independently", async () => {
    await setupTestUser("user_1", "cus_test_user");

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "subscriber",
    });

    const subscription = createMockSubscription({
      id: "sub_enterprise",
      priceId: "price_enterprise_monthly",
      customerId: "cus_test_user",
    });

    await lifecycle.onSubscriptionCreated(subscription);

    // Enterprise: 100,000 api_calls, 1000 storage_gb, 50 seats
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(100000);
    expect(await credits.getBalance({ userId: "user_1", key: "storage_gb" })).toBe(1000);
    expect(await credits.getBalance({ userId: "user_1", key: "seats" })).toBe(50);
  });

  test("idempotency: duplicate subscription created events throw error (caught by webhook handler)", async () => {
    await setupTestUser("user_1", "cus_test_user");

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "subscriber",
    });

    const subscription = createMockSubscription({
      id: "sub_idempotent",
      priceId: "price_basic_monthly",
      customerId: "cus_test_user",
    });

    // First call succeeds
    await lifecycle.onSubscriptionCreated(subscription);
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(1000);

    // Second call throws idempotency error (webhook handler catches this)
    let error: Error | null = null;
    try {
      await lifecycle.onSubscriptionCreated(subscription);
    } catch (e) {
      error = e as Error;
    }

    expect(error).not.toBeNull();
    expect(error?.message).toContain("already processed");

    // Balance unchanged
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(1000);
  });

  test("does nothing when grantTo is 'manual'", async () => {
    await setupTestUser("user_1", "cus_test_user");

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "manual",
    });

    const subscription = createMockSubscription({
      id: "sub_manual",
      priceId: "price_pro_monthly",
      customerId: "cus_test_user",
    });

    await lifecycle.onSubscriptionCreated(subscription);

    // No credits should be granted
    const allBalances = await credits.getAllBalances({ userId: "user_1" });
    expect(Object.keys(allBalances).length).toBe(0);
  });
});

// =============================================================================
// Tests: Upgrade - Free to Paid
// =============================================================================

describe("Lifecycle: Upgrade Free → Paid", () => {
  test("revokes free credits and grants paid credits", async () => {
    await setupTestUser("user_1", "cus_test_user");

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "subscriber",
    });

    // Start with Free plan credits
    const freeSub = createMockSubscription({
      id: "sub_upgrade_1",
      priceId: "price_free_monthly",
      customerId: "cus_test_user",
    });
    await lifecycle.onSubscriptionCreated(freeSub);

    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(100);

    // Upgrade to Pro (Free → Paid)
    const upgradedSub = createMockSubscription({
      id: "sub_upgrade_1",
      priceId: "price_pro_monthly",
      customerId: "cus_test_user",
      metadata: {
        upgrade_from_price_id: "price_free_monthly",
        upgrade_from_price_amount: "0", // Free plan indicator
      },
    });

    await lifecycle.onSubscriptionPlanChanged(upgradedSub, "price_free_monthly");

    // Should have Pro credits only (not 100 + 10000)
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(10000);
    expect(await credits.getBalance({ userId: "user_1", key: "storage_gb" })).toBe(100);
  });

  test("revokes only remaining free credits if some were consumed", async () => {
    await setupTestUser("user_1", "cus_test_user");

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "subscriber",
    });

    // Start with Free plan
    const freeSub = createMockSubscription({
      id: "sub_upgrade_2",
      priceId: "price_free_monthly",
      customerId: "cus_test_user",
    });
    await lifecycle.onSubscriptionCreated(freeSub);

    // Consume 60 of 100 credits
    await credits.consume({ userId: "user_1", key: "api_calls", amount: 60 });
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(40);

    // Upgrade to Basic
    const upgradedSub = createMockSubscription({
      id: "sub_upgrade_2",
      priceId: "price_basic_monthly",
      customerId: "cus_test_user",
      metadata: {
        upgrade_from_price_id: "price_free_monthly",
        upgrade_from_price_amount: "0",
      },
    });

    await lifecycle.onSubscriptionPlanChanged(upgradedSub, "price_free_monthly");

    // Should have Basic credits only (1000), remaining 40 revoked
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(1000);
  });
});

// =============================================================================
// Tests: Upgrade - Paid to Paid
// =============================================================================

describe("Lifecycle: Upgrade Paid → Paid", () => {
  test("keeps old credits and adds new credits (no proration compensation)", async () => {
    await setupTestUser("user_1", "cus_test_user");

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "subscriber",
    });

    // Start with Basic plan
    const basicSub = createMockSubscription({
      id: "sub_paid_upgrade",
      priceId: "price_basic_monthly",
      customerId: "cus_test_user",
    });
    await lifecycle.onSubscriptionCreated(basicSub);

    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(1000);

    // Consume some credits
    await credits.consume({ userId: "user_1", key: "api_calls", amount: 300 });
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(700);

    // Upgrade to Pro (Paid → Paid)
    const upgradedSub = createMockSubscription({
      id: "sub_paid_upgrade",
      priceId: "price_pro_monthly",
      customerId: "cus_test_user",
      metadata: {
        upgrade_from_price_id: "price_basic_monthly",
        upgrade_from_price_amount: "999", // Non-zero = paid plan
      },
    });

    await lifecycle.onSubscriptionPlanChanged(upgradedSub, "price_basic_monthly");

    // Should keep 700 + get 10000 = 10700
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(10700);
    // Should also get storage credits (new credit type)
    expect(await credits.getBalance({ userId: "user_1", key: "storage_gb" })).toBe(100);
  });

  test("adds new credit types that did not exist in old plan", async () => {
    await setupTestUser("user_1", "cus_test_user");

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "subscriber",
    });

    // Start with Basic (only api_calls)
    const basicSub = createMockSubscription({
      id: "sub_new_types",
      priceId: "price_basic_monthly",
      customerId: "cus_test_user",
    });
    await lifecycle.onSubscriptionCreated(basicSub);

    // Upgrade to Enterprise (api_calls, storage_gb, seats)
    const upgradedSub = createMockSubscription({
      id: "sub_new_types",
      priceId: "price_enterprise_monthly",
      customerId: "cus_test_user",
      metadata: {
        upgrade_from_price_id: "price_basic_monthly",
        upgrade_from_price_amount: "999",
      },
    });

    await lifecycle.onSubscriptionPlanChanged(upgradedSub, "price_basic_monthly");

    // Should have all Enterprise credits added
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(1000 + 100000);
    expect(await credits.getBalance({ userId: "user_1", key: "storage_gb" })).toBe(1000);
    expect(await credits.getBalance({ userId: "user_1", key: "seats" })).toBe(50);
  });
});

// =============================================================================
// Tests: Downgrade
// =============================================================================

describe("Lifecycle: Downgrade", () => {
  test("does not change credits immediately when pending_credit_downgrade is set", async () => {
    await setupTestUser("user_1", "cus_test_user");

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "subscriber",
    });

    // Start with Pro plan
    const proSub = createMockSubscription({
      id: "sub_downgrade",
      priceId: "price_pro_monthly",
      customerId: "cus_test_user",
    });
    await lifecycle.onSubscriptionCreated(proSub);

    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(10000);
    expect(await credits.getBalance({ userId: "user_1", key: "storage_gb" })).toBe(100);

    // Downgrade to Basic (scheduled for period end)
    const downgradedSub = createMockSubscription({
      id: "sub_downgrade",
      priceId: "price_basic_monthly",
      customerId: "cus_test_user",
      metadata: {
        pending_credit_downgrade: "true",
        downgrade_from_price: "price_pro_monthly",
      },
    });

    await lifecycle.onSubscriptionPlanChanged(downgradedSub, "price_pro_monthly");

    // Credits should be UNCHANGED (defer to renewal)
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(10000);
    expect(await credits.getBalance({ userId: "user_1", key: "storage_gb" })).toBe(100);
  });

  test("applies downgrade at renewal: revokes extra credit types, resets to new allocation", async () => {
    await setupTestUser("user_1", "cus_test_user");

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "subscriber",
    });

    // Start with Pro credits (granted manually to simulate existing state)
    await credits.grant({ userId: "user_1", key: "api_calls", amount: 10000, source: "subscription", sourceId: "sub_downgrade_2" });
    await credits.grant({ userId: "user_1", key: "storage_gb", amount: 100, source: "subscription", sourceId: "sub_downgrade_2" });

    // Consume some
    await credits.consume({ userId: "user_1", key: "api_calls", amount: 3000 });
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(7000);

    // Downgrade applied at renewal
    const downgradedSub = createMockSubscription({
      id: "sub_downgrade_2",
      priceId: "price_basic_monthly",
      customerId: "cus_test_user",
    });

    await lifecycle.onDowngradeApplied(downgradedSub, "price_basic_monthly");

    // api_calls: reset to Basic allocation (1000) because onRenewal: "reset"
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(1000);
    // storage_gb: revoked entirely (not in Basic plan)
    expect(await credits.getBalance({ userId: "user_1", key: "storage_gb" })).toBe(0);
  });

  test("downgrade respects onRenewal: add mode", async () => {
    await setupTestUser("user_1", "cus_test_user");

    // Custom config where Basic has onRenewal: "add"
    const customConfig: BillingConfig = {
      test: {
        plans: [
          {
            id: "pro",
            name: "Pro",
            price: [{ id: "price_pro", amount: 2999, currency: "usd", interval: "month" }],
            features: { api_calls: { credits: { allocation: 10000 } } },
          },
          {
            id: "basic_add",
            name: "Basic Add",
            price: [{ id: "price_basic_add", amount: 999, currency: "usd", interval: "month" }],
            features: { api_calls: { credits: { allocation: 500, onRenewal: "add" } } },
          },
        ],
      },
    };

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: customConfig,
      mode: "test",
      grantTo: "subscriber",
    });

    // Start with 7000 credits remaining
    await credits.grant({ userId: "user_1", key: "api_calls", amount: 7000, source: "subscription", sourceId: "sub_add" });

    const downgradedSub = createMockSubscription({
      id: "sub_add",
      priceId: "price_basic_add",
      customerId: "cus_test_user",
    });

    await lifecycle.onDowngradeApplied(downgradedSub, "price_basic_add");

    // With onRenewal: "add", should keep 7000 + add 500 = 7500
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(7500);
  });
});

// =============================================================================
// Tests: Renewal
// =============================================================================

describe("Lifecycle: Renewal", () => {
  test("resets credits on renewal with onRenewal: reset (default)", async () => {
    await setupTestUser("user_1", "cus_test_user");

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "subscriber",
    });

    // User has 500 remaining of 1000 Basic credits
    await credits.grant({ userId: "user_1", key: "api_calls", amount: 1000, source: "subscription", sourceId: "sub_renew" });
    await credits.consume({ userId: "user_1", key: "api_calls", amount: 500 });
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(500);

    const subscription = createMockSubscription({
      id: "sub_renew",
      priceId: "price_basic_monthly",
      customerId: "cus_test_user",
    });

    await lifecycle.onSubscriptionRenewed(subscription, "inv_renewal_1");

    // Should reset to 1000 (unused 500 lost)
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(1000);
  });

  test("accumulates credits on renewal with onRenewal: add", async () => {
    await setupTestUser("user_1", "cus_test_user");

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "subscriber",
    });

    // User has 50 storage_gb remaining (Pro plan has onRenewal: "add" for storage)
    await credits.grant({ userId: "user_1", key: "storage_gb", amount: 100, source: "subscription", sourceId: "sub_add_renew" });
    await credits.consume({ userId: "user_1", key: "storage_gb", amount: 50 });
    expect(await credits.getBalance({ userId: "user_1", key: "storage_gb" })).toBe(50);

    // Also set up api_calls which uses "reset"
    await credits.grant({ userId: "user_1", key: "api_calls", amount: 10000, source: "subscription", sourceId: "sub_add_renew" });
    await credits.consume({ userId: "user_1", key: "api_calls", amount: 3000 });
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(7000);

    const subscription = createMockSubscription({
      id: "sub_add_renew",
      priceId: "price_pro_monthly",
      customerId: "cus_test_user",
    });

    await lifecycle.onSubscriptionRenewed(subscription, "inv_renewal_2");

    // api_calls: reset to 10000 (7000 lost)
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(10000);
    // storage_gb: add 100 to existing 50 = 150
    expect(await credits.getBalance({ userId: "user_1", key: "storage_gb" })).toBe(150);
  });

  test("renewal idempotency: same invoice throws error on duplicate", async () => {
    await setupTestUser("user_1", "cus_test_user");

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "subscriber",
    });

    const subscription = createMockSubscription({
      id: "sub_idem_renew",
      priceId: "price_basic_monthly",
      customerId: "cus_test_user",
    });

    // First renewal succeeds
    await lifecycle.onSubscriptionRenewed(subscription, "inv_same");
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(1000);

    // Second call with same invoice returns gracefully (no error, to avoid webhook retry loops)
    await lifecycle.onSubscriptionRenewed(subscription, "inv_same");

    // Balance unchanged - credits not granted twice
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(1000);
  });
});

// =============================================================================
// Tests: Cancellation
// =============================================================================

describe("Lifecycle: Cancellation", () => {
  test("revokes all credits on subscription cancellation", async () => {
    await setupTestUser("user_1", "cus_test_user");

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "subscriber",
    });

    // User has credits from subscription
    await credits.grant({ userId: "user_1", key: "api_calls", amount: 5000, source: "subscription", sourceId: "sub_cancel" });
    await credits.grant({ userId: "user_1", key: "storage_gb", amount: 100, source: "subscription", sourceId: "sub_cancel" });

    // User also has top-up credits
    await credits.grant({ userId: "user_1", key: "api_calls", amount: 1000, source: "topup", sourceId: "topup_1" });

    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(6000);
    expect(await credits.getBalance({ userId: "user_1", key: "storage_gb" })).toBe(100);

    const subscription = createMockSubscription({
      id: "sub_cancel",
      priceId: "price_pro_monthly",
      customerId: "cus_test_user",
      status: "canceled",
    });

    await lifecycle.onSubscriptionCancelled(subscription);

    // ALL credits revoked (including top-ups) because user loses service access
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(0);
    expect(await credits.getBalance({ userId: "user_1", key: "storage_gb" })).toBe(0);
  });

  test("does nothing if user has no credits", async () => {
    await setupTestUser("user_1", "cus_test_user");

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "subscriber",
    });

    const subscription = createMockSubscription({
      id: "sub_cancel_empty",
      priceId: "price_basic_monthly",
      customerId: "cus_test_user",
      status: "canceled",
    });

    // Should not throw
    await lifecycle.onSubscriptionCancelled(subscription);

    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(0);
  });
});

// =============================================================================
// Tests: Edge Cases
// =============================================================================

describe("Lifecycle: Edge Cases", () => {
  test("handles unknown user gracefully", async () => {
    // Don't set up user - customer doesn't exist in DB

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "subscriber",
    });

    const subscription = createMockSubscription({
      id: "sub_unknown",
      priceId: "price_pro_monthly",
      customerId: "cus_nonexistent",
    });

    // Should not throw, just skip
    await lifecycle.onSubscriptionCreated(subscription);

    // No credits granted
    const allBalances = await credits.getAllBalances({ userId: "unknown_user" });
    expect(Object.keys(allBalances).length).toBe(0);
  });

  test("handles unknown plan gracefully", async () => {
    await setupTestUser("user_1", "cus_test_user");

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "subscriber",
    });

    const subscription = createMockSubscription({
      id: "sub_unknown_plan",
      priceId: "price_does_not_exist",
      customerId: "cus_test_user",
    });

    // Should not throw, just skip
    await lifecycle.onSubscriptionCreated(subscription);

    // No credits granted
    const allBalances = await credits.getAllBalances({ userId: "user_1" });
    expect(Object.keys(allBalances).length).toBe(0);
  });

  test("callbacks are invoked on credit changes", async () => {
    await setupTestUser("user_1", "cus_test_user");

    const grantedCredits: Array<{ key: string; amount: number }> = [];

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "subscriber",
      callbacks: {
        onCreditsGranted: ({ key, amount }) => {
          grantedCredits.push({ key, amount });
        },
      },
    });

    const subscription = createMockSubscription({
      id: "sub_callback",
      priceId: "price_pro_monthly",
      customerId: "cus_test_user",
    });

    await lifecycle.onSubscriptionCreated(subscription);

    expect(grantedCredits).toContainEqual({ key: "api_calls", amount: 10000 });
    expect(grantedCredits).toContainEqual({ key: "storage_gb", amount: 100 });
  });

  test("same plan change does nothing", async () => {
    await setupTestUser("user_1", "cus_test_user");

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "subscriber",
    });

    // Start with Basic
    const basicSub = createMockSubscription({
      id: "sub_same",
      priceId: "price_basic_monthly",
      customerId: "cus_test_user",
    });
    await lifecycle.onSubscriptionCreated(basicSub);
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(1000);

    // "Change" to same plan (e.g., billing interval change within same plan)
    await lifecycle.onSubscriptionPlanChanged(basicSub, "price_basic_monthly");

    // Credits should be unchanged
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(1000);
  });
});

// =============================================================================
// Tests: Seat-Users Mode Lifecycle
// =============================================================================

describe("Lifecycle: Seat-Users Mode", () => {
  test("onSubscriptionCreated grants credits to first_seat_user_id if present", async () => {
    // In seat-users mode, credits go to individual seat users, not the org
    // When subscription is created, if first_seat_user_id is in metadata, grant to that user
    await setupTestUser("org_1", "cus_org_1");

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "seat-users",
    });

    const subscription = createMockSubscription({
      id: "sub_seat_1",
      priceId: "price_basic_monthly",
      customerId: "cus_org_1",
      metadata: { first_seat_user_id: "user_alice" },
    });

    await lifecycle.onSubscriptionCreated(subscription);

    // Credits should go to user_alice, not org_1
    expect(await credits.getBalance({ userId: "user_alice", key: "api_calls" })).toBe(1000);
    expect(await credits.getBalance({ userId: "org_1", key: "api_calls" })).toBe(0);
  });

  test("onSubscriptionCreated does nothing without first_seat_user_id in seat-users mode", async () => {
    await setupTestUser("org_1", "cus_org_1");

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "seat-users",
    });

    const subscription = createMockSubscription({
      id: "sub_seat_2",
      priceId: "price_basic_monthly",
      customerId: "cus_org_1",
      // No first_seat_user_id
    });

    await lifecycle.onSubscriptionCreated(subscription);

    // No credits granted - developer will manually add seats
    expect(await credits.getBalance({ userId: "org_1", key: "api_calls" })).toBe(0);
  });

  test("onSubscriptionRenewed grants to all active seat users", async () => {
    await setupTestUser("org_1", "cus_org_1");

    // Simulate existing seat users with credits (from previous grant)
    // These users would be found via getActiveSeatUsers
    await credits.grant({
      userId: "user_alice",
      key: "api_calls",
      amount: 500,
      source: "seat_grant",
      sourceId: "sub_seat_renewal",
    });
    await credits.grant({
      userId: "user_bob",
      key: "api_calls",
      amount: 500,
      source: "seat_grant",
      sourceId: "sub_seat_renewal",
    });

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "seat-users",
    });

    const subscription = createMockSubscription({
      id: "sub_seat_renewal",
      priceId: "price_basic_monthly",
      customerId: "cus_org_1",
    });

    await lifecycle.onSubscriptionRenewed(subscription, "inv_renewal_1");

    // Both users should get renewed credits (reset to 1000 each)
    expect(await credits.getBalance({ userId: "user_alice", key: "api_calls" })).toBe(1000);
    expect(await credits.getBalance({ userId: "user_bob", key: "api_calls" })).toBe(1000);
  });

  test("onSubscriptionCancelled revokes from all seat users", async () => {
    await setupTestUser("org_1", "cus_org_1");

    // Give credits to seat users
    await credits.grant({
      userId: "user_alice",
      key: "api_calls",
      amount: 1000,
      source: "seat_grant",
      sourceId: "sub_seat_cancel",
    });
    await credits.grant({
      userId: "user_bob",
      key: "api_calls",
      amount: 1000,
      source: "seat_grant",
      sourceId: "sub_seat_cancel",
    });

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "seat-users",
    });

    const subscription = createMockSubscription({
      id: "sub_seat_cancel",
      priceId: "price_basic_monthly",
      customerId: "cus_org_1",
      status: "canceled",
    });

    await lifecycle.onSubscriptionCancelled(subscription);

    // All seat users should have credits revoked
    expect(await credits.getBalance({ userId: "user_alice", key: "api_calls" })).toBe(0);
    expect(await credits.getBalance({ userId: "user_bob", key: "api_calls" })).toBe(0);
  });

  test("manual mode does nothing in lifecycle hooks", async () => {
    await setupTestUser("user_1", "cus_test_user");

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "manual",
    });

    const subscription = createMockSubscription({
      id: "sub_manual",
      priceId: "price_pro_monthly",
      customerId: "cus_test_user",
    });

    await lifecycle.onSubscriptionCreated(subscription);
    await lifecycle.onSubscriptionRenewed(subscription, "inv_manual");

    // No credits granted in manual mode
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(0);
  });
});

// =============================================================================
// Tests: Yearly Plan Support - New Subscription
// =============================================================================

describe("Lifecycle: Yearly Plans - New Subscription", () => {
  test("yearly subscription grants 12x monthly allocation", async () => {
    await setupTestUser("user_1", "cus_test_user");

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "subscriber",
    });

    const subscription = createMockSubscription({
      id: "sub_yearly_1",
      priceId: "price_basic_yearly",
      customerId: "cus_test_user",
      interval: "year",
    });

    await lifecycle.onSubscriptionCreated(subscription);

    // Basic plan: 1000 api_calls monthly → 12000 yearly
    const balance = await credits.getBalance({ userId: "user_1", key: "api_calls" });
    expect(balance).toBe(12000);
  });

  test("yearly subscription grants 12x for multiple credit types", async () => {
    await setupTestUser("user_1", "cus_test_user");

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "subscriber",
    });

    const subscription = createMockSubscription({
      id: "sub_yearly_pro",
      priceId: "price_pro_yearly",
      customerId: "cus_test_user",
      interval: "year",
    });

    await lifecycle.onSubscriptionCreated(subscription);

    // Pro plan: 10000 api_calls, 100 storage_gb → 120000, 1200
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(120000);
    expect(await credits.getBalance({ userId: "user_1", key: "storage_gb" })).toBe(1200);
  });

  test("weekly subscription grants 0.25x monthly allocation (rounded up)", async () => {
    await setupTestUser("user_1", "cus_test_user");

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "subscriber",
    });

    const subscription = createMockSubscription({
      id: "sub_weekly_1",
      priceId: "price_basic_weekly",
      customerId: "cus_test_user",
      interval: "week",
    });

    await lifecycle.onSubscriptionCreated(subscription);

    // Basic plan: 1000 api_calls monthly → ceil(1000/4) = 250 weekly
    const balance = await credits.getBalance({ userId: "user_1", key: "api_calls" });
    expect(balance).toBe(250);
  });

  test("weekly with non-divisible allocation rounds up", async () => {
    // Create a custom config with a non-divisible allocation
    const customConfig: BillingConfig = {
      test: {
        plans: [
          {
            id: "odd",
            name: "Odd Plan",
            price: [{ id: "price_odd_weekly", amount: 299, currency: "usd", interval: "week" }],
            features: { api_calls: { credits: { allocation: 100 } } }, // 100/4 = 25
          },
          {
            id: "odd2",
            name: "Odd Plan 2",
            price: [{ id: "price_odd2_weekly", amount: 299, currency: "usd", interval: "week" }],
            features: { api_calls: { credits: { allocation: 99 } } }, // 99/4 = 24.75 → ceil = 25
          },
        ],
      },
    };

    await setupTestUser("user_1", "cus_test_user");

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: customConfig,
      mode: "test",
      grantTo: "subscriber",
    });

    const sub1 = createMockSubscription({
      id: "sub_odd1",
      priceId: "price_odd_weekly",
      customerId: "cus_test_user",
      interval: "week",
    });

    await lifecycle.onSubscriptionCreated(sub1);
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(25); // ceil(100/4)

    // Clean up for next test
    await credits.revokeAll({ userId: "user_1", key: "api_calls", source: "manual" });

    const sub2 = createMockSubscription({
      id: "sub_odd2",
      priceId: "price_odd2_weekly",
      customerId: "cus_test_user",
      interval: "week",
    });

    await lifecycle.onSubscriptionCreated(sub2);
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(25); // ceil(99/4) = 25
  });
});

// =============================================================================
// Tests: Yearly Plan Support - Renewal
// =============================================================================

describe("Lifecycle: Yearly Plans - Renewal", () => {
  test("yearly renewal grants 12x credits with onRenewal: reset", async () => {
    await setupTestUser("user_1", "cus_test_user");

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "subscriber",
    });

    // User has 5000 remaining from previous year
    await credits.grant({
      userId: "user_1",
      key: "api_calls",
      amount: 5000,
      source: "subscription",
      sourceId: "sub_yearly_renew",
    });

    const subscription = createMockSubscription({
      id: "sub_yearly_renew",
      priceId: "price_basic_yearly",
      customerId: "cus_test_user",
      interval: "year",
    });

    await lifecycle.onSubscriptionRenewed(subscription, "inv_yearly_1");

    // Should reset to 12000 (unused 5000 lost)
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(12000);
  });

  test("yearly renewal with onRenewal: add accumulates 12x", async () => {
    await setupTestUser("user_1", "cus_test_user");

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "subscriber",
    });

    // User has 500 storage remaining (Pro has onRenewal: "add" for storage)
    await credits.grant({
      userId: "user_1",
      key: "storage_gb",
      amount: 500,
      source: "subscription",
      sourceId: "sub_yearly_add",
    });

    const subscription = createMockSubscription({
      id: "sub_yearly_add",
      priceId: "price_pro_yearly",
      customerId: "cus_test_user",
      interval: "year",
    });

    await lifecycle.onSubscriptionRenewed(subscription, "inv_yearly_add");

    // storage_gb: 500 existing + 1200 (100 * 12) = 1700
    expect(await credits.getBalance({ userId: "user_1", key: "storage_gb" })).toBe(1700);
    // api_calls: reset to 120000
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(120000);
  });

  test("weekly renewal grants 0.25x credits", async () => {
    await setupTestUser("user_1", "cus_test_user");

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "subscriber",
    });

    // User has 100 remaining from previous week
    await credits.grant({
      userId: "user_1",
      key: "api_calls",
      amount: 100,
      source: "subscription",
      sourceId: "sub_weekly_renew",
    });

    const subscription = createMockSubscription({
      id: "sub_weekly_renew",
      priceId: "price_basic_weekly",
      customerId: "cus_test_user",
      interval: "week",
    });

    await lifecycle.onSubscriptionRenewed(subscription, "inv_weekly_1");

    // Should reset to 250 (ceil(1000/4))
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(250);
  });
});

// =============================================================================
// Tests: Yearly Plan Support - Same-Plan Interval Changes
// =============================================================================

describe("Lifecycle: Yearly Plans - Same-Plan Interval Changes", () => {
  test("monthly to yearly upgrade: keeps old credits + grants 12x new", async () => {
    await setupTestUser("user_1", "cus_test_user");

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "subscriber",
    });

    // Start with Basic Monthly
    const monthlySub = createMockSubscription({
      id: "sub_interval_change",
      priceId: "price_basic_monthly",
      customerId: "cus_test_user",
      interval: "month",
    });
    await lifecycle.onSubscriptionCreated(monthlySub);
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(1000);

    // Consume some credits
    await credits.consume({ userId: "user_1", key: "api_calls", amount: 300 });
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(700);

    // Upgrade to Basic Yearly (same plan, different interval)
    const yearlySub = createMockSubscription({
      id: "sub_interval_change",
      priceId: "price_basic_yearly",
      customerId: "cus_test_user",
      interval: "year",
      metadata: {
        upgrade_from_price_id: "price_basic_monthly",
        upgrade_from_price_amount: "999", // Non-zero = paid, so keep old credits
      },
    });

    await lifecycle.onSubscriptionPlanChanged(yearlySub, "price_basic_monthly");

    // Should keep 700 + get 12000 = 12700
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(12700);
  });

  test("yearly to monthly downgrade: scheduled, grants monthly at period end", async () => {
    await setupTestUser("user_1", "cus_test_user");

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "subscriber",
    });

    // User has yearly credits
    await credits.grant({
      userId: "user_1",
      key: "api_calls",
      amount: 12000,
      source: "subscription",
      sourceId: "sub_yearly_downgrade",
    });

    // Consume some
    await credits.consume({ userId: "user_1", key: "api_calls", amount: 4000 });
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(8000);

    // Schedule downgrade (credits unchanged immediately)
    const scheduledSub = createMockSubscription({
      id: "sub_yearly_downgrade",
      priceId: "price_basic_monthly",
      customerId: "cus_test_user",
      interval: "month",
      metadata: {
        pending_credit_downgrade: "true",
        downgrade_from_price: "price_basic_yearly",
      },
    });

    await lifecycle.onSubscriptionPlanChanged(scheduledSub, "price_basic_yearly");

    // Credits unchanged (still 8000)
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(8000);

    // At period end, downgrade applied
    const appliedSub = createMockSubscription({
      id: "sub_yearly_downgrade",
      priceId: "price_basic_monthly",
      customerId: "cus_test_user",
      interval: "month",
    });

    await lifecycle.onDowngradeApplied(appliedSub, "price_basic_monthly");

    // Should reset to monthly allocation (1000)
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(1000);
  });
});

// =============================================================================
// Tests: Yearly Plan Support - Cross-Plan Upgrades with Intervals
// =============================================================================

describe("Lifecycle: Yearly Plans - Cross-Plan Upgrades", () => {
  test("Basic Monthly to Pro Yearly: keeps old + grants 12x Pro", async () => {
    await setupTestUser("user_1", "cus_test_user");

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "subscriber",
    });

    // Start with Basic Monthly
    const basicSub = createMockSubscription({
      id: "sub_cross_upgrade",
      priceId: "price_basic_monthly",
      customerId: "cus_test_user",
      interval: "month",
    });
    await lifecycle.onSubscriptionCreated(basicSub);
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(1000);

    // Consume some
    await credits.consume({ userId: "user_1", key: "api_calls", amount: 400 });
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(600);

    // Upgrade to Pro Yearly
    const proYearlySub = createMockSubscription({
      id: "sub_cross_upgrade",
      priceId: "price_pro_yearly",
      customerId: "cus_test_user",
      interval: "year",
      metadata: {
        upgrade_from_price_id: "price_basic_monthly",
        upgrade_from_price_amount: "999",
      },
    });

    await lifecycle.onSubscriptionPlanChanged(proYearlySub, "price_basic_monthly");

    // api_calls: 600 (kept) + 120000 (Pro yearly) = 120600
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(120600);
    // storage_gb: new credit type, 100 * 12 = 1200
    expect(await credits.getBalance({ userId: "user_1", key: "storage_gb" })).toBe(1200);
  });

  test("Free Monthly to Pro Yearly: revokes free, grants 12x Pro", async () => {
    await setupTestUser("user_1", "cus_test_user");

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "subscriber",
    });

    // Start with Free plan
    const freeSub = createMockSubscription({
      id: "sub_free_to_yearly",
      priceId: "price_free_monthly",
      customerId: "cus_test_user",
      interval: "month",
    });
    await lifecycle.onSubscriptionCreated(freeSub);
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(100);

    // Upgrade to Pro Yearly (Free → Paid)
    const proYearlySub = createMockSubscription({
      id: "sub_free_to_yearly",
      priceId: "price_pro_yearly",
      customerId: "cus_test_user",
      interval: "year",
      metadata: {
        upgrade_from_price_id: "price_free_monthly",
        upgrade_from_price_amount: "0", // Free plan indicator
      },
    });

    await lifecycle.onSubscriptionPlanChanged(proYearlySub, "price_free_monthly");

    // api_calls: revoked free 100, granted 120000
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(120000);
    // storage_gb: 1200 (new credit type)
    expect(await credits.getBalance({ userId: "user_1", key: "storage_gb" })).toBe(1200);
  });
});

// =============================================================================
// Tests: Yearly Plan Support - Downgrades with Intervals
// =============================================================================

describe("Lifecycle: Yearly Plans - Downgrades", () => {
  test("Pro Yearly to Basic Monthly downgrade: resets to monthly Basic allocation", async () => {
    await setupTestUser("user_1", "cus_test_user");

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "subscriber",
    });

    // User has Pro yearly credits
    await credits.grant({
      userId: "user_1",
      key: "api_calls",
      amount: 120000,
      source: "subscription",
      sourceId: "sub_yearly_to_monthly",
    });
    await credits.grant({
      userId: "user_1",
      key: "storage_gb",
      amount: 1200,
      source: "subscription",
      sourceId: "sub_yearly_to_monthly",
    });

    // Consume some
    await credits.consume({ userId: "user_1", key: "api_calls", amount: 50000 });
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(70000);

    // Downgrade applied at period end to Basic Monthly
    const downgradedSub = createMockSubscription({
      id: "sub_yearly_to_monthly",
      priceId: "price_basic_monthly",
      customerId: "cus_test_user",
      interval: "month",
    });

    await lifecycle.onDowngradeApplied(downgradedSub, "price_basic_monthly");

    // api_calls: reset to monthly Basic (1000)
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(1000);
    // storage_gb: revoked (not in Basic plan)
    expect(await credits.getBalance({ userId: "user_1", key: "storage_gb" })).toBe(0);
  });

  test("Pro Yearly to Basic Yearly downgrade: resets to yearly Basic allocation", async () => {
    await setupTestUser("user_1", "cus_test_user");

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "subscriber",
    });

    // User has Pro yearly credits
    await credits.grant({
      userId: "user_1",
      key: "api_calls",
      amount: 120000,
      source: "subscription",
      sourceId: "sub_yearly_to_yearly",
    });
    await credits.grant({
      userId: "user_1",
      key: "storage_gb",
      amount: 1200,
      source: "subscription",
      sourceId: "sub_yearly_to_yearly",
    });

    // Downgrade applied at period end to Basic Yearly
    const downgradedSub = createMockSubscription({
      id: "sub_yearly_to_yearly",
      priceId: "price_basic_yearly",
      customerId: "cus_test_user",
      interval: "year",
    });

    await lifecycle.onDowngradeApplied(downgradedSub, "price_basic_yearly");

    // api_calls: reset to yearly Basic (1000 * 12 = 12000)
    expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(12000);
    // storage_gb: revoked (not in Basic plan)
    expect(await credits.getBalance({ userId: "user_1", key: "storage_gb" })).toBe(0);
  });
});

// =============================================================================
// Tests: Yearly Plan Support - Seat-Users Mode
// =============================================================================

describe("Lifecycle: Yearly Plans - Seat-Users Mode", () => {
  test("yearly subscription grants 12x to first seat user", async () => {
    await setupTestUser("org_1", "cus_org_1");

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "seat-users",
    });

    const subscription = createMockSubscription({
      id: "sub_seat_yearly",
      priceId: "price_basic_yearly",
      customerId: "cus_org_1",
      interval: "year",
      metadata: { first_seat_user_id: "user_alice" },
    });

    await lifecycle.onSubscriptionCreated(subscription);

    // user_alice should get 12x credits
    expect(await credits.getBalance({ userId: "user_alice", key: "api_calls" })).toBe(12000);
    expect(await credits.getBalance({ userId: "org_1", key: "api_calls" })).toBe(0);
  });

  test("yearly renewal grants 12x to all seat users", async () => {
    await setupTestUser("org_1", "cus_org_1");

    // Set up existing seat users
    await credits.grant({
      userId: "user_alice",
      key: "api_calls",
      amount: 5000,
      source: "seat_grant",
      sourceId: "sub_seat_yearly_renew",
    });
    await credits.grant({
      userId: "user_bob",
      key: "api_calls",
      amount: 3000,
      source: "seat_grant",
      sourceId: "sub_seat_yearly_renew",
    });

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "seat-users",
    });

    const subscription = createMockSubscription({
      id: "sub_seat_yearly_renew",
      priceId: "price_basic_yearly",
      customerId: "cus_org_1",
      interval: "year",
    });

    await lifecycle.onSubscriptionRenewed(subscription, "inv_seat_yearly");

    // Both users should get reset to 12000 each
    expect(await credits.getBalance({ userId: "user_alice", key: "api_calls" })).toBe(12000);
    expect(await credits.getBalance({ userId: "user_bob", key: "api_calls" })).toBe(12000);
  });
});
