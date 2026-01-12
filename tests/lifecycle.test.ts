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
        credits: {
          api_calls: { allocation: 100 },
        },
      },
      {
        id: "basic",
        name: "Basic",
        price: [{ id: "price_basic_monthly", amount: 999, currency: "usd", interval: "month" }],
        credits: {
          api_calls: { allocation: 1000, onRenewal: "reset" },
        },
      },
      {
        id: "pro",
        name: "Pro",
        price: [{ id: "price_pro_monthly", amount: 2999, currency: "usd", interval: "month" }],
        credits: {
          api_calls: { allocation: 10000, onRenewal: "reset" },
          storage_gb: { allocation: 100, onRenewal: "add" },
        },
      },
      {
        id: "enterprise",
        name: "Enterprise",
        price: [{ id: "price_enterprise_monthly", amount: 9999, currency: "usd", interval: "month" }],
        credits: {
          api_calls: { allocation: 100000, onRenewal: "reset" },
          storage_gb: { allocation: 1000, onRenewal: "add" },
          seats: { allocation: 50, onRenewal: "reset" },
        },
      },
      {
        id: "no_credits",
        name: "No Credits Plan",
        price: [{ id: "price_no_credits", amount: 499, currency: "usd", interval: "month" }],
        // No credits configured
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
}): Stripe.Subscription {
  const { priceId, customerId = "cus_test_user", ...rest } = overrides;

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
    const apiBalance = await credits.getBalance("user_1", "api_calls");
    const storageBalance = await credits.getBalance("user_1", "storage_gb");

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

    const allBalances = await credits.getAllBalances("user_1");
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
    expect(await credits.getBalance("user_1", "api_calls")).toBe(100000);
    expect(await credits.getBalance("user_1", "storage_gb")).toBe(1000);
    expect(await credits.getBalance("user_1", "seats")).toBe(50);
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
    expect(await credits.getBalance("user_1", "api_calls")).toBe(1000);

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
    expect(await credits.getBalance("user_1", "api_calls")).toBe(1000);
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
    const allBalances = await credits.getAllBalances("user_1");
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

    expect(await credits.getBalance("user_1", "api_calls")).toBe(100);

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
    expect(await credits.getBalance("user_1", "api_calls")).toBe(10000);
    expect(await credits.getBalance("user_1", "storage_gb")).toBe(100);
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
    await credits.consume({ userId: "user_1", creditType: "api_calls", amount: 60 });
    expect(await credits.getBalance("user_1", "api_calls")).toBe(40);

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
    expect(await credits.getBalance("user_1", "api_calls")).toBe(1000);
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

    expect(await credits.getBalance("user_1", "api_calls")).toBe(1000);

    // Consume some credits
    await credits.consume({ userId: "user_1", creditType: "api_calls", amount: 300 });
    expect(await credits.getBalance("user_1", "api_calls")).toBe(700);

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
    expect(await credits.getBalance("user_1", "api_calls")).toBe(10700);
    // Should also get storage credits (new credit type)
    expect(await credits.getBalance("user_1", "storage_gb")).toBe(100);
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
    expect(await credits.getBalance("user_1", "api_calls")).toBe(1000 + 100000);
    expect(await credits.getBalance("user_1", "storage_gb")).toBe(1000);
    expect(await credits.getBalance("user_1", "seats")).toBe(50);
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

    expect(await credits.getBalance("user_1", "api_calls")).toBe(10000);
    expect(await credits.getBalance("user_1", "storage_gb")).toBe(100);

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
    expect(await credits.getBalance("user_1", "api_calls")).toBe(10000);
    expect(await credits.getBalance("user_1", "storage_gb")).toBe(100);
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
    await credits.grant({ userId: "user_1", creditType: "api_calls", amount: 10000, source: "subscription", sourceId: "sub_downgrade_2" });
    await credits.grant({ userId: "user_1", creditType: "storage_gb", amount: 100, source: "subscription", sourceId: "sub_downgrade_2" });

    // Consume some
    await credits.consume({ userId: "user_1", creditType: "api_calls", amount: 3000 });
    expect(await credits.getBalance("user_1", "api_calls")).toBe(7000);

    // Downgrade applied at renewal
    const downgradedSub = createMockSubscription({
      id: "sub_downgrade_2",
      priceId: "price_basic_monthly",
      customerId: "cus_test_user",
    });

    await lifecycle.onDowngradeApplied(downgradedSub, "price_basic_monthly");

    // api_calls: reset to Basic allocation (1000) because onRenewal: "reset"
    expect(await credits.getBalance("user_1", "api_calls")).toBe(1000);
    // storage_gb: revoked entirely (not in Basic plan)
    expect(await credits.getBalance("user_1", "storage_gb")).toBe(0);
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
            credits: { api_calls: { allocation: 10000 } },
          },
          {
            id: "basic_add",
            name: "Basic Add",
            price: [{ id: "price_basic_add", amount: 999, currency: "usd", interval: "month" }],
            credits: { api_calls: { allocation: 500, onRenewal: "add" } },
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
    await credits.grant({ userId: "user_1", creditType: "api_calls", amount: 7000, source: "subscription", sourceId: "sub_add" });

    const downgradedSub = createMockSubscription({
      id: "sub_add",
      priceId: "price_basic_add",
      customerId: "cus_test_user",
    });

    await lifecycle.onDowngradeApplied(downgradedSub, "price_basic_add");

    // With onRenewal: "add", should keep 7000 + add 500 = 7500
    expect(await credits.getBalance("user_1", "api_calls")).toBe(7500);
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
    await credits.grant({ userId: "user_1", creditType: "api_calls", amount: 1000, source: "subscription", sourceId: "sub_renew" });
    await credits.consume({ userId: "user_1", creditType: "api_calls", amount: 500 });
    expect(await credits.getBalance("user_1", "api_calls")).toBe(500);

    const subscription = createMockSubscription({
      id: "sub_renew",
      priceId: "price_basic_monthly",
      customerId: "cus_test_user",
    });

    await lifecycle.onSubscriptionRenewed(subscription, "inv_renewal_1");

    // Should reset to 1000 (unused 500 lost)
    expect(await credits.getBalance("user_1", "api_calls")).toBe(1000);
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
    await credits.grant({ userId: "user_1", creditType: "storage_gb", amount: 100, source: "subscription", sourceId: "sub_add_renew" });
    await credits.consume({ userId: "user_1", creditType: "storage_gb", amount: 50 });
    expect(await credits.getBalance("user_1", "storage_gb")).toBe(50);

    // Also set up api_calls which uses "reset"
    await credits.grant({ userId: "user_1", creditType: "api_calls", amount: 10000, source: "subscription", sourceId: "sub_add_renew" });
    await credits.consume({ userId: "user_1", creditType: "api_calls", amount: 3000 });
    expect(await credits.getBalance("user_1", "api_calls")).toBe(7000);

    const subscription = createMockSubscription({
      id: "sub_add_renew",
      priceId: "price_pro_monthly",
      customerId: "cus_test_user",
    });

    await lifecycle.onSubscriptionRenewed(subscription, "inv_renewal_2");

    // api_calls: reset to 10000 (7000 lost)
    expect(await credits.getBalance("user_1", "api_calls")).toBe(10000);
    // storage_gb: add 100 to existing 50 = 150
    expect(await credits.getBalance("user_1", "storage_gb")).toBe(150);
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
    expect(await credits.getBalance("user_1", "api_calls")).toBe(1000);

    // Second call with same invoice throws idempotency error
    let error: Error | null = null;
    try {
      await lifecycle.onSubscriptionRenewed(subscription, "inv_same");
    } catch (e) {
      error = e as Error;
    }

    expect(error).not.toBeNull();
    expect(error?.message).toContain("already processed");

    // Balance unchanged
    expect(await credits.getBalance("user_1", "api_calls")).toBe(1000);
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
    await credits.grant({ userId: "user_1", creditType: "api_calls", amount: 5000, source: "subscription", sourceId: "sub_cancel" });
    await credits.grant({ userId: "user_1", creditType: "storage_gb", amount: 100, source: "subscription", sourceId: "sub_cancel" });

    // User also has top-up credits
    await credits.grant({ userId: "user_1", creditType: "api_calls", amount: 1000, source: "topup", sourceId: "topup_1" });

    expect(await credits.getBalance("user_1", "api_calls")).toBe(6000);
    expect(await credits.getBalance("user_1", "storage_gb")).toBe(100);

    const subscription = createMockSubscription({
      id: "sub_cancel",
      priceId: "price_pro_monthly",
      customerId: "cus_test_user",
      status: "canceled",
    });

    await lifecycle.onSubscriptionCancelled(subscription);

    // ALL credits revoked (including top-ups) because user loses service access
    expect(await credits.getBalance("user_1", "api_calls")).toBe(0);
    expect(await credits.getBalance("user_1", "storage_gb")).toBe(0);
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

    expect(await credits.getBalance("user_1", "api_calls")).toBe(0);
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
    const allBalances = await credits.getAllBalances("unknown_user");
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
    const allBalances = await credits.getAllBalances("user_1");
    expect(Object.keys(allBalances).length).toBe(0);
  });

  test("callbacks are invoked on credit changes", async () => {
    await setupTestUser("user_1", "cus_test_user");

    const grantedCredits: Array<{ creditType: string; amount: number }> = [];

    const lifecycle = createCreditLifecycle({
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "subscriber",
      callbacks: {
        onCreditsGranted: ({ creditType, amount }) => {
          grantedCredits.push({ creditType, amount });
        },
      },
    });

    const subscription = createMockSubscription({
      id: "sub_callback",
      priceId: "price_pro_monthly",
      customerId: "cus_test_user",
    });

    await lifecycle.onSubscriptionCreated(subscription);

    expect(grantedCredits).toContainEqual({ creditType: "api_calls", amount: 10000 });
    expect(grantedCredits).toContainEqual({ creditType: "storage_gb", amount: 100 });
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
    expect(await credits.getBalance("user_1", "api_calls")).toBe(1000);

    // "Change" to same plan (e.g., billing interval change within same plan)
    await lifecycle.onSubscriptionPlanChanged(basicSub, "price_basic_monthly");

    // Credits should be unchanged
    expect(await credits.getBalance("user_1", "api_calls")).toBe(1000);
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
    expect(await credits.getBalance("user_alice", "api_calls")).toBe(1000);
    expect(await credits.getBalance("org_1", "api_calls")).toBe(0);
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
    expect(await credits.getBalance("org_1", "api_calls")).toBe(0);
  });

  test("onSubscriptionRenewed grants to all active seat users", async () => {
    await setupTestUser("org_1", "cus_org_1");

    // Simulate existing seat users with credits (from previous grant)
    // These users would be found via getActiveSeatUsers
    await credits.grant({
      userId: "user_alice",
      creditType: "api_calls",
      amount: 500,
      source: "seat_grant",
      sourceId: "sub_seat_renewal",
    });
    await credits.grant({
      userId: "user_bob",
      creditType: "api_calls",
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
    expect(await credits.getBalance("user_alice", "api_calls")).toBe(1000);
    expect(await credits.getBalance("user_bob", "api_calls")).toBe(1000);
  });

  test("onSubscriptionCancelled revokes from all seat users", async () => {
    await setupTestUser("org_1", "cus_org_1");

    // Give credits to seat users
    await credits.grant({
      userId: "user_alice",
      creditType: "api_calls",
      amount: 1000,
      source: "seat_grant",
      sourceId: "sub_seat_cancel",
    });
    await credits.grant({
      userId: "user_bob",
      creditType: "api_calls",
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
    expect(await credits.getBalance("user_alice", "api_calls")).toBe(0);
    expect(await credits.getBalance("user_bob", "api_calls")).toBe(0);
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
    expect(await credits.getBalance("user_1", "api_calls")).toBe(0);
  });
});
