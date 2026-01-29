import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { StripeProxy as Stripe } from "../src/stripe-proxy";

// ============================================================================
// Mock Setup
// ============================================================================

const MOCK_STRIPE_SK = "sk_test_123";

// Mock Pool
let mockQueryResult = { rows: [] as any[] };
let mockQueryError: Error | null = null;
const mockQuery = mock((_query: string, _params: unknown[]) => {
  if (mockQueryError) return Promise.reject(mockQueryError);
  return Promise.resolve(mockQueryResult);
});
const mockEnd = mock(() => Promise.resolve());

mock.module("pg", () => ({
  Pool: class MockPool {
    query = mockQuery;
    end = mockEnd;
  },
}));

// Mock Stripe - store references for test assertions
const stripeMocks: Record<string, ReturnType<typeof createMockResource>> = {};

function createMockResource(name: string) {
  return {
    list: mock(() =>
      Promise.resolve({
        object: "list",
        data: [{ id: `${name}_stripe_1` }],
        has_more: false,
        url: `/v1/${name}`,
      }),
    ),
    retrieve: mock(() =>
      Promise.resolve({
        id: `${name}_stripe_1`,
        lastResponse: { headers: {}, requestId: "req_123", statusCode: 200 },
      }),
    ),
    create: mock(() =>
      Promise.resolve({
        id: `${name}_new_1`,
        lastResponse: { headers: {}, requestId: "req_124", statusCode: 200 },
      }),
    ),
    update: mock(() =>
      Promise.resolve({
        id: `${name}_stripe_1`,
        lastResponse: { headers: {}, requestId: "req_125", statusCode: 200 },
      }),
    ),
    del: mock(() =>
      Promise.resolve({
        id: `${name}_stripe_1`,
        deleted: true,
        lastResponse: { headers: {}, requestId: "req_126", statusCode: 200 },
      }),
    ),
  };
}

mock.module("stripe", () => ({
  default: class MockStripe {
    // Define mock module while also storing references in stripeMocks for test assertions
    products = (stripeMocks.products = createMockResource("prod"));
    prices = (stripeMocks.prices = createMockResource("price"));
    customers = (stripeMocks.customers = createMockResource("cus"));
    subscriptions = (stripeMocks.subscriptions = createMockResource("sub"));
    invoices = (stripeMocks.invoices = createMockResource("in"));
    charges = (stripeMocks.charges = createMockResource("ch"));
    paymentIntents = (stripeMocks.paymentIntents = createMockResource("pi"));
    paymentMethods = (stripeMocks.paymentMethods = createMockResource("pm"));
    setupIntents = (stripeMocks.setupIntents = createMockResource("seti"));
    plans = (stripeMocks.plans = createMockResource("plan"));
    coupons = (stripeMocks.coupons = createMockResource("coupon"));
    refunds = (stripeMocks.refunds = createMockResource("re"));
    disputes = (stripeMocks.disputes = createMockResource("dp"));
    checkout = { sessions: {} };
    billingPortal = { sessions: {} };
    webhooks = { constructEvent: () => {} };
    webhookEndpoints = {};
  },
}));

function resetMocks() {
  mockQueryResult = { rows: [] };
  mockQueryError = null;
  mockQuery.mockClear();
  mockEnd.mockClear();
  Object.values(stripeMocks).forEach((r) => {
    r.list.mockClear();
    r.retrieve.mockClear();
    r.create.mockClear();
    r.update.mockClear();
    r.del.mockClear();
  });
}

// ============================================================================
// Tests
// ============================================================================

describe("Stripe Proxy", () => {
  beforeEach(resetMocks);

  describe("Constructor", () => {
    it("should throw error when no API key provided and no env var set", () => {
      const originalEnv = process.env.STRIPE_SECRET_KEY;
      delete process.env.STRIPE_SECRET_KEY;
      expect(() => new Stripe()).toThrow(
        "Stripe secret key is required. Pass it as first argument or set STRIPE_SECRET_KEY env var.",
      );
      process.env.STRIPE_SECRET_KEY = originalEnv;
    });

    it("should use API key from constructor argument", () => {
      expect(new Stripe(MOCK_STRIPE_SK)).toBeDefined();
    });

    it("should use API key from environment variable", () => {
      const originalEnv = process.env.STRIPE_SECRET_KEY;
      process.env.STRIPE_SECRET_KEY = "sk_test_from_env";
      expect(new Stripe()).toBeDefined();
      process.env.STRIPE_SECRET_KEY = originalEnv;
    });

    it("should initialize with database URL from config", () => {
      const proxy = new Stripe(MOCK_STRIPE_SK, {
        databaseUrl: "postgres://localhost/test",
      });
      expect(proxy.hasDatabase).toBe(true);
    });

    it("should initialize with database URL from environment", () => {
      const originalEnv = process.env.DATABASE_URL;
      process.env.DATABASE_URL = "postgres://localhost/test";
      expect(new Stripe(MOCK_STRIPE_SK).hasDatabase).toBe(true);
      process.env.DATABASE_URL = originalEnv;
    });

    it("should initialize without database when no URL provided", () => {
      const originalEnv = process.env.DATABASE_URL;
      delete process.env.DATABASE_URL;
      expect(new Stripe(MOCK_STRIPE_SK).hasDatabase).toBe(false);
      process.env.DATABASE_URL = originalEnv;
    });

    it("should use custom schema from config", () => {
      const proxy = new Stripe(MOCK_STRIPE_SK, {
        databaseUrl: "postgres://localhost/test",
        schema: "custom_schema",
      });
      expect(proxy.hasDatabase).toBe(true);
    });

    it("should accept pool config object for database", () => {
      const proxy = new Stripe(MOCK_STRIPE_SK, {
        databaseUrl: { host: "localhost", database: "test" },
      });
      expect(proxy.hasDatabase).toBe(true);
    });
  });

  describe("hasDatabase property", () => {
    it("should return true when database is configured", () => {
      const proxy = new Stripe(MOCK_STRIPE_SK, {
        databaseUrl: "postgres://localhost/test",
      });
      expect(proxy.hasDatabase).toBe(true);
    });

    it("should return false when database is not configured", () => {
      const originalEnv = process.env.DATABASE_URL;
      delete process.env.DATABASE_URL;
      expect(new Stripe(MOCK_STRIPE_SK).hasDatabase).toBe(false);
      process.env.DATABASE_URL = originalEnv;
    });
  });

  describe("raw property", () => {
    it("should return the underlying Stripe instance", () => {
      expect(new Stripe(MOCK_STRIPE_SK).raw).toBeDefined();
    });
  });

  describe("close method", () => {
    it("should close the database pool", async () => {
      const proxy = new Stripe(MOCK_STRIPE_SK, {
        databaseUrl: "postgres://localhost/test",
      });
      await proxy.close();
      expect(mockEnd).toHaveBeenCalled();
    });

    it("should handle close when no pool exists", async () => {
      const originalEnv = process.env.DATABASE_URL;
      delete process.env.DATABASE_URL;
      const proxy = new Stripe(MOCK_STRIPE_SK);
      await proxy.close();
      process.env.DATABASE_URL = originalEnv;
    });
  });

  describe("Read operations without database", () => {
    let proxy: Stripe;

    beforeEach(() => {
      const originalEnv = process.env.DATABASE_URL;
      delete process.env.DATABASE_URL;
      proxy = new Stripe(MOCK_STRIPE_SK);
      process.env.DATABASE_URL = originalEnv;
    });

    const resources = [
      ["products", "list"],
      ["prices", "list"],
      ["customers", "list"],
      ["subscriptions", "list"],
      ["invoices", "list"],
      ["charges", "list"],
      ["paymentIntents", "list"],
      ["setupIntents", "list"],
      ["plans", "list"],
      ["coupons", "list"],
      ["refunds", "list"],
      ["disputes", "list"],
    ] as const;

    resources.forEach(([resource]) => {
      it(`${resource}.list should call Stripe API`, async () => {
        await (proxy as any)[resource].list();
        expect(stripeMocks[resource].list).toHaveBeenCalled();
      });
    });

    it("products.retrieve should call Stripe API", async () => {
      await proxy.products.retrieve("prod_123");
      expect(stripeMocks.products.retrieve).toHaveBeenCalledWith(
        "prod_123",
        undefined,
      );
    });

    it("paymentMethods.list should call Stripe API", async () => {
      await proxy.paymentMethods.list({ customer: "cus_123" } as any);
      expect(stripeMocks.paymentMethods.list).toHaveBeenCalled();
    });
  });

  describe("Read operations with database", () => {
    let proxy: Stripe;

    beforeEach(() => {
      proxy = new Stripe(MOCK_STRIPE_SK, {
        databaseUrl: "postgres://localhost/test",
      });
    });

    afterEach(() => proxy.close());

    describe("list operations", () => {
      it("should query database and return results", async () => {
        mockQueryResult = {
          rows: [
            { id: "prod_db_1", name: "DB Product 1" },
            { id: "prod_db_2", name: "DB Product 2" },
          ],
        };
        const result = await proxy.products.list();
        expect(mockQuery).toHaveBeenCalled();
        expect(stripeMocks.products.list).not.toHaveBeenCalled();
        expect(result.data).toHaveLength(2);
        expect(result.data[0].id).toBe("prod_db_1");
        expect(result.has_more).toBe(false);
      });

      it("should generate correct SQL for basic list query", async () => {
        mockQueryResult = { rows: [] };
        await proxy.products.list();
        const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
        expect(query).toContain("SELECT * FROM stripe.products");
        expect(query).toContain("ORDER BY id DESC");
        expect(query).toContain("LIMIT");
      });

      it("should apply limit parameter", async () => {
        mockQueryResult = { rows: [] };
        await proxy.products.list({ limit: 5 });
        const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
        expect(params).toContain(6); // limit + 1 for has_more check
      });

      it("should cap limit at 100", async () => {
        mockQueryResult = { rows: [] };
        await proxy.products.list({ limit: 200 });
        const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
        expect(params).toContain(101);
      });

      it("should detect has_more when more results exist", async () => {
        mockQueryResult = {
          rows: Array(11)
            .fill(null)
            .map((_, i) => ({ id: `prod_${i}` })),
        };
        const result = await proxy.products.list();
        expect(result.has_more).toBe(true);
        expect(result.data).toHaveLength(10);
      });

      it("should handle starting_after pagination", async () => {
        mockQueryResult = { rows: [] };
        await proxy.products.list({ starting_after: "prod_abc" });
        const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
        expect(query).toContain("id < $");
        expect(params).toContain("prod_abc");
        expect(query).toContain("ORDER BY id DESC");
      });

      it("should handle ending_before pagination", async () => {
        mockQueryResult = { rows: [{ id: "prod_2" }, { id: "prod_1" }] };
        const result = await proxy.products.list({ ending_before: "prod_xyz" });
        const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
        expect(query).toContain("id > $");
        expect(params).toContain("prod_xyz");
        expect(query).toContain("ORDER BY id ASC");
        expect(result.data[0].id).toBe("prod_1");
      });

      it("should handle created filter as number", async () => {
        mockQueryResult = { rows: [] };
        await proxy.products.list({ created: 1234567890 });
        const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
        expect(query).toContain("created = $");
        expect(params).toContain(1234567890);
      });

      const createdFilterTests = [
        ["gt", ">"],
        ["gte", ">="],
        ["lt", "<"],
        ["lte", "<="],
      ] as const;

      createdFilterTests.forEach(([op, sql]) => {
        it(`should handle created filter with ${op}`, async () => {
          mockQueryResult = { rows: [] };
          await proxy.products.list({ created: { [op]: 1234567890 } });
          const [query, params] = mockQuery.mock.calls[0] as [
            string,
            unknown[],
          ];
          expect(query).toContain(`created ${sql} $`);
          expect(params).toContain(1234567890);
        });
      });

      it("should handle created filter with multiple conditions", async () => {
        mockQueryResult = { rows: [] };
        await proxy.products.list({
          created: { gte: 1000000000, lte: 2000000000 },
        });
        const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
        expect(query).toContain("created >= $");
        expect(query).toContain("created <= $");
        expect(params).toContain(1000000000);
        expect(params).toContain(2000000000);
      });

      it("should fall back to Stripe API on database error", async () => {
        mockQueryError = new Error("Database connection failed");
        await proxy.products.list();
        expect(mockQuery).toHaveBeenCalled();
        expect(stripeMocks.products.list).toHaveBeenCalled();
      });

      it("should use custom schema in queries", async () => {
        await proxy.close();
        proxy = new Stripe(MOCK_STRIPE_SK, {
          databaseUrl: "postgres://localhost/test",
          schema: "my_schema",
        });
        mockQueryResult = { rows: [] };
        await proxy.products.list();
        const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
        expect(query).toContain("FROM my_schema.products");
      });
    });

    describe("retrieve operations", () => {
      it("should query database and return result", async () => {
        mockQueryResult = { rows: [{ id: "prod_db_1", name: "DB Product" }] };
        const result = await proxy.products.retrieve("prod_db_1");
        expect(mockQuery).toHaveBeenCalled();
        expect(stripeMocks.products.retrieve).not.toHaveBeenCalled();
        expect(result.id).toBe("prod_db_1");
      });

      it("should generate correct SQL for retrieve query", async () => {
        mockQueryResult = { rows: [{ id: "prod_123" }] };
        await proxy.products.retrieve("prod_123");
        const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
        expect(query).toContain("SELECT * FROM stripe.products WHERE id = $1");
        expect(params).toEqual(["prod_123"]);
      });

      it("should add lastResponse stub for DB results", async () => {
        mockQueryResult = { rows: [{ id: "prod_db_1" }] };
        const result = await proxy.products.retrieve("prod_db_1");
        expect(result.lastResponse).toBeDefined();
        expect(result.lastResponse.requestId).toBe("db-cache");
        expect(result.lastResponse.statusCode).toBe(200);
      });

      it("should fall back to Stripe API when not found in database", async () => {
        mockQueryResult = { rows: [] };
        await proxy.products.retrieve("prod_not_found");
        expect(mockQuery).toHaveBeenCalled();
        expect(stripeMocks.products.retrieve).toHaveBeenCalledWith(
          "prod_not_found",
          undefined,
        );
      });

      it("should fall back to Stripe API on database error", async () => {
        mockQueryError = new Error("Database connection failed");
        await proxy.products.retrieve("prod_123");
        expect(mockQuery).toHaveBeenCalled();
        expect(stripeMocks.products.retrieve).toHaveBeenCalled();
      });
    });

    describe("resource-specific filters", () => {
      beforeEach(() => {
        mockQueryResult = { rows: [] };
      });

      it("products should filter by active", async () => {
        await proxy.products.list({ active: true });
        const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
        expect(query).toContain("active = $");
        expect(params).toContain(true);
      });

      it("prices should filter by product, currency, type, active", async () => {
        await proxy.prices.list({
          product: "prod_123",
          currency: "usd",
          type: "recurring",
          active: true,
        });
        const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
        ["product", "currency", "type", "active"].forEach((f) =>
          expect(query).toContain(`${f} = $`),
        );
        expect(params).toContain("prod_123");
        expect(params).toContain("usd");
        expect(params).toContain("recurring");
        expect(params).toContain(true);
      });

      it("customers should filter by email and exclude deleted", async () => {
        await proxy.customers.list({ email: "test@example.com" });
        const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
        expect(query).toContain("deleted = $");
        expect(query).toContain("email = $");
        expect(params).toContain(false);
        expect(params).toContain("test@example.com");
      });

      it("subscriptions should filter by customer, status", async () => {
        await proxy.subscriptions.list({
          customer: "cus_123",
          status: "active",
        });
        const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
        expect(query).toContain("customer = $");
        expect(query).toContain("status = $");
        expect(params).toContain("cus_123");
        expect(params).toContain("active");
      });

      it("invoices should filter by customer, subscription, status", async () => {
        await proxy.invoices.list({
          customer: "cus_123",
          subscription: "sub_456",
          status: "paid",
        });
        const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
        ["customer", "subscription", "status"].forEach((f) =>
          expect(query).toContain(`${f} = $`),
        );
        expect(params).toContain("cus_123");
        expect(params).toContain("sub_456");
        expect(params).toContain("paid");
      });

      it("charges should filter by customer, payment_intent", async () => {
        await proxy.charges.list({
          customer: "cus_123",
          payment_intent: "pi_456",
        });
        const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
        expect(query).toContain("customer = $");
        expect(query).toContain("payment_intent = $");
        expect(params).toContain("cus_123");
        expect(params).toContain("pi_456");
      });

      it("paymentIntents should filter by customer", async () => {
        await proxy.paymentIntents.list({ customer: "cus_123" });
        const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
        expect(query).toContain("customer = $");
        expect(params).toContain("cus_123");
      });

      it("paymentMethods should filter by customer, type", async () => {
        await proxy.paymentMethods.list({
          customer: "cus_123",
          type: "card",
        } as any);
        const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
        expect(query).toContain("customer = $");
        expect(query).toContain("type = $");
        expect(params).toContain("cus_123");
        expect(params).toContain("card");
      });

      it("setupIntents should filter by customer, payment_method", async () => {
        await proxy.setupIntents.list({
          customer: "cus_123",
          payment_method: "pm_456",
        });
        const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
        expect(query).toContain("customer = $");
        expect(query).toContain("payment_method = $");
        expect(params).toContain("cus_123");
        expect(params).toContain("pm_456");
      });

      it("plans should filter by active, product", async () => {
        await proxy.plans.list({ active: true, product: "prod_123" });
        const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
        expect(query).toContain("active = $");
        expect(query).toContain("product = $");
        expect(params).toContain(true);
        expect(params).toContain("prod_123");
      });

      it("refunds should filter by charge, payment_intent", async () => {
        await proxy.refunds.list({
          charge: "ch_123",
          payment_intent: "pi_456",
        });
        const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
        expect(query).toContain("charge = $");
        expect(query).toContain("payment_intent = $");
        expect(params).toContain("ch_123");
        expect(params).toContain("pi_456");
      });

      it("disputes should filter by charge, payment_intent", async () => {
        await proxy.disputes.list({
          charge: "ch_123",
          payment_intent: "pi_456",
        });
        const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
        expect(query).toContain("charge = $");
        expect(query).toContain("payment_intent = $");
        expect(params).toContain("ch_123");
        expect(params).toContain("pi_456");
      });
    });
  });

  describe("Write operations (always go to Stripe)", () => {
    let proxy: Stripe;

    beforeEach(() => {
      proxy = new Stripe(MOCK_STRIPE_SK, {
        databaseUrl: "postgres://localhost/test",
      });
    });

    afterEach(() => proxy.close());

    describe("create operations", () => {
      const createTests: [string, string, any][] = [
        ["products", "products", { name: "New Product" }],
        [
          "prices",
          "prices",
          { currency: "usd", unit_amount: 1000, product: "prod_123" },
        ],
        ["customers", "customers", { email: "test@example.com" }],
        [
          "subscriptions",
          "subscriptions",
          { customer: "cus_123", items: [{ price: "price_123" }] },
        ],
        ["invoices", "invoices", { customer: "cus_123" }],
        [
          "charges",
          "charges",
          { amount: 1000, currency: "usd", source: "tok_123" },
        ],
        ["paymentIntents", "paymentIntents", { amount: 1000, currency: "usd" }],
        ["paymentMethods", "paymentMethods", { type: "card" }],
        ["setupIntents", "setupIntents", {}],
        [
          "plans",
          "plans",
          {
            amount: 1000,
            currency: "usd",
            interval: "month",
            product: "prod_123",
          },
        ],
        ["coupons", "coupons", { percent_off: 25, duration: "once" }],
        ["refunds", "refunds", { charge: "ch_123" }],
      ];

      createTests.forEach(([resource, mockKey, params]) => {
        it(`${resource}.create should call Stripe API`, async () => {
          await (proxy as any)[resource].create(params);
          expect(stripeMocks[mockKey].create).toHaveBeenCalled();
          expect(mockQuery).not.toHaveBeenCalled();
        });
      });
    });

    describe("update operations", () => {
      const updateTests: [string, string, string, any][] = [
        ["products", "products", "prod_123", { name: "Updated Product" }],
        ["prices", "prices", "price_123", { active: false }],
        ["customers", "customers", "cus_123", { name: "Updated Name" }],
        [
          "subscriptions",
          "subscriptions",
          "sub_123",
          { cancel_at_period_end: true },
        ],
        ["invoices", "invoices", "in_123", { description: "Updated" }],
        ["charges", "charges", "ch_123", { description: "Updated" }],
        [
          "paymentIntents",
          "paymentIntents",
          "pi_123",
          { description: "Updated" },
        ],
        ["paymentMethods", "paymentMethods", "pm_123", {}],
        ["setupIntents", "setupIntents", "seti_123", {}],
        ["plans", "plans", "plan_123", { active: false }],
        ["coupons", "coupons", "coupon_123", { name: "Updated" }],
        ["refunds", "refunds", "re_123", {}],
        ["disputes", "disputes", "dp_123", {}],
      ];

      updateTests.forEach(([resource, mockKey, id, params]) => {
        it(`${resource}.update should call Stripe API`, async () => {
          await (proxy as any)[resource].update(id, params);
          expect(stripeMocks[mockKey].update).toHaveBeenCalled();
          expect(mockQuery).not.toHaveBeenCalled();
        });
      });
    });

    describe("delete operations", () => {
      const deleteTests: [string, string, string][] = [
        ["products", "products", "prod_123"],
        ["customers", "customers", "cus_123"],
        ["subscriptions", "subscriptions", "sub_123"],
        ["plans", "plans", "plan_123"],
        ["coupons", "coupons", "coupon_123"],
      ];

      deleteTests.forEach(([resource, mockKey, id]) => {
        it(`${resource}.del should call Stripe API`, async () => {
          await (proxy as any)[resource].del(id);
          expect(stripeMocks[mockKey].del).toHaveBeenCalled();
          expect(mockQuery).not.toHaveBeenCalled();
        });
      });
    });
  });

  describe("Pass-through resources", () => {
    let proxy: Stripe;

    beforeEach(() => {
      proxy = new Stripe(MOCK_STRIPE_SK, {
        databaseUrl: "postgres://localhost/test",
      });
    });

    afterEach(() => proxy.close());

    ["checkout", "billingPortal", "webhooks", "webhookEndpoints"].forEach(
      (resource) => {
        it(`${resource} should be available`, () => {
          expect((proxy as any)[resource]).toBeDefined();
        });
      },
    );
  });

  describe("SQL query construction", () => {
    let proxy: Stripe;

    beforeEach(() => {
      proxy = new Stripe(MOCK_STRIPE_SK, {
        databaseUrl: "postgres://localhost/test",
      });
      mockQueryResult = { rows: [] };
    });

    afterEach(() => proxy.close());

    it("should build WHERE clause with multiple conditions", async () => {
      await proxy.customers.list({
        email: "test@example.com",
        created: { gte: 1000000000 },
        starting_after: "cus_abc",
      });
      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain("WHERE");
      expect(query).toContain("AND");
      expect(params).toContain(false);
      expect(params).toContain(1000000000);
      expect(params).toContain("cus_abc");
      expect(params).toContain("test@example.com");
    });

    it("should handle no conditions (basic list)", async () => {
      await proxy.products.list();
      const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).not.toContain("WHERE");
      expect(query).toContain("ORDER BY id DESC");
      expect(query).toContain("LIMIT");
    });

    it("should properly escape schema and table names", async () => {
      await proxy.close();
      proxy = new Stripe(MOCK_STRIPE_SK, {
        databaseUrl: "postgres://localhost/test",
        schema: "my_schema",
      });
      await proxy.paymentIntents.list();
      const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain("FROM my_schema.payment_intents");
    });

    it("should use parameterized queries to prevent SQL injection", async () => {
      const maliciousInput = "'; DROP TABLE users; --";
      await proxy.customers.list({ email: maliciousInput });
      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).not.toContain(maliciousInput);
      expect(params).toContain(maliciousInput);
    });
  });

  describe("Complex pagination scenarios", () => {
    let proxy: Stripe;

    beforeEach(() => {
      proxy = new Stripe(MOCK_STRIPE_SK, {
        databaseUrl: "postgres://localhost/test",
      });
    });

    afterEach(() => proxy.close());

    it("should handle pagination with filters", async () => {
      mockQueryResult = { rows: [] };
      await proxy.products.list({
        active: true,
        created: { gte: 1000000000 },
        starting_after: "prod_abc",
        limit: 25,
      });
      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain("active = $");
      expect(query).toContain("created >= $");
      expect(query).toContain("id < $");
      expect(params).toContain(true);
      expect(params).toContain(1000000000);
      expect(params).toContain("prod_abc");
      expect(params).toContain(26);
    });

    it("should return correct url in list response", async () => {
      mockQueryResult = { rows: [{ id: "prod_1" }] };
      const result = await proxy.products.list();
      expect(result.url).toBe("/v1/products");
      expect(result.object).toBe("list");
    });
  });
});
