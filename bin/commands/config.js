const fs = require("fs");
const path = require("path");
const {
  createPrompt,
  question,
  questionHidden,
  saveToEnvFiles,
  getTemplatesDir,
  detectRouterType,
  isValidStripeKey,
  loadStripe,
} = require("./helpers/utils");
const { setupDev } = require("./helpers/dev-webhook-listener");

async function config(options = {}) {
  const {
    env = process.env,
    cwd = process.cwd(),
    logger = console,
    exitOnError = true,
    StripeClass = null,
  } = options;

  let Stripe = StripeClass || loadStripe();
  if (!Stripe) {
    logger.error("❌ Stripe package not found.");
    logger.log("Please install it first: npm install stripe");
    if (exitOnError) process.exit(1);
    return { success: false, error: "Stripe package not found" };
  }

  logger.log("\n🔧 Stripe Webhook Configuration\n");

  const { type: routerType, useSrc } = detectRouterType(cwd);
  const routerLabel = routerType === "app" ? "App Router" : "Pages Router";
  logger.log(`📂 Detected: ${routerLabel}${useSrc ? " (src/)" : ""}\n`);

  // Check for existing valid Stripe key
  const existingStripeKey = env.STRIPE_SECRET_KEY || "";
  let stripeSecretKey;

  if (isValidStripeKey(existingStripeKey)) {
    logger.log("✓ STRIPE_SECRET_KEY already set in environment");
    stripeSecretKey = existingStripeKey;
  } else {
    stripeSecretKey = await questionHidden(
      null,
      "Enter your Stripe Secret Key (sk_...)",
      existingStripeKey
    );
    if (!isValidStripeKey(stripeSecretKey)) {
      logger.error(
        "❌ Invalid Stripe Secret Key. It should start with 'sk_' or 'rk_'"
      );
      if (exitOnError) process.exit(1);
      return { success: false, error: "Invalid Stripe Secret Key" };
    }
  }

  // Check for existing site URL
  const existingSiteUrl = env.NEXT_PUBLIC_SITE_URL || "";
  let siteUrl;

  if (existingSiteUrl) {
    try {
      new URL(existingSiteUrl);
      logger.log("✓ NEXT_PUBLIC_SITE_URL already set in environment");
      siteUrl = existingSiteUrl;
    } catch {
      const rl = createPrompt();
      siteUrl = await question(rl, "Enter your site URL", "");
      rl.close();
    }
  } else {
    const rl = createPrompt();
    siteUrl = await question(rl, "Enter your site URL", "");
    rl.close();
  }

  if (!siteUrl) {
    logger.error("❌ Site URL is required");
    if (exitOnError) process.exit(1);
    return { success: false, error: "Site URL is required" };
  }

  let webhookUrl;
  try {
    webhookUrl = `${new URL(siteUrl).origin}/api/stripe/webhook`;
  } catch {
    logger.error("❌ Invalid URL format");
    if (exitOnError) process.exit(1);
    return { success: false, error: "Invalid URL format" };
  }

  // Check for existing DATABASE_URL
  let databaseUrlInput = "";
  if (env.DATABASE_URL) {
    logger.log("✓ DATABASE_URL already set in environment");
    databaseUrlInput = env.DATABASE_URL;
  } else {
    const rl = createPrompt();
    databaseUrlInput = await question(
      rl,
      "Enter your DATABASE_URL (optional, press Enter to skip)",
      ""
    );
    rl.close();
  }

  const templatesDir = getTemplatesDir();
  const baseDir = path.join(cwd, useSrc ? "src" : "");
  const prefix = useSrc ? "src/" : "";

  // Create lib/stripe.ts (idempotent)
  logger.log(`\n📁 Setting up lib/stripe.ts...`);
  try {
    const libStripePath = path.join(baseDir, "lib", "stripe.ts");
    const libStripeRelative = `${prefix}lib/stripe.ts`;
    if (fs.existsSync(libStripePath)) {
      logger.log(`✓ ${libStripeRelative} already exists`);
    } else {
      fs.mkdirSync(path.dirname(libStripePath), { recursive: true });
      fs.writeFileSync(
        libStripePath,
        fs.readFileSync(path.join(templatesDir, "lib-stripe.ts"), "utf8")
      );
      logger.log(`✅ Created ${libStripeRelative}`);
    }
  } catch (error) {
    logger.error("❌ Failed to create lib/stripe.ts:", error.message);
    if (exitOnError) process.exit(1);
    return { success: false, error: error.message };
  }

  // Create API route (idempotent)
  logger.log(`📁 Setting up API route...`);
  try {
    const isApp = routerType === "app";
    const routeRelPath = isApp
      ? "app/api/stripe/[...all]/route.ts"
      : "pages/api/stripe/[...all].ts";
    const routePath = path.join(baseDir, routeRelPath);
    const routeRelative = `${prefix}${routeRelPath}`;
    if (fs.existsSync(routePath)) {
      logger.log(`✓ ${routeRelative} already exists`);
    } else {
      const templateName = isApp ? "app-router.ts" : "pages-router.ts";
      const commentPattern = isApp
        ? /^\/\/ app\/api\/stripe\/\[\.\.\.all\]\/route\.ts\n/
        : /^\/\/ pages\/api\/stripe\/\[\.\.\.all\]\.ts\n/;
      const template = fs
        .readFileSync(path.join(templatesDir, templateName), "utf8")
        .replace(commentPattern, "");
      fs.mkdirSync(path.dirname(routePath), { recursive: true });
      fs.writeFileSync(routePath, template);
      logger.log(`✅ Created ${routeRelative}`);
    }
  } catch (error) {
    logger.error("❌ Failed to create API route:", error.message);
    if (exitOnError) process.exit(1);
    return { success: false, error: error.message };
  }

  // Create billing.config.ts (idempotent)
  logger.log(`📁 Setting up billing.config.ts...`);
  try {
    const billingConfigPath = path.join(cwd, "billing.config.ts");
    if (fs.existsSync(billingConfigPath)) {
      logger.log(`✓ billing.config.ts already exists`);
    } else {
      fs.writeFileSync(
        billingConfigPath,
        fs.readFileSync(path.join(templatesDir, "billing.config.ts"), "utf8")
      );
      logger.log(`✅ Created billing.config.ts`);
    }
  } catch (error) {
    logger.error("❌ Failed to create billing.config.ts:", error.message);
    if (exitOnError) process.exit(1);
    return { success: false, error: error.message };
  }

  // Check for existing webhook endpoint
  logger.log(`\n📡 Setting up webhook endpoint: ${webhookUrl}`);

  const stripe = new Stripe(stripeSecretKey);
  let webhook;
  let webhookSecret = env.STRIPE_WEBHOOK_SECRET || "";

  try {
    const existingWebhooks = await stripe.webhookEndpoints.list({ limit: 100 });
    const existingWebhook = existingWebhooks.data.find(
      (wh) => wh.url === webhookUrl
    );

    if (existingWebhook && webhookSecret) {
      logger.log(`✓ Webhook endpoint already exists (${existingWebhook.id})`);
      webhook = existingWebhook;
    } else if (existingWebhook && !webhookSecret) {
      logger.log(`🔄 Webhook exists but secret not found, recreating...`);
      await stripe.webhookEndpoints.del(existingWebhook.id);
      webhook = await stripe.webhookEndpoints.create({
        url: webhookUrl,
        enabled_events: ["*"],
        description: "Created by stripe-no-webhooks CLI",
      });
      webhookSecret = webhook.secret;
      logger.log("✅ Webhook recreated successfully!");
    } else {
      logger.log(`🔄 Creating new webhook endpoint...`);
      webhook = await stripe.webhookEndpoints.create({
        url: webhookUrl,
        enabled_events: ["*"],
        description: "Created by stripe-no-webhooks CLI",
      });
      webhookSecret = webhook.secret;
      logger.log("✅ Webhook created successfully!");
    }

    // Build env vars to save (only if values changed)
    const envVars = [];
    if (env.STRIPE_SECRET_KEY !== stripeSecretKey)
      envVars.push({ key: "STRIPE_SECRET_KEY", value: stripeSecretKey });
    if (env.STRIPE_WEBHOOK_SECRET !== webhookSecret)
      envVars.push({ key: "STRIPE_WEBHOOK_SECRET", value: webhookSecret });
    if (env.NEXT_PUBLIC_SITE_URL !== siteUrl)
      envVars.push({ key: "NEXT_PUBLIC_SITE_URL", value: siteUrl });
    if (databaseUrlInput && env.DATABASE_URL !== databaseUrlInput)
      envVars.push({ key: "DATABASE_URL", value: databaseUrlInput });

    if (envVars.length > 0) {
      const updatedFiles = saveToEnvFiles(envVars, cwd);
      const envVarNames = envVars.map((v) => v.key).join(", ");
      if (updatedFiles.length > 0) {
        logger.log(
          `\n📝 Updated ${updatedFiles.join(", ")} with ${envVarNames}`
        );
        logger.log(
          "\nREMEMBER: Update the environment variables in Vercel too:"
        );
        for (const { key, value } of envVars) logger.log(`${key}=${value}`);
      } else {
        logger.log("\nAdd these to your environment variables:\n");
        for (const { key, value } of envVars) logger.log(`${key}=${value}`);
      }
    } else {
      logger.log("\n✓ All environment variables already configured");
    }

    logger.log("\n" + "─".repeat(50));
    logger.log("Webhook ID:", webhook.id);
    logger.log("Webhook URL:", webhook.url || webhookUrl);
    logger.log("Events: All events (*)");
    logger.log("─".repeat(50));

    // Setup dev scripts
    logger.log("\n📦 Setting up development scripts...");
    await setupDev({ cwd, logger, exitOnError: false });

    return { success: true, webhook };
  } catch (error) {
    if (error.type === "StripeAuthenticationError") {
      logger.error("❌ Authentication failed. Check your Stripe Secret Key.");
    } else if (error.type === "StripeInvalidRequestError") {
      logger.error("❌ Invalid request:", error.message);
    } else {
      logger.error("❌ Failed to create webhook:");
      logger.error(error.message);
    }
    if (exitOnError) process.exit(1);
    return { success: false, error: error.message };
  }
}

module.exports = { config };
