const fs = require("fs");
const path = require("path");
const {
  questionHidden,
  isValidStripeKey,
  getMode,
  loadStripe,
} = require("./utils");
const {
  buildProductsByNameMap,
  buildPricesByKeyMap,
  findMatchingProduct,
  findMatchingPrice,
  generatePriceKey,
  syncPlan,
} = require("../sync-helpers");

function findMatchingBrace(content, startIndex) {
  let depth = 0;
  for (let i = startIndex; i < content.length; i++) {
    if (content[i] === "{" || content[i] === "[") depth++;
    else if (content[i] === "}" || content[i] === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function tsObjectToJson(tsContent) {
  let json = tsContent.replace(/\/\/.*$/gm, "");
  json = json.replace(/\/\*[\s\S]*?\*\//g, "");
  json = json.replace(/(\s*)(\w+)(\s*:)/g, '$1"$2"$3');
  json = json.replace(/,(\s*[}\]])/g, "$1");
  return json;
}

function extractBillingConfigObject(content) {
  const configStartMatch = content.match(
    /const\s+billingConfig\s*:\s*BillingConfig\s*=\s*\{/
  );
  if (!configStartMatch) {
    return null;
  }

  const objectStart = configStartMatch.index + configStartMatch[0].length - 1;
  const objectEnd = findMatchingBrace(content, objectStart);
  if (objectEnd === -1) return null;

  const rawObject = content.substring(objectStart, objectEnd + 1);
  return {
    raw: rawObject,
    start: objectStart,
    end: objectEnd + 1,
  };
}

function parseBillingConfig(content, mode, logger = console) {
  const extracted = extractBillingConfigObject(content);
  if (!extracted) {
    return { config: null, plans: [] };
  }

  const jsonString = tsObjectToJson(extracted.raw);
  let config;
  try {
    config = JSON.parse(jsonString);
  } catch (e) {
    logger.error("Failed to parse billing config as JSON:", e.message);
    return { config: null, plans: [] };
  }

  const modeConfig = config[mode];
  if (!modeConfig || !modeConfig.plans || modeConfig.plans.length === 0) {
    return { config, plans: [], extracted };
  }

  const plans = modeConfig.plans.map((plan, index) => ({
    plan,
    index,
  }));

  return { config, plans, extracted };
}

function reorderWithIdFirst(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return obj;
  }

  const { id, ...rest } = obj;
  if (id !== undefined) {
    return { id, ...rest };
  }
  return obj;
}

function toTsObjectLiteral(value, indent = 0) {
  const spaces = "  ".repeat(indent);
  const childSpaces = "  ".repeat(indent + 1);

  if (value === null || value === undefined) {
    return String(value);
  }

  if (typeof value === "string") {
    return `"${value}"`;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }
    const items = value.map((item) => toTsObjectLiteral(item, indent + 1));
    return `[\n${childSpaces}${items.join(`,\n${childSpaces}`)},\n${spaces}]`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return "{}";
    }
    const props = entries.map(
      ([key, val]) => `${key}: ${toTsObjectLiteral(val, indent + 1)}`
    );
    return `{\n${childSpaces}${props.join(`,\n${childSpaces}`)},\n${spaces}}`;
  }

  return String(value);
}

function formatConfigToTs(config) {
  const reorderedConfig = {};

  for (const mode of ["test", "production"]) {
    if (config[mode]) {
      reorderedConfig[mode] = {
        plans: (config[mode].plans || []).map((plan) => {
          const reorderedPlan = reorderWithIdFirst(plan);
          if (reorderedPlan.price) {
            reorderedPlan.price = reorderedPlan.price.map(reorderWithIdFirst);
          }
          return reorderedPlan;
        }),
      };
    }
  }

  return toTsObjectLiteral(reorderedConfig, 0);
}

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

  let Stripe = StripeClass;
  if (!Stripe) {
    Stripe = loadStripe();
    if (!Stripe) {
      logger.error("❌ Stripe package not found.");
      logger.log("Please install it first: npm install stripe");
      if (exitOnError) process.exit(1);
      return { success: false, error: "Stripe package not found" };
    }
  }

  let stripeSecretKey = env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    stripeSecretKey = await questionHidden(
      null,
      "Enter your Stripe Secret Key (sk_...)"
    );
  }

  if (!isValidStripeKey(stripeSecretKey)) {
    logger.error("❌ Invalid Stripe Secret Key. It should start with 'sk_' or 'rk_'");
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
  const { config, plans, extracted } = parseBillingConfig(content, mode, logger);

  if (!config) {
    logger.error("❌ Failed to parse billing.config.ts");
    if (exitOnError) process.exit(1);
    return { success: false, error: "Failed to parse billing.config.ts" };
  }

  if (!config[mode]) {
    config[mode] = { plans: [] };
  }
  if (!config[mode].plans) {
    config[mode].plans = [];
  }

  let configModified = false;
  let productsPulled = 0;
  let pricesPulled = 0;
  let productsCreated = 0;
  let pricesCreated = 0;
  let skippedProducts = 0;
  let skippedPrices = 0;

  logger.log("📥 Pulling products from Stripe...\n");

  try {
    const stripeProducts = await stripe.products.list({
      active: true,
      limit: 100,
    });

    const stripePrices = await stripe.prices.list({ active: true, limit: 100 });

    const pricesByProduct = {};
    for (const price of stripePrices.data) {
      const productId =
        typeof price.product === "string" ? price.product : price.product.id;
      if (!pricesByProduct[productId]) {
        pricesByProduct[productId] = [];
      }
      pricesByProduct[productId].push(price);
    }

    const existingProductIds = new Set(
      config[mode].plans.filter((p) => p.id).map((p) => p.id)
    );

    const existingPriceIds = new Set();
    for (const plan of config[mode].plans) {
      if (plan.price) {
        for (const price of plan.price) {
          if (price.id) {
            existingPriceIds.add(price.id);
          }
        }
      }
    }

    for (const product of stripeProducts.data) {
      if (existingProductIds.has(product.id)) {
        const planIndex = config[mode].plans.findIndex(
          (p) => p.id === product.id
        );
        const plan = config[mode].plans[planIndex];
        const productPrices = pricesByProduct[product.id] || [];

        for (const stripePrice of productPrices) {
          if (!existingPriceIds.has(stripePrice.id)) {
            const newPrice = {
              id: stripePrice.id,
              amount: stripePrice.unit_amount,
              currency: stripePrice.currency,
              interval: stripePrice.recurring?.interval || "one_time",
            };
            if (!plan.price) {
              plan.price = [];
            }
            plan.price.push(newPrice);
            existingPriceIds.add(stripePrice.id);
            pricesPulled++;
            configModified = true;
            logger.log(
              `   📥 Added price ${stripePrice.unit_amount / 100} ${
                stripePrice.currency
              }/${newPrice.interval} to "${product.name}"`
            );
          }
        }
        continue;
      }

      const productPrices = pricesByProduct[product.id] || [];
      const newPlan = {
        id: product.id,
        name: product.name,
        description: product.description || undefined,
        price: productPrices.map((p) => ({
          id: p.id,
          amount: p.unit_amount,
          currency: p.currency,
          interval: p.recurring?.interval || "one_time",
        })),
      };

      if (!newPlan.description) {
        delete newPlan.description;
      }

      config[mode].plans.push(newPlan);
      productsPulled++;
      pricesPulled += productPrices.length;
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

    if (productsPulled === 0 && pricesPulled === 0) {
      logger.log("   No new products or prices to pull from Stripe.\n");
    } else {
      logger.log("");
    }
  } catch (error) {
    logger.error("❌ Failed to fetch products from Stripe:", error.message);
  }

  logger.log("📤 Pushing new plans to Stripe...\n");

  const currentPlans = config[mode].plans || [];

  if (currentPlans.length === 0) {
    logger.log(`   No plans in billing.config.ts for ${mode} mode.\n`);
  }

  let stripeProductsByName = {};
  let stripePricesByKey = {};

  try {
    const stripeProducts = await stripe.products.list({
      active: true,
      limit: 100,
    });
    const stripePrices = await stripe.prices.list({ active: true, limit: 100 });

    stripeProductsByName = buildProductsByNameMap(stripeProducts.data);
    stripePricesByKey = buildPricesByKeyMap(stripePrices.data);
  } catch (error) {
    logger.error(
      "⚠️  Could not fetch existing Stripe data for matching:",
      error.message
    );
  }

  let productsSynced = 0;
  let pricesSynced = 0;

  for (let index = 0; index < currentPlans.length; index++) {
    const plan = currentPlans[index];
    let productId = plan.id;

    if (!productId) {
      const existingProduct = findMatchingProduct(stripeProductsByName, plan.name);

      if (existingProduct) {
        productId = existingProduct.id;
        logger.log(
          `🔗 Matched existing product "${plan.name}" (${productId})`
        );
        config[mode].plans[index].id = productId;
        productsSynced++;
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

          const nameKey = plan.name.toLowerCase().trim();
          stripeProductsByName[nameKey] = product;

          config[mode].plans[index].id = productId;
          productsCreated++;
          configModified = true;
        } catch (error) {
          logger.error(
            `❌ Failed to create product "${plan.name}":`,
            error.message
          );
          continue;
        }
      }
    } else {
      skippedProducts++;
    }

    if (plan.price && plan.price.length > 0) {
      for (let priceIndex = 0; priceIndex < plan.price.length; priceIndex++) {
        const price = plan.price[priceIndex];

        if (price.id) {
          skippedPrices++;
          continue;
        }

        const existingPrice = findMatchingPrice(stripePricesByKey, productId, price);
        const interval = price.interval || "one_time";

        if (existingPrice) {
          logger.log(
            `   🔗 Matched existing price ${price.amount / 100} ${
              price.currency
            }/${interval} (${existingPrice.id})`
          );
          config[mode].plans[index].price[priceIndex].id = existingPrice.id;
          pricesSynced++;
          configModified = true;
          continue;
        }

        try {
          logger.log(
            `   🔄 Creating price ${price.amount / 100} ${price.currency}/${
              price.interval
            }...`
          );

          const priceParams = {
            product: productId,
            unit_amount: price.amount,
            currency: price.currency.toLowerCase(),
          };

          if (price.interval && price.interval !== "one_time") {
            priceParams.recurring = {
              interval: price.interval,
            };
          }

          const stripePrice = await stripe.prices.create(priceParams);

          logger.log(`   ✅ Created price (${stripePrice.id})`);

          const priceKey = generatePriceKey(productId, price.amount, price.currency, price.interval);
          stripePricesByKey[priceKey] = stripePrice;

          config[mode].plans[index].price[priceIndex].id = stripePrice.id;
          pricesCreated++;
          configModified = true;
        } catch (error) {
          logger.error(
            `   ❌ Failed to create price ${price.interval}/${price.currency}:`,
            error.message
          );
        }
      }
    }
  }

  if (productsCreated === 0 && pricesCreated === 0 && productsSynced === 0 && pricesSynced === 0) {
    logger.log("   No new products or prices to push to Stripe.\n");
  }

  if (configModified) {
    const newConfigJson = formatConfigToTs(config);
    const newContent =
      content.substring(0, extracted.start) +
      newConfigJson +
      content.substring(extracted.end);
    fs.writeFileSync(billingConfigPath, newContent);
    logger.log(`\n📝 Updated billing.config.ts`);
  }

  logger.log(`\n✅ Done!`);
  logger.log(
    `   Pulled from Stripe: ${productsPulled} product(s), ${pricesPulled} price(s)`
  );
  logger.log(
    `   Matched existing: ${productsSynced} product(s), ${pricesSynced} price(s)`
  );
  logger.log(
    `   Created new: ${productsCreated} product(s), ${pricesCreated} price(s)`
  );

  return {
    success: true,
    stats: {
      productsPulled,
      pricesPulled,
      productsSynced,
      pricesSynced,
      productsCreated,
      pricesCreated,
    },
  };
}

module.exports = {
  sync,
  // Export helpers for testing
  findMatchingBrace,
  tsObjectToJson,
  extractBillingConfigObject,
  parseBillingConfig,
  reorderWithIdFirst,
  toTsObjectLiteral,
  formatConfigToTs,
};
