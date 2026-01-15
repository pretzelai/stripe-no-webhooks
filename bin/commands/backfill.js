const { Pool } = require("pg");
const { StripeSync } = require("@pretzelai/stripe-sync-engine");
const {
  questionHidden,
  isValidStripeKey,
  getMode,
  saveToEnvFiles,
  createPrompt,
  question,
} = require("./helpers/utils");
const { SYNC_OBJECTS, REQUIRED_TABLES } = require("./helpers/backfill-maps");

// Map our CLI object names to library's SyncObject type
const CLI_TO_LIBRARY_MAP = {
  checkout_session: "checkout_sessions",
  subscription_schedule: "subscription_schedules",
};

function mapObjectType(cliType) {
  return CLI_TO_LIBRARY_MAP[cliType] || cliType;
}

async function checkDatabaseConnection(connectionString) {
  const pool = new Pool({ connectionString });
  try {
    const client = await pool.connect();
    client.release();
    await pool.end();
    return { success: true };
  } catch (error) {
    try {
      await pool.end();
    } catch {}
    return { success: false, error: error.message };
  }
}

async function checkTablesExist(connectionString) {
  const pool = new Pool({ connectionString });
  try {
    const client = await pool.connect();
    const schema = await client.query(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'stripe'`
    );
    if (!schema.rows.length) {
      client.release();
      await pool.end();
      return { success: false, error: "schema_missing" };
    }

    const tables = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'stripe' AND table_name = ANY($1)`,
      [REQUIRED_TABLES]
    );
    client.release();
    await pool.end();

    const existing = tables.rows.map((r) => r.table_name);
    const missing = REQUIRED_TABLES.filter((t) => !existing.includes(t));
    return missing.length
      ? { success: false, error: "tables_missing", missingTables: missing }
      : { success: true };
  } catch (error) {
    try {
      await pool.end();
    } catch {}
    return { success: false, error: error.message };
  }
}

// All object types in sync order (matching library's syncBackfill order)
const ALL_OBJECT_TYPES = [
  "product",
  "price",
  "plan",
  "customer",
  "subscription",
  "subscription_schedule",
  "invoice",
  "charge",
  "setup_intent",
  "payment_method",
  "payment_intent",
  "credit_note",
  "dispute",
  "refund",
  "checkout_session",
];

async function backfill(objectType, options = {}) {
  const { env = process.env, logger = console, exitOnError = true, since, skip } = options;

  // Step 1: Get DATABASE_URL
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
    const updated = saveToEnvFiles([
      { key: "DATABASE_URL", value: databaseUrl },
    ]);
    if (updated.length)
      logger.log(`\n📝 Saved DATABASE_URL to ${updated.join(", ")}`);
    env.DATABASE_URL = databaseUrl;
  }

  // Step 2: Test connection
  logger.log("\n🔌 Checking database connection...");
  const connResult = await checkDatabaseConnection(databaseUrl);
  if (!connResult.success) {
    logger.error(`❌ Failed to connect to database: ${connResult.error}`);
    if (exitOnError) process.exit(1);
    return {
      success: false,
      error: `Database connection failed: ${connResult.error}`,
    };
  }
  logger.log("✅ Database connection successful.");

  // Step 3: Check migrations
  logger.log("\n🔍 Checking if migrations have been run...");
  const tablesResult = await checkTablesExist(databaseUrl);
  if (!tablesResult.success) {
    if (tablesResult.error === "schema_missing") {
      logger.error(
        "\n❌ The 'stripe' schema does not exist.\n\nPlease run migrations first:\n  npx stripe-no-webhooks migrate"
      );
    } else if (tablesResult.error === "tables_missing") {
      logger.error(
        `\n❌ Required tables are missing: ${tablesResult.missingTables.join(
          ", "
        )}\n\nPlease run migrations first:\n  npx stripe-no-webhooks migrate`
      );
    } else {
      logger.error(`\n❌ Failed to check tables: ${tablesResult.error}`);
    }
    if (exitOnError) process.exit(1);
    return {
      success: false,
      error:
        tablesResult.error === "schema_missing"
          ? "Stripe schema not found. Run migrate first."
          : tablesResult.error,
    };
  }
  logger.log("✅ Stripe schema and tables found.");

  // Step 4: Get Stripe key
  let stripeSecretKey = env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey)
    stripeSecretKey = await questionHidden(
      null,
      "\nEnter your Stripe Secret Key (sk_...)"
    );

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

  // Step 5: Validate object type
  const syncObject = objectType || "all";
  if (!SYNC_OBJECTS.includes(syncObject)) {
    logger.error(
      `❌ Invalid object type: ${syncObject}\n\nValid types: ${SYNC_OBJECTS.join(
        ", "
      )}`
    );
    if (exitOnError) process.exit(1);
    return { success: false, error: `Invalid object type: ${syncObject}` };
  }

  // Parse --since date filter if provided
  let createdFilter;
  if (since) {
    const sinceDate = new Date(since);
    if (isNaN(sinceDate.getTime())) {
      logger.error(`❌ Invalid date format: ${since}. Use YYYY-MM-DD (e.g., 2024-01-01)`);
      if (exitOnError) process.exit(1);
      return { success: false, error: "Invalid date format" };
    }
    createdFilter = { gte: Math.floor(sinceDate.getTime() / 1000) };
  }

  // Parse --skip option
  const skipTypes = skip ? skip.split(",").map((s) => s.trim().toLowerCase()) : [];

  // Step 6: Create StripeSync instance and run backfill
  logger.log(`\n🚀 Starting Stripe backfill (${mode} mode)...`);
  logger.log(`   Syncing: ${syncObject}`);
  if (since) {
    logger.log(`   Since: ${since}`);
  }
  if (skipTypes.length) {
    logger.log(`   Skipping: ${skipTypes.join(", ")}`);
  }
  logger.log("");

  const sync = new StripeSync({
    poolConfig: { connectionString: databaseUrl },
    stripeSecretKey,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || "not-needed-for-backfill",
    schema: "stripe",
  });

  const startTime = Date.now();

  try {
    let result;

    // If syncing 'all' with skip types, sync each type individually
    if (syncObject === "all" && skipTypes.length > 0) {
      result = {};
      const typesToSync = ALL_OBJECT_TYPES.filter(
        (t) => !skipTypes.includes(t) && !skipTypes.includes(t.replace("_", ""))
      );

      for (const objType of typesToSync) {
        const libraryType = mapObjectType(objType);
        logger.log(`🔄 Syncing ${objType}...`);
        try {
          const typeResult = await sync.syncBackfill({
            object: libraryType,
            ...(createdFilter && { created: createdFilter }),
          });
          // Merge results
          Object.assign(result, typeResult);
        } catch (err) {
          logger.log(`⚠️  ${objType}: ${err.message}`);
        }
      }
    } else {
      // Standard sync without skip
      const libraryObjectType = mapObjectType(syncObject);
      result = await sync.syncBackfill({
        object: libraryObjectType,
        ...(createdFilter && { created: createdFilter }),
      });
    }

    // Log results
    const results = {};
    let totalSynced = 0;

    // Pretty labels for each object type
    const labels = {
      products: "Products",
      prices: "Prices",
      plans: "Plans",
      customers: "Customers",
      subscriptions: "Subscriptions",
      subscriptionSchedules: "Subscription Schedules",
      invoices: "Invoices",
      charges: "Charges",
      setupIntents: "Setup Intents",
      paymentMethods: "Payment Methods",
      paymentIntents: "Payment Intents",
      taxIds: "Tax IDs",
      creditNotes: "Credit Notes",
      disputes: "Disputes",
      earlyFraudWarnings: "Early Fraud Warnings",
      refunds: "Refunds",
      checkoutSessions: "Checkout Sessions",
    };

    for (const [key, value] of Object.entries(result)) {
      if (value?.synced !== undefined) {
        results[key] = { synced: value.synced, failed: 0 };
        totalSynced += value.synced;
        const label = labels[key] || key;
        logger.log(`✅ ${label}: ${value.synced} synced`);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.log("\n" + "=".repeat(50));
    logger.log("📊 Backfill Summary");
    logger.log("=".repeat(50));
    logger.log(`   Objects synced: ${totalSynced}`);
    logger.log(`\n⏱️  Completed in ${elapsed}s`);
    logger.log("✅ Backfill completed successfully!\n");

    return {
      success: true,
      results,
      stats: {
        totalSynced,
        totalFailed: 0,
      },
    };
  } catch (error) {
    logger.error(`\n❌ Backfill failed: ${error.message}`);
    if (exitOnError) process.exit(1);
    return { success: false, error: error.message };
  } finally {
    await sync.close();
  }
}

module.exports = { backfill, SYNC_OBJECTS };
