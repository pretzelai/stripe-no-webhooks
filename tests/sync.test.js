import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { sync } from "../bin/commands/sync.js";
import StripeMock from "./stripe-mock.js";
import fs from "fs";
import path from "path";
import os from "os";
import {
  STRIPE_VALID_LIVE_KEY,
  STRIPE_VALID_TEST_KEY,
  STRIPE_RESTRICTED_LIVE_KEY,
  STRIPE_RESTRICTED_TEST_KEY,
} from "./test-utils.js";

const BILLING_CONFIG_TEMPLATE = `
import { defineConfig } from "stripe-no-webhooks";

export default defineConfig({
  test: {
    plans: [],
  },
  production: {
    plans: [],
  },
});
`;

function createBillingConfig(testPlans = [], productionPlans = []) {
  return `
import { defineConfig } from "stripe-no-webhooks";

export default defineConfig({
  test: {
    plans: ${JSON.stringify(testPlans, null, 4).replace(/"(\w+)":/g, "$1:")},
  },
  production: {
    plans: ${JSON.stringify(productionPlans, null, 4).replace(
      /"(\w+)":/g,
      "$1:"
    )},
  },
});
`;
}

describe("sync command e2e", () => {
  let tempDir;
  let logs;
  let errors;
  let stripe;

  const mockLogger = {
    log: (...args) => logs.push(args.join(" ")),
    error: (...args) => errors.push(args.join(" ")),
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-test-"));
    logs = [];
    errors = [];
    stripe = new StripeMock(STRIPE_VALID_TEST_KEY);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns error when billing.config.ts not found", async () => {
    const result = await sync({
      cwd: tempDir,
      env: { STRIPE_SECRET_KEY: STRIPE_VALID_TEST_KEY },
      logger: mockLogger,
      exitOnError: false,
      StripeClass: StripeMock,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("billing.config.ts not found");
  });

  test("returns error when STRIPE_SECRET_KEY is invalid", async () => {
    fs.writeFileSync(
      path.join(tempDir, "billing.config.ts"),
      BILLING_CONFIG_TEMPLATE
    );

    const result = await sync({
      cwd: tempDir,
      env: { STRIPE_SECRET_KEY: "invalid_key" },
      logger: mockLogger,
      exitOnError: false,
      StripeClass: StripeMock,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Invalid Stripe Secret Key");
  });

  test("pulls new products from Stripe into empty config", async () => {
    fs.writeFileSync(
      path.join(tempDir, "billing.config.ts"),
      BILLING_CONFIG_TEMPLATE
    );

    // Seed Stripe with products
    stripe._seedProducts([
      {
        id: "id_prod_pro",
        name: "Pro Plan",
        description: "Professional tier",
        active: true,
      },
      { id: "id_prod_enterprise", name: "Enterprise Plan", active: true },
    ]);
    stripe._seedPrices([
      {
        id: "id_price_pro_monthly",
        product: "id_prod_pro",
        unit_amount: 2900,
        currency: "usd",
        active: true,
        recurring: { interval: "month" },
      },
      {
        id: "id_price_pro_yearly",
        product: "id_prod_pro",
        unit_amount: 29000,
        currency: "usd",
        active: true,
        recurring: { interval: "year" },
      },
      {
        id: "id_price_enterprise",
        product: "id_prod_enterprise",
        unit_amount: 9900,
        currency: "usd",
        active: true,
        recurring: { interval: "month" },
      },
    ]);

    const result = await sync({
      cwd: tempDir,
      env: { STRIPE_SECRET_KEY: STRIPE_VALID_TEST_KEY },
      logger: mockLogger,
      exitOnError: false,
      StripeClass: function () {
        return stripe;
      },
    });

    expect(result.success).toBe(true);
    expect(result.stats.productsPulled).toBe(2);
    expect(result.stats.pricesPulled).toBe(3);

    // Verify billing.config.ts was updated
    const updatedConfig = fs.readFileSync(
      path.join(tempDir, "billing.config.ts"),
      "utf8"
    );
    expect(updatedConfig).toContain("prod_pro");
    expect(updatedConfig).toContain("prod_enterprise");
    expect(updatedConfig).toContain("Pro Plan");
    expect(updatedConfig).toContain("Enterprise Plan");
  });

  test("pushes new products from config to Stripe", async () => {
    const config = createBillingConfig([
      {
        name: "Starter Plan",
        description: "For small teams",
        price: [{ amount: 900, currency: "usd", interval: "month" }],
      },
      {
        name: "Growth Plan",
        price: [
          { amount: 2900, currency: "usd", interval: "month" },
          { amount: 29000, currency: "usd", interval: "year" },
        ],
      },
    ]);
    fs.writeFileSync(path.join(tempDir, "billing.config.ts"), config);

    const result = await sync({
      cwd: tempDir,
      env: { STRIPE_SECRET_KEY: STRIPE_VALID_TEST_KEY },
      logger: mockLogger,
      exitOnError: false,
      StripeClass: function () {
        return stripe;
      },
    });

    expect(result.success).toBe(true);
    expect(result.stats.productsCreated).toBe(2);
    expect(result.stats.pricesCreated).toBe(3);

    // Verify products were created in Stripe
    const { data: products } = await stripe.products.list();
    expect(products.length).toBe(2);
    expect(products.map((p) => p.name).sort()).toEqual([
      "Growth Plan",
      "Starter Plan",
    ]);

    // Verify prices were created in Stripe
    const { data: prices } = await stripe.prices.list();
    expect(prices.length).toBe(3);

    // Verify billing.config.ts was updated with IDs
    const updatedConfig = fs.readFileSync(
      path.join(tempDir, "billing.config.ts"),
      "utf8"
    );
    expect(updatedConfig).toContain("prod_mock_");
    expect(updatedConfig).toContain("price_mock_");
  });

  test("matches existing products by name instead of creating duplicates", async () => {
    const config = createBillingConfig([
      {
        name: "Pro Plan",
        price: [{ amount: 2900, currency: "usd", interval: "month" }],
      },
    ]);
    fs.writeFileSync(path.join(tempDir, "billing.config.ts"), config);

    // Seed Stripe with existing product with same name
    stripe._seedProducts([
      { id: "id_prod_existing_pro", name: "Pro Plan", active: true },
    ]);
    stripe._seedPrices([
      {
        id: "id_price_existing",
        product: "id_prod_existing_pro",
        unit_amount: 2900,
        currency: "usd",
        active: true,
        recurring: { interval: "month" },
      },
    ]);

    const result = await sync({
      cwd: tempDir,
      env: { STRIPE_SECRET_KEY: STRIPE_VALID_TEST_KEY },
      logger: mockLogger,
      exitOnError: false,
      StripeClass: function () {
        return stripe;
      },
    });

    expect(result.success).toBe(true);
    expect(result.stats.productsSynced).toBe(1);
    expect(result.stats.productsCreated).toBe(0);
    expect(result.stats.pricesSynced).toBe(1);
    expect(result.stats.pricesCreated).toBe(0);

    // Verify no new products were created
    const { data: products } = await stripe.products.list();
    expect(products.length).toBe(1);

    // Verify config was updated with existing IDs
    const updatedConfig = fs.readFileSync(
      path.join(tempDir, "billing.config.ts"),
      "utf8"
    );
    expect(updatedConfig).toContain("prod_existing_pro");
    expect(updatedConfig).toContain("price_existing");
  });

  test("matches existing prices by attributes", async () => {
    const config = createBillingConfig([
      {
        id: "id_prod_123",
        name: "Pro Plan",
        price: [
          { amount: 2900, currency: "usd", interval: "month" },
          { amount: 29000, currency: "usd", interval: "year" },
        ],
      },
    ]);
    fs.writeFileSync(path.join(tempDir, "billing.config.ts"), config);

    // Seed Stripe with product and one matching price
    stripe._seedProducts([
      { id: "id_prod_123", name: "Pro Plan", active: true },
    ]);
    stripe._seedPrices([
      {
        id: "id_price_monthly_existing",
        product: "id_prod_123",
        unit_amount: 2900,
        currency: "usd",
        active: true,
        recurring: { interval: "month" },
      },
    ]);

    const result = await sync({
      cwd: tempDir,
      env: { STRIPE_SECRET_KEY: STRIPE_VALID_TEST_KEY },
      logger: mockLogger,
      exitOnError: false,
      StripeClass: function () {
        return stripe;
      },
    });

    expect(result.success).toBe(true);
    expect(result.stats.pricesSynced).toBe(1);
    expect(result.stats.pricesCreated).toBe(1);

    // Verify only one new price was created
    const { data: prices } = await stripe.prices.list();
    expect(prices.length).toBe(2);

    // Verify config was updated
    const updatedConfig = fs.readFileSync(
      path.join(tempDir, "billing.config.ts"),
      "utf8"
    );
    expect(updatedConfig).toContain("price_monthly_existing");
    expect(updatedConfig).toContain("price_mock_");
  });

  test("skips products and prices that already have IDs", async () => {
    const config = createBillingConfig([
      {
        id: "id_prod_already_synced",
        name: "Already Synced Plan",
        price: [
          {
            id: "id_price_already_synced",
            amount: 1000,
            currency: "usd",
            interval: "month",
          },
        ],
      },
    ]);
    fs.writeFileSync(path.join(tempDir, "billing.config.ts"), config);

    stripe._seedProducts([
      {
        id: "id_prod_already_synced",
        name: "Already Synced Plan",
        active: true,
      },
    ]);
    stripe._seedPrices([
      {
        id: "id_price_already_synced",
        product: "id_prod_already_synced",
        unit_amount: 1000,
        currency: "usd",
        active: true,
        recurring: { interval: "month" },
      },
    ]);

    const result = await sync({
      cwd: tempDir,
      env: { STRIPE_SECRET_KEY: STRIPE_VALID_TEST_KEY },
      logger: mockLogger,
      exitOnError: false,
      StripeClass: function () {
        return stripe;
      },
    });

    expect(result.success).toBe(true);
    expect(result.stats.productsCreated).toBe(0);
    expect(result.stats.productsSynced).toBe(0);
    expect(result.stats.pricesCreated).toBe(0);
    expect(result.stats.pricesSynced).toBe(0);
  });

  test("pulls missing prices for existing products in config", async () => {
    const config = createBillingConfig([
      {
        id: "id_prod_existing",
        name: "Existing Plan",
        price: [
          {
            id: "id_price_monthly",
            amount: 1000,
            currency: "usd",
            interval: "month",
          },
        ],
      },
    ]);
    fs.writeFileSync(path.join(tempDir, "billing.config.ts"), config);

    // Stripe has an additional yearly price not in config
    stripe._seedProducts([
      { id: "id_prod_existing", name: "Existing Plan", active: true },
    ]);
    stripe._seedPrices([
      {
        id: "id_price_monthly",
        product: "id_prod_existing",
        unit_amount: 1000,
        currency: "usd",
        active: true,
        recurring: { interval: "month" },
      },
      {
        id: "id_price_yearly_new",
        product: "id_prod_existing",
        unit_amount: 10000,
        currency: "usd",
        active: true,
        recurring: { interval: "year" },
      },
    ]);

    const result = await sync({
      cwd: tempDir,
      env: { STRIPE_SECRET_KEY: STRIPE_VALID_TEST_KEY },
      logger: mockLogger,
      exitOnError: false,
      StripeClass: function () {
        return stripe;
      },
    });

    expect(result.success).toBe(true);
    expect(result.stats.pricesPulled).toBe(1);

    // Verify config was updated with the new price
    const updatedConfig = fs.readFileSync(
      path.join(tempDir, "billing.config.ts"),
      "utf8"
    );
    expect(updatedConfig).toContain("price_yearly_new");
    expect(updatedConfig).toContain("10000");
  });

  test("handles one_time prices correctly", async () => {
    const config = createBillingConfig([
      {
        name: "Lifetime Access",
        price: [{ amount: 29900, currency: "usd", interval: "one_time" }],
      },
    ]);
    fs.writeFileSync(path.join(tempDir, "billing.config.ts"), config);

    const result = await sync({
      cwd: tempDir,
      env: { STRIPE_SECRET_KEY: STRIPE_VALID_TEST_KEY },
      logger: mockLogger,
      exitOnError: false,
      StripeClass: function () {
        return stripe;
      },
    });

    expect(result.success).toBe(true);
    expect(result.stats.productsCreated).toBe(1);
    expect(result.stats.pricesCreated).toBe(1);

    // Verify the price was created without recurring
    const { data: prices } = await stripe.prices.list();
    expect(prices[0].recurring).toBeNull();
  });

  test("handles case-insensitive product name matching", async () => {
    const config = createBillingConfig([
      {
        name: "premium plan",
        price: [{ amount: 5000, currency: "usd", interval: "month" }],
      },
    ]);
    fs.writeFileSync(path.join(tempDir, "billing.config.ts"), config);

    stripe._seedProducts([
      { id: "id_prod_premium", name: "PREMIUM PLAN", active: true },
    ]);
    stripe._seedPrices([
      {
        id: "id_price_premium",
        product: "id_prod_premium",
        unit_amount: 5000,
        currency: "usd",
        active: true,
        recurring: { interval: "month" },
      },
    ]);

    const result = await sync({
      cwd: tempDir,
      env: { STRIPE_SECRET_KEY: STRIPE_VALID_TEST_KEY },
      logger: mockLogger,
      exitOnError: false,
      StripeClass: function () {
        return stripe;
      },
    });

    expect(result.success).toBe(true);
    expect(result.stats.productsSynced).toBe(1);
    expect(result.stats.productsCreated).toBe(0);

    const updatedConfig = fs.readFileSync(
      path.join(tempDir, "billing.config.ts"),
      "utf8"
    );
    expect(updatedConfig).toContain("prod_premium");
  });

  test("handles production mode with sk_live_ key", async () => {
    const config = createBillingConfig(
      [],
      [
        {
          name: "Production Plan",
          price: [{ amount: 9900, currency: "usd", interval: "month" }],
        },
      ]
    );
    fs.writeFileSync(path.join(tempDir, "billing.config.ts"), config);

    const result = await sync({
      cwd: tempDir,
      env: { STRIPE_SECRET_KEY: STRIPE_VALID_LIVE_KEY },
      logger: mockLogger,
      exitOnError: false,
      StripeClass: function () {
        return stripe;
      },
    });

    expect(result.success).toBe(true);
    expect(result.stats.productsCreated).toBe(1);
    expect(logs.some((log) => log.includes("production mode"))).toBe(true);
  });

  test("handles test mode with rk_test_ restricted key", async () => {
    const config = createBillingConfig([
      {
        name: "Test Plan",
        price: [{ amount: 1900, currency: "usd", interval: "month" }],
      },
    ]);
    fs.writeFileSync(path.join(tempDir, "billing.config.ts"), config);

    const result = await sync({
      cwd: tempDir,
      env: { STRIPE_SECRET_KEY: STRIPE_RESTRICTED_TEST_KEY },
      logger: mockLogger,
      exitOnError: false,
      StripeClass: function () {
        return stripe;
      },
    });

    expect(result.success).toBe(true);
    expect(result.stats.productsCreated).toBe(1);
    expect(logs.some((log) => log.includes("test mode"))).toBe(true);
  });

  test("handles production mode with rk_live_ restricted key", async () => {
    const config = createBillingConfig(
      [],
      [
        {
          name: "Production Restricted Plan",
          price: [{ amount: 4900, currency: "usd", interval: "month" }],
        },
      ]
    );
    fs.writeFileSync(path.join(tempDir, "billing.config.ts"), config);

    const result = await sync({
      cwd: tempDir,
      env: { STRIPE_SECRET_KEY: STRIPE_RESTRICTED_LIVE_KEY },
      logger: mockLogger,
      exitOnError: false,
      StripeClass: function () {
        return stripe;
      },
    });

    expect(result.success).toBe(true);
    expect(result.stats.productsCreated).toBe(1);
    expect(logs.some((log) => log.includes("production mode"))).toBe(true);
  });

  test("handles empty config and empty Stripe gracefully", async () => {
    fs.writeFileSync(
      path.join(tempDir, "billing.config.ts"),
      BILLING_CONFIG_TEMPLATE
    );

    const result = await sync({
      cwd: tempDir,
      env: { STRIPE_SECRET_KEY: STRIPE_VALID_TEST_KEY },
      logger: mockLogger,
      exitOnError: false,
      StripeClass: function () {
        return stripe;
      },
    });

    expect(result.success).toBe(true);
    expect(result.stats.productsPulled).toBe(0);
    expect(result.stats.pricesPulled).toBe(0);
    expect(result.stats.productsCreated).toBe(0);
    expect(result.stats.pricesCreated).toBe(0);
  });

  test("handles multiple currencies", async () => {
    const config = createBillingConfig([
      {
        name: "Global Plan",
        price: [
          { amount: 1000, currency: "usd", interval: "month" },
          { amount: 900, currency: "eur", interval: "month" },
          { amount: 800, currency: "gbp", interval: "month" },
        ],
      },
    ]);
    fs.writeFileSync(path.join(tempDir, "billing.config.ts"), config);

    const result = await sync({
      cwd: tempDir,
      env: { STRIPE_SECRET_KEY: STRIPE_VALID_TEST_KEY },
      logger: mockLogger,
      exitOnError: false,
      StripeClass: function () {
        return stripe;
      },
    });

    expect(result.success).toBe(true);
    expect(result.stats.pricesCreated).toBe(3);

    const { data: prices } = await stripe.prices.list();
    const currencies = prices.map((p) => p.currency).sort();
    expect(currencies).toEqual(["eur", "gbp", "usd"]);
  });

  test("bidirectional sync: pulls from Stripe and pushes to Stripe", async () => {
    // Config has one plan
    const config = createBillingConfig([
      {
        name: "Local Plan",
        price: [{ amount: 1500, currency: "usd", interval: "month" }],
      },
    ]);
    fs.writeFileSync(path.join(tempDir, "billing.config.ts"), config);

    // Stripe has a different plan
    stripe._seedProducts([
      { id: "id_prod_remote", name: "Remote Plan", active: true },
    ]);
    stripe._seedPrices([
      {
        id: "id_price_remote",
        product: "id_prod_remote",
        unit_amount: 2500,
        currency: "usd",
        active: true,
        recurring: { interval: "month" },
      },
    ]);

    const result = await sync({
      cwd: tempDir,
      env: { STRIPE_SECRET_KEY: STRIPE_VALID_TEST_KEY },
      logger: mockLogger,
      exitOnError: false,
      StripeClass: function () {
        return stripe;
      },
    });

    expect(result.success).toBe(true);
    // Pulled from Stripe
    expect(result.stats.productsPulled).toBe(1);
    expect(result.stats.pricesPulled).toBe(1);
    // Pushed to Stripe
    expect(result.stats.productsCreated).toBe(1);
    expect(result.stats.pricesCreated).toBe(1);

    // Config should now have both plans
    const updatedConfig = fs.readFileSync(
      path.join(tempDir, "billing.config.ts"),
      "utf8"
    );
    expect(updatedConfig).toContain("Local Plan");
    expect(updatedConfig).toContain("Remote Plan");
    expect(updatedConfig).toContain("prod_remote");

    // Stripe should have both products
    const { data: products } = await stripe.products.list();
    expect(products.length).toBe(2);
  });

  test("preserves product description when pulling from Stripe", async () => {
    fs.writeFileSync(
      path.join(tempDir, "billing.config.ts"),
      BILLING_CONFIG_TEMPLATE
    );

    stripe._seedProducts([
      {
        id: "id_prod_desc",
        name: "Described Plan",
        description: "This is a detailed description",
        active: true,
      },
    ]);
    stripe._seedPrices([
      {
        id: "id_price_desc",
        product: "id_prod_desc",
        unit_amount: 1000,
        currency: "usd",
        active: true,
        recurring: { interval: "month" },
      },
    ]);

    const result = await sync({
      cwd: tempDir,
      env: { STRIPE_SECRET_KEY: STRIPE_VALID_TEST_KEY },
      logger: mockLogger,
      exitOnError: false,
      StripeClass: function () {
        return stripe;
      },
    });

    expect(result.success).toBe(true);

    const updatedConfig = fs.readFileSync(
      path.join(tempDir, "billing.config.ts"),
      "utf8"
    );
    expect(updatedConfig).toContain("This is a detailed description");
  });

  test("handles mixed synced and unsynced plans", async () => {
    const config = createBillingConfig([
      {
        id: "id_prod_synced",
        name: "Already Synced",
        price: [
          {
            id: "id_price_synced",
            amount: 1000,
            currency: "usd",
            interval: "month",
          },
        ],
      },
      {
        name: "Not Yet Synced",
        price: [{ amount: 2000, currency: "usd", interval: "month" }],
      },
    ]);
    fs.writeFileSync(path.join(tempDir, "billing.config.ts"), config);

    stripe._seedProducts([
      { id: "id_prod_synced", name: "Already Synced", active: true },
    ]);
    stripe._seedPrices([
      {
        id: "id_price_synced",
        product: "id_prod_synced",
        unit_amount: 1000,
        currency: "usd",
        active: true,
        recurring: { interval: "month" },
      },
    ]);

    const result = await sync({
      cwd: tempDir,
      env: { STRIPE_SECRET_KEY: STRIPE_VALID_TEST_KEY },
      logger: mockLogger,
      exitOnError: false,
      StripeClass: function () {
        return stripe;
      },
    });

    expect(result.success).toBe(true);
    expect(result.stats.productsCreated).toBe(1);
    expect(result.stats.pricesCreated).toBe(1);

    const { data: products } = await stripe.products.list();
    expect(products.length).toBe(2);
  });
});

describe("sync command - usage/meter sync", () => {
  let tempDir;
  let logs;
  let errors;
  let stripe;

  const mockLogger = {
    log: (...args) => logs.push(args.join(" ")),
    error: (...args) => errors.push(args.join(" ")),
  };

  function createBillingConfigWithFeatures(testPlans = []) {
    return `
import { defineConfig } from "stripe-no-webhooks";

export default defineConfig({
  test: {
    plans: ${JSON.stringify(testPlans, null, 4).replace(/"(\w+)":/g, "$1:")},
  },
  production: {
    plans: [],
  },
});
`;
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-meter-test-"));
    logs = [];
    errors = [];
    stripe = new StripeMock(STRIPE_VALID_TEST_KEY);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("creates meter for feature with trackUsage enabled", async () => {
    const config = createBillingConfigWithFeatures([
      {
        name: "Pro Plan",
        price: [{ amount: 2000, currency: "usd", interval: "month" }],
        features: {
          api_calls: {
            displayName: "API Calls",
            pricePerCredit: 10,
            trackUsage: true,
          },
        },
      },
    ]);
    fs.writeFileSync(path.join(tempDir, "billing.config.ts"), config);

    const result = await sync({
      cwd: tempDir,
      env: { STRIPE_SECRET_KEY: STRIPE_VALID_TEST_KEY },
      logger: mockLogger,
      exitOnError: false,
      StripeClass: function () {
        return stripe;
      },
    });

    expect(result.success).toBe(true);
    expect(result.stats.metersCreated).toBe(1);

    // Verify meter was created in Stripe mock
    const { data: meters } = await stripe.billing.meters.list();
    expect(meters.length).toBe(1);
    expect(meters[0].event_name).toBe("api_calls");
  });

  test("creates separate product for usage feature (for clear invoice line items)", async () => {
    const config = createBillingConfigWithFeatures([
      {
        name: "Pro Plan",
        price: [{ amount: 2000, currency: "usd", interval: "month" }],
        features: {
          api_calls: {
            displayName: "API Calls",
            pricePerCredit: 10,
            trackUsage: true,
          },
        },
      },
    ]);
    fs.writeFileSync(path.join(tempDir, "billing.config.ts"), config);

    const result = await sync({
      cwd: tempDir,
      env: { STRIPE_SECRET_KEY: STRIPE_VALID_TEST_KEY },
      logger: mockLogger,
      exitOnError: false,
      StripeClass: function () {
        return stripe;
      },
    });

    expect(result.success).toBe(true);

    // Verify usage product was created separate from plan product
    const { data: products } = await stripe.products.list();
    expect(products.length).toBe(2); // Pro Plan + API Calls

    const productNames = products.map((p) => p.name);
    expect(productNames).toContain("Pro Plan");
    expect(productNames).toContain("API Calls");
  });

  test("creates metered price under usage product, not plan product", async () => {
    const config = createBillingConfigWithFeatures([
      {
        name: "Pro Plan",
        price: [{ amount: 2000, currency: "usd", interval: "month" }],
        features: {
          api_calls: {
            displayName: "API Calls",
            pricePerCredit: 10,
            trackUsage: true,
          },
        },
      },
    ]);
    fs.writeFileSync(path.join(tempDir, "billing.config.ts"), config);

    const result = await sync({
      cwd: tempDir,
      env: { STRIPE_SECRET_KEY: STRIPE_VALID_TEST_KEY },
      logger: mockLogger,
      exitOnError: false,
      StripeClass: function () {
        return stripe;
      },
    });

    expect(result.success).toBe(true);
    expect(result.stats.meteredPricesCreated).toBe(1);

    // Find the usage product (API Calls)
    const { data: products } = await stripe.products.list();
    const usageProduct = products.find((p) => p.name === "API Calls");
    expect(usageProduct).toBeDefined();

    // Verify metered price is under usage product, not plan product
    const { data: prices } = await stripe.prices.list({ product: usageProduct.id });
    expect(prices.length).toBe(1);
    expect(prices[0].unit_amount).toBe(10);
    expect(prices[0].recurring?.meter).toBeDefined();
  });

  test("populates meteredPriceId in config after sync", async () => {
    const config = createBillingConfigWithFeatures([
      {
        name: "Pro Plan",
        price: [{ amount: 2000, currency: "usd", interval: "month" }],
        features: {
          api_calls: {
            displayName: "API Calls",
            pricePerCredit: 10,
            trackUsage: true,
          },
        },
      },
    ]);
    fs.writeFileSync(path.join(tempDir, "billing.config.ts"), config);

    await sync({
      cwd: tempDir,
      env: { STRIPE_SECRET_KEY: STRIPE_VALID_TEST_KEY },
      logger: mockLogger,
      exitOnError: false,
      StripeClass: function () {
        return stripe;
      },
    });

    // Verify config was updated with meteredPriceId
    const updatedConfig = fs.readFileSync(
      path.join(tempDir, "billing.config.ts"),
      "utf8"
    );
    expect(updatedConfig).toContain("meteredPriceId");
    expect(updatedConfig).toContain("price_mock_");
  });

  test("skips meter creation if feature does not have trackUsage", async () => {
    const config = createBillingConfigWithFeatures([
      {
        name: "Basic Plan",
        price: [{ amount: 1000, currency: "usd", interval: "month" }],
        features: {
          api_calls: {
            displayName: "API Calls",
            credits: {
              allocation: 100,
            },
            // No trackUsage - just credits
          },
        },
      },
    ]);
    fs.writeFileSync(path.join(tempDir, "billing.config.ts"), config);

    const result = await sync({
      cwd: tempDir,
      env: { STRIPE_SECRET_KEY: STRIPE_VALID_TEST_KEY },
      logger: mockLogger,
      exitOnError: false,
      StripeClass: function () {
        return stripe;
      },
    });

    expect(result.success).toBe(true);
    expect(result.stats.metersCreated).toBeUndefined();

    // Verify no meters were created
    const { data: meters } = await stripe.billing.meters.list();
    expect(meters.length).toBe(0);
  });

  test("skips meter creation if feature has trackUsage but no pricePerCredit", async () => {
    const config = createBillingConfigWithFeatures([
      {
        name: "Basic Plan",
        price: [{ amount: 1000, currency: "usd", interval: "month" }],
        features: {
          api_calls: {
            displayName: "API Calls",
            trackUsage: true,
            // No pricePerCredit - invalid combination
          },
        },
      },
    ]);
    fs.writeFileSync(path.join(tempDir, "billing.config.ts"), config);

    const result = await sync({
      cwd: tempDir,
      env: { STRIPE_SECRET_KEY: STRIPE_VALID_TEST_KEY },
      logger: mockLogger,
      exitOnError: false,
      StripeClass: function () {
        return stripe;
      },
    });

    expect(result.success).toBe(true);

    // Verify no meters were created (trackUsage without pricePerCredit is invalid)
    const { data: meters } = await stripe.billing.meters.list();
    expect(meters.length).toBe(0);
  });

  test("reuses existing meter if already created", async () => {
    // Seed existing meter
    stripe._seedMeters([
      {
        id: "mtr_existing_api_calls",
        event_name: "api_calls",
        display_name: "api_calls",
        status: "active",
      },
    ]);

    const config = createBillingConfigWithFeatures([
      {
        name: "Pro Plan",
        price: [{ amount: 2000, currency: "usd", interval: "month" }],
        features: {
          api_calls: {
            displayName: "API Calls",
            pricePerCredit: 10,
            trackUsage: true,
          },
        },
      },
    ]);
    fs.writeFileSync(path.join(tempDir, "billing.config.ts"), config);

    const result = await sync({
      cwd: tempDir,
      env: { STRIPE_SECRET_KEY: STRIPE_VALID_TEST_KEY },
      logger: mockLogger,
      exitOnError: false,
      StripeClass: function () {
        return stripe;
      },
    });

    expect(result.success).toBe(true);
    expect(result.stats.metersCreated).toBe(0);
    expect(result.stats.metersSynced).toBe(1);

    // Verify no new meters were created
    const { data: meters } = await stripe.billing.meters.list();
    expect(meters.length).toBe(1);
    expect(meters[0].id).toBe("mtr_existing_api_calls");
  });

  test("creates one meter shared across multiple plans", async () => {
    const config = createBillingConfigWithFeatures([
      {
        name: "Pro Plan",
        price: [{ amount: 2000, currency: "usd", interval: "month" }],
        features: {
          api_calls: {
            displayName: "API Calls",
            pricePerCredit: 10,
            trackUsage: true,
          },
        },
      },
      {
        name: "Enterprise Plan",
        price: [{ amount: 5000, currency: "usd", interval: "month" }],
        features: {
          api_calls: {
            displayName: "API Calls",
            pricePerCredit: 5, // Different price
            trackUsage: true,
          },
        },
      },
    ]);
    fs.writeFileSync(path.join(tempDir, "billing.config.ts"), config);

    const result = await sync({
      cwd: tempDir,
      env: { STRIPE_SECRET_KEY: STRIPE_VALID_TEST_KEY },
      logger: mockLogger,
      exitOnError: false,
      StripeClass: function () {
        return stripe;
      },
    });

    expect(result.success).toBe(true);

    // Only ONE meter for the shared feature key
    expect(result.stats.metersCreated).toBe(1);

    // But TWO metered prices (one per plan)
    expect(result.stats.meteredPricesCreated).toBe(2);

    const { data: meters } = await stripe.billing.meters.list();
    expect(meters.length).toBe(1);
  });

  test("creates multiple meters for different feature keys", async () => {
    const config = createBillingConfigWithFeatures([
      {
        name: "Pro Plan",
        price: [{ amount: 2000, currency: "usd", interval: "month" }],
        features: {
          api_calls: {
            displayName: "API Calls",
            pricePerCredit: 10,
            trackUsage: true,
          },
          storage_gb: {
            displayName: "Storage GB",
            pricePerCredit: 25,
            trackUsage: true,
          },
        },
      },
    ]);
    fs.writeFileSync(path.join(tempDir, "billing.config.ts"), config);

    const result = await sync({
      cwd: tempDir,
      env: { STRIPE_SECRET_KEY: STRIPE_VALID_TEST_KEY },
      logger: mockLogger,
      exitOnError: false,
      StripeClass: function () {
        return stripe;
      },
    });

    expect(result.success).toBe(true);
    expect(result.stats.metersCreated).toBe(2);
    expect(result.stats.meteredPricesCreated).toBe(2);

    const { data: meters } = await stripe.billing.meters.list();
    expect(meters.length).toBe(2);

    const eventNames = meters.map((m) => m.event_name).sort();
    expect(eventNames).toEqual(["api_calls", "storage_gb"]);
  });

  test("properly quotes feature keys with hyphens", async () => {
    const config = createBillingConfigWithFeatures([
      {
        name: "Pro Plan",
        price: [{ amount: 2000, currency: "usd", interval: "month" }],
        features: {
          "ai-chat": {
            displayName: "AI Chat",
            pricePerCredit: 5,
            trackUsage: true,
          },
        },
      },
    ]);
    fs.writeFileSync(path.join(tempDir, "billing.config.ts"), config);

    const result = await sync({
      cwd: tempDir,
      env: { STRIPE_SECRET_KEY: STRIPE_VALID_TEST_KEY },
      logger: mockLogger,
      exitOnError: false,
      StripeClass: function () {
        return stripe;
      },
    });

    expect(result.success).toBe(true);

    // Verify the config was updated with quoted key
    const updatedConfig = fs.readFileSync(
      path.join(tempDir, "billing.config.ts"),
      "utf8"
    );
    // Key should be quoted since it contains a hyphen
    expect(updatedConfig).toContain('"ai-chat"');
    // Should be valid TypeScript (no syntax errors from unquoted hyphenated key)
    expect(updatedConfig).not.toMatch(/[^"']ai-chat[^"']/);
  });
});
