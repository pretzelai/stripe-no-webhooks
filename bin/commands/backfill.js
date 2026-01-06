const { Client } = require("pg");
const { StripeSync } = require("@supabase/stripe-sync-engine");
const {
  questionHidden,
  isValidStripeKey,
  getMode,
  saveToEnvFiles,
  createPrompt,
  question,
} = require("./helpers/utils");

const SYNC_OBJECTS = [
  "all",
  "charge",
  "checkout_sessions",
  "credit_note",
  "customer",
  "customer_with_entitlements",
  "dispute",
  "early_fraud_warning",
  "invoice",
  "payment_intent",
  "payment_method",
  "plan",
  "price",
  "product",
  "refund",
  "setup_intent",
  "subscription",
  "subscription_schedules",
  "tax_id",
];

const REQUIRED_TABLES = [
  "active_entitlements",
  "charges",
  "checkout_session_line_items",
  "checkout_sessions",
  "coupons",
  "credit_notes",
  "customers",
  "disputes",
  "early_fraud_warnings",
  "events",
  "features",
  "invoices",
  "migrations",
  "payment_intents",
  "payment_methods",
  "payouts",
  "plans",
  "prices",
  "products",
  "refunds",
  "reviews",
  "setup_intents",
  "subscription_items",
  "subscription_schedules",
  "subscriptions",
  "tax_ids",
  "user_stripe_customer_map",
];

async function checkDatabaseConnection(connectionString, logger) {
  const client = new Client({ connectionString });
  try {
    await client.connect();
    await client.end();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function checkTablesExist(connectionString, logger) {
  const client = new Client({ connectionString });
  try {
    await client.connect();

    // Check if stripe schema exists
    const schemaResult = await client.query(`
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name = 'stripe'
    `);

    if (schemaResult.rows.length === 0) {
      await client.end();
      return { success: false, error: "schema_missing" };
    }

    // Check if required tables exist
    const tablesResult = await client.query(
      `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'stripe'
        AND table_name = ANY($1)
    `,
      [REQUIRED_TABLES]
    );

    await client.end();

    const existingTables = tablesResult.rows.map((r) => r.table_name);
    const missingTables = REQUIRED_TABLES.filter(
      (t) => !existingTables.includes(t)
    );

    if (missingTables.length > 0) {
      return { success: false, error: "tables_missing", missingTables };
    }

    return { success: true };
  } catch (error) {
    try {
      await client.end();
    } catch {}
    return { success: false, error: error.message };
  }
}

async function backfill(objectType, options = {}) {
  const { env = process.env, logger = console, exitOnError = true } = options;

  // Step 1: Check DATABASE_URL, prompt if missing
  let databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    logger.log("📝 DATABASE_URL not found in environment.\n");
    const rl = createPrompt();
    databaseUrl = await question(rl, "Enter your PostgreSQL connection string");
    rl.close();

    if (!databaseUrl) {
      logger.error("❌ Database URL is required.");
      if (exitOnError) process.exit(1);
      return { success: false, error: "Missing DATABASE_URL" };
    }

    // Save to env files
    const updatedFiles = saveToEnvFiles([
      { key: "DATABASE_URL", value: databaseUrl },
    ]);
    if (updatedFiles.length > 0) {
      logger.log(`\n📝 Saved DATABASE_URL to ${updatedFiles.join(", ")}`);
    }
    // Also set in current process
    env.DATABASE_URL = databaseUrl;
  }

  // Step 2: Test database connection
  logger.log("\n🔌 Checking database connection...");
  const connectionResult = await checkDatabaseConnection(databaseUrl, logger);
  if (!connectionResult.success) {
    logger.error(`❌ Failed to connect to database: ${connectionResult.error}`);
    if (exitOnError) process.exit(1);
    return {
      success: false,
      error: `Database connection failed: ${connectionResult.error}`,
    };
  }
  logger.log("✅ Database connection successful.");

  // Step 3: Check if migrations have been run
  logger.log("\n🔍 Checking if migrations have been run...");
  const tablesResult = await checkTablesExist(databaseUrl, logger);
  if (!tablesResult.success) {
    if (tablesResult.error === "schema_missing") {
      logger.error("\n❌ The 'stripe' schema does not exist.");
      logger.log("\nPlease run migrations first:");
      logger.log("  npx stripe-no-webhooks migrate");
      if (exitOnError) process.exit(1);
      return {
        success: false,
        error: "Stripe schema not found. Run migrate first.",
      };
    }
    if (tablesResult.error === "tables_missing") {
      logger.error(
        "\n❌ Required tables are missing from the 'stripe' schema."
      );
      logger.log(`   Missing: ${tablesResult.missingTables.join(", ")}`);
      logger.log("\nPlease run migrations first:");
      logger.log("  npx stripe-no-webhooks migrate");
      if (exitOnError) process.exit(1);
      return {
        success: false,
        error: "Required tables missing. Run migrate first.",
      };
    }
    logger.error(`\n❌ Failed to check tables: ${tablesResult.error}`);
    if (exitOnError) process.exit(1);
    return { success: false, error: tablesResult.error };
  }
  logger.log("✅ Stripe schema and tables found.");

  // Step 4: Get Stripe API key
  let stripeSecretKey = env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    stripeSecretKey = await questionHidden(
      null,
      "\nEnter your Stripe Secret Key (sk_...)"
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

  const syncObject = objectType || "all";

  if (!SYNC_OBJECTS.includes(syncObject)) {
    logger.error(`❌ Invalid object type: ${syncObject}`);
    logger.log(`\nValid object types: ${SYNC_OBJECTS.join(", ")}`);
    if (exitOnError) process.exit(1);
    return { success: false, error: `Invalid object type: ${syncObject}` };
  }

  logger.log(`\n🚀 Starting Stripe backfill (${mode} mode)...`);
  logger.log(`   Syncing: ${syncObject}\n`);

  const sync = new StripeSync({
    poolConfig: { connectionString: databaseUrl },
    schema: "stripe",
    stripeSecretKey,
    stripeWebhookSecret: "", // Not needed for backfill
    backfillRelatedEntities: true,
  });

  try {
    const startTime = Date.now();
    const result = await sync.syncBackfill({
      object: syncObject,
      backfillRelatedEntities: true,
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    logger.log("✅ Backfill completed!\n");
    logger.log("📊 Summary:");

    const entries = Object.entries(result);
    if (entries.length === 0) {
      logger.log("   No objects synced.");
    } else {
      for (const [key, value] of entries) {
        if (value && value.synced !== undefined) {
          logger.log(`   ${key}: ${value.synced} synced`);
        }
      }
    }

    logger.log(`\n⏱️  Completed in ${elapsed}s`);

    await sync.close();

    return { success: true, result };
  } catch (error) {
    logger.error("❌ Backfill failed:", error.message);
    await sync.close();
    if (exitOnError) process.exit(1);
    return { success: false, error: error.message };
  }
}

module.exports = { backfill, SYNC_OBJECTS };
