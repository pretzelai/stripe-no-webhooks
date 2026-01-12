import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { Pool } from "pg";
import {
  setupTestDb,
  cleanupTestData,
  teardownTestDb,
  seedCustomer,
  seedPrice,
  seedSubscription,
  seedUserMap,
  cleanupAllTestData,
} from "./setup";
import { initCredits, credits } from "../src/credits";
import { createSeatsApi } from "../src/credits/seats";
import type { BillingConfig } from "../src/BillingConfig";
import StripeMock from "./stripe-mock";

let pool: Pool;
let stripe: StripeMock;

// =============================================================================
// Test Billing Config
// =============================================================================

const TEST_BILLING_CONFIG: BillingConfig = {
  test: {
    plans: [
      {
        id: "team",
        name: "Team",
        price: [{ id: "price_team_monthly", amount: 2999, currency: "usd", interval: "month" }],
        credits: {
          api_calls: { allocation: 5000, onRenewal: "reset" },
          storage_gb: { allocation: 50, onRenewal: "add" },
        },
      },
      {
        id: "team_per_seat",
        name: "Team Per Seat",
        price: [{ id: "price_team_per_seat", amount: 1999, currency: "usd", interval: "month" }],
        perSeat: true,
        credits: {
          api_calls: { allocation: 1000, onRenewal: "reset" },
        },
      },
      {
        id: "enterprise",
        name: "Enterprise",
        price: [{ id: "price_enterprise", amount: 9999, currency: "usd", interval: "month" }],
        credits: {
          api_calls: { allocation: 100000, onRenewal: "reset" },
          storage_gb: { allocation: 1000, onRenewal: "add" },
        },
      },
      {
        id: "no_credits",
        name: "No Credits",
        price: [{ id: "price_no_credits", amount: 999, currency: "usd", interval: "month" }],
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
  stripe = new StripeMock("sk_test_mock");
});

beforeEach(async () => {
  await cleanupAllTestData();
  stripe = new StripeMock("sk_test_mock"); // Fresh mock for each test
});

afterAll(async () => {
  await teardownTestDb();
});

// =============================================================================
// Helper: Setup org with subscription
// =============================================================================

async function setupOrgWithSubscription(
  orgId: string,
  customerId: string,
  subscriptionId: string,
  priceId: string,
  quantity = 1
): Promise<void> {
  // Seed price
  await seedPrice({ id: priceId, productId: "prod_test", unitAmount: 2999 });

  // Seed customer for org
  await seedCustomer({ id: customerId, metadata: { user_id: orgId } });

  // Seed subscription
  await seedSubscription({
    id: subscriptionId,
    customerId,
    priceId,
    quantity,
  });

  // Map org to customer
  await seedUserMap({ userId: orgId, stripeCustomerId: customerId });

  // Also add to Stripe mock (append, not replace)
  stripe._addCustomer({ id: customerId, metadata: { user_id: orgId } });
  stripe._addPrice({
    id: priceId,
    product: "prod_test",
    unit_amount: 2999,
    currency: "usd",
    recurring: { interval: "month" },
  });
  stripe._addSubscription({
    id: subscriptionId,
    customer: customerId,
    status: "active",
    items: {
      object: "list",
      data: [{
        id: `si_${subscriptionId.replace("sub_", "")}`,
        price: { id: priceId },
        quantity,
      }],
    },
    current_period_start: Math.floor(Date.now() / 1000),
    current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
  });
}

// =============================================================================
// Tests: Add Seat (seat-users mode)
// =============================================================================

describe("Seats: Add Seat (seat-users mode)", () => {
  test("grants credits to user when added as seat", async () => {
    await setupOrgWithSubscription("org_1", "cus_org_1", "sub_team_1", "price_team_monthly");

    const seatsApi = createSeatsApi({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "seat-users",
    });

    const result = await seatsApi.add({ userId: "user_alice", orgId: "org_1" });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.creditsGranted).toEqual({
        api_calls: 5000,
        storage_gb: 50,
      });
    }

    // Verify user has credits
    const apiBalance = await credits.getBalance("user_alice", "api_calls");
    const storageBalance = await credits.getBalance("user_alice", "storage_gb");
    expect(apiBalance).toBe(5000);
    expect(storageBalance).toBe(50);
  });

  test("multiple users can be added as seats", async () => {
    await setupOrgWithSubscription("org_1", "cus_org_1", "sub_team_1", "price_team_monthly");

    const seatsApi = createSeatsApi({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "seat-users",
    });

    await seatsApi.add({ userId: "user_alice", orgId: "org_1" });
    await seatsApi.add({ userId: "user_bob", orgId: "org_1" });
    await seatsApi.add({ userId: "user_carol", orgId: "org_1" });

    // Each user should have their own credits
    expect(await credits.getBalance("user_alice", "api_calls")).toBe(5000);
    expect(await credits.getBalance("user_bob", "api_calls")).toBe(5000);
    expect(await credits.getBalance("user_carol", "api_calls")).toBe(5000);
  });

  test("idempotent: adding same seat twice returns success without double-granting", async () => {
    await setupOrgWithSubscription("org_1", "cus_org_1", "sub_team_1", "price_team_monthly");

    const seatsApi = createSeatsApi({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "seat-users",
    });

    // Add seat twice
    const result1 = await seatsApi.add({ userId: "user_alice", orgId: "org_1" });
    const result2 = await seatsApi.add({ userId: "user_alice", orgId: "org_1" });

    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);

    // Should only have one allocation's worth of credits
    expect(await credits.getBalance("user_alice", "api_calls")).toBe(5000);
  });

  test("fails if org has no Stripe customer", async () => {
    const seatsApi = createSeatsApi({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "seat-users",
    });

    const result = await seatsApi.add({ userId: "user_alice", orgId: "nonexistent_org" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("no Stripe customer");
    }
  });

  test("fails if org has no active subscription", async () => {
    // Seed customer but no subscription
    await seedCustomer({ id: "cus_org_1", metadata: { user_id: "org_1" } });
    await seedUserMap({ userId: "org_1", stripeCustomerId: "cus_org_1" });

    const seatsApi = createSeatsApi({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "seat-users",
    });

    const result = await seatsApi.add({ userId: "user_alice", orgId: "org_1" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("No active subscription");
    }
  });

  test("user cannot be seat of multiple orgs", async () => {
    // Setup two orgs with subscriptions
    await setupOrgWithSubscription("org_1", "cus_org_1", "sub_team_1", "price_team_monthly");
    await setupOrgWithSubscription("org_2", "cus_org_2", "sub_team_2", "price_team_monthly");

    const seatsApi = createSeatsApi({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "seat-users",
    });

    // Add user to first org
    const result1 = await seatsApi.add({ userId: "user_alice", orgId: "org_1" });
    expect(result1.success).toBe(true);

    // Try to add same user to second org - should fail
    const result2 = await seatsApi.add({ userId: "user_alice", orgId: "org_2" });
    expect(result2.success).toBe(false);
    if (!result2.success) {
      expect(result2.error).toContain("already a seat of another subscription");
    }
  });
});

// =============================================================================
// Tests: Add Seat (subscriber mode)
// =============================================================================

describe("Seats: Add Seat (subscriber mode)", () => {
  test("grants credits to org (shared pool) when seat added", async () => {
    await setupOrgWithSubscription("org_1", "cus_org_1", "sub_team_1", "price_team_monthly");

    const seatsApi = createSeatsApi({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "subscriber", // Credits go to org, not user
    });

    const result = await seatsApi.add({ userId: "user_alice", orgId: "org_1" });

    expect(result.success).toBe(true);

    // Org should have credits, not user
    expect(await credits.getBalance("org_1", "api_calls")).toBe(5000);
    expect(await credits.getBalance("user_alice", "api_calls")).toBe(0);
  });

  test("multiple seats add to org's shared pool", async () => {
    await setupOrgWithSubscription("org_1", "cus_org_1", "sub_team_1", "price_team_monthly");

    const seatsApi = createSeatsApi({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "subscriber",
    });

    await seatsApi.add({ userId: "user_alice", orgId: "org_1" });
    await seatsApi.add({ userId: "user_bob", orgId: "org_1" });

    // Org should have 2x credits (one per seat)
    expect(await credits.getBalance("org_1", "api_calls")).toBe(10000);
  });
});

// =============================================================================
// Tests: Remove Seat
// =============================================================================

describe("Seats: Remove Seat", () => {
  test("revokes credits from user when removed as seat", async () => {
    await setupOrgWithSubscription("org_1", "cus_org_1", "sub_team_1", "price_team_monthly");

    const seatsApi = createSeatsApi({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "seat-users",
    });

    // Add seat
    await seatsApi.add({ userId: "user_alice", orgId: "org_1" });
    expect(await credits.getBalance("user_alice", "api_calls")).toBe(5000);

    // Remove seat
    const result = await seatsApi.remove({ userId: "user_alice", orgId: "org_1" });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.creditsRevoked.api_calls).toBe(5000);
      expect(result.creditsRevoked.storage_gb).toBe(50);
    }

    // User should have no credits
    expect(await credits.getBalance("user_alice", "api_calls")).toBe(0);
    expect(await credits.getBalance("user_alice", "storage_gb")).toBe(0);
  });

  test("only revokes credits from this subscription (preserves top-ups)", async () => {
    await setupOrgWithSubscription("org_1", "cus_org_1", "sub_team_1", "price_team_monthly");

    const seatsApi = createSeatsApi({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "seat-users",
    });

    // Add seat
    await seatsApi.add({ userId: "user_alice", orgId: "org_1" });

    // User also has a top-up
    await credits.grant({
      userId: "user_alice",
      creditType: "api_calls",
      amount: 1000,
      source: "topup",
      sourceId: "topup_123",
    });

    expect(await credits.getBalance("user_alice", "api_calls")).toBe(6000);

    // Remove seat - should only revoke seat credits, not top-up
    await seatsApi.remove({ userId: "user_alice", orgId: "org_1" });

    // User should still have top-up credits
    expect(await credits.getBalance("user_alice", "api_calls")).toBe(1000);
  });

  test("revokes partial balance if user consumed some credits", async () => {
    await setupOrgWithSubscription("org_1", "cus_org_1", "sub_team_1", "price_team_monthly");

    const seatsApi = createSeatsApi({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "seat-users",
    });

    // Add seat
    await seatsApi.add({ userId: "user_alice", orgId: "org_1" });

    // User consumes some credits
    await credits.consume({
      userId: "user_alice",
      creditType: "api_calls",
      amount: 3000,
      description: "API usage",
    });

    expect(await credits.getBalance("user_alice", "api_calls")).toBe(2000);

    // Remove seat - should revoke remaining balance
    const result = await seatsApi.remove({ userId: "user_alice", orgId: "org_1" });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.creditsRevoked.api_calls).toBe(2000);
    }

    expect(await credits.getBalance("user_alice", "api_calls")).toBe(0);
  });
});

// =============================================================================
// Tests: Per-Seat Billing
// =============================================================================

describe("Seats: Per-Seat Billing", () => {
  test("increments subscription quantity when adding seat", async () => {
    await setupOrgWithSubscription("org_1", "cus_org_1", "sub_per_seat_1", "price_team_per_seat", 1);

    const seatsApi = createSeatsApi({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "seat-users",
    });

    // Add seat
    await seatsApi.add({ userId: "user_alice", orgId: "org_1" });

    // Check subscription quantity in mock
    const subscription = await stripe.subscriptions.retrieve("sub_per_seat_1");
    expect(subscription.items.data[0].quantity).toBe(2);
  });

  test("decrements subscription quantity when removing seat", async () => {
    await setupOrgWithSubscription("org_1", "cus_org_1", "sub_per_seat_1", "price_team_per_seat", 3);

    const seatsApi = createSeatsApi({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "seat-users",
    });

    // Add seat first (to create ledger entry)
    await seatsApi.add({ userId: "user_alice", orgId: "org_1" });

    // Remove seat
    await seatsApi.remove({ userId: "user_alice", orgId: "org_1" });

    // Check subscription quantity - should go down
    const subscription = await stripe.subscriptions.retrieve("sub_per_seat_1");
    expect(subscription.items.data[0].quantity).toBe(3); // Started at 3, +1, -1 = 3
  });

  test("does not go below 1 seat when removing", async () => {
    await setupOrgWithSubscription("org_1", "cus_org_1", "sub_per_seat_1", "price_team_per_seat", 1);

    const seatsApi = createSeatsApi({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "seat-users",
    });

    // Add and remove seat
    await seatsApi.add({ userId: "user_alice", orgId: "org_1" });
    await seatsApi.remove({ userId: "user_alice", orgId: "org_1" });

    // Quantity should still be at least 1
    const subscription = await stripe.subscriptions.retrieve("sub_per_seat_1");
    expect(subscription.items.data[0].quantity).toBeGreaterThanOrEqual(1);
  });
});

// =============================================================================
// Tests: Manual Mode
// =============================================================================

describe("Seats: Manual Mode", () => {
  test("does not grant credits in manual mode", async () => {
    await setupOrgWithSubscription("org_1", "cus_org_1", "sub_team_1", "price_team_monthly");

    const seatsApi = createSeatsApi({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "manual",
    });

    const result = await seatsApi.add({ userId: "user_alice", orgId: "org_1" });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.creditsGranted).toEqual({});
    }

    // No credits granted
    expect(await credits.getBalance("user_alice", "api_calls")).toBe(0);
    expect(await credits.getBalance("org_1", "api_calls")).toBe(0);
  });
});

// =============================================================================
// Tests: Callbacks
// =============================================================================

describe("Seats: Callbacks", () => {
  test("fires onCreditsGranted callback when seat added", async () => {
    await setupOrgWithSubscription("org_1", "cus_org_1", "sub_team_1", "price_team_monthly");

    const grantedCredits: Array<{ userId: string; creditType: string; amount: number }> = [];

    const seatsApi = createSeatsApi({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "seat-users",
      callbacks: {
        onCreditsGranted: (params) => {
          grantedCredits.push({
            userId: params.userId,
            creditType: params.creditType,
            amount: params.amount,
          });
        },
      },
    });

    await seatsApi.add({ userId: "user_alice", orgId: "org_1" });

    expect(grantedCredits).toHaveLength(2);
    expect(grantedCredits).toContainEqual({ userId: "user_alice", creditType: "api_calls", amount: 5000 });
    expect(grantedCredits).toContainEqual({ userId: "user_alice", creditType: "storage_gb", amount: 50 });
  });

  test("fires onCreditsRevoked callback when seat removed", async () => {
    await setupOrgWithSubscription("org_1", "cus_org_1", "sub_team_1", "price_team_monthly");

    const revokedCredits: Array<{ userId: string; creditType: string; amount: number }> = [];

    const seatsApi = createSeatsApi({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "seat-users",
      callbacks: {
        onCreditsRevoked: (params) => {
          revokedCredits.push({
            userId: params.userId,
            creditType: params.creditType,
            amount: params.amount,
          });
        },
      },
    });

    await seatsApi.add({ userId: "user_alice", orgId: "org_1" });
    await seatsApi.remove({ userId: "user_alice", orgId: "org_1" });

    expect(revokedCredits).toHaveLength(2);
    expect(revokedCredits).toContainEqual({ userId: "user_alice", creditType: "api_calls", amount: 5000 });
    expect(revokedCredits).toContainEqual({ userId: "user_alice", creditType: "storage_gb", amount: 50 });
  });
});

// =============================================================================
// Tests: Plan Without Credits
// =============================================================================

describe("Seats: Plan Without Credits", () => {
  test("addSeat succeeds for plan without credits", async () => {
    await setupOrgWithSubscription("org_1", "cus_org_1", "sub_no_credits", "price_no_credits");

    const seatsApi = createSeatsApi({
      stripe: stripe as any,
      pool,
      schema: "stripe",
      billingConfig: TEST_BILLING_CONFIG,
      mode: "test",
      grantTo: "seat-users",
    });

    const result = await seatsApi.add({ userId: "user_alice", orgId: "org_1" });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.creditsGranted).toEqual({});
    }
  });
});
