const fs = require("fs");
const path = require("path");
const {
  createPrompt,
  question,
  questionHidden,
  isValidStripeKey,
  getMode,
  loadStripe,
  isLocalhost,
  saveWebhookSecret,
  selectOption,
  getDevPort,
} = require("./helpers/utils");
const {
  buildProductsByNameMap,
  buildPricesByKeyMap,
  findMatchingProduct,
  findMatchingPrice,
  generatePriceKey,
} = require("./helpers/sync-helpers");
const {
  modeBox,
  webhookSecretBox,
  localDevNotice,
  success,
  error,
  info,
  divider,
  complete,
  BOLD,
  RESET,
  DIM,
} = require("./helpers/output");

// --- Meter/Usage Sync Helpers ---

/**
 * Normalize feature key to valid Stripe meter event name.
 * Must be alphanumeric with underscores, max 40 chars.
 */
function normalizeEventName(featureKey) {
  return featureKey
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .substring(0, 40);
}

/**
 * Sync meters for features with trackUsage enabled.
 * Creates ONE meter per unique feature key (shared across plans).
 * Creates metered prices per plan (different plans can have different prices).
 */
async function syncMeters(stripe, plans, mode, logger) {
  const stats = { metersCreated: 0, metersSynced: 0, meteredPricesCreated: 0 };
  let configModified = false;

  // Collect all unique feature keys that need meters
  const featureKeysNeedingMeters = new Set();
  const normalizedToOriginal = {}; // Track normalized -> original mappings for collision detection

  for (const plan of plans) {
    if (!plan.features) continue;
    for (const [featureKey, featureConfig] of Object.entries(plan.features)) {
      if (featureConfig.trackUsage && featureConfig.pricePerCredit) {
        const normalized = normalizeEventName(featureKey);

        // Check for collisions (different feature keys normalizing to same event name)
        if (normalizedToOriginal[normalized] && normalizedToOriginal[normalized] !== featureKey) {
          logger.error(
            `   ❌ Feature key collision: "${featureKey}" and "${normalizedToOriginal[normalized]}" ` +
            `both normalize to "${normalized}". Please rename one of them.`
          );
          continue;
        }
        normalizedToOriginal[normalized] = featureKey;
        featureKeysNeedingMeters.add(featureKey);
      }
    }
  }

  if (featureKeysNeedingMeters.size === 0) {
    return { stats, configModified };
  }

  // Fetch existing meters
  let existingMeters = [];
  try {
    const metersList = await stripe.billing.meters.list({ limit: 100 });
    existingMeters = metersList.data;
  } catch (err) {
    if (err.code === "resource_missing" || err.statusCode === 404) {
      logger.log("   ⚠️  Billing meters API not available, skipping meter sync");
      return { stats, configModified };
    }
    throw err;
  }

  const metersByEventName = {};
  for (const meter of existingMeters) {
    metersByEventName[meter.event_name] = meter;
  }

  // Step 1: Ensure meters exist for each unique feature key
  const metersForFeature = {}; // featureKey -> meter
  for (const featureKey of featureKeysNeedingMeters) {
    const eventName = normalizeEventName(featureKey);
    let meter = metersByEventName[eventName];

    if (meter) {
      logger.log(`   🔗 Found existing meter for "${featureKey}" (${meter.id})`);
      stats.metersSynced++;
    } else {
      try {
        logger.log(`   🔄 Creating meter for "${featureKey}"...`);
        meter = await stripe.billing.meters.create({
          display_name: featureKey,
          event_name: eventName,
          default_aggregation: { formula: "sum" },
        });
        metersByEventName[eventName] = meter;
        stats.metersCreated++;
        logger.log(`   ✅ Created meter (${meter.id})`);
      } catch (err) {
        logger.error(`   ❌ Failed to create meter for "${featureKey}": ${err.message}`);
        continue;
      }
    }
    metersForFeature[featureKey] = meter;
  }

  // Step 2: Create or validate metered prices for each plan+feature combination
  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i];
    if (!plan.features || !plan.id) continue;

    for (const [featureKey, featureConfig] of Object.entries(plan.features)) {
      if (!featureConfig.trackUsage || !featureConfig.pricePerCredit) continue;

      const meter = metersForFeature[featureKey];
      if (!meter) continue;

      const displayName = featureConfig.displayName || featureKey;

      // If already has meteredPriceId, validate it still exists and update metadata if needed
      if (featureConfig.meteredPriceId) {
        try {
          const existingPrice = await stripe.prices.retrieve(featureConfig.meteredPriceId);
          if (!existingPrice.active) {
            logger.error(`   ⚠️  Metered price ${featureConfig.meteredPriceId} is inactive for "${plan.name}:${featureKey}". Clearing from config.`);
            plan.features[featureKey].meteredPriceId = undefined;
            configModified = true;
            // Continue to create a new one below
          } else {
            // Ensure feature_key metadata is set
            if (existingPrice.metadata?.feature_key !== featureKey) {
              try {
                await stripe.prices.update(existingPrice.id, {
                  metadata: { feature_key: featureKey },
                });
                logger.log(`   🔧 Updated metadata on metered price for "${plan.name}:${featureKey}"`);
              } catch (err) {
                logger.error(`   ⚠️  Could not update metadata: ${err.message}`);
              }
            }
            continue; // Price exists and is valid
          }
        } catch (err) {
          logger.error(`   ⚠️  Could not retrieve metered price ${featureConfig.meteredPriceId}: ${err.message}. Clearing from config.`);
          plan.features[featureKey].meteredPriceId = undefined;
          configModified = true;
          // Continue to find/create below
        }
      }

      // Find existing metered price for this plan+meter
      try {
        const prices = await stripe.prices.list({
          product: plan.id,
          type: "recurring",
          limit: 100,
        });

        const existingMeteredPrice = prices.data.find(
          (p) => p.recurring?.meter === meter.id && p.active
        );

        if (existingMeteredPrice) {
          plan.features[featureKey].meteredPriceId = existingMeteredPrice.id;
          configModified = true;
          logger.log(`   🔗 Matched metered price for "${plan.name}:${featureKey}" (${existingMeteredPrice.id})`);

          // Ensure feature_key metadata
          if (existingMeteredPrice.metadata?.feature_key !== featureKey) {
            try {
              await stripe.prices.update(existingMeteredPrice.id, {
                metadata: { feature_key: featureKey },
              });
              logger.log(`   🔧 Updated metadata on metered price`);
            } catch (err) {
              logger.error(`   ⚠️  Could not update metadata: ${err.message}`);
            }
          }
        } else {
          // Create metered price
          const baseCurrency = plan.price?.[0]?.currency || "usd";

          logger.log(`   🔄 Creating metered price for "${plan.name}:${featureKey}"...`);
          const meteredPrice = await stripe.prices.create({
            product: plan.id,
            currency: baseCurrency.toLowerCase(),
            unit_amount: featureConfig.pricePerCredit,
            recurring: {
              interval: "month",
              usage_type: "metered",
              meter: meter.id,
            },
            nickname: `${plan.name} - ${displayName} (usage)`,
            metadata: { feature_key: featureKey },
          });

          plan.features[featureKey].meteredPriceId = meteredPrice.id;
          stats.meteredPricesCreated++;
          configModified = true;
          logger.log(`   ✅ Created metered price (${meteredPrice.id})`);
        }
      } catch (err) {
        logger.error(`   ❌ Failed to sync metered price for "${plan.name}:${featureKey}": ${err.message}`);
      }
    }
  }

  return { stats, configModified };
}

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

// --- Main Sync Logic (pure function, no interactive prompts) ---

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

  // Show mode indicator
  logger.log(`Running in ${mode} mode`);
  modeBox(mode, stripeSecretKey, `${mode}.plans`);

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

      // First, check if we have a plan with this exact ID
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

      // Check if we have a plan with matching NAME but no ID (IDs were lost)
      const planByName = config[mode].plans.find(
        (p) => !p.id && p.name.toLowerCase().trim() === product.name.toLowerCase().trim()
      );

      if (planByName) {
        // Update existing plan with ID instead of creating duplicate
        planByName.id = product.id;
        existingProductIds.add(product.id);
        stats.productsSynced++;
        configModified = true;
        logger.log(`🔗 Matched existing plan "${product.name}" with Stripe product (${product.id})`);

        // Add any missing prices
        planByName.price = planByName.price || [];
        for (const stripePrice of productPrices) {
          const priceExists = planByName.price.some(
            (p) => p.id === stripePrice.id ||
              (p.amount === stripePrice.unit_amount &&
               p.currency === stripePrice.currency &&
               (p.interval || "one_time") === (stripePrice.recurring?.interval || "one_time"))
          );
          if (!priceExists) {
            planByName.price.push({
              id: stripePrice.id,
              amount: stripePrice.unit_amount,
              currency: stripePrice.currency,
              interval: stripePrice.recurring?.interval || "one_time",
            });
            stats.pricesPulled++;
            configModified = true;
          } else {
            // Update existing price with ID if it doesn't have one
            const existingPrice = planByName.price.find(
              (p) => !p.id &&
                p.amount === stripePrice.unit_amount &&
                p.currency === stripePrice.currency &&
                (p.interval || "one_time") === (stripePrice.recurring?.interval || "one_time")
            );
            if (existingPrice) {
              existingPrice.id = stripePrice.id;
              stats.pricesSynced++;
              configModified = true;
            }
          }
          existingPriceIds.add(stripePrice.id);
        }
        continue;
      }

      // No match by ID or name - add as new plan
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

  // --- Sync Meters for Usage-Based Billing ---
  const hasUsageFeatures = currentPlans.some((plan) => {
    if (!plan.features) return false;
    return Object.values(plan.features).some((f) => f.trackUsage && f.pricePerCredit);
  });

  if (hasUsageFeatures) {
    logger.log("📊 Syncing usage meters...\n");
    const meterResult = await syncMeters(stripe, currentPlans, mode, logger);
    if (meterResult.configModified) {
      configModified = true;
    }
    stats.metersCreated = meterResult.stats.metersCreated;
    stats.metersSynced = meterResult.stats.metersSynced;
    stats.meteredPricesCreated = meterResult.stats.meteredPricesCreated;

    if (meterResult.stats.metersCreated > 0 || meterResult.stats.meteredPricesCreated > 0) {
      logger.log("");
    }
  }

  if (configModified) {
    const newContent =
      content.substring(0, extracted.start) +
      formatConfigToTs(config) +
      content.substring(extracted.end);
    fs.writeFileSync(billingConfigPath, newContent);
    success("Updated billing.config.ts");
  }

  console.log();
  const productTotal = stats.productsPulled + stats.productsSynced + stats.productsCreated;
  const priceTotal = stats.pricesPulled + stats.pricesSynced + stats.pricesCreated;
  const meterTotal = (stats.metersCreated || 0) + (stats.metersSynced || 0);
  const meteredPriceTotal = stats.meteredPricesCreated || 0;

  let syncSummary = `Synced ${productTotal} products, ${priceTotal} prices`;
  if (meterTotal > 0 || meteredPriceTotal > 0) {
    syncSummary += `, ${meterTotal} meters, ${meteredPriceTotal} metered prices`;
  }
  success(syncSummary);

  return {
    success: true,
    stats,
    // Return context needed for webhook setup
    _context: { stripe, mode, billingConfigPath, Stripe },
  };
}

// --- Interactive Webhook Setup (CLI only) ---

async function setupWebhooks(options = {}) {
  const {
    env = process.env,
    cwd = process.cwd(),
    logger = console,
    stripe,
    mode,
    billingConfigPath,
    Stripe,
  } = options;

  const siteUrl = env.NEXT_PUBLIC_APP_URL || "";
  const isLocal = !siteUrl || isLocalhost(siteUrl);

  divider();

  // If localhost, show local dev notice first
  if (isLocal) {
    const port = getDevPort(cwd);
    localDevNotice(port);
  }

  // Always show webhook menu
  console.log(`  ${BOLD}What would you like to do next?${RESET}`);

  const rl = createPrompt();
  const menuOptions = isLocal
    ? [
        { label: "Continue with local development", action: "skip" },
        { label: "Set up for staging (test mode, public URL)", action: "staging" },
        { label: "Set up for production (live mode)", action: "production" },
      ]
    : [
        { label: "Skip webhook setup", action: "skip" },
        { label: "Set up for staging (test mode, public URL)", action: "staging" },
        { label: "Set up for production (live mode)", action: "production" },
      ];
  const choice = await selectOption(rl, menuOptions);

  if (choice.action === "skip") {
    rl.close();
    info("Skipped webhook setup");
    return { success: true };
  }

  if (choice.action === "staging") {
    // Staging: use current test key, ask for URL
    const defaultUrl = isLocal ? "" : siteUrl;
    const stagingUrl = await question(rl, "Enter your staging URL", defaultUrl);
    rl.close();

    const webhookUrl = `${new URL(stagingUrl).origin}/api/stripe/webhook`;
    info(`Creating webhook for ${webhookUrl}...`);

    try {
      // Check for existing webhook and delete it to get new secret
      const existingWebhooks = await stripe.webhookEndpoints.list({ limit: 100 });
      const existing = existingWebhooks.data.find((wh) => wh.url === webhookUrl);
      if (existing) {
        await stripe.webhookEndpoints.del(existing.id);
      }

      const webhook = await stripe.webhookEndpoints.create({
        url: webhookUrl,
        enabled_events: ["*"],
        description: "Created by stripe-no-webhooks CLI (staging)",
      });

      webhookSecretBox(webhook.secret, "staging");

      saveWebhookSecret(
        { environment: "staging", url: webhookUrl, secret: webhook.secret },
        cwd
      );
      success("Saved to .stripe-webhook-secrets");
      success("Added .stripe-webhook-secrets to .gitignore");
    } catch (err) {
      error(`Failed to create webhook: ${err.message}`);
    }

    return { success: true };
  }

  if (choice.action === "production") {
    // Production: need live key
    console.log();
    const liveKey = await questionHidden(
      null,
      "Enter your LIVE Stripe Secret Key (sk_live_...)"
    );

    if (!liveKey.includes("_live_")) {
      rl.close();
      error("Production setup requires a live key (sk_live_...)");
      return { success: true };
    }

    const prodUrl = await question(rl, "Enter your production URL");
    rl.close();

    if (!prodUrl) {
      error("Production URL is required");
      return { success: true };
    }

    const liveStripe = new Stripe(liveKey);

    // Show production mode indicator
    modeBox("production", liveKey, "production.plans");

    // Sync production plans
    info("Syncing production.plans...");

    // Re-read config and sync production mode
    const prodContent = fs.readFileSync(billingConfigPath, "utf8");
    const { config: prodConfig, extracted: prodExtracted } = parseBillingConfig(
      prodContent,
      "production",
      logger
    );

    if (prodConfig) {
      prodConfig.production = prodConfig.production || { plans: [] };
      prodConfig.production.plans = prodConfig.production.plans || [];

      let prodConfigModified = false;

      // Fetch existing Stripe data
      let prodProductsByName = {},
        prodPricesByKey = {};
      try {
        const [prodProducts, prodPrices] = await Promise.all([
          liveStripe.products.list({ active: true, limit: 100 }),
          liveStripe.prices.list({ active: true, limit: 100 }),
        ]);
        prodProductsByName = buildProductsByNameMap(prodProducts.data);
        prodPricesByKey = buildPricesByKeyMap(prodPrices.data);
      } catch (err) {
        error(`Could not fetch production Stripe data: ${err.message}`);
      }

      // Sync each plan
      for (let i = 0; i < prodConfig.production.plans.length; i++) {
        const plan = prodConfig.production.plans[i];
        let productId = plan.id;

        if (!productId) {
          const existing = findMatchingProduct(prodProductsByName, plan.name);
          if (existing) {
            productId = existing.id;
            success(`Matched "${plan.name}" (${productId})`);
            prodConfig.production.plans[i].id = productId;
            prodConfigModified = true;
          } else {
            try {
              const product = await liveStripe.products.create({
                name: plan.name,
                description: plan.description || undefined,
              });
              productId = product.id;
              success(`Created "${plan.name}" (${productId})`);
              prodProductsByName[plan.name.toLowerCase().trim()] = product;
              prodConfig.production.plans[i].id = productId;
              prodConfigModified = true;
            } catch (err) {
              error(`Failed to create "${plan.name}": ${err.message}`);
              continue;
            }
          }
        }

        if (!plan.price?.length) continue;

        for (let j = 0; j < plan.price.length; j++) {
          const price = plan.price[j];
          if (price.id) continue;

          const existing = findMatchingPrice(prodPricesByKey, productId, price);
          const interval = price.interval || "one_time";

          if (existing) {
            prodConfig.production.plans[i].price[j].id = existing.id;
            prodConfigModified = true;
          } else {
            try {
              const priceParams = {
                product: productId,
                unit_amount: price.amount,
                currency: price.currency.toLowerCase(),
              };
              if (interval !== "one_time") priceParams.recurring = { interval };

              const stripePrice = await liveStripe.prices.create(priceParams);
              success(`Created price ${price.amount / 100} ${price.currency}/${interval}`);
              prodConfig.production.plans[i].price[j].id = stripePrice.id;
              prodConfigModified = true;
            } catch (err) {
              error(`Failed to create price: ${err.message}`);
            }
          }
        }
      }

      // Sync meters for usage-based billing in production
      const prodPlans = prodConfig.production.plans || [];
      const hasUsageFeatures = prodPlans.some((plan) => {
        if (!plan.features) return false;
        return Object.values(plan.features).some((f) => f.trackUsage && f.pricePerCredit);
      });

      if (hasUsageFeatures) {
        info("Syncing usage meters for production...");
        const meterResult = await syncMeters(liveStripe, prodPlans, "production", { log: info, error });
        if (meterResult.configModified) {
          prodConfigModified = true;
        }
        if (meterResult.stats.metersCreated > 0 || meterResult.stats.meteredPricesCreated > 0) {
          success(`Synced ${meterResult.stats.metersCreated + meterResult.stats.metersSynced} meters, ${meterResult.stats.meteredPricesCreated} metered prices`);
        }
      }

      if (prodConfigModified) {
        const newProdContent =
          prodContent.substring(0, prodExtracted.start) +
          formatConfigToTs(prodConfig) +
          prodContent.substring(prodExtracted.end);
        fs.writeFileSync(billingConfigPath, newProdContent);
        success("Updated billing.config.ts with production IDs");
      }
    }

    // Create production webhook
    const webhookUrl = `${new URL(prodUrl).origin}/api/stripe/webhook`;
    info(`Creating webhook for ${webhookUrl}...`);

    try {
      const existingWebhooks = await liveStripe.webhookEndpoints.list({ limit: 100 });
      const existing = existingWebhooks.data.find((wh) => wh.url === webhookUrl);
      if (existing) {
        await liveStripe.webhookEndpoints.del(existing.id);
      }

      const webhook = await liveStripe.webhookEndpoints.create({
        url: webhookUrl,
        enabled_events: ["*"],
        description: "Created by stripe-no-webhooks CLI (production)",
      });

      webhookSecretBox(webhook.secret, "production");

      saveWebhookSecret(
        { environment: "production", url: webhookUrl, secret: webhook.secret },
        cwd
      );
      success("Saved to .stripe-webhook-secrets");
      success("Added .stripe-webhook-secrets to .gitignore");

      console.log();
      info(`${BOLD}Don't forget to commit billing.config.ts!${RESET}`);
    } catch (err) {
      error(`Failed to create webhook: ${err.message}`);
    }

    return { success: true };
  }

  rl.close();
  return { success: true };
}

module.exports = {
  sync,
  setupWebhooks,
  // Export for testing
  findMatchingBrace,
  tsObjectToJson,
  extractBillingConfigObject,
  parseBillingConfig,
  reorderWithIdFirst,
  toTsObjectLiteral,
  formatConfigToTs,
};
