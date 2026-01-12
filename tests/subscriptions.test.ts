import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { createSubscriptionsApi } from "../src/subscriptions";
import {
  setupTestDb,
  teardownTestDb,
  cleanupAllTestData,
  seedCustomer,
  seedUserMap,
  seedSubscription,
  seedPrice,
  SCHEMA,
} from "./setup";
import type { Pool } from "pg";
import type { BillingConfig } from "../src/BillingConfig";

const testBillingConfig: BillingConfig = {
  test: {
    plans: [
      {
        id: "pro",
        name: "Pro",
        price: [
          { id: "price_pro_monthly", amount: 1000, currency: "usd", interval: "month" },
          { id: "price_pro_yearly", amount: 10000, currency: "usd", interval: "year" },
        ],
      },
      {
        id: "basic",
        name: "Basic",
        price: [
          { id: "price_basic_monthly", amount: 500, currency: "usd", interval: "month" },
        ],
      },
      {
        id: "enterprise",
        name: "Enterprise",
        price: [
          { id: "price_enterprise_monthly", amount: 5000, currency: "usd", interval: "month" },
        ],
      },
    ],
  },
};

describe("Subscriptions API", () => {
  let pool: Pool;
  let subscriptions: ReturnType<typeof createSubscriptionsApi>;

  beforeAll(async () => {
    pool = await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await cleanupAllTestData();

    subscriptions = createSubscriptionsApi({
      pool,
      schema: SCHEMA,
      billingConfig: testBillingConfig,
      mode: "test",
    });
  });

  describe("isActive", () => {
    it("returns false for non-existent user", async () => {
      const result = await subscriptions.isActive("unknown_user");
      expect(result).toBe(false);
    });

    it("returns false for user without subscription", async () => {
      await seedCustomer({ id: "cus_nosub" });
      await seedUserMap({ userId: "user_nosub", stripeCustomerId: "cus_nosub" });

      const result = await subscriptions.isActive("user_nosub");
      expect(result).toBe(false);
    });

    it("returns true for user with active subscription", async () => {
      await seedPrice({ id: "price_pro_monthly", productId: "prod_pro", unitAmount: 1000 });
      await seedCustomer({ id: "cus_active" });
      await seedUserMap({ userId: "user_active", stripeCustomerId: "cus_active" });
      await seedSubscription({
        id: "sub_active",
        customerId: "cus_active",
        priceId: "price_pro_monthly",
        status: "active",
      });

      const result = await subscriptions.isActive("user_active");
      expect(result).toBe(true);
    });

    it("returns true for user with trialing subscription", async () => {
      await seedPrice({ id: "price_pro_monthly", productId: "prod_pro", unitAmount: 1000 });
      await seedCustomer({ id: "cus_trial" });
      await seedUserMap({ userId: "user_trial", stripeCustomerId: "cus_trial" });
      await seedSubscription({
        id: "sub_trial",
        customerId: "cus_trial",
        priceId: "price_pro_monthly",
        status: "trialing",
      });

      const result = await subscriptions.isActive("user_trial");
      expect(result).toBe(true);
    });

    it("returns false for user with canceled subscription", async () => {
      await seedPrice({ id: "price_pro_monthly", productId: "prod_pro", unitAmount: 1000 });
      await seedCustomer({ id: "cus_canceled" });
      await seedUserMap({ userId: "user_canceled", stripeCustomerId: "cus_canceled" });
      await seedSubscription({
        id: "sub_canceled",
        customerId: "cus_canceled",
        priceId: "price_pro_monthly",
        status: "canceled",
      });

      const result = await subscriptions.isActive("user_canceled");
      expect(result).toBe(false);
    });

    it("returns false for user with past_due subscription", async () => {
      await seedPrice({ id: "price_pro_monthly", productId: "prod_pro", unitAmount: 1000 });
      await seedCustomer({ id: "cus_pastdue" });
      await seedUserMap({ userId: "user_pastdue", stripeCustomerId: "cus_pastdue" });
      await seedSubscription({
        id: "sub_pastdue",
        customerId: "cus_pastdue",
        priceId: "price_pro_monthly",
        status: "past_due",
      });

      const result = await subscriptions.isActive("user_pastdue");
      expect(result).toBe(false);
    });
  });

  describe("get", () => {
    it("returns null for non-existent user", async () => {
      const result = await subscriptions.get("unknown_user");
      expect(result).toBeNull();
    });

    it("returns null for user without customer mapping", async () => {
      const result = await subscriptions.get("user_no_mapping");
      expect(result).toBeNull();
    });

    it("returns null for user without any subscription", async () => {
      await seedCustomer({ id: "cus_nosub" });
      await seedUserMap({ userId: "user_nosub", stripeCustomerId: "cus_nosub" });

      const result = await subscriptions.get("user_nosub");
      expect(result).toBeNull();
    });

    it("returns active subscription with plan info", async () => {
      await seedPrice({ id: "price_pro_monthly", productId: "prod_pro", unitAmount: 1000 });
      await seedCustomer({ id: "cus_sub" });
      await seedUserMap({ userId: "user_sub", stripeCustomerId: "cus_sub" });

      const now = Math.floor(Date.now() / 1000);
      const periodEnd = now + 30 * 24 * 60 * 60;

      await seedSubscription({
        id: "sub_get",
        customerId: "cus_sub",
        priceId: "price_pro_monthly",
        status: "active",
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
      });

      const result = await subscriptions.get("user_sub");

      expect(result).not.toBeNull();
      expect(result!.id).toBe("sub_get");
      expect(result!.status).toBe("active");
      expect(result!.plan).not.toBeNull();
      expect(result!.plan!.name).toBe("Pro");
      expect(result!.plan!.id).toBe("pro");
      expect(result!.plan!.priceId).toBe("price_pro_monthly");
      expect(result!.currentPeriodStart).toBeInstanceOf(Date);
      expect(result!.currentPeriodEnd).toBeInstanceOf(Date);
      expect(result!.cancelAtPeriodEnd).toBe(false);
    });

    it("prefers active subscription over canceled", async () => {
      await seedPrice({ id: "price_pro_monthly", productId: "prod_pro", unitAmount: 1000 });
      await seedPrice({ id: "price_basic_monthly", productId: "prod_basic", unitAmount: 500 });
      await seedCustomer({ id: "cus_multi" });
      await seedUserMap({ userId: "user_multi", stripeCustomerId: "cus_multi" });

      // Older canceled subscription
      await seedSubscription({
        id: "sub_old_canceled",
        customerId: "cus_multi",
        priceId: "price_basic_monthly",
        status: "canceled",
        currentPeriodEnd: Math.floor(Date.now() / 1000) + 60 * 24 * 60 * 60, // Further in future
      });

      // Active subscription
      await seedSubscription({
        id: "sub_current_active",
        customerId: "cus_multi",
        priceId: "price_pro_monthly",
        status: "active",
        currentPeriodEnd: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
      });

      const result = await subscriptions.get("user_multi");

      expect(result).not.toBeNull();
      expect(result!.id).toBe("sub_current_active");
      expect(result!.status).toBe("active");
    });

    it("returns most recent subscription when no active subscription exists", async () => {
      await seedPrice({ id: "price_pro_monthly", productId: "prod_pro", unitAmount: 1000 });
      await seedPrice({ id: "price_basic_monthly", productId: "prod_basic", unitAmount: 500 });
      await seedCustomer({ id: "cus_both_canceled" });
      await seedUserMap({ userId: "user_both_canceled", stripeCustomerId: "cus_both_canceled" });

      // Older canceled subscription
      await seedSubscription({
        id: "sub_older",
        customerId: "cus_both_canceled",
        priceId: "price_basic_monthly",
        status: "canceled",
        currentPeriodEnd: Math.floor(Date.now() / 1000) - 60 * 24 * 60 * 60, // In the past
      });

      // More recent canceled subscription
      await seedSubscription({
        id: "sub_recent",
        customerId: "cus_both_canceled",
        priceId: "price_pro_monthly",
        status: "canceled",
        currentPeriodEnd: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
      });

      const result = await subscriptions.get("user_both_canceled");

      expect(result).not.toBeNull();
      expect(result!.id).toBe("sub_recent");
    });

    it("returns null plan when price not in billing config", async () => {
      await seedPrice({ id: "price_unknown", productId: "prod_unknown", unitAmount: 9999 });
      await seedCustomer({ id: "cus_unknown_plan" });
      await seedUserMap({ userId: "user_unknown_plan", stripeCustomerId: "cus_unknown_plan" });
      await seedSubscription({
        id: "sub_unknown",
        customerId: "cus_unknown_plan",
        priceId: "price_unknown",
        status: "active",
      });

      const result = await subscriptions.get("user_unknown_plan");

      expect(result).not.toBeNull();
      expect(result!.plan).toBeNull();
    });
  });

  describe("list", () => {
    it("returns empty array for non-existent user", async () => {
      const result = await subscriptions.list("unknown_user");
      expect(result).toEqual([]);
    });

    it("returns empty array for user without subscriptions", async () => {
      await seedCustomer({ id: "cus_nosubs" });
      await seedUserMap({ userId: "user_nosubs", stripeCustomerId: "cus_nosubs" });

      const result = await subscriptions.list("user_nosubs");
      expect(result).toEqual([]);
    });

    it("returns all subscriptions for user", async () => {
      await seedPrice({ id: "price_pro_monthly", productId: "prod_pro", unitAmount: 1000 });
      await seedPrice({ id: "price_basic_monthly", productId: "prod_basic", unitAmount: 500 });
      await seedCustomer({ id: "cus_manysubs" });
      await seedUserMap({ userId: "user_manysubs", stripeCustomerId: "cus_manysubs" });

      await seedSubscription({
        id: "sub_first",
        customerId: "cus_manysubs",
        priceId: "price_basic_monthly",
        status: "canceled",
        currentPeriodEnd: Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60,
      });

      await seedSubscription({
        id: "sub_second",
        customerId: "cus_manysubs",
        priceId: "price_pro_monthly",
        status: "active",
        currentPeriodEnd: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
      });

      const result = await subscriptions.list("user_manysubs");

      expect(result.length).toBe(2);
      // Should be ordered by period_end DESC
      expect(result[0].id).toBe("sub_second");
      expect(result[1].id).toBe("sub_first");
    });

    it("resolves plan info for each subscription", async () => {
      await seedPrice({ id: "price_pro_monthly", productId: "prod_pro", unitAmount: 1000 });
      await seedPrice({ id: "price_basic_monthly", productId: "prod_basic", unitAmount: 500 });
      await seedCustomer({ id: "cus_plans" });
      await seedUserMap({ userId: "user_plans", stripeCustomerId: "cus_plans" });

      await seedSubscription({
        id: "sub_basic",
        customerId: "cus_plans",
        priceId: "price_basic_monthly",
        status: "canceled",
        currentPeriodEnd: Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60,
      });

      await seedSubscription({
        id: "sub_pro",
        customerId: "cus_plans",
        priceId: "price_pro_monthly",
        status: "active",
        currentPeriodEnd: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
      });

      const result = await subscriptions.list("user_plans");

      const proSub = result.find(s => s.id === "sub_pro");
      const basicSub = result.find(s => s.id === "sub_basic");

      expect(proSub?.plan?.name).toBe("Pro");
      expect(basicSub?.plan?.name).toBe("Basic");
    });
  });

  describe("Without pool", () => {
    it("isActive returns false when no pool", async () => {
      const nopoolSubs = createSubscriptionsApi({
        pool: null,
        schema: SCHEMA,
        billingConfig: testBillingConfig,
        mode: "test",
      });

      const result = await nopoolSubs.isActive("any_user");
      expect(result).toBe(false);
    });

    it("get returns null when no pool", async () => {
      const nopoolSubs = createSubscriptionsApi({
        pool: null,
        schema: SCHEMA,
        billingConfig: testBillingConfig,
        mode: "test",
      });

      const result = await nopoolSubs.get("any_user");
      expect(result).toBeNull();
    });

    it("list returns empty array when no pool", async () => {
      const nopoolSubs = createSubscriptionsApi({
        pool: null,
        schema: SCHEMA,
        billingConfig: testBillingConfig,
        mode: "test",
      });

      const result = await nopoolSubs.list("any_user");
      expect(result).toEqual([]);
    });
  });

  describe("Without billing config", () => {
    it("returns subscription with null plan when no billing config", async () => {
      const noconfigSubs = createSubscriptionsApi({
        pool,
        schema: SCHEMA,
        billingConfig: undefined,
        mode: "test",
      });

      await seedPrice({ id: "price_test", productId: "prod_test", unitAmount: 1000 });
      await seedCustomer({ id: "cus_noconfig" });
      await seedUserMap({ userId: "user_noconfig", stripeCustomerId: "cus_noconfig" });
      await seedSubscription({
        id: "sub_noconfig",
        customerId: "cus_noconfig",
        priceId: "price_test",
        status: "active",
      });

      const result = await noconfigSubs.get("user_noconfig");

      expect(result).not.toBeNull();
      expect(result!.plan).toBeNull();
    });
  });
});
