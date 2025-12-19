#!/usr/bin/env node

const { runMigrations } = require("@supabase/stripe-sync-engine");
const readline = require("readline");
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

// Load environment variables from .env files in the user's project directory
require("dotenv").config({ path: path.join(process.cwd(), ".env.local") });
require("dotenv").config({ path: path.join(process.cwd(), ".env") });

const args = process.argv.slice(2);
const command = args[0];
const databaseUrl = args[1];

function createPrompt() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function question(rl, query, defaultValue = "") {
  return new Promise((resolve) => {
    const prompt = defaultValue ? `${query} (${defaultValue}): ` : `${query}: `;
    rl.question(prompt, (answer) => {
      resolve(answer || defaultValue);
    });
  });
}

function maskSecretKey(key) {
  if (!key || key.length < 8) return "*****";
  return key.slice(0, 3) + "*****" + key.slice(-4);
}

function questionHidden(rl, query, defaultValue = "") {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    const maskedDefault = defaultValue ? maskSecretKey(defaultValue) : "";
    const prompt = maskedDefault
      ? `${query} (${maskedDefault}): `
      : `${query}: `;
    stdout.write(prompt);

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let input = "";
    const onData = (char) => {
      if (char === "\n" || char === "\r" || char === "\u0004") {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        stdout.write("\n");
        resolve(input || defaultValue);
      } else if (char === "\u0003") {
        // Ctrl+C
        process.exit();
      } else if (char === "\u007F" || char === "\b") {
        // Backspace
        if (input.length > 0) {
          input = input.slice(0, -1);
          stdout.write("\b \b"); // Erase character from display
        }
      } else {
        input += char;
        stdout.write("*"); // Show asterisk for each character
      }
    };

    stdin.on("data", onData);
  });
}

async function migrate(dbUrl) {
  const SCHEMA = "stripe";
  const databaseUrl = dbUrl || process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("❌ Missing database URL.\n");
    console.log(
      "Usage:\n  npx stripe-no-webhooks migrate <postgres_connection_string>"
    );
    process.exit(1);
  }

  console.log("🚀 Running Stripe migrations...");
  try {
    await runMigrations({
      databaseUrl,
      schema: SCHEMA,
      logger: console,
    });
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();

    await client.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.user_stripe_customer_map (
        user_id text PRIMARY KEY,
        stripe_customer_id text UNIQUE NOT NULL,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now()
      );
    `);

    await client.end();
    console.log("✅ Stripe schema migrations completed!");

    if (!process.env.DATABASE_URL) {
      const envVars = [{ key: "DATABASE_URL", value: databaseUrl }];
      const updatedFiles = saveToEnvFiles(envVars);
      if (updatedFiles.length > 0) {
        console.log(`📝 Updated ${updatedFiles.join(", ")} with DATABASE_URL`);
      }
    }
  } catch (error) {
    console.error("❌ Migration failed:");
    console.error(error);
    process.exit(1);
  }
}

function saveToEnvFiles(envVars) {
  const envFiles = [
    ".env",
    ".env.local",
    ".env.development",
    ".env.production",
  ];
  const cwd = process.cwd();
  const updatedFiles = [];

  for (const envFile of envFiles) {
    const envPath = path.join(cwd, envFile);
    if (fs.existsSync(envPath)) {
      let content = fs.readFileSync(envPath, "utf8");

      for (const { key, value } of envVars) {
        const line = `${key}=${value}`;
        const regex = new RegExp(`^${key}=.*`, "m");

        if (regex.test(content)) {
          content = content.replace(regex, line);
        } else {
          const newline = content.endsWith("\n") ? "" : "\n";
          content = content + newline + line + "\n";
        }
      }

      fs.writeFileSync(envPath, content);
      updatedFiles.push(envFile);
    }
  }

  return updatedFiles;
}

function getTemplatesDir() {
  return path.join(__dirname, "..", "src", "templates");
}

function getAppRouterTemplate() {
  const templatePath = path.join(getTemplatesDir(), "app-router.ts");
  return fs.readFileSync(templatePath, "utf8");
}

function getPagesRouterTemplate() {
  const templatePath = path.join(getTemplatesDir(), "pages-router.ts");
  return fs.readFileSync(templatePath, "utf8");
}

function detectRouterType() {
  const cwd = process.cwd();
  const hasAppDir = fs.existsSync(path.join(cwd, "app"));
  const hasPagesDir = fs.existsSync(path.join(cwd, "pages"));

  // Also check for src/app and src/pages (common Next.js structure)
  const hasSrcAppDir = fs.existsSync(path.join(cwd, "src", "app"));
  const hasSrcPagesDir = fs.existsSync(path.join(cwd, "src", "pages"));

  // Prefer App Router if app directory exists
  if (hasAppDir || hasSrcAppDir) {
    return { type: "app", useSrc: hasSrcAppDir && !hasAppDir };
  }

  if (hasPagesDir || hasSrcPagesDir) {
    return { type: "pages", useSrc: hasSrcPagesDir && !hasPagesDir };
  }

  // Default to App Router if no directories found
  return { type: "app", useSrc: false };
}

function createApiRoute(routerType, useSrc) {
  const cwd = process.cwd();
  const baseDir = useSrc ? path.join(cwd, "src") : cwd;

  if (routerType === "app") {
    // App Router: app/api/stripe/[...all]/route.ts
    const routeDir = path.join(baseDir, "app", "api", "stripe", "[...all]");
    const routeFile = path.join(routeDir, "route.ts");
    fs.mkdirSync(routeDir, { recursive: true });

    // Get template content (remove the comment with file path)
    let template = getAppRouterTemplate();
    template = template.replace(
      /^\/\/ app\/api\/stripe\/\[\.\.\.all\]\/route\.ts\n/,
      ""
    );

    fs.writeFileSync(routeFile, template);

    const prefix = useSrc ? "src/" : "";
    return `${prefix}app/api/stripe/[...all]/route.ts`;
  } else {
    // Pages Router: pages/api/stripe/[...all].ts
    const routeDir = path.join(baseDir, "pages", "api", "stripe");
    const routeFile = path.join(routeDir, "[...all].ts");

    fs.mkdirSync(routeDir, { recursive: true });

    // Get template content (remove the comment with file path)
    let template = getPagesRouterTemplate();
    template = template.replace(
      /^\/\/ pages\/api\/stripe\/\[\.\.\.all\]\.ts\n/,
      ""
    );
    fs.writeFileSync(routeFile, template);

    const prefix = useSrc ? "src/" : "";
    return `${prefix}pages/api/stripe/[...all].ts`;
  }
}

async function config() {
  let Stripe;
  try {
    Stripe = require("stripe").default || require("stripe");
  } catch (e) {
    console.error("❌ Stripe package not found.");
    console.log("Please install it first: npm install stripe");
    process.exit(1);
  }

  console.log("\n🔧 Stripe Webhook Configuration\n");

  // Detect router type from folder structure
  const { type: routerType, useSrc } = detectRouterType();
  const routerLabel = routerType === "app" ? "App Router" : "Pages Router";
  const srcLabel = useSrc ? " (src/)" : "";
  console.log(`📂 Detected: ${routerLabel}${srcLabel}\n`);

  const existingStripeKey = process.env.STRIPE_SECRET_KEY || "";
  const stripeSecretKey = await questionHidden(
    null,
    "Enter your Stripe Secret Key (sk_...)",
    existingStripeKey
  );

  if (!stripeSecretKey || !stripeSecretKey.startsWith("sk_")) {
    console.error("❌ Invalid Stripe Secret Key. It should start with 'sk_'");
    process.exit(1);
  }

  const rl = createPrompt();

  const defaultSiteUrl = process.env.NEXT_PUBLIC_SITE_URL || "";
  const siteUrl = await question(rl, "Enter your site URL", defaultSiteUrl);

  if (!siteUrl) {
    console.error("❌ Site URL is required");
    rl.close();
    process.exit(1);
  }

  let webhookUrl;
  try {
    const url = new URL(siteUrl);
    webhookUrl = `${url.origin}/api/stripe/webhook`;
  } catch (e) {
    console.error("❌ Invalid URL format");
    rl.close();
    process.exit(1);
  }

  let databaseUrlInput = "";
  if (process.env.DATABASE_URL) {
    console.log("✓ DATABASE_URL already set in environment");
    databaseUrlInput = process.env.DATABASE_URL;
  } else {
    databaseUrlInput = await question(
      rl,
      "Enter your DATABASE_URL (optional, press Enter to skip)",
      ""
    );
  }

  rl.close();

  console.log(`📁 Creating API route...`);
  try {
    const createdFile = createApiRoute(routerType, useSrc);
    console.log(`✅ Created ${createdFile}`);
  } catch (error) {
    console.error("❌ Failed to create API route:", error.message);
    process.exit(1);
  }

  console.log(`📁 Creating billing.config.ts...`);
  try {
    const billingConfigPath = path.join(process.cwd(), "billing.config.ts");
    if (!fs.existsSync(billingConfigPath)) {
      const templatePath = path.join(getTemplatesDir(), "billing.config.ts");
      const template = fs.readFileSync(templatePath, "utf8");
      fs.writeFileSync(billingConfigPath, template);
      console.log(`✅ Created billing.config.ts\n`);
    } else {
      console.log(`✓ billing.config.ts already exists\n`);
    }
  } catch (error) {
    console.error("❌ Failed to create billing.config.ts:", error.message);
    process.exit(1);
  }

  console.log(`📡 Creating webhook endpoint: ${webhookUrl}\n`);

  const stripe = new Stripe(stripeSecretKey);

  try {
    const existingWebhooks = await stripe.webhookEndpoints.list({ limit: 100 });
    const existingWebhook = existingWebhooks.data.find(
      (wh) => wh.url === webhookUrl
    );

    if (existingWebhook) {
      console.log(`🔄 Found existing webhook with same URL, deleting it...`);
      await stripe.webhookEndpoints.del(existingWebhook.id);
      console.log(`✅ Deleted existing webhook (${existingWebhook.id})\n`);
    }

    console.log(`🔄 Creating new webhook endpoint...`);
    const webhook = await stripe.webhookEndpoints.create({
      url: webhookUrl,
      enabled_events: ["*"], // Listen to all events
      description: "Created by stripe-no-webhooks CLI",
    });
    console.log("✅ Webhook created successfully!\n");

    const envVars = [
      { key: "STRIPE_SECRET_KEY", value: stripeSecretKey },
      { key: "STRIPE_WEBHOOK_SECRET", value: webhook.secret },
      { key: "NEXT_PUBLIC_SITE_URL", value: siteUrl },
    ];
    if (databaseUrlInput) {
      envVars.push({ key: "DATABASE_URL", value: databaseUrlInput });
    }

    const updatedFiles = saveToEnvFiles(envVars);

    const envVarNames = envVars.map((v) => v.key).join(", ");
    if (updatedFiles.length > 0) {
      console.log(`📝 Updated ${updatedFiles.join(", ")} with ${envVarNames}`);
      console.log(
        "\nREMEMBER: Update the environment variables in Vercel too:"
      );
      for (const { key, value } of envVars) {
        console.log(`${key}=${value}`);
      }
    } else {
      console.log("Add these to your environment variables:\n");
      for (const { key, value } of envVars) {
        console.log(`${key}=${value}`);
      }
    }

    console.log("─".repeat(50));
    console.log("Webhook ID:", webhook.id);
    console.log("Webhook URL:", webhook.url);
    console.log("Events: All events (*)");
    if (updatedFiles.length === 0) {
      console.log("Secret:", webhook.secret);
    }
    console.log("─".repeat(50));
  } catch (error) {
    if (error.type === "StripeAuthenticationError") {
      console.error("❌ Authentication failed. Check your Stripe Secret Key.");
    } else if (error.type === "StripeInvalidRequestError") {
      console.error("❌ Invalid request:", error.message);
    } else {
      console.error("❌ Failed to create webhook:");
      console.error(error.message);
    }
    process.exit(1);
  }
}

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

function getMode(stripeKey) {
  if (stripeKey.includes("_test_")) {
    return "test";
  } else if (stripeKey.includes("_live_")) {
    return "production";
  } else {
    throw new Error("Invalid Stripe key");
  }
}

function tsObjectToJson(tsContent) {
  // Remove single-line comments
  let json = tsContent.replace(/\/\/.*$/gm, "");
  // Remove multi-line comments
  json = json.replace(/\/\*[\s\S]*?\*\//g, "");
  // Quote unquoted keys (word characters followed by colon)
  json = json.replace(/(\s*)(\w+)(\s*:)/g, '$1"$2"$3');
  // Remove trailing commas before ] or }
  json = json.replace(/,(\s*[}\]])/g, "$1");
  return json;
}

function extractBillingConfigObject(content) {
  // Find the start of the config object
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

function parseBillingConfig(content, mode) {
  const extracted = extractBillingConfigObject(content);
  if (!extracted) {
    return { config: null, plans: [] };
  }

  const jsonString = tsObjectToJson(extracted.raw);
  let config;
  try {
    config = JSON.parse(jsonString);
  } catch (e) {
    console.error("Failed to parse billing config as JSON:", e.message);
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
  // Reorder plans and prices so 'id' is always first
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

async function sync() {
  const billingConfigPath = path.join(process.cwd(), "billing.config.ts");

  if (!fs.existsSync(billingConfigPath)) {
    console.error("❌ billing.config.ts not found in project root.");
    console.log("Run 'npx stripe-no-webhooks config' first to create it.");
    process.exit(1);
  }

  let Stripe;
  try {
    Stripe = require("stripe").default || require("stripe");
  } catch (e) {
    console.error("❌ Stripe package not found.");
    console.log("Please install it first: npm install stripe");
    process.exit(1);
  }

  let stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    stripeSecretKey = await questionHidden(
      null,
      "Enter your Stripe Secret Key (sk_...)"
    );
  }

  if (!stripeSecretKey || !stripeSecretKey.startsWith("sk_")) {
    console.error("❌ Invalid Stripe Secret Key. It should start with 'sk_'");
    process.exit(1);
  }

  let mode;
  try {
    mode = getMode(stripeSecretKey);
  } catch (e) {
    console.error("❌", e.message);
    process.exit(1);
  }

  const stripe = new Stripe(stripeSecretKey);

  console.log(`\n🔄 Syncing billing plans with Stripe (${mode} mode)...\n`);

  let content = fs.readFileSync(billingConfigPath, "utf8");
  const { config, plans, extracted } = parseBillingConfig(content, mode);

  if (!config) {
    console.error("❌ Failed to parse billing.config.ts");
    process.exit(1);
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

  console.log("📥 Pulling products from Stripe...\n");

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

    // Add missing products and their prices
    for (const product of stripeProducts.data) {
      if (existingProductIds.has(product.id)) {
        // Product exists, but check if any prices are missing
        const planIndex = config[mode].plans.findIndex(
          (p) => p.id === product.id
        );
        const plan = config[mode].plans[planIndex];
        const productPrices = pricesByProduct[product.id] || [];

        for (const stripePrice of productPrices) {
          if (!existingPriceIds.has(stripePrice.id)) {
            // Add missing price to existing plan
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
            console.log(
              `   📥 Added price ${stripePrice.unit_amount / 100} ${
                stripePrice.currency
              }/${newPrice.interval} to "${product.name}"`
            );
          }
        }
        continue;
      }

      // Product doesn't exist in config, add it
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

      // Remove undefined description
      if (!newPlan.description) {
        delete newPlan.description;
      }

      config[mode].plans.push(newPlan);
      productsPulled++;
      pricesPulled += productPrices.length;
      configModified = true;

      console.log(`📥 Added product "${product.name}" (${product.id})`);
      for (const price of newPlan.price) {
        console.log(
          `   📥 Added price ${price.amount / 100} ${price.currency}/${
            price.interval
          }`
        );
      }
    }

    if (productsPulled === 0 && pricesPulled === 0) {
      console.log("   No new products or prices to pull from Stripe.\n");
    } else {
      console.log("");
    }
  } catch (error) {
    console.error("❌ Failed to fetch products from Stripe:", error.message);
  }

  console.log("📤 Pushing new plans to Stripe...\n");

  const currentPlans = config[mode].plans || [];

  if (currentPlans.length === 0) {
    console.log(`   No plans in billing.config.ts for ${mode} mode.\n`);
  }

  for (let index = 0; index < currentPlans.length; index++) {
    const plan = currentPlans[index];
    let productId = plan.id;

    // Create product if needed
    if (!productId) {
      try {
        console.log(`🔄 Creating product "${plan.name}" in Stripe...`);

        const product = await stripe.products.create({
          name: plan.name,
          description: plan.description || undefined,
        });

        productId = product.id;
        console.log(`✅ Created product "${plan.name}" (${productId})`);

        // Update the config object with the new product id
        config[mode].plans[index].id = productId;
        productsCreated++;
        configModified = true;
      } catch (error) {
        console.error(
          `❌ Failed to create product "${plan.name}":`,
          error.message
        );
        continue;
      }
    } else {
      skippedProducts++;
    }

    // Create prices if needed
    if (plan.price && plan.price.length > 0) {
      for (let priceIndex = 0; priceIndex < plan.price.length; priceIndex++) {
        const price = plan.price[priceIndex];

        if (price.id) {
          skippedPrices++;
          continue;
        }

        try {
          console.log(
            `   🔄 Creating price ${price.amount / 100} ${price.currency}/${
              price.interval
            }...`
          );

          const priceParams = {
            product: productId,
            unit_amount: price.amount,
            currency: price.currency.toLowerCase(),
          };

          // Only add recurring for non-one_time intervals
          if (price.interval && price.interval !== "one_time") {
            priceParams.recurring = {
              interval: price.interval,
            };
          }

          const stripePrice = await stripe.prices.create(priceParams);

          console.log(`   ✅ Created price (${stripePrice.id})`);

          // Update the config object with the new price id
          config[mode].plans[index].price[priceIndex].id = stripePrice.id;
          pricesCreated++;
          configModified = true;
        } catch (error) {
          console.error(
            `   ❌ Failed to create price ${price.interval}/${price.currency}:`,
            error.message
          );
        }
      }
    }
  }

  if (productsCreated === 0 && pricesCreated === 0) {
    console.log("   No new products or prices to push to Stripe.\n");
  }

  if (configModified) {
    const newConfigJson = formatConfigToTs(config);
    const newContent =
      content.substring(0, extracted.start) +
      newConfigJson +
      content.substring(extracted.end);
    fs.writeFileSync(billingConfigPath, newContent);
    console.log(`\n📝 Updated billing.config.ts`);
  }

  console.log(`\n✅ Done!`);
  console.log(
    `   Pulled from Stripe: ${productsPulled} product(s), ${pricesPulled} price(s)`
  );
  console.log(
    `   Pushed to Stripe: ${productsCreated} product(s), ${pricesCreated} price(s)`
  );
}

async function main() {
  switch (command) {
    case "migrate":
      await migrate(databaseUrl);
      break;

    case "config":
      await config();
      break;

    case "sync":
      await sync();
      break;

    default:
      console.log("Usage:");
      console.log("  npx stripe-no-webhooks migrate <connection_string>");
      console.log("  npx stripe-no-webhooks config");
      console.log("  npx stripe-no-webhooks push");
      process.exit(1);
  }
}

main();
