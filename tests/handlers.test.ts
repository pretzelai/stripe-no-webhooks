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
  SCHEMA,
} from "./setup";
import type { Pool } from "pg";
import type { BillingConfig } from "../src/BillingConfig";

const TEST_DB_URL = "postgres://test:test@localhost:54321/snw_test";

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
        credits: { api_calls: { allocation: 1000 } },
      },
      {
        id: "basic",
        name: "Basic",
        price: [
          { id: "price_basic_monthly", amount: 500, currency: "usd", interval: "month" },
        ],
        credits: { api_calls: { allocation: 100 } },
      },
      {
        id: "enterprise",
        name: "Enterprise",
        price: [
          { id: "price_enterprise_monthly", amount: 5000, currency: "usd", interval: "month" },
        ],
        credits: { api_calls: { allocation: 10000 } },
      },
    ],
  },
};

describe("Checkout Handler", () => {
  let pool: Pool;
  let billing: Billing;
  let handler: (request: Request) => Promise<Response>;

  beforeAll(async () => {
    pool = await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await cleanupAllTestData();

    billing = new Billing({
      stripeSecretKey: "sk_test_mock",
      stripeWebhookSecret: "whsec_mock",
      databaseUrl: TEST_DB_URL,
      schema: SCHEMA,
      billingConfig: testBillingConfig,
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    handler = billing.createHandler({
      resolveUser: async (req) => {
        const authHeader = req.headers.get("authorization");
        if (authHeader === "Bearer user_123") {
          return { id: "user_123", email: "test@example.com" };
        }
        if (authHeader === "Bearer user_456") {
          return { id: "user_456", email: "user456@example.com" };
        }
        return null;
      },
    });
  });

  // Note: Tests that require Stripe API calls are skipped as they would need a real API key
  // or more sophisticated mocking. The checkout handler is integration-tested via e2e tests.

  describe("Plan Resolution", () => {
    it("returns 400 when no plan specified", async () => {
      const request = new Request("http://localhost/api/stripe/checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer user_123",
        },
        body: JSON.stringify({}),
      });

      const response = await handler(request);
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain("Provide either priceId, planName+interval, or planId+interval");
    });

    it("returns error when interval missing for planName", async () => {
      const request = new Request("http://localhost/api/stripe/checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer user_123",
        },
        body: JSON.stringify({ planName: "Pro" }),
      });

      const response = await handler(request);
      expect(response.status).toBe(500);

      const body = await response.json();
      expect(body.error).toContain("interval is required");
    });

    it("returns error when plan not found", async () => {
      const request = new Request("http://localhost/api/stripe/checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer user_123",
        },
        body: JSON.stringify({ planName: "NonExistent", interval: "month" }),
      });

      const response = await handler(request);
      expect(response.status).toBe(500);

      const body = await response.json();
      expect(body.error).toContain("Plan not found");
    });

    it("returns error when price interval not found", async () => {
      const request = new Request("http://localhost/api/stripe/checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer user_123",
        },
        body: JSON.stringify({ planName: "Basic", interval: "year" }),
      });

      const response = await handler(request);
      expect(response.status).toBe(500);

      const body = await response.json();
      expect(body.error).toContain("Price with interval");
    });
  });
});

describe("Customer Portal Handler", () => {
  let pool: Pool;
  let billing: Billing;
  let handler: (request: Request) => Promise<Response>;

  beforeAll(async () => {
    pool = await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await cleanupAllTestData();

    billing = new Billing({
      stripeSecretKey: "sk_test_mock",
      stripeWebhookSecret: "whsec_mock",
      databaseUrl: TEST_DB_URL,
      schema: SCHEMA,
    });

    handler = billing.createHandler({
      resolveUser: async (req) => {
        const authHeader = req.headers.get("authorization");
        if (authHeader === "Bearer user_123") {
          return { id: "user_123" };
        }
        return null;
      },
    });
  });

  it("returns 401 when no user authenticated", async () => {
    const request = new Request("http://localhost/api/stripe/customer_portal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const response = await handler(request);
    expect(response.status).toBe(401);
  });

  it("returns 404 when user has no billing account", async () => {
    const request = new Request("http://localhost/api/stripe/customer_portal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user_123",
      },
      body: JSON.stringify({}),
    });

    const response = await handler(request);
    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body.error).toContain("No billing account");
  });

  // Note: Tests that call Stripe's billing portal API require a real API key
});

describe("Webhook Handler", () => {
  let pool: Pool;
  let billing: Billing;
  let handler: (request: Request) => Promise<Response>;
  let callbacksCalled: string[];

  beforeAll(async () => {
    pool = await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await cleanupAllTestData();
    callbacksCalled = [];

    billing = new Billing({
      stripeSecretKey: "sk_test_mock",
      stripeWebhookSecret: "whsec_mock",
      databaseUrl: TEST_DB_URL,
      schema: SCHEMA,
      billingConfig: testBillingConfig,
    });

    handler = billing.createHandler({
      callbacks: {
        onSubscriptionCreated: async (sub) => {
          callbacksCalled.push(`created:${sub.id}`);
        },
        onSubscriptionCancelled: async (sub) => {
          callbacksCalled.push(`cancelled:${sub.id}`);
        },
        onSubscriptionRenewed: async (sub) => {
          callbacksCalled.push(`renewed:${sub.id}`);
        },
        onSubscriptionPlanChanged: async (sub, oldPriceId) => {
          callbacksCalled.push(`changed:${sub.id}:${oldPriceId}`);
        },
      },
    });
  });

  describe("Signature Verification", () => {
    it("skips signature verification on localhost", async () => {
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

    it("requires signature on non-localhost", async () => {
      const request = new Request("https://production.com/api/stripe/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "evt_test",
          type: "ping",
          data: { object: {} },
        }),
      });

      const response = await handler(request);
      expect(response.status).toBe(400);

      const body = await response.text();
      expect(body).toContain("Missing stripe-signature");
    });
  });

  describe("Subscription Events", () => {
    beforeEach(async () => {
      await seedPrice({ id: "price_pro_monthly", productId: "prod_pro", unitAmount: 1000 });
      await seedCustomer({ id: "cus_webhook" });
      await seedUserMap({ userId: "user_webhook", stripeCustomerId: "cus_webhook" });
    });

    // Note: subscription.created requires Stripe API call to check for duplicate subscriptions
    // This is tested in lifecycle.test.ts with proper mocking

    it("handles customer.subscription.deleted event", async () => {
      const request = new Request("http://localhost/api/stripe/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "evt_sub_deleted",
          type: "customer.subscription.deleted",
          data: {
            object: {
              id: "sub_cancelled",
              customer: "cus_webhook",
              status: "canceled",
              metadata: {},
              items: {
                data: [{ price: { id: "price_pro_monthly" } }],
              },
            },
          },
        }),
      });

      const response = await handler(request);
      expect(response.status).toBe(200);
      expect(callbacksCalled).toContain("cancelled:sub_cancelled");
    });

    it("skips credit handling for duplicate-cancelled subscriptions", async () => {
      const request = new Request("http://localhost/api/stripe/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "evt_sub_deleted",
          type: "customer.subscription.deleted",
          data: {
            object: {
              id: "sub_duplicate",
              customer: "cus_webhook",
              status: "canceled",
              metadata: { cancelled_as_duplicate: "true" },
              items: {
                data: [{ price: { id: "price_pro_monthly" } }],
              },
            },
          },
        }),
      });

      const response = await handler(request);
      expect(response.status).toBe(200);
      // Callback should NOT be called for duplicates
      expect(callbacksCalled).not.toContain("cancelled:sub_duplicate");
    });

    it("handles customer.subscription.updated with status change to canceled", async () => {
      const request = new Request("http://localhost/api/stripe/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "evt_sub_updated",
          type: "customer.subscription.updated",
          data: {
            object: {
              id: "sub_status_cancel",
              customer: "cus_webhook",
              status: "canceled",
              metadata: {},
              items: {
                data: [{ price: { id: "price_pro_monthly" } }],
              },
            },
            previous_attributes: {
              status: "active",
            },
          },
        }),
      });

      const response = await handler(request);
      expect(response.status).toBe(200);
      expect(callbacksCalled).toContain("cancelled:sub_status_cancel");
    });

    it("handles plan change event", async () => {
      await seedPrice({ id: "price_basic_monthly", productId: "prod_basic", unitAmount: 500 });
      await seedSubscription({
        id: "sub_upgrade",
        customerId: "cus_webhook",
        priceId: "price_pro_monthly",
        status: "active",
      });

      const request = new Request("http://localhost/api/stripe/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "evt_sub_updated",
          type: "customer.subscription.updated",
          data: {
            object: {
              id: "sub_upgrade",
              customer: "cus_webhook",
              status: "active",
              metadata: {},
              items: {
                data: [{ price: { id: "price_pro_monthly" } }],
              },
            },
            previous_attributes: {
              items: {
                data: [{ price: { id: "price_basic_monthly" } }],
              },
            },
          },
        }),
      });

      const response = await handler(request);
      expect(response.status).toBe(200);
      expect(callbacksCalled).toContain("changed:sub_upgrade:price_basic_monthly");
    });
  });

  // Note: Invoice and checkout session events that require Stripe API calls
  // (e.g., subscription retrieval) are tested in lifecycle.test.ts with proper mocking

  describe("Payment Intent Events", () => {
    it("handles payment_intent.succeeded for top-up", async () => {
      await seedCustomer({ id: "cus_topup" });
      await seedUserMap({ userId: "user_topup", stripeCustomerId: "cus_topup" });

      const request = new Request("http://localhost/api/stripe/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "evt_pi_succeeded",
          type: "payment_intent.succeeded",
          data: {
            object: {
              id: "pi_topup",
              customer: "cus_topup",
              amount: 1000,
              currency: "usd",
              status: "succeeded",
              metadata: {
                top_up_key: "api_calls",
                top_up_amount: "100",
                user_id: "user_topup",
              },
            },
          },
        }),
      });

      const response = await handler(request);
      expect(response.status).toBe(200);
    });

    it("ignores payment intents without top-up metadata", async () => {
      const request = new Request("http://localhost/api/stripe/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "evt_pi_succeeded",
          type: "payment_intent.succeeded",
          data: {
            object: {
              id: "pi_other",
              customer: "cus_other",
              amount: 5000,
              currency: "usd",
              status: "succeeded",
              metadata: {},
            },
          },
        }),
      });

      const response = await handler(request);
      expect(response.status).toBe(200);
    });
  });
});
