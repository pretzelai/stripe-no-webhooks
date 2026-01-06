const fs = require("fs");
const path = require("path");
const {
  createPrompt,
  question,
  questionHidden,
  saveToEnvFiles,
  getTemplatesDir,
  detectRouterType,
  createApiRoute,
  loadStripe,
} = require("./utils");

async function config(options = {}) {
  const {
    env = process.env,
    cwd = process.cwd(),
    logger = console,
    exitOnError = true,
    // For testing: inject Stripe class
    StripeClass = null,
  } = options;

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

  logger.log("\n🔧 Stripe Webhook Configuration\n");

  const { type: routerType, useSrc } = detectRouterType(cwd);
  const routerLabel = routerType === "app" ? "App Router" : "Pages Router";
  const srcLabel = useSrc ? " (src/)" : "";
  logger.log(`📂 Detected: ${routerLabel}${srcLabel}\n`);

  const existingStripeKey = env.STRIPE_SECRET_KEY || "";
  const stripeSecretKey = await questionHidden(
    null,
    "Enter your Stripe Secret Key (sk_...)",
    existingStripeKey
  );

  if (!stripeSecretKey || !stripeSecretKey.startsWith("sk_")) {
    logger.error("❌ Invalid Stripe Secret Key. It should start with 'sk_'");
    if (exitOnError) process.exit(1);
    return { success: false, error: "Invalid Stripe Secret Key" };
  }

  const rl = createPrompt();

  const defaultSiteUrl = env.NEXT_PUBLIC_SITE_URL || "";
  const siteUrl = await question(rl, "Enter your site URL", defaultSiteUrl);

  if (!siteUrl) {
    logger.error("❌ Site URL is required");
    rl.close();
    if (exitOnError) process.exit(1);
    return { success: false, error: "Site URL is required" };
  }

  let webhookUrl;
  try {
    const url = new URL(siteUrl);
    webhookUrl = `${url.origin}/api/stripe/webhook`;
  } catch (e) {
    logger.error("❌ Invalid URL format");
    rl.close();
    if (exitOnError) process.exit(1);
    return { success: false, error: "Invalid URL format" };
  }

  let databaseUrlInput = "";
  if (env.DATABASE_URL) {
    logger.log("✓ DATABASE_URL already set in environment");
    databaseUrlInput = env.DATABASE_URL;
  } else {
    databaseUrlInput = await question(
      rl,
      "Enter your DATABASE_URL (optional, press Enter to skip)",
      ""
    );
  }

  rl.close();

  logger.log(`📁 Creating API route...`);
  try {
    const createdFile = createApiRoute(routerType, useSrc, cwd);
    logger.log(`✅ Created ${createdFile}`);
  } catch (error) {
    logger.error("❌ Failed to create API route:", error.message);
    if (exitOnError) process.exit(1);
    return { success: false, error: error.message };
  }

  logger.log(`📁 Creating billing.config.ts...`);
  try {
    const billingConfigPath = path.join(cwd, "billing.config.ts");
    if (!fs.existsSync(billingConfigPath)) {
      const templatePath = path.join(getTemplatesDir(), "billing.config.ts");
      const template = fs.readFileSync(templatePath, "utf8");
      fs.writeFileSync(billingConfigPath, template);
      logger.log(`✅ Created billing.config.ts\n`);
    } else {
      logger.log(`✓ billing.config.ts already exists\n`);
    }
  } catch (error) {
    logger.error("❌ Failed to create billing.config.ts:", error.message);
    if (exitOnError) process.exit(1);
    return { success: false, error: error.message };
  }

  logger.log(`📡 Creating webhook endpoint: ${webhookUrl}\n`);

  const stripe = new Stripe(stripeSecretKey);

  try {
    const existingWebhooks = await stripe.webhookEndpoints.list({ limit: 100 });
    const existingWebhook = existingWebhooks.data.find(
      (wh) => wh.url === webhookUrl
    );

    if (existingWebhook) {
      logger.log(`🔄 Found existing webhook with same URL, deleting it...`);
      await stripe.webhookEndpoints.del(existingWebhook.id);
      logger.log(`✅ Deleted existing webhook (${existingWebhook.id})\n`);
    }

    logger.log(`🔄 Creating new webhook endpoint...`);
    const webhook = await stripe.webhookEndpoints.create({
      url: webhookUrl,
      enabled_events: ["*"],
      description: "Created by stripe-no-webhooks CLI",
    });
    logger.log("✅ Webhook created successfully!\n");

    const envVars = [
      { key: "STRIPE_SECRET_KEY", value: stripeSecretKey },
      { key: "STRIPE_WEBHOOK_SECRET", value: webhook.secret },
      { key: "NEXT_PUBLIC_SITE_URL", value: siteUrl },
    ];
    if (databaseUrlInput) {
      envVars.push({ key: "DATABASE_URL", value: databaseUrlInput });
    }

    const updatedFiles = saveToEnvFiles(envVars, cwd);

    const envVarNames = envVars.map((v) => v.key).join(", ");
    if (updatedFiles.length > 0) {
      logger.log(`📝 Updated ${updatedFiles.join(", ")} with ${envVarNames}`);
      logger.log("\nREMEMBER: Update the environment variables in Vercel too:");
      for (const { key, value } of envVars) {
        logger.log(`${key}=${value}`);
      }
    } else {
      logger.log("Add these to your environment variables:\n");
      for (const { key, value } of envVars) {
        logger.log(`${key}=${value}`);
      }
    }

    logger.log("─".repeat(50));
    logger.log("Webhook ID:", webhook.id);
    logger.log("Webhook URL:", webhook.url);
    logger.log("Events: All events (*)");
    if (updatedFiles.length === 0) {
      logger.log("Secret:", webhook.secret);
    }
    logger.log("─".repeat(50));

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
