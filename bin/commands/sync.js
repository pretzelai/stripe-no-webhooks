const fs = require("fs");
const path = require("path");
const {
  questionHidden,
  isValidStripeKey,
  getMode,
  loadStripe,
} = require("./helpers/utils");
const {
  buildProductsByNameMap,
  buildPricesByKeyMap,
  findMatchingProduct,
  findMatchingPrice,
  generatePriceKey,
} = require("./helpers/sync-helpers");

// --- TypeScript Config Parsing (for billing.config.ts) ---

function findMatchingBrace(content, startIndex) {
  let depth = 0;
  for (let i = startIndex; i < content.length; i++) {
    if (content[i] === "{" || content[i] === "[") depth++;
    else if (content[i] === "}" || content[i] === "]") {
      if (--depth === 0) return i;
    }
  }
  return -1;
}

function tsObjectToJson(ts) {
  return ts
    .replace(/\/\/.*$/gm, "") // Remove single-line comments
    .replace(/\/\*[\s\S]*?\*\//g, "") // Remove multi-line comments
    .replace(/(\s*)(\w+)(\s*:)/g, '$1"$2"$3') // Quote keys
    .replace(/,(\s*[}\]])/g, "$1"); // Remove trailing commas
}

function extractBillingConfigObject(content) {
  const match = content.match(
    /const\s+billingConfig\s*:\s*BillingConfig\s*=\s*\{/
  );
  if (!match) return null;
  const start = match.index + match[0].length - 1;
  const end = findMatchingBrace(content, start);
  return end === -1
    ? null
    : { raw: content.substring(start, end + 1), start, end: end + 1 };
}

function parseBillingConfig(content, mode, logger = console) {
  const extracted = extractBillingConfigObject(content);
  if (!extracted) return { config: null, plans: [] };

  let config;
  try {
    config = JSON.parse(tsObjectToJson(extracted.raw));
  } catch (e) {
    logger.error("Failed to parse billing config as JSON:", e.message);
    return { config: null, plans: [] };
  }

  const modeConfig = config[mode];
  const plans = modeConfig?.plans?.length
    ? modeConfig.plans.map((plan, index) => ({ plan, index }))
    : [];
  return { config, plans, extracted };
}

// --- TypeScript Config Formatting ---

function toTsObjectLiteral(value, indent = 0) {
  const spaces = "  ".repeat(indent);
  const childSpaces = "  ".repeat(indent + 1);

  if (value == null) return String(value);
  if (typeof value === "string") return `"${value}"`;
  if (typeof value !== "object") return String(value);

  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return `[\n${childSpaces}${value
      .map((v) => toTsObjectLiteral(v, indent + 1))
      .join(`,\n${childSpaces}`)},\n${spaces}]`;
  }

  const entries = Object.entries(value);
  if (!entries.length) return "{}";
  const props = entries.map(
    ([k, v]) => `${k}: ${toTsObjectLiteral(v, indent + 1)}`
  );
  return `{\n${childSpaces}${props.join(`,\n${childSpaces}`)},\n${spaces}}`;
}

function reorderWithIdFirst(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const { id, ...rest } = obj;
  return id !== undefined ? { id, ...rest } : obj;
}

function formatConfigToTs(config) {
  const reordered = {};
  for (const mode of ["test", "production"]) {
    if (!config[mode]) continue;
    reordered[mode] = {
      plans: (config[mode].plans || []).map((plan) => {
        const p = reorderWithIdFirst(plan);
        if (p.price) p.price = p.price.map(reorderWithIdFirst);
        return p;
      }),
    };
  }
  return toTsObjectLiteral(reordered, 0);
}

// --- Main Sync Command ---

async function sync(options = {}) {
  const {
    env = process.env,
    cwd = process.cwd(),
    logger = console,
    exitOnError = true,
    StripeClass = null,
  } = options;
  const billingConfigPath = path.join(cwd, "billing.config.ts");

  if (!fs.existsSync(billingConfigPath)) {
    logger.error("❌ billing.config.ts not found in project root.");
    logger.log("Run 'npx stripe-no-webhooks config' first to create it.");
    if (exitOnError) process.exit(1);
    return { success: false, error: "billing.config.ts not found" };
  }

  let Stripe = StripeClass || loadStripe();
  if (!Stripe) {
    logger.error("❌ Stripe package not found.");
    logger.log("Please install it first: npm install stripe");
    if (exitOnError) process.exit(1);
    return { success: false, error: "Stripe package not found" };
  }

  let stripeSecretKey = env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    stripeSecretKey = await questionHidden(
      null,
      "Enter your Stripe Secret Key (sk_...)"
    );
  }

  if (!isValidStripeKey(stripeSecretKey)) {
    logger.error(
      "❌ Invalid Stripe Secret Key. It should start with 'sk_' or 'rk_'"
    );
    if (exitOnError) process.exit(1);
    return { success: false, error: "Invalid Stripe Secret Key" };
  }

  let mode;
  try {
    mode = getMode(stripeSecretKey);
  } catch (e) {
    logger.error("❌", e.message);
    if (exitOnError) process.exit(1);
    return { success: false, error: e.message };
  }

  const stripe = new Stripe(stripeSecretKey);
  logger.log(`\n🔄 Syncing billing plans with Stripe (${mode} mode)...\n`);

  let content = fs.readFileSync(billingConfigPath, "utf8");
  const { config, extracted } = parseBillingConfig(content, mode, logger);

  if (!config) {
    logger.error("❌ Failed to parse billing.config.ts");
    if (exitOnError) process.exit(1);
    return { success: false, error: "Failed to parse billing.config.ts" };
  }

  config[mode] = config[mode] || { plans: [] };
  config[mode].plans = config[mode].plans || [];

  let configModified = false;
  const stats = {
    productsPulled: 0,
    pricesPulled: 0,
    productsSynced: 0,
    pricesSynced: 0,
    productsCreated: 0,
    pricesCreated: 0,
  };

  // --- Pull from Stripe ---
  logger.log("📥 Pulling products from Stripe...\n");

  try {
    const [stripeProducts, stripePrices] = await Promise.all([
      stripe.products.list({ active: true, limit: 100 }),
      stripe.prices.list({ active: true, limit: 100 }),
    ]);

    const pricesByProduct = {};
    for (const price of stripePrices.data) {
      const productId =
        typeof price.product === "string" ? price.product : price.product.id;
      (pricesByProduct[productId] ||= []).push(price);
    }

    const existingProductIds = new Set(
      config[mode].plans.filter((p) => p.id).map((p) => p.id)
    );
    const existingPriceIds = new Set(
      config[mode].plans.flatMap((p) =>
        (p.price || []).filter((pr) => pr.id).map((pr) => pr.id)
      )
    );

    for (const product of stripeProducts.data) {
      const productPrices = pricesByProduct[product.id] || [];

      if (existingProductIds.has(product.id)) {
        const plan = config[mode].plans.find((p) => p.id === product.id);
        for (const stripePrice of productPrices) {
          if (existingPriceIds.has(stripePrice.id)) continue;
          plan.price = plan.price || [];
          plan.price.push({
            id: stripePrice.id,
            amount: stripePrice.unit_amount,
            currency: stripePrice.currency,
            interval: stripePrice.recurring?.interval || "one_time",
          });
          existingPriceIds.add(stripePrice.id);
          stats.pricesPulled++;
          configModified = true;
          logger.log(
            `   📥 Added price ${stripePrice.unit_amount / 100} ${
              stripePrice.currency
            }/${stripePrice.recurring?.interval || "one_time"} to "${
              product.name
            }"`
          );
        }
        continue;
      }

      const newPlan = {
        id: product.id,
        name: product.name,
        ...(product.description && { description: product.description }),
        price: productPrices.map((p) => ({
          id: p.id,
          amount: p.unit_amount,
          currency: p.currency,
          interval: p.recurring?.interval || "one_time",
        })),
      };

      config[mode].plans.push(newPlan);
      stats.productsPulled++;
      stats.pricesPulled += productPrices.length;
      configModified = true;

      logger.log(`📥 Added product "${product.name}" (${product.id})`);
      for (const price of newPlan.price) {
        logger.log(
          `   📥 Added price ${price.amount / 100} ${price.currency}/${
            price.interval
          }`
        );
      }
    }

    if (stats.productsPulled === 0 && stats.pricesPulled === 0) {
      logger.log("   No new products or prices to pull from Stripe.\n");
    } else {
      logger.log("");
    }
  } catch (error) {
    logger.error("❌ Failed to fetch products from Stripe:", error.message);
  }

  // --- Push to Stripe ---
  logger.log("📤 Pushing new plans to Stripe...\n");

  const currentPlans = config[mode].plans || [];
  if (!currentPlans.length) {
    logger.log(`   No plans in billing.config.ts for ${mode} mode.\n`);
  }

  let stripeProductsByName = {},
    stripePricesByKey = {};
  try {
    const [stripeProducts, stripePrices] = await Promise.all([
      stripe.products.list({ active: true, limit: 100 }),
      stripe.prices.list({ active: true, limit: 100 }),
    ]);
    stripeProductsByName = buildProductsByNameMap(stripeProducts.data);
    stripePricesByKey = buildPricesByKeyMap(stripePrices.data);
  } catch (error) {
    logger.error(
      "⚠️  Could not fetch existing Stripe data for matching:",
      error.message
    );
  }

  for (let i = 0; i < currentPlans.length; i++) {
    const plan = currentPlans[i];
    let productId = plan.id;

    if (!productId) {
      const existing = findMatchingProduct(stripeProductsByName, plan.name);
      if (existing) {
        productId = existing.id;
        logger.log(`🔗 Matched existing product "${plan.name}" (${productId})`);
        config[mode].plans[i].id = productId;
        stats.productsSynced++;
        configModified = true;
      } else {
        try {
          logger.log(`🔄 Creating product "${plan.name}" in Stripe...`);
          const product = await stripe.products.create({
            name: plan.name,
            description: plan.description || undefined,
          });
          productId = product.id;
          logger.log(`✅ Created product "${plan.name}" (${productId})`);
          stripeProductsByName[plan.name.toLowerCase().trim()] = product;
          config[mode].plans[i].id = productId;
          stats.productsCreated++;
          configModified = true;
        } catch (error) {
          logger.error(
            `❌ Failed to create product "${plan.name}":`,
            error.message
          );
          continue;
        }
      }
    }

    if (!plan.price?.length) continue;

    for (let j = 0; j < plan.price.length; j++) {
      const price = plan.price[j];
      if (price.id) continue;

      const existing = findMatchingPrice(stripePricesByKey, productId, price);
      const interval = price.interval || "one_time";

      if (existing) {
        logger.log(
          `   🔗 Matched existing price ${price.amount / 100} ${
            price.currency
          }/${interval} (${existing.id})`
        );
        config[mode].plans[i].price[j].id = existing.id;
        stats.pricesSynced++;
        configModified = true;
        continue;
      }

      try {
        logger.log(
          `   🔄 Creating price ${price.amount / 100} ${
            price.currency
          }/${interval}...`
        );
        const priceParams = {
          product: productId,
          unit_amount: price.amount,
          currency: price.currency.toLowerCase(),
        };
        if (interval !== "one_time") priceParams.recurring = { interval };

        const stripePrice = await stripe.prices.create(priceParams);
        logger.log(`   ✅ Created price (${stripePrice.id})`);
        stripePricesByKey[
          generatePriceKey(productId, price.amount, price.currency, interval)
        ] = stripePrice;
        config[mode].plans[i].price[j].id = stripePrice.id;
        stats.pricesCreated++;
        configModified = true;
      } catch (error) {
        logger.error(
          `   ❌ Failed to create price ${interval}/${price.currency}:`,
          error.message
        );
      }
    }
  }

  if (
    stats.productsCreated === 0 &&
    stats.pricesCreated === 0 &&
    stats.productsSynced === 0 &&
    stats.pricesSynced === 0
  ) {
    logger.log("   No new products or prices to push to Stripe.\n");
  }

  if (configModified) {
    const newContent =
      content.substring(0, extracted.start) +
      formatConfigToTs(config) +
      content.substring(extracted.end);
    fs.writeFileSync(billingConfigPath, newContent);
    logger.log(`\n📝 Updated billing.config.ts`);
  }

  logger.log(`\n✅ Done!`);
  logger.log(
    `   Pulled from Stripe: ${stats.productsPulled} product(s), ${stats.pricesPulled} price(s)`
  );
  logger.log(
    `   Matched existing: ${stats.productsSynced} product(s), ${stats.pricesSynced} price(s)`
  );
  logger.log(
    `   Created new: ${stats.productsCreated} product(s), ${stats.pricesCreated} price(s)`
  );

  return { success: true, stats };
}

module.exports = {
  sync,
  // Export for testing
  findMatchingBrace,
  tsObjectToJson,
  extractBillingConfigObject,
  parseBillingConfig,
  reorderWithIdFirst,
  toTsObjectLiteral,
  formatConfigToTs,
};
