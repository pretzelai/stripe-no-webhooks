import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Billing, createHandler } from "../src/Billing";
import { initCredits, credits } from "../src/credits";
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
} from "./setup";
import type { Pool } from "pg";

const TEST_DB_URL = "postgres://test:test@localhost:54321/snw_test";

describe("Billing Class", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await setupTestDb();
    initCredits(pool, SCHEMA);
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await cleanupAllTestData();
  });

  describe("Constructor", () => {
    it("creates instance with minimal config", () => {
      const billing = new Billing({
        stripeSecretKey: "sk_test_mock",
        stripeWebhookSecret: "whsec_mock",
      });

      expect(billing).toBeDefined();
      expect(billing.subscriptions).toBeDefined();
      expect(billing.credits).toBeDefined();
      expect(billing.seats).toBeDefined();
    });

    it("creates instance with full config", () => {
      const billing = new Billing({
        stripeSecretKey: "sk_test_mock",
        stripeWebhookSecret: "whsec_mock",
        databaseUrl: TEST_DB_URL,
        schema: SCHEMA,
        billingConfig: {
          test: {
            plans: [
              {
                name: "Pro",
                price: [{ amount: 1000, currency: "usd", interval: "month" }],
                features: { api_calls: { credits: { allocation: 100 } } },
              },
            ],
          },
        },
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      });

      expect(billing).toBeDefined();
      expect(billing.subscriptions).toBeDefined();
      expect(billing.credits).toBeDefined();
      expect(billing.seats).toBeDefined();
    });

    it("uses env variables for missing config", () => {
      // Save original env
      const originalStripeKey = process.env.STRIPE_SECRET_KEY;
      const originalWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

      process.env.STRIPE_SECRET_KEY = "sk_test_env";
      process.env.STRIPE_WEBHOOK_SECRET = "whsec_env";

      const billing = new Billing();
      expect(billing).toBeDefined();

      // Restore env
      process.env.STRIPE_SECRET_KEY = originalStripeKey;
      process.env.STRIPE_WEBHOOK_SECRET = originalWebhookSecret;
    });

    it("detects test mode from sk_test_ key", () => {
      const billing = new Billing({
        stripeSecretKey: "sk_test_123",
        stripeWebhookSecret: "whsec_mock",
      });

      expect(billing).toBeDefined();
    });

    it("detects production mode from sk_live_ key", () => {
      const billing = new Billing({
        stripeSecretKey: "sk_live_123",
        stripeWebhookSecret: "whsec_mock",
      });

      expect(billing).toBeDefined();
    });

    it("configures grantTo mode", () => {
      const billing = new Billing({
        stripeSecretKey: "sk_test_mock",
        stripeWebhookSecret: "whsec_mock",
        databaseUrl: TEST_DB_URL,
        credits: { grantTo: "seat-users" },
      });

      expect(billing).toBeDefined();
    });
  });

  describe("createHandler", () => {
    it("returns a handler function", () => {
      const billing = new Billing({
        stripeSecretKey: "sk_test_mock",
        stripeWebhookSecret: "whsec_mock",
      });

      const handler = billing.createHandler({
        resolveUser: async () => ({ id: "user_123" }),
      });

      expect(typeof handler).toBe("function");
    });

    it("rejects non-POST requests", async () => {
      const billing = new Billing({
        stripeSecretKey: "sk_test_mock",
        stripeWebhookSecret: "whsec_mock",
      });

      const handler = billing.createHandler({
        resolveUser: async () => ({ id: "user_123" }),
      });

      const request = new Request("http://localhost/api/stripe/checkout", {
        method: "GET",
      });

      const response = await handler(request);
      expect(response.status).toBe(405);

      const body = await response.json();
      expect(body.error).toBe("Method not allowed");
    });

    it("routes to checkout handler", async () => {
      const billing = new Billing({
        stripeSecretKey: "sk_test_mock",
        stripeWebhookSecret: "whsec_mock",
      });

      const handler = billing.createHandler({
        resolveUser: async () => null,
      });

      // Empty body should return 400 from checkout handler (before price resolution)
      const request = new Request("http://localhost/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      const response = await handler(request);
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain("Provide either priceId, planName+interval, or planId+interval");
    });

    it("routes to customer_portal handler", async () => {
      const billing = new Billing({
        stripeSecretKey: "sk_test_mock",
        stripeWebhookSecret: "whsec_mock",
      });

      const handler = billing.createHandler({
        resolveUser: async () => null,
      });

      const request = new Request("http://localhost/api/stripe/customer_portal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      const response = await handler(request);
      expect(response.status).toBe(401);
    });

    it("routes to webhook handler", async () => {
      const billing = new Billing({
        stripeSecretKey: "sk_test_mock",
        stripeWebhookSecret: "whsec_mock",
      });

      const handler = billing.createHandler();

      // Localhost webhooks skip signature verification
      const request = new Request("http://localhost/api/stripe/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "evt_test",
          type: "ping",
          data: { object: {} },
        }),
      });

      const response = await handler(request);
      expect(response.status).toBe(200);
    });

    it("returns 404 for unknown actions", async () => {
      const billing = new Billing({
        stripeSecretKey: "sk_test_mock",
        stripeWebhookSecret: "whsec_mock",
      });

      const handler = billing.createHandler();

      const request = new Request("http://localhost/api/stripe/unknown", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      const response = await handler(request);
      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body.error).toContain("Unknown action");
    });
  });

  describe("Credits API", () => {
    it("exposes credit methods", () => {
      const billing = new Billing({
        stripeSecretKey: "sk_test_mock",
        stripeWebhookSecret: "whsec_mock",
        databaseUrl: TEST_DB_URL,
      });

      expect(typeof billing.credits.consume).toBe("function");
      expect(typeof billing.credits.grant).toBe("function");
      expect(typeof billing.credits.revoke).toBe("function");
      expect(typeof billing.credits.revokeAll).toBe("function");
      expect(typeof billing.credits.setBalance).toBe("function");
      expect(typeof billing.credits.getBalance).toBe("function");
      expect(typeof billing.credits.getAllBalances).toBe("function");
      expect(typeof billing.credits.hasCredits).toBe("function");
      expect(typeof billing.credits.getHistory).toBe("function");
      expect(typeof billing.credits.topUp).toBe("function");
      expect(typeof billing.credits.hasPaymentMethod).toBe("function");
    });

    // Note: Credit operations are comprehensively tested in credits.test.ts
    // This file focuses on testing the Billing class itself
  });

  describe("Subscriptions API", () => {
    it("exposes subscription methods", () => {
      const billing = new Billing({
        stripeSecretKey: "sk_test_mock",
        stripeWebhookSecret: "whsec_mock",
        databaseUrl: TEST_DB_URL,
      });

      expect(typeof billing.subscriptions.isActive).toBe("function");
      expect(typeof billing.subscriptions.get).toBe("function");
      expect(typeof billing.subscriptions.list).toBe("function");
    });

    it("checks subscription status", async () => {
      const billing = new Billing({
        stripeSecretKey: "sk_test_mock",
        stripeWebhookSecret: "whsec_mock",
        databaseUrl: TEST_DB_URL,
        schema: SCHEMA,
      });

      // User without subscription
      const isActive = await billing.subscriptions.isActive({ userId: "unknown_user" });
      expect(isActive).toBe(false);
    });

    it("gets subscription for user with active subscription", async () => {
      const billing = new Billing({
        stripeSecretKey: "sk_test_mock",
        stripeWebhookSecret: "whsec_mock",
        databaseUrl: TEST_DB_URL,
        schema: SCHEMA,
        billingConfig: {
          test: {
            plans: [
              {
                name: "Pro",
                price: [{ id: "price_pro", amount: 1000, currency: "usd", interval: "month" }],
              },
            ],
          },
        },
      });

      // Seed test data
      await seedCustomer({ id: "cus_test123" });
      await seedUserMap({ userId: "user_123", stripeCustomerId: "cus_test123" });
      await seedPrice({ id: "price_pro", productId: "prod_test", unitAmount: 1000 });
      await seedSubscription({
        id: "sub_test123",
        customerId: "cus_test123",
        priceId: "price_pro",
        status: "active",
      });

      const subscription = await billing.subscriptions.get({ userId: "user_123" });
      expect(subscription).not.toBeNull();
      expect(subscription?.status).toBe("active");
      expect(subscription?.plan?.name).toBe("Pro");
    });
  });

  describe("Seats API", () => {
    it("exposes seats methods", () => {
      const billing = new Billing({
        stripeSecretKey: "sk_test_mock",
        stripeWebhookSecret: "whsec_mock",
        databaseUrl: TEST_DB_URL,
      });

      expect(typeof billing.seats.add).toBe("function");
      expect(typeof billing.seats.remove).toBe("function");
    });
  });
});

describe("createHandler function", () => {
  it("creates a handler with combined config", () => {
    const handler = createHandler({
      stripeSecretKey: "sk_test_mock",
      stripeWebhookSecret: "whsec_mock",
      resolveUser: async () => ({ id: "user_123" }),
    });

    expect(typeof handler).toBe("function");
  });

  it("handler responds to requests", async () => {
    const handler = createHandler({
      stripeSecretKey: "sk_test_mock",
      stripeWebhookSecret: "whsec_mock",
      resolveUser: async () => null,
    });

    // Empty body should return 400 (validates before checking auth)
    const request = new Request("http://localhost/api/stripe/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const response = await handler(request);
    expect(response.status).toBe(400);
  });
});
