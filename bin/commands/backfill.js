const { Pool } = require("pg");
const Stripe = require("stripe").default;
const {
  questionHidden,
  isValidStripeKey,
  getMode,
  saveToEnvFiles,
  createPrompt,
  question,
} = require("./helpers/utils");
const {
  SYNC_ORDER,
  REQUIRED_TABLES,
  FIELD_MAPS,
  SYNC_OBJECTS,
} = require("./helpers/backfill-maps");

// Rate limiting - Stripe allows 100 req/s live, 25 req/s test - we use 20 to be safe
const REQUESTS_PER_SECOND = 20;
const MIN_REQUEST_INTERVAL_MS = 1000 / REQUESTS_PER_SECOND;
const BATCH_SIZE = 100;
const MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY_MS = 2000;

let lastRequestTime = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rateLimitedRequest(fn) {
  const wait = MIN_REQUEST_INTERVAL_MS - (Date.now() - lastRequestTime);
  if (wait > 0) await sleep(wait);
  lastRequestTime = Date.now();
  return fn();
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

// Tables that have an updated_at column
const TABLES_WITH_UPDATED_AT = [
  "customers",
  "products",
  "prices",
  "subscriptions",
  "invoices",
  "charges",
  "coupons",
  "plans",
  "refunds",
  "disputes",
  "subscription_schedules",
  "credit_notes",
  "checkout_sessions",
];

async function upsertRecord(pool, table, record, logger) {
  const columns = Object.keys(record);
  const values = Object.values(record);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
  const updateSet = columns
    .filter((c) => c !== "id")
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(", ");

  // Only add updated_at for tables that have the column
  const updatedAtClause = TABLES_WITH_UPDATED_AT.includes(table)
    ? ", updated_at = NOW()"
    : "";

  try {
    await pool.query(
      `INSERT INTO stripe.${table} (${columns.join(
        ", "
      )}) VALUES (${placeholders}) ON CONFLICT (id) DO UPDATE SET ${updateSet}${updatedAtClause}`,
      values
    );
    return true;
  } catch (error) {
    logger.log(`   ⚠️  Failed to upsert ${record.id}: ${error.message}`);
    return false;
  }
}

// Tables that DON'T have a livemode column
const TABLES_WITHOUT_LIVEMODE = ["setup_intents", "payment_methods"];

function transformStripeObject(obj, table) {
  const record = { id: obj.id };

  // Common fields
  for (const f of ["object", "created"]) if (obj[f] !== undefined) record[f] = obj[f];
  // livemode only for tables that have the column
  if (!TABLES_WITHOUT_LIVEMODE.includes(table) && obj.livemode !== undefined) {
    record.livemode = obj.livemode;
  }
  if (obj.metadata !== undefined)
    record.metadata = JSON.stringify(obj.metadata);

  // Table-specific fields
  const fields = FIELD_MAPS[table] || [];
  for (const [stripeField, dbField, isRef, isJson] of fields) {
    const val = obj[stripeField];
    if (val === undefined) continue;
    const key = dbField || stripeField;
    if (isRef) record[key] = typeof val === "string" ? val : val?.id;
    else if (isJson) record[key] = JSON.stringify(val);
    else record[key] = val;
  }

  return record;
}

async function syncResource(
  stripe,
  pool,
  { table, label, stripeMethod },
  logger
) {
  let synced = 0,
    failed = 0,
    hasMore = true,
    startingAfter = null,
    pageCount = 0;

  const methodParts = stripeMethod.split(".");
  let stripeResource = stripe;
  for (const part of methodParts) stripeResource = stripeResource[part];

  while (hasMore) {
    pageCount++;
    const params = { limit: BATCH_SIZE };
    if (startingAfter) params.starting_after = startingAfter;

    let response,
      retries = 0;
    while (retries < MAX_RETRIES) {
      try {
        response = await rateLimitedRequest(() => stripeResource.list(params));
        break;
      } catch (error) {
        retries++;
        if (retries >= MAX_RETRIES) throw error;
        const isRateLimit =
          error.statusCode === 429 ||
          error.message?.toLowerCase().includes("rate limit");
        const delay = isRateLimit
          ? INITIAL_RETRY_DELAY_MS * Math.pow(2, retries - 1)
          : INITIAL_RETRY_DELAY_MS;
        logger.log(
          `   ⚠️  ${
            isRateLimit ? "Rate limited" : error.message
          }. Retry ${retries}/${MAX_RETRIES} in ${delay / 1000}s...`
        );
        await sleep(delay);
      }
    }

    hasMore = response.has_more;
    if (response.data.length) {
      startingAfter = response.data[response.data.length - 1].id;
      for (const item of response.data) {
        (await upsertRecord(
          pool,
          table,
          transformStripeObject(item, table),
          logger
        ))
          ? synced++
          : failed++;
      }
      process.stdout.write(
        `\r   📥 Page ${pageCount}: ${synced} synced${
          failed ? `, ${failed} failed` : ""
        }...`
      );
    }
  }
  process.stdout.write("\r" + " ".repeat(60) + "\r");
  return { synced, failed };
}

async function backfill(objectType, options = {}) {
  const { env = process.env, logger = console, exitOnError = true } = options;

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

  logger.log(`\n🚀 Starting Stripe backfill (${mode} mode)...`);
  logger.log(`   Syncing: ${syncObject}`);
  logger.log(`   Rate limit: ${REQUESTS_PER_SECOND} requests/second\n`);

  const stripe = new Stripe(stripeSecretKey);
  const pool = new Pool({ connectionString: databaseUrl });
  const startTime = Date.now();
  const results = {},
    errors = [];

  try {
    const resources =
      syncObject === "all"
        ? SYNC_ORDER
        : SYNC_ORDER.filter((r) => r.key === syncObject);

    for (let i = 0; i < resources.length; i++) {
      const config = resources[i];
      const progress = `[${i + 1}/${resources.length}]`;
      logger.log(`${progress} 🔄 Syncing ${config.label}...`);

      try {
        const { synced, failed } = await syncResource(
          stripe,
          pool,
          config,
          logger
        );
        results[config.key] = { synced, failed };
        logger.log(
          `${progress} ${failed ? "⚠️ " : "✅"} ${
            config.label
          }: ${synced} synced${failed ? `, ${failed} failed` : ""}`
        );
      } catch (error) {
        errors.push({ resource: config.label, error: error.message });
        logger.log(`${progress} ❌ ${config.label}: Failed - ${error.message}`);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    let totalSynced = 0,
      totalFailed = 0;
    for (const v of Object.values(results)) {
      totalSynced += v.synced || 0;
      totalFailed += v.failed || 0;
    }

    logger.log("\n" + "=".repeat(50));
    logger.log("📊 Backfill Summary");
    logger.log("=".repeat(50));
    logger.log(
      `   Resources: ${Object.keys(results).length}/${resources.length}`
    );
    logger.log(`   Objects synced: ${totalSynced}`);
    if (totalFailed) logger.log(`   Objects failed: ${totalFailed}`);
    if (errors.length) {
      logger.log(`\n❌ Resource errors (${errors.length}):`);
      for (const { resource, error } of errors)
        logger.log(`   - ${resource}: ${error}`);
    }
    logger.log(`\n⏱️  Completed in ${elapsed}s`);
    logger.log(
      errors.length === 0 && totalFailed === 0
        ? "✅ Backfill completed successfully!\n"
        : "⚠️  Backfill completed with issues.\n"
    );

    await pool.end();
    return {
      success: errors.length < resources.length,
      results,
      errors,
      stats: {
        totalSynced,
        totalFailed,
        successCount: Object.keys(results).length,
        totalResources: resources.length,
      },
    };
  } catch (error) {
    logger.error("\n❌ Backfill failed unexpectedly:", error.message);
    try {
      await pool.end();
    } catch {}
    if (exitOnError) process.exit(1);
    return { success: false, error: error.message };
  }
}

module.exports = { backfill, SYNC_OBJECTS };
