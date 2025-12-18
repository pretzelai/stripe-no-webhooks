#!/usr/bin/env node

const { runMigrations } = require("@supabase/stripe-sync-engine");
const readline = require("readline");
const fs = require("fs");
const path = require("path");

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

function questionHidden(rl, query) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    stdout.write(`${query}: `);

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
        resolve(input);
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
        stdout.write("**************"); // Show asterisk for each character
      }
    };

    stdin.on("data", onData);
  });
}

async function migrate(databaseUrl) {
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
      schema: "stripe",
      logger: console,
    });
    console.log("✅ Migrations completed successfully!");

    // Save DATABASE_URL to env files
    const envVars = [{ key: "DATABASE_URL", value: databaseUrl }];
    const updatedFiles = saveToEnvFiles(envVars);
    if (updatedFiles.length > 0) {
      console.log(`📝 Updated ${updatedFiles.join(", ")} with DATABASE_URL`);
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
          // Replace existing value
          content = content.replace(regex, line);
        } else {
          // Append to file
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

    // Create directories if they don't exist
    fs.mkdirSync(routeDir, { recursive: true });

    // Get template content (remove the comment with file path)
    let template = getAppRouterTemplate();
    template = template.replace(
      /^\/\/ app\/api\/stripe\/\[\.\.\.all\]\/route\.ts\n/,
      ""
    );

    // Write the file
    fs.writeFileSync(routeFile, template);

    const prefix = useSrc ? "src/" : "";
    return `${prefix}app/api/stripe/[...all]/route.ts`;
  } else {
    // Pages Router: pages/api/stripe/[...all].ts
    const routeDir = path.join(baseDir, "pages", "api", "stripe");
    const routeFile = path.join(routeDir, "[...all].ts");

    // Create directories if they don't exist
    fs.mkdirSync(routeDir, { recursive: true });

    // Get template content (remove the comment with file path)
    let template = getPagesRouterTemplate();
    template = template.replace(
      /^\/\/ pages\/api\/stripe\/\[\.\.\.all\]\.ts\n/,
      ""
    );

    // Write the file
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

  // Get Stripe API key (hidden input)
  const stripeSecretKey = await questionHidden(
    null,
    "Enter your Stripe Secret Key (sk_...)"
  );

  if (!stripeSecretKey || !stripeSecretKey.startsWith("sk_")) {
    console.error("❌ Invalid Stripe Secret Key. It should start with 'sk_'");
    process.exit(1);
  }

  // Create readline for site URL question
  const rl = createPrompt();

  // Get site URL with default from env
  const defaultSiteUrl = process.env.NEXT_PUBLIC_SITE_URL || "";
  const siteUrl = await question(rl, "Enter your site URL", defaultSiteUrl);

  if (!siteUrl) {
    console.error("❌ Site URL is required");
    rl.close();
    process.exit(1);
  }

  // Validate URL
  let webhookUrl;
  try {
    const url = new URL(siteUrl);
    webhookUrl = `${url.origin}/api/stripe/webhook`;
  } catch (e) {
    console.error("❌ Invalid URL format");
    rl.close();
    process.exit(1);
  }

  // Get DATABASE_URL (optional) - skip if already set in env
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

  // Create the API route
  console.log(`📁 Creating API route...`);
  try {
    const createdFile = createApiRoute(routerType, useSrc);
    console.log(`✅ Created ${createdFile}`);
  } catch (error) {
    console.error("❌ Failed to create API route:", error.message);
    process.exit(1);
  }

  // Copy billing.config.ts to root
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
    // Check if a webhook with the same URL already exists
    const existingWebhooks = await stripe.webhookEndpoints.list({ limit: 100 });
    const existingWebhook = existingWebhooks.data.find(
      (wh) => wh.url === webhookUrl
    );

    if (existingWebhook) {
      console.log(`🔄 Found existing webhook with same URL, deleting it...`);
      await stripe.webhookEndpoints.del(existingWebhook.id);
      console.log(`✅ Deleted existing webhook (${existingWebhook.id})\n`);
    }

    // Create webhook endpoint
    console.log(`🔄 Creating new webhook endpoint...`);
    const webhook = await stripe.webhookEndpoints.create({
      url: webhookUrl,
      enabled_events: ["*"], // Listen to all events
      description: "Created by stripe-no-webhooks CLI",
    });
    console.log("✅ Webhook created successfully!\n");

    // Build list of env vars to update
    const envVars = [
      { key: "STRIPE_SECRET_KEY", value: stripeSecretKey },
      { key: "STRIPE_WEBHOOK_SECRET", value: webhook.secret },
      { key: "NEXT_PUBLIC_SITE_URL", value: siteUrl },
    ];
    if (databaseUrlInput) {
      envVars.push({ key: "DATABASE_URL", value: databaseUrlInput });
    }

    // Save to env files
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
  // Find the matching closing brace for an opening brace
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

function parseBillingConfig(content) {
  // Extract the plans array from the file content
  const plansStartMatch = content.match(/plans\s*:\s*\[/);
  if (!plansStartMatch) {
    return [];
  }

  const plansStart = plansStartMatch.index + plansStartMatch[0].length - 1;
  const plansEnd = findMatchingBrace(content, plansStart);
  if (plansEnd === -1) return [];

  const plansContent = content.substring(plansStart + 1, plansEnd);
  const plans = [];

  // Find each plan object by looking for opening braces at the top level
  let depth = 0;
  let planStart = -1;

  for (let i = 0; i < plansContent.length; i++) {
    const char = plansContent[i];
    if (char === "{") {
      if (depth === 0) planStart = i;
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0 && planStart !== -1) {
        const planRaw = plansContent.substring(planStart, i + 1);
        const plan = parsePlanObject(planRaw);
        if (plan.name) {
          plans.push({
            plan,
            raw: planRaw,
            startIndex:
              plansStartMatch.index + plansStartMatch[0].length + planStart,
          });
        }
        planStart = -1;
      }
    }
  }

  return plans;
}

function parsePlanObject(planContent) {
  const plan = {};

  // Extract id if present (product id)
  const idMatch = planContent.match(/^\s*\{\s*id\s*:\s*["']([^"']+)["']/);
  if (idMatch) plan.id = idMatch[1];

  // Also try to find id not at start
  if (!plan.id) {
    const idMatch2 = planContent.match(/[,{]\s*id\s*:\s*["']([^"']+)["']/);
    if (idMatch2) plan.id = idMatch2[1];
  }

  // Extract name
  const nameMatch = planContent.match(/name\s*:\s*["']([^"']+)["']/);
  if (nameMatch) plan.name = nameMatch[1];

  // Extract description
  const descMatch = planContent.match(/description\s*:\s*["']([^"']+)["']/);
  if (descMatch) plan.description = descMatch[1];

  // Extract price array
  const priceStartMatch = planContent.match(/price\s*:\s*\[/);
  if (priceStartMatch) {
    const priceStart = priceStartMatch.index + priceStartMatch[0].length - 1;
    const priceEnd = findMatchingBrace(planContent, priceStart);
    if (priceEnd !== -1) {
      const priceArrayContent = planContent.substring(priceStart + 1, priceEnd);
      plan.prices = parsePriceArray(priceArrayContent);
      plan.priceArrayStart = priceStart;
      plan.priceArrayEnd = priceEnd;
    }
  }

  return plan;
}

function parsePriceArray(priceArrayContent) {
  const prices = [];
  let depth = 0;
  let priceStart = -1;

  for (let i = 0; i < priceArrayContent.length; i++) {
    const char = priceArrayContent[i];
    if (char === "{") {
      if (depth === 0) priceStart = i;
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0 && priceStart !== -1) {
        const priceRaw = priceArrayContent.substring(priceStart, i + 1);
        const price = parsePriceObject(priceRaw);
        prices.push({ price, raw: priceRaw, localStart: priceStart });
        priceStart = -1;
      }
    }
  }

  return prices;
}

function parsePriceObject(priceContent) {
  const price = {};

  // Extract id if present (price id)
  const idMatch = priceContent.match(/id\s*:\s*["']([^"']+)["']/);
  if (idMatch) price.id = idMatch[1];

  // Extract amount
  const amountMatch = priceContent.match(/amount\s*:\s*(\d+)/);
  if (amountMatch) price.amount = parseInt(amountMatch[1], 10);

  // Extract currency
  const currencyMatch = priceContent.match(/currency\s*:\s*["']([^"']+)["']/);
  if (currencyMatch) price.currency = currencyMatch[1];

  // Extract interval
  const intervalMatch = priceContent.match(/interval\s*:\s*["']([^"']+)["']/);
  if (intervalMatch) price.interval = intervalMatch[1];

  return price;
}

async function push() {
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

  // Get Stripe API key from env or prompt
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

  const stripe = new Stripe(stripeSecretKey);

  console.log("\n📤 Pushing billing plans to Stripe...\n");

  let content = fs.readFileSync(billingConfigPath, "utf8");
  const parsedPlans = parseBillingConfig(content);

  if (parsedPlans.length === 0) {
    console.log("No plans found in billing.config.ts");
    console.log("Add plans to the config file and run this command again.");
    process.exit(0);
  }

  let updatedContent = content;
  let productsCreated = 0;
  let pricesCreated = 0;
  let skippedProducts = 0;
  let skippedPrices = 0;

  for (const { plan, raw } of parsedPlans) {
    let productId = plan.id;
    let updatedPlanRaw = raw;

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

        // Add product id to plan
        updatedPlanRaw = updatedPlanRaw.replace(
          /\{/,
          `{\n      id: "${productId}",`
        );
        productsCreated++;
      } catch (error) {
        console.error(
          `❌ Failed to create product "${plan.name}":`,
          error.message
        );
        continue;
      }
    } else {
      console.log(`⏭️  Product "${plan.name}" already exists (${productId})`);
      skippedProducts++;
    }

    // Create prices if needed
    if (plan.prices && plan.prices.length > 0) {
      for (const { price, raw: priceRaw } of plan.prices) {
        if (price.id) {
          console.log(
            `   ⏭️  Price ${price.interval}/${price.currency} already exists (${price.id})`
          );
          skippedPrices++;
          continue;
        }

        try {
          console.log(
            `   🔄 Creating price ${price.amount / 100} ${price.currency}/${
              price.interval
            }...`
          );

          const stripePrice = await stripe.prices.create({
            product: productId,
            unit_amount: price.amount,
            currency: price.currency.toLowerCase(),
            recurring: {
              interval: price.interval,
            },
          });

          console.log(`   ✅ Created price (${stripePrice.id})`);

          // Add price id to price object
          const updatedPriceRaw = priceRaw.replace(
            /\{/,
            `{\n          id: "${stripePrice.id}",`
          );
          updatedPlanRaw = updatedPlanRaw.replace(priceRaw, updatedPriceRaw);
          pricesCreated++;
        } catch (error) {
          console.error(
            `   ❌ Failed to create price ${price.interval}/${price.currency}:`,
            error.message
          );
        }
      }
    }

    // Update content with modified plan
    if (updatedPlanRaw !== raw) {
      updatedContent = updatedContent.replace(raw, updatedPlanRaw);
    }
  }

  // Write updated content back to file
  if (productsCreated > 0 || pricesCreated > 0) {
    fs.writeFileSync(billingConfigPath, updatedContent);
    console.log(
      `\n📝 Updated billing.config.ts with ${productsCreated} product(s) and ${pricesCreated} price(s)`
    );
  }

  console.log(`\n✅ Done!`);
  console.log(
    `   Products: ${productsCreated} created, ${skippedProducts} skipped`
  );
  console.log(`   Prices: ${pricesCreated} created, ${skippedPrices} skipped`);
}

async function main() {
  switch (command) {
    case "migrate":
      await migrate(databaseUrl);
      break;

    case "config":
      await config();
      break;

    case "push":
      await push();
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
