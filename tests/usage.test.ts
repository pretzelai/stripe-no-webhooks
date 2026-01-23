import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Billing } from "../src/Billing";
import {
  setupTestDb,
  teardownTestDb,
  cleanupAllTestData,
  seedCustomer,
  seedUserMap,
  seedSubscription,
  seedPrice,
  getTestPool,
  SCHEMA,
  createTestStripe,
} from "./setup";
import type { Pool } from "pg";
import type { BillingConfig } from "../src/BillingConfig";
import type Stripe from "stripe";

const TEST_DB_URL = "postgres://test:test@localhost:54321/snw_test";

describe("Usage-Based Billing", () => {
  let pool: Pool;
  let mockStripe: Stripe;

  beforeAll(async () => {
    pool = await setupTestDb();
    mockStripe = createTestStripe() as Stripe;
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await cleanupAllTestData();
  });

  describe("Config Scenarios", () => {
    it("credits only - no usage tracking", async () => {
      const config: BillingConfig = {
        test: {
          plans: [
            {
              name: "Pro",
              price: [{ id: "price_pro", amount: 2000, currency: "usd", interval: "month" }],
              features: {
                api_calls: {
                  displayName: "API Calls",
                  credits: { allocation: 1000 },
                  // No trackUsage, no pricePerCredit
                },
              },
            },
          ],
        },
      };

      const billing = new Billing({
        stripeSecretKey: "sk_test_mock",
        stripeWebhookSecret: "whsec_mock",
        databaseUrl: TEST_DB_URL,
        schema: SCHEMA,
        billingConfig: config,
        _stripeClient: mockStripe,
      });

      await seedCustomer({ id: "cus_credits_only" });
      await seedUserMap({ userId: "user_credits_only", stripeCustomerId: "cus_credits_only" });
      await seedPrice({ id: "price_pro", productId: "prod_pro", unitAmount: 2000 });
      await seedSubscription({
        id: "sub_credits_only",
        customerId: "cus_credits_only",
        priceId: "price_pro",
        status: "active",
      });

      // Should throw because trackUsage is not enabled
      await expect(
        billing.usage.record({ userId: "user_credits_only", key: "api_calls", amount: 10 })
      ).rejects.toThrow("Usage tracking not enabled");
    });

    it("usage only - pure pay-as-you-go", async () => {
      const config: BillingConfig = {
        test: {
          plans: [
            {
              name: "Pay As You Go",
              price: [{ id: "price_payg", amount: 0, currency: "usd", interval: "month" }],
              features: {
                api_calls: {
                  displayName: "API Calls",
                  pricePerCredit: 2, // 2 cents per call
                  trackUsage: true,
                },
              },
            },
          ],
        },
      };

      const billing = new Billing({
        stripeSecretKey: "sk_test_mock",
        stripeWebhookSecret: "whsec_mock",
        databaseUrl: TEST_DB_URL,
        schema: SCHEMA,
        billingConfig: config,
        _stripeClient: mockStripe,
      });

      await seedCustomer({ id: "cus_payg" });
      await seedUserMap({ userId: "user_payg", stripeCustomerId: "cus_payg" });
      await seedPrice({ id: "price_payg", productId: "prod_payg", unitAmount: 0 });
      await seedSubscription({
        id: "sub_payg",
        customerId: "cus_payg",
        priceId: "price_payg",
        status: "active",
      });

      // Should succeed
      const result = await billing.usage.record({
        userId: "user_payg",
        key: "api_calls",
        amount: 100,
      });

      expect(result.event).toBeDefined();
      expect(result.event.amount).toBe(100);
      expect(result.meterEventId).toBeDefined();
    });

    it("credits + usage - hybrid model", async () => {
      const config: BillingConfig = {
        test: {
          plans: [
            {
              name: "Pro",
              price: [{ id: "price_hybrid", amount: 2000, currency: "usd", interval: "month" }],
              features: {
                api_calls: {
                  displayName: "API Calls",
                  credits: { allocation: 500 },
                  pricePerCredit: 2, // 2 cents after credits exhausted
                  trackUsage: true,
                },
              },
            },
          ],
        },
      };

      const billing = new Billing({
        stripeSecretKey: "sk_test_mock",
        stripeWebhookSecret: "whsec_mock",
        databaseUrl: TEST_DB_URL,
        schema: SCHEMA,
        billingConfig: config,
        _stripeClient: mockStripe,
      });

      await seedCustomer({ id: "cus_hybrid" });
      await seedUserMap({ userId: "user_hybrid", stripeCustomerId: "cus_hybrid" });
      await seedPrice({ id: "price_hybrid", productId: "prod_hybrid", unitAmount: 2000 });
      await seedSubscription({
        id: "sub_hybrid",
        customerId: "cus_hybrid",
        priceId: "price_hybrid",
        status: "active",
      });

      // Should succeed - usage.record() works alongside credits
      const result = await billing.usage.record({
        userId: "user_hybrid",
        key: "api_calls",
        amount: 50,
      });

      expect(result.event.amount).toBe(50);
      expect(result.meterEventId).toBeDefined();
    });

    it("pricePerCredit only - enables top-ups but not usage tracking", async () => {
      const config: BillingConfig = {
        test: {
          plans: [
            {
              name: "Pro",
              price: [{ id: "price_topup", amount: 2000, currency: "usd", interval: "month" }],
              features: {
                api_calls: {
                  displayName: "API Calls",
                  credits: { allocation: 1000 },
                  pricePerCredit: 2, // Enables top-ups
                  // trackUsage: false (default)
                },
              },
            },
          ],
        },
      };

      const billing = new Billing({
        stripeSecretKey: "sk_test_mock",
        stripeWebhookSecret: "whsec_mock",
        databaseUrl: TEST_DB_URL,
        schema: SCHEMA,
        billingConfig: config,
        _stripeClient: mockStripe,
      });

      await seedCustomer({ id: "cus_topup_only" });
      await seedUserMap({ userId: "user_topup_only", stripeCustomerId: "cus_topup_only" });
      await seedPrice({ id: "price_topup", productId: "prod_topup", unitAmount: 2000 });
      await seedSubscription({
        id: "sub_topup_only",
        customerId: "cus_topup_only",
        priceId: "price_topup",
        status: "active",
      });

      // Should throw because trackUsage is not true
      await expect(
        billing.usage.record({ userId: "user_topup_only", key: "api_calls", amount: 10 })
      ).rejects.toThrow("trackUsage: true");
    });
  });

  describe("usage.record()", () => {
    const usageConfig: BillingConfig = {
      test: {
        plans: [
          {
            name: "Pro",
            price: [{ id: "price_usage", amount: 2000, currency: "usd", interval: "month" }],
            features: {
              api_calls: {
                displayName: "API Calls",
                pricePerCredit: 2,
                trackUsage: true,
              },
              storage_gb: {
                displayName: "Storage",
                credits: { allocation: 50 },
                // No usage tracking
              },
            },
          },
        ],
      },
    };

    let billing: Billing;

    beforeEach(async () => {
      billing = new Billing({
        stripeSecretKey: "sk_test_mock",
        stripeWebhookSecret: "whsec_mock",
        databaseUrl: TEST_DB_URL,
        schema: SCHEMA,
        billingConfig: usageConfig,
        _stripeClient: mockStripe,
      });

      await seedCustomer({ id: "cus_record" });
      await seedUserMap({ userId: "user_record", stripeCustomerId: "cus_record" });
      await seedPrice({ id: "price_usage", productId: "prod_usage", unitAmount: 2000 });
      await seedSubscription({
        id: "sub_record",
        customerId: "cus_record",
        priceId: "price_usage",
        status: "active",
      });
    });

    it("records usage event successfully", async () => {
      const result = await billing.usage.record({
        userId: "user_record",
        key: "api_calls",
        amount: 100,
      });

      expect(result.event.userId).toBe("user_record");
      expect(result.event.key).toBe("api_calls");
      expect(result.event.amount).toBe(100);
      expect(result.meterEventId).toMatch(/^mevt_/);
    });

    it("stores event in local database", async () => {
      await billing.usage.record({
        userId: "user_record",
        key: "api_calls",
        amount: 50,
      });

      const history = await billing.usage.getHistory({
        userId: "user_record",
        key: "api_calls",
      });

      expect(history.length).toBe(1);
      expect(history[0].amount).toBe(50);
    });

    it("rejects invalid amounts", async () => {
      await expect(
        billing.usage.record({ userId: "user_record", key: "api_calls", amount: 0 })
      ).rejects.toThrow("positive number");

      await expect(
        billing.usage.record({ userId: "user_record", key: "api_calls", amount: -10 })
      ).rejects.toThrow("positive number");

      await expect(
        billing.usage.record({ userId: "user_record", key: "api_calls", amount: NaN })
      ).rejects.toThrow("positive number");

      await expect(
        billing.usage.record({ userId: "user_record", key: "api_calls", amount: Infinity })
      ).rejects.toThrow("positive number");
    });

    it("rejects unknown user", async () => {
      await expect(
        billing.usage.record({ userId: "unknown_user", key: "api_calls", amount: 10 })
      ).rejects.toThrow("No Stripe customer found");
    });

    it("rejects user without subscription", async () => {
      await seedCustomer({ id: "cus_no_sub" });
      await seedUserMap({ userId: "user_no_sub", stripeCustomerId: "cus_no_sub" });

      await expect(
        billing.usage.record({ userId: "user_no_sub", key: "api_calls", amount: 10 })
      ).rejects.toThrow("No active subscription");
    });

    it("rejects unknown feature key", async () => {
      await expect(
        billing.usage.record({ userId: "user_record", key: "unknown_feature", amount: 10 })
      ).rejects.toThrow('Feature "unknown_feature" not found');
    });

    it("rejects feature without usage tracking", async () => {
      await expect(
        billing.usage.record({ userId: "user_record", key: "storage_gb", amount: 10 })
      ).rejects.toThrow("Usage tracking not enabled");
    });
  });

  describe("usage.getSummary()", () => {
    const summaryConfig: BillingConfig = {
      test: {
        plans: [
          {
            name: "Pro",
            price: [{ id: "price_summary", amount: 2000, currency: "usd", interval: "month" }],
            features: {
              api_calls: {
                displayName: "API Calls",
                pricePerCredit: 2, // 2 cents per call
                trackUsage: true,
              },
            },
          },
        ],
      },
    };

    let billing: Billing;

    beforeEach(async () => {
      billing = new Billing({
        stripeSecretKey: "sk_test_mock",
        stripeWebhookSecret: "whsec_mock",
        databaseUrl: TEST_DB_URL,
        schema: SCHEMA,
        billingConfig: summaryConfig,
        _stripeClient: mockStripe,
      });

      await seedCustomer({ id: "cus_summary" });
      await seedUserMap({ userId: "user_summary", stripeCustomerId: "cus_summary" });
      await seedPrice({ id: "price_summary", productId: "prod_summary", unitAmount: 2000 });
      await seedSubscription({
        id: "sub_summary",
        customerId: "cus_summary",
        priceId: "price_summary",
        status: "active",
      });
    });

    it("returns zero for no usage", async () => {
      const summary = await billing.usage.getSummary({
        userId: "user_summary",
        key: "api_calls",
      });

      expect(summary.totalAmount).toBe(0);
      expect(summary.eventCount).toBe(0);
      expect(summary.estimatedCost).toBe(0);
    });

    it("sums multiple usage events", async () => {
      await billing.usage.record({ userId: "user_summary", key: "api_calls", amount: 100 });
      await billing.usage.record({ userId: "user_summary", key: "api_calls", amount: 50 });
      await billing.usage.record({ userId: "user_summary", key: "api_calls", amount: 25 });

      const summary = await billing.usage.getSummary({
        userId: "user_summary",
        key: "api_calls",
      });

      expect(summary.totalAmount).toBe(175);
      expect(summary.eventCount).toBe(3);
      expect(summary.estimatedCost).toBe(350); // 175 * 2 cents
      expect(summary.currency).toBe("usd");
    });

    it("includes period dates", async () => {
      const summary = await billing.usage.getSummary({
        userId: "user_summary",
        key: "api_calls",
      });

      expect(summary.periodStart).toBeInstanceOf(Date);
      expect(summary.periodEnd).toBeInstanceOf(Date);
      expect(summary.periodEnd > summary.periodStart).toBe(true);
    });
  });

  describe("usage.getHistory()", () => {
    const historyConfig: BillingConfig = {
      test: {
        plans: [
          {
            name: "Pro",
            price: [{ id: "price_history", amount: 2000, currency: "usd", interval: "month" }],
            features: {
              api_calls: {
                pricePerCredit: 2,
                trackUsage: true,
              },
            },
          },
        ],
      },
    };

    let billing: Billing;

    beforeEach(async () => {
      billing = new Billing({
        stripeSecretKey: "sk_test_mock",
        stripeWebhookSecret: "whsec_mock",
        databaseUrl: TEST_DB_URL,
        schema: SCHEMA,
        billingConfig: historyConfig,
        _stripeClient: mockStripe,
      });

      await seedCustomer({ id: "cus_history" });
      await seedUserMap({ userId: "user_history", stripeCustomerId: "cus_history" });
      await seedPrice({ id: "price_history", productId: "prod_history", unitAmount: 2000 });
      await seedSubscription({
        id: "sub_history",
        customerId: "cus_history",
        priceId: "price_history",
        status: "active",
      });
    });

    it("returns events in descending order", async () => {
      await billing.usage.record({ userId: "user_history", key: "api_calls", amount: 10 });
      await billing.usage.record({ userId: "user_history", key: "api_calls", amount: 20 });
      await billing.usage.record({ userId: "user_history", key: "api_calls", amount: 30 });

      const history = await billing.usage.getHistory({
        userId: "user_history",
        key: "api_calls",
      });

      expect(history.length).toBe(3);
      // Most recent first
      expect(history[0].amount).toBe(30);
      expect(history[2].amount).toBe(10);
    });

    it("respects limit parameter", async () => {
      for (let i = 0; i < 10; i++) {
        await billing.usage.record({ userId: "user_history", key: "api_calls", amount: i + 1 });
      }

      const history = await billing.usage.getHistory({
        userId: "user_history",
        key: "api_calls",
        limit: 5,
      });

      expect(history.length).toBe(5);
    });

    it("respects offset parameter", async () => {
      for (let i = 0; i < 10; i++) {
        await billing.usage.record({ userId: "user_history", key: "api_calls", amount: i + 1 });
      }

      const history = await billing.usage.getHistory({
        userId: "user_history",
        key: "api_calls",
        limit: 3,
        offset: 3,
      });

      expect(history.length).toBe(3);
      // Offset skips first 3 (most recent), so we get items 4-6 in descending order
    });
  });

  describe("Error Messages", () => {
    it("provides helpful error for missing trackUsage", async () => {
      const config: BillingConfig = {
        test: {
          plans: [
            {
              name: "Pro",
              price: [{ id: "price_err", amount: 2000, currency: "usd", interval: "month" }],
              features: {
                api_calls: {
                  pricePerCredit: 2,
                  // Missing trackUsage: true
                },
              },
            },
          ],
        },
      };

      const billing = new Billing({
        stripeSecretKey: "sk_test_mock",
        stripeWebhookSecret: "whsec_mock",
        databaseUrl: TEST_DB_URL,
        schema: SCHEMA,
        billingConfig: config,
        _stripeClient: mockStripe,
      });

      await seedCustomer({ id: "cus_err1" });
      await seedUserMap({ userId: "user_err1", stripeCustomerId: "cus_err1" });
      await seedPrice({ id: "price_err", productId: "prod_err", unitAmount: 2000 });
      await seedSubscription({
        id: "sub_err1",
        customerId: "cus_err1",
        priceId: "price_err",
        status: "active",
      });

      try {
        await billing.usage.record({ userId: "user_err1", key: "api_calls", amount: 10 });
        expect(true).toBe(false); // Should not reach here
      } catch (err) {
        const error = err as Error;
        expect(error.message).toContain("trackUsage: true");
      }
    });

    it("provides helpful error for missing pricePerCredit", async () => {
      const config: BillingConfig = {
        test: {
          plans: [
            {
              name: "Pro",
              price: [{ id: "price_err2", amount: 2000, currency: "usd", interval: "month" }],
              features: {
                api_calls: {
                  trackUsage: true,
                  // Missing pricePerCredit
                },
              },
            },
          ],
        },
      };

      const billing = new Billing({
        stripeSecretKey: "sk_test_mock",
        stripeWebhookSecret: "whsec_mock",
        databaseUrl: TEST_DB_URL,
        schema: SCHEMA,
        billingConfig: config,
        _stripeClient: mockStripe,
      });

      await seedCustomer({ id: "cus_err2" });
      await seedUserMap({ userId: "user_err2", stripeCustomerId: "cus_err2" });
      await seedPrice({ id: "price_err2", productId: "prod_err2", unitAmount: 2000 });
      await seedSubscription({
        id: "sub_err2",
        customerId: "cus_err2",
        priceId: "price_err2",
        status: "active",
      });

      try {
        await billing.usage.record({ userId: "user_err2", key: "api_calls", amount: 10 });
        expect(true).toBe(false);
      } catch (err) {
        const error = err as Error;
        expect(error.message).toContain("pricePerCredit");
      }
    });

    it("provides helpful error for both missing", async () => {
      const config: BillingConfig = {
        test: {
          plans: [
            {
              name: "Pro",
              price: [{ id: "price_err3", amount: 2000, currency: "usd", interval: "month" }],
              features: {
                api_calls: {
                  displayName: "API Calls",
                  credits: { allocation: 1000 },
                  // Missing both trackUsage and pricePerCredit
                },
              },
            },
          ],
        },
      };

      const billing = new Billing({
        stripeSecretKey: "sk_test_mock",
        stripeWebhookSecret: "whsec_mock",
        databaseUrl: TEST_DB_URL,
        schema: SCHEMA,
        billingConfig: config,
        _stripeClient: mockStripe,
      });

      await seedCustomer({ id: "cus_err3" });
      await seedUserMap({ userId: "user_err3", stripeCustomerId: "cus_err3" });
      await seedPrice({ id: "price_err3", productId: "prod_err3", unitAmount: 2000 });
      await seedSubscription({
        id: "sub_err3",
        customerId: "cus_err3",
        priceId: "price_err3",
        status: "active",
      });

      try {
        await billing.usage.record({ userId: "user_err3", key: "api_calls", amount: 10 });
        expect(true).toBe(false);
      } catch (err) {
        const error = err as Error;
        expect(error.message).toContain("trackUsage: true");
        expect(error.message).toContain("pricePerCredit");
      }
    });
  });
});
