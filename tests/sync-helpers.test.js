import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  buildProductsByNameMap,
  buildPricesByKeyMap,
  findMatchingProduct,
  findMatchingPrice,
  generatePriceKey,
  syncPlan,
} from "../bin/commands/helpers/sync-helpers.js";
import StripeMock from "./stripe-mock.js";

describe("buildProductsByNameMap", () => {
  test("builds map from Stripe products", () => {
    const products = [
      { id: "prod_123", name: "Premium Plan" },
      { id: "prod_456", name: "Basic Plan" },
    ];

    const map = buildProductsByNameMap(products);

    expect(map["premium plan"]).toEqual({
      id: "prod_123",
      name: "Premium Plan",
    });
    expect(map["basic plan"]).toEqual({ id: "prod_456", name: "Basic Plan" });
  });

  test("uses lowercase keys for case-insensitive matching", () => {
    const products = [{ id: "prod_123", name: "PREMIUM PLAN" }];

    const map = buildProductsByNameMap(products);

    expect(map["premium plan"]).toBeDefined();
    expect(map["PREMIUM PLAN"]).toBeUndefined();
  });

  test("trims whitespace from names", () => {
    const products = [{ id: "prod_123", name: "  Premium Plan  " }];

    const map = buildProductsByNameMap(products);

    expect(map["premium plan"]).toBeDefined();
  });

  test("keeps first product when duplicates exist", () => {
    const products = [
      { id: "prod_123", name: "Premium Plan" },
      { id: "prod_456", name: "premium plan" },
    ];

    const map = buildProductsByNameMap(products);

    expect(map["premium plan"].id).toBe("prod_123");
  });

  test("handles empty array", () => {
    const map = buildProductsByNameMap([]);
    expect(Object.keys(map).length).toBe(0);
  });
});

describe("buildPricesByKeyMap", () => {
  test("builds map from Stripe prices", () => {
    const prices = [
      {
        id: "price_123",
        product: "prod_abc",
        unit_amount: 1000,
        currency: "usd",
        recurring: { interval: "month" },
      },
      {
        id: "price_456",
        product: "prod_abc",
        unit_amount: 10000,
        currency: "usd",
        recurring: { interval: "year" },
      },
    ];

    const map = buildPricesByKeyMap(prices);

    expect(map["prod_abc:1000:usd:month"]).toBeDefined();
    expect(map["prod_abc:1000:usd:month"].id).toBe("price_123");
    expect(map["prod_abc:10000:usd:year"]).toBeDefined();
    expect(map["prod_abc:10000:usd:year"].id).toBe("price_456");
  });

  test("handles product as object instead of string", () => {
    const prices = [
      {
        id: "price_123",
        product: { id: "prod_abc", name: "Test" },
        unit_amount: 1000,
        currency: "usd",
        recurring: { interval: "month" },
      },
    ];

    const map = buildPricesByKeyMap(prices);

    expect(map["prod_abc:1000:usd:month"]).toBeDefined();
  });

  test("handles one_time prices without recurring", () => {
    const prices = [
      {
        id: "price_123",
        product: "prod_abc",
        unit_amount: 5000,
        currency: "usd",
      },
    ];

    const map = buildPricesByKeyMap(prices);

    expect(map["prod_abc:5000:usd:one_time"]).toBeDefined();
  });

  test("handles empty array", () => {
    const map = buildPricesByKeyMap([]);
    expect(Object.keys(map).length).toBe(0);
  });
});

describe("findMatchingProduct", () => {
  test("finds product with exact name match (case-insensitive)", () => {
    const productsByName = {
      "premium plan": { id: "prod_123", name: "Premium Plan" },
    };

    const result = findMatchingProduct(productsByName, "Premium Plan");
    expect(result).toEqual({ id: "prod_123", name: "Premium Plan" });
  });

  test("finds product with different case", () => {
    const productsByName = {
      "premium plan": { id: "prod_123", name: "Premium Plan" },
    };

    const result = findMatchingProduct(productsByName, "PREMIUM PLAN");
    expect(result).toEqual({ id: "prod_123", name: "Premium Plan" });
  });

  test("finds product with extra whitespace", () => {
    const productsByName = {
      "premium plan": { id: "prod_123", name: "Premium Plan" },
    };

    const result = findMatchingProduct(productsByName, "  Premium Plan  ");
    expect(result).toEqual({ id: "prod_123", name: "Premium Plan" });
  });

  test("returns null when no match found", () => {
    const productsByName = {
      "premium plan": { id: "prod_123", name: "Premium Plan" },
    };

    const result = findMatchingProduct(productsByName, "Basic Plan");
    expect(result).toBeNull();
  });
});

describe("findMatchingPrice", () => {
  test("finds price with matching attributes", () => {
    const pricesByKey = {
      "prod_123:1000:usd:month": { id: "price_abc", unit_amount: 1000 },
    };

    const result = findMatchingPrice(pricesByKey, "prod_123", {
      amount: 1000,
      currency: "usd",
      interval: "month",
    });

    expect(result).toEqual({ id: "price_abc", unit_amount: 1000 });
  });

  test("finds price with uppercase currency", () => {
    const pricesByKey = {
      "prod_123:1000:usd:month": { id: "price_abc" },
    };

    const result = findMatchingPrice(pricesByKey, "prod_123", {
      amount: 1000,
      currency: "USD",
      interval: "month",
    });

    expect(result).toEqual({ id: "price_abc" });
  });

  test("returns null when amount differs", () => {
    const pricesByKey = {
      "prod_123:1000:usd:month": { id: "price_abc" },
    };

    const result = findMatchingPrice(pricesByKey, "prod_123", {
      amount: 2000,
      currency: "usd",
      interval: "month",
    });

    expect(result).toBeNull();
  });

  test("returns null when interval differs", () => {
    const pricesByKey = {
      "prod_123:1000:usd:month": { id: "price_abc" },
    };

    const result = findMatchingPrice(pricesByKey, "prod_123", {
      amount: 1000,
      currency: "usd",
      interval: "year",
    });

    expect(result).toBeNull();
  });

  test("handles one_time interval", () => {
    const pricesByKey = {
      "prod_123:5000:usd:one_time": { id: "price_abc" },
    };

    const result = findMatchingPrice(pricesByKey, "prod_123", {
      amount: 5000,
      currency: "usd",
      interval: "one_time",
    });

    expect(result).toEqual({ id: "price_abc" });
  });

  test("defaults to one_time when interval is undefined", () => {
    const pricesByKey = {
      "prod_123:5000:usd:one_time": { id: "price_abc" },
    };

    const result = findMatchingPrice(pricesByKey, "prod_123", {
      amount: 5000,
      currency: "usd",
    });

    expect(result).toEqual({ id: "price_abc" });
  });
});

describe("generatePriceKey", () => {
  test("generates correct key format", () => {
    const key = generatePriceKey("prod_123", 1000, "usd", "month");
    expect(key).toBe("prod_123:1000:usd:month");
  });

  test("lowercases currency", () => {
    const key = generatePriceKey("prod_123", 1000, "USD", "month");
    expect(key).toBe("prod_123:1000:usd:month");
  });

  test("defaults to one_time for undefined interval", () => {
    const key = generatePriceKey("prod_123", 1000, "usd", undefined);
    expect(key).toBe("prod_123:1000:usd:one_time");
  });
});

describe("syncPlan", () => {
  test("matches existing product by name", async () => {
    const plan = {
      name: "Premium Plan",
      price: [{ amount: 1000, currency: "usd", interval: "month" }],
    };

    const productsByName = {
      "premium plan": { id: "prod_existing", name: "Premium Plan" },
    };

    const pricesByKey = {
      "prod_existing:1000:usd:month": { id: "price_existing" },
    };

    const mockStripe = {
      products: { create: mock(() => {}) },
      prices: { create: mock(() => {}) },
    };

    const result = await syncPlan(
      plan,
      productsByName,
      pricesByKey,
      mockStripe
    );

    expect(result.productMatched).toBe(true);
    expect(result.productCreated).toBe(false);
    expect(result.plan.id).toBe("prod_existing");
    expect(mockStripe.products.create).not.toHaveBeenCalled();
  });

  test("creates new product when no match found", async () => {
    const plan = {
      name: "New Plan",
      description: "A new plan",
      price: [],
    };

    const productsByName = {};
    const pricesByKey = {};

    const mockStripe = {
      products: {
        create: mock(() =>
          Promise.resolve({ id: "prod_new", name: "New Plan" })
        ),
      },
      prices: { create: mock(() => {}) },
    };

    const result = await syncPlan(
      plan,
      productsByName,
      pricesByKey,
      mockStripe
    );

    expect(result.productMatched).toBe(false);
    expect(result.productCreated).toBe(true);
    expect(result.plan.id).toBe("prod_new");
    expect(mockStripe.products.create).toHaveBeenCalledWith({
      name: "New Plan",
      description: "A new plan",
    });
  });

  test("matches existing price by attributes", async () => {
    const plan = {
      id: "prod_123",
      name: "Premium Plan",
      price: [{ amount: 1000, currency: "usd", interval: "month" }],
    };

    const productsByName = {};
    const pricesByKey = {
      "prod_123:1000:usd:month": { id: "price_existing" },
    };

    const mockStripe = {
      products: { create: mock(() => {}) },
      prices: { create: mock(() => {}) },
    };

    const result = await syncPlan(
      plan,
      productsByName,
      pricesByKey,
      mockStripe
    );

    expect(result.pricesMatched).toBe(1);
    expect(result.pricesCreated).toBe(0);
    expect(result.plan.price[0].id).toBe("price_existing");
    expect(mockStripe.prices.create).not.toHaveBeenCalled();
  });

  test("creates new price when no match found", async () => {
    const plan = {
      id: "prod_123",
      name: "Premium Plan",
      price: [{ amount: 2000, currency: "eur", interval: "year" }],
    };

    const productsByName = {};
    const pricesByKey = {};

    const mockStripe = {
      products: { create: mock(() => {}) },
      prices: {
        create: mock(() => Promise.resolve({ id: "price_new" })),
      },
    };

    const result = await syncPlan(
      plan,
      productsByName,
      pricesByKey,
      mockStripe
    );

    expect(result.pricesMatched).toBe(0);
    expect(result.pricesCreated).toBe(1);
    expect(result.plan.price[0].id).toBe("price_new");
    expect(mockStripe.prices.create).toHaveBeenCalledWith({
      product: "prod_123",
      unit_amount: 2000,
      currency: "eur",
      recurring: { interval: "year" },
    });
  });

  test("creates one_time price without recurring", async () => {
    const plan = {
      id: "prod_123",
      name: "One-time Product",
      price: [{ amount: 5000, currency: "usd", interval: "one_time" }],
    };

    const productsByName = {};
    const pricesByKey = {};

    const mockStripe = {
      products: { create: mock(() => {}) },
      prices: {
        create: mock(() => Promise.resolve({ id: "price_onetime" })),
      },
    };

    const result = await syncPlan(
      plan,
      productsByName,
      pricesByKey,
      mockStripe
    );

    expect(mockStripe.prices.create).toHaveBeenCalledWith({
      product: "prod_123",
      unit_amount: 5000,
      currency: "usd",
    });
    expect(result.plan.price[0].id).toBe("price_onetime");
  });

  test("skips price that already has an id", async () => {
    const plan = {
      id: "prod_123",
      name: "Premium Plan",
      price: [
        {
          id: "price_existing",
          amount: 1000,
          currency: "usd",
          interval: "month",
        },
      ],
    };

    const productsByName = {};
    const pricesByKey = {};

    const mockStripe = {
      products: { create: mock(() => {}) },
      prices: { create: mock(() => {}) },
    };

    const result = await syncPlan(
      plan,
      productsByName,
      pricesByKey,
      mockStripe
    );

    expect(result.pricesMatched).toBe(0);
    expect(result.pricesCreated).toBe(0);
    expect(mockStripe.prices.create).not.toHaveBeenCalled();
  });

  test("handles product creation error", async () => {
    const plan = {
      name: "Error Plan",
      price: [{ amount: 1000, currency: "usd", interval: "month" }],
    };

    const productsByName = {};
    const pricesByKey = {};

    const mockStripe = {
      products: {
        create: mock(() => Promise.reject(new Error("API Error"))),
      },
      prices: { create: mock(() => {}) },
    };

    const result = await syncPlan(
      plan,
      productsByName,
      pricesByKey,
      mockStripe
    );

    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("Failed to create product");
    expect(result.productCreated).toBe(false);
    expect(result.plan.id).toBeUndefined();
  });

  test("handles price creation error", async () => {
    const plan = {
      id: "prod_123",
      name: "Premium Plan",
      price: [{ amount: 1000, currency: "usd", interval: "month" }],
    };

    const productsByName = {};
    const pricesByKey = {};

    const mockStripe = {
      products: { create: mock(() => {}) },
      prices: {
        create: mock(() => Promise.reject(new Error("Price API Error"))),
      },
    };

    const result = await syncPlan(
      plan,
      productsByName,
      pricesByKey,
      mockStripe
    );

    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("Failed to create price");
    expect(result.pricesCreated).toBe(0);
  });

  test("syncs both product and price in one call", async () => {
    const plan = {
      name: "Brand New Plan",
      description: "Test description",
      price: [
        { amount: 1000, currency: "usd", interval: "month" },
        { amount: 10000, currency: "usd", interval: "year" },
      ],
    };

    const productsByName = {};
    const pricesByKey = {};

    let priceCallCount = 0;
    const mockStripe = {
      products: {
        create: mock(() => Promise.resolve({ id: "prod_brand_new" })),
      },
      prices: {
        create: mock(() => {
          priceCallCount++;
          return Promise.resolve({ id: `price_new_${priceCallCount}` });
        }),
      },
    };

    const result = await syncPlan(
      plan,
      productsByName,
      pricesByKey,
      mockStripe
    );

    expect(result.productCreated).toBe(true);
    expect(result.pricesCreated).toBe(2);
    expect(result.plan.id).toBe("prod_brand_new");
    expect(result.plan.price[0].id).toBe("price_new_1");
    expect(result.plan.price[1].id).toBe("price_new_2");
  });

  test("matches product and creates only missing prices", async () => {
    const plan = {
      name: "Premium Plan",
      price: [
        { amount: 1000, currency: "usd", interval: "month" },
        { amount: 10000, currency: "usd", interval: "year" },
      ],
    };

    const productsByName = {
      "premium plan": { id: "prod_existing" },
    };

    const pricesByKey = {
      "prod_existing:1000:usd:month": { id: "price_monthly" },
    };

    const mockStripe = {
      products: { create: mock(() => {}) },
      prices: {
        create: mock(() => Promise.resolve({ id: "price_yearly_new" })),
      },
    };

    const result = await syncPlan(
      plan,
      productsByName,
      pricesByKey,
      mockStripe
    );

    expect(result.productMatched).toBe(true);
    expect(result.productCreated).toBe(false);
    expect(result.pricesMatched).toBe(1);
    expect(result.pricesCreated).toBe(1);
    expect(result.plan.price[0].id).toBe("price_monthly");
    expect(result.plan.price[1].id).toBe("price_yearly_new");
    expect(mockStripe.products.create).not.toHaveBeenCalled();
    expect(mockStripe.prices.create).toHaveBeenCalledTimes(1);
  });
});

// Integration tests using StripeMock
describe("StripeMock", () => {
  test("works with require pattern: default || named", () => {
    // This simulates: Stripe = require("stripe").default || require("stripe")
    const Stripe =
      require("./stripe-mock.js").default || require("./stripe-mock.js");
    const stripe = new Stripe("sk_test_123");
    expect(stripe.apiKey).toBe("sk_test_123");
  });

  test("products.list returns seeded products", async () => {
    const stripe = new StripeMock("sk_test_123");
    stripe._seedProducts([
      { id: "prod_1", name: "Product 1", active: true },
      { id: "prod_2", name: "Product 2", active: false },
    ]);

    const { data } = await stripe.products.list({ active: true });
    expect(data.length).toBe(1);
    expect(data[0].name).toBe("Product 1");
  });

  test("products.create generates unique IDs", async () => {
    const stripe = new StripeMock("sk_test_123");

    const p1 = await stripe.products.create({ name: "Product 1" });
    const p2 = await stripe.products.create({ name: "Product 2" });

    expect(p1.id).not.toBe(p2.id);
    expect(p1.id).toMatch(/^prod_mock_/);
  });

  test("prices.list returns seeded prices", async () => {
    const stripe = new StripeMock("sk_test_123");
    stripe._seedPrices([
      {
        id: "price_1",
        product: "prod_1",
        unit_amount: 1000,
        currency: "usd",
        active: true,
      },
      {
        id: "price_2",
        product: "prod_1",
        unit_amount: 2000,
        currency: "usd",
        active: true,
      },
    ]);

    const { data } = await stripe.prices.list({ product: "prod_1" });
    expect(data.length).toBe(2);
  });

  test("prices.create generates unique IDs", async () => {
    const stripe = new StripeMock("sk_test_123");

    const p1 = await stripe.prices.create({
      product: "prod_1",
      unit_amount: 1000,
      currency: "usd",
    });
    const p2 = await stripe.prices.create({
      product: "prod_1",
      unit_amount: 2000,
      currency: "usd",
    });

    expect(p1.id).not.toBe(p2.id);
    expect(p1.id).toMatch(/^price_mock_/);
  });
});

describe("syncPlan with StripeMock", () => {
  let stripe;

  beforeEach(() => {
    stripe = new StripeMock("sk_test_123");
  });

  test("full sync flow: new product with new prices", async () => {
    const plan = {
      name: "Pro Plan",
      description: "Professional tier",
      price: [
        { amount: 2900, currency: "usd", interval: "month" },
        { amount: 29000, currency: "usd", interval: "year" },
      ],
    };

    const productsByName = {};
    const pricesByKey = {};

    const result = await syncPlan(plan, productsByName, pricesByKey, stripe);

    expect(result.productCreated).toBe(true);
    expect(result.pricesCreated).toBe(2);
    expect(result.plan.id).toMatch(/^prod_mock_/);
    expect(result.plan.price[0].id).toMatch(/^price_mock_/);
    expect(result.plan.price[1].id).toMatch(/^price_mock_/);

    // Verify products were actually created in the mock
    const { data: products } = await stripe.products.list();
    expect(products.length).toBe(1);
    expect(products[0].name).toBe("Pro Plan");

    // Verify prices were actually created in the mock
    const { data: prices } = await stripe.prices.list();
    expect(prices.length).toBe(2);
  });

  test("full sync flow: match existing product, create missing price", async () => {
    // Pre-seed Stripe with existing product and one price
    stripe._seedProducts([
      { id: "prod_existing", name: "Enterprise Plan", active: true },
    ]);
    stripe._seedPrices([
      {
        id: "price_monthly",
        product: "prod_existing",
        unit_amount: 9900,
        currency: "usd",
        active: true,
        recurring: { interval: "month" },
      },
    ]);

    // Build maps from "fetched" Stripe data
    const { data: products } = await stripe.products.list({ active: true });
    const { data: prices } = await stripe.prices.list({ active: true });
    const productsByName = buildProductsByNameMap(products);
    const pricesByKey = buildPricesByKeyMap(prices);

    // Plan with matching product name but additional yearly price
    const plan = {
      name: "Enterprise Plan",
      price: [
        { amount: 9900, currency: "usd", interval: "month" },
        { amount: 99000, currency: "usd", interval: "year" },
      ],
    };

    const result = await syncPlan(plan, productsByName, pricesByKey, stripe);

    expect(result.productMatched).toBe(true);
    expect(result.productCreated).toBe(false);
    expect(result.plan.id).toBe("prod_existing");
    expect(result.pricesMatched).toBe(1);
    expect(result.pricesCreated).toBe(1);
    expect(result.plan.price[0].id).toBe("price_monthly");
    expect(result.plan.price[1].id).toMatch(/^price_mock_/);

    // Verify new price was created
    const { data: allPrices } = await stripe.prices.list();
    expect(allPrices.length).toBe(2);
  });

  test("full sync flow: everything already exists", async () => {
    stripe._seedProducts([
      { id: "prod_starter", name: "Starter Plan", active: true },
    ]);
    stripe._seedPrices([
      {
        id: "price_starter_monthly",
        product: "prod_starter",
        unit_amount: 900,
        currency: "usd",
        active: true,
        recurring: { interval: "month" },
      },
    ]);

    const { data: products } = await stripe.products.list({ active: true });
    const { data: prices } = await stripe.prices.list({ active: true });
    const productsByName = buildProductsByNameMap(products);
    const pricesByKey = buildPricesByKeyMap(prices);

    const plan = {
      name: "Starter Plan",
      price: [{ amount: 900, currency: "usd", interval: "month" }],
    };

    const result = await syncPlan(plan, productsByName, pricesByKey, stripe);

    expect(result.productMatched).toBe(true);
    expect(result.productCreated).toBe(false);
    expect(result.pricesMatched).toBe(1);
    expect(result.pricesCreated).toBe(0);
    expect(result.plan.id).toBe("prod_starter");
    expect(result.plan.price[0].id).toBe("price_starter_monthly");

    // No new products or prices created
    const { data: allProducts } = await stripe.products.list();
    const { data: allPrices } = await stripe.prices.list();
    expect(allProducts.length).toBe(1);
    expect(allPrices.length).toBe(1);
  });

  test("full sync flow: multiple plans", async () => {
    stripe._seedProducts([{ id: "prod_basic", name: "Basic", active: true }]);
    stripe._seedPrices([
      {
        id: "price_basic",
        product: "prod_basic",
        unit_amount: 500,
        currency: "usd",
        active: true,
        recurring: { interval: "month" },
      },
    ]);

    const { data: products } = await stripe.products.list({ active: true });
    const { data: prices } = await stripe.prices.list({ active: true });
    const productsByName = buildProductsByNameMap(products);
    const pricesByKey = buildPricesByKeyMap(prices);

    const plans = [
      {
        name: "Basic",
        price: [{ amount: 500, currency: "usd", interval: "month" }],
      },
      {
        name: "Pro",
        price: [{ amount: 1500, currency: "usd", interval: "month" }],
      },
      {
        name: "Enterprise",
        price: [{ amount: 5000, currency: "usd", interval: "month" }],
      },
    ];

    const results = [];
    for (const plan of plans) {
      const result = await syncPlan(plan, productsByName, pricesByKey, stripe);
      results.push(result);
    }

    // Basic: matched product and price
    expect(results[0].productMatched).toBe(true);
    expect(results[0].pricesMatched).toBe(1);

    // Pro: new product and price
    expect(results[1].productCreated).toBe(true);
    expect(results[1].pricesCreated).toBe(1);

    // Enterprise: new product and price
    expect(results[2].productCreated).toBe(true);
    expect(results[2].pricesCreated).toBe(1);

    // Total in Stripe: 3 products, 3 prices
    const { data: allProducts } = await stripe.products.list();
    const { data: allPrices } = await stripe.prices.list();
    expect(allProducts.length).toBe(3);
    expect(allPrices.length).toBe(3);
  });

  test("handles one_time prices correctly", async () => {
    const plan = {
      name: "Lifetime Access",
      price: [{ amount: 29900, currency: "usd", interval: "one_time" }],
    };

    const result = await syncPlan(plan, {}, {}, stripe);

    expect(result.productCreated).toBe(true);
    expect(result.pricesCreated).toBe(1);

    const { data: prices } = await stripe.prices.list();
    expect(prices[0].recurring).toBeNull();
  });

  test("handles mixed recurring and one_time prices", async () => {
    const plan = {
      name: "Flexible Plan",
      price: [
        { amount: 1000, currency: "usd", interval: "month" },
        { amount: 10000, currency: "usd", interval: "year" },
        { amount: 50000, currency: "usd", interval: "one_time" },
      ],
    };

    const result = await syncPlan(plan, {}, {}, stripe);

    expect(result.pricesCreated).toBe(3);

    const { data: prices } = await stripe.prices.list();
    const recurring = prices.filter((p) => p.recurring !== null);
    const oneTime = prices.filter((p) => p.recurring === null);

    expect(recurring.length).toBe(2);
    expect(oneTime.length).toBe(1);
  });

  test("case-insensitive product matching", async () => {
    stripe._seedProducts([
      { id: "prod_premium", name: "PREMIUM PLAN", active: true },
    ]);

    const { data: products } = await stripe.products.list({ active: true });
    const productsByName = buildProductsByNameMap(products);

    const plan = {
      name: "premium plan", // lowercase
      price: [],
    };

    const result = await syncPlan(plan, productsByName, {}, stripe);

    expect(result.productMatched).toBe(true);
    expect(result.plan.id).toBe("prod_premium");
  });
});
