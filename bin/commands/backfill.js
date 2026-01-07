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

const SYNC_OBJECTS = [
  "all",
  "charge",
  "checkout_session",
  "coupon",
  "credit_note",
  "customer",
  "dispute",
  "invoice",
  "payment_intent",
  "payment_method",
  "plan",
  "price",
  "product",
  "refund",
  "setup_intent",
  "subscription",
  "subscription_schedule",
];

// Order matters: sync dependencies first (products before prices, customers before subscriptions)
const SYNC_ORDER = [
  { key: "product", table: "products", label: "Products", stripeMethod: "products" },
  { key: "price", table: "prices", label: "Prices", stripeMethod: "prices" },
  { key: "coupon", table: "coupons", label: "Coupons", stripeMethod: "coupons" },
  { key: "plan", table: "plans", label: "Plans", stripeMethod: "plans" },
  { key: "customer", table: "customers", label: "Customers", stripeMethod: "customers" },
  { key: "subscription", table: "subscriptions", label: "Subscriptions", stripeMethod: "subscriptions" },
  { key: "subscription_schedule", table: "subscription_schedules", label: "Subscription Schedules", stripeMethod: "subscriptionSchedules" },
  { key: "invoice", table: "invoices", label: "Invoices", stripeMethod: "invoices" },
  { key: "charge", table: "charges", label: "Charges", stripeMethod: "charges" },
  { key: "payment_intent", table: "payment_intents", label: "Payment Intents", stripeMethod: "paymentIntents" },
  { key: "payment_method", table: "payment_methods", label: "Payment Methods", stripeMethod: "paymentMethods" },
  { key: "setup_intent", table: "setup_intents", label: "Setup Intents", stripeMethod: "setupIntents" },
  { key: "refund", table: "refunds", label: "Refunds", stripeMethod: "refunds" },
  { key: "dispute", table: "disputes", label: "Disputes", stripeMethod: "disputes" },
  { key: "credit_note", table: "credit_notes", label: "Credit Notes", stripeMethod: "creditNotes" },
  { key: "checkout_session", table: "checkout_sessions", label: "Checkout Sessions", stripeMethod: "checkout.sessions" },
];

const REQUIRED_TABLES = [
  "customers",
  "products",
  "prices",
  "subscriptions",
  "invoices",
];

// Rate limiting configuration
// Stripe allows 100 req/s live, 25 req/s test - we use 20 to be safe
const REQUESTS_PER_SECOND = 20;
const MIN_REQUEST_INTERVAL_MS = 1000 / REQUESTS_PER_SECOND; // 50ms between requests
const BATCH_SIZE = 100; // Stripe's max limit per request
const MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY_MS = 2000;

// Rate limiter state
let lastRequestTime = 0;

async function rateLimitedRequest(fn) {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;

  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL_MS) {
    await sleep(MIN_REQUEST_INTERVAL_MS - timeSinceLastRequest);
  }

  lastRequestTime = Date.now();
  return fn();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkDatabaseConnection(connectionString) {
  const pool = new Pool({ connectionString });
  try {
    const client = await pool.connect();
    client.release();
    await pool.end();
    return { success: true };
  } catch (error) {
    try { await pool.end(); } catch {}
    return { success: false, error: error.message };
  }
}

async function checkTablesExist(connectionString) {
  const pool = new Pool({ connectionString });
  try {
    const client = await pool.connect();

    const schemaResult = await client.query(`
      SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'stripe'
    `);

    if (schemaResult.rows.length === 0) {
      client.release();
      await pool.end();
      return { success: false, error: "schema_missing" };
    }

    const tablesResult = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'stripe' AND table_name = ANY($1)
    `, [REQUIRED_TABLES]);

    client.release();
    await pool.end();

    const existingTables = tablesResult.rows.map((r) => r.table_name);
    const missingTables = REQUIRED_TABLES.filter((t) => !existingTables.includes(t));

    if (missingTables.length > 0) {
      return { success: false, error: "tables_missing", missingTables };
    }

    return { success: true };
  } catch (error) {
    try { await pool.end(); } catch {}
    return { success: false, error: error.message };
  }
}

async function upsertRecord(pool, table, record, logger) {
  const columns = Object.keys(record);
  const values = Object.values(record);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
  const updateSet = columns
    .filter(c => c !== 'id')
    .map((c, i) => `${c} = EXCLUDED.${c}`)
    .join(", ");

  const query = `
    INSERT INTO stripe.${table} (${columns.join(", ")})
    VALUES (${placeholders})
    ON CONFLICT (id) DO UPDATE SET ${updateSet}, updated_at = NOW()
  `;

  try {
    await pool.query(query, values);
    return true;
  } catch (error) {
    // Log but don't fail - some records might have schema mismatches
    logger.log(`   ⚠️  Failed to upsert ${record.id}: ${error.message}`);
    return false;
  }
}

function transformStripeObject(obj, table) {
  // Convert Stripe object to database record
  const record = { id: obj.id };

  // Common fields
  if (obj.object !== undefined) record.object = obj.object;
  if (obj.created !== undefined) record.created = obj.created;
  if (obj.livemode !== undefined) record.livemode = obj.livemode;
  if (obj.metadata !== undefined) record.metadata = JSON.stringify(obj.metadata);

  // Table-specific transformations
  switch (table) {
    case "products":
      if (obj.name !== undefined) record.name = obj.name;
      if (obj.description !== undefined) record.description = obj.description;
      if (obj.active !== undefined) record.active = obj.active;
      if (obj.images !== undefined) record.images = JSON.stringify(obj.images);
      if (obj.default_price !== undefined) record.default_price = typeof obj.default_price === 'string' ? obj.default_price : obj.default_price?.id;
      if (obj.updated !== undefined) record.updated = obj.updated;
      break;

    case "prices":
      if (obj.active !== undefined) record.active = obj.active;
      if (obj.currency !== undefined) record.currency = obj.currency;
      if (obj.unit_amount !== undefined) record.unit_amount = obj.unit_amount;
      if (obj.type !== undefined) record.type = obj.type;
      if (obj.recurring !== undefined) record.recurring = JSON.stringify(obj.recurring);
      if (obj.product !== undefined) record.product = typeof obj.product === 'string' ? obj.product : obj.product?.id;
      if (obj.nickname !== undefined) record.nickname = obj.nickname;
      if (obj.billing_scheme !== undefined) record.billing_scheme = obj.billing_scheme;
      if (obj.lookup_key !== undefined) record.lookup_key = obj.lookup_key;
      break;

    case "customers":
      if (obj.email !== undefined) record.email = obj.email;
      if (obj.name !== undefined) record.name = obj.name;
      if (obj.phone !== undefined) record.phone = obj.phone;
      if (obj.description !== undefined) record.description = obj.description;
      if (obj.address !== undefined) record.address = JSON.stringify(obj.address);
      if (obj.shipping !== undefined) record.shipping = JSON.stringify(obj.shipping);
      if (obj.balance !== undefined) record.balance = obj.balance;
      if (obj.currency !== undefined) record.currency = obj.currency;
      if (obj.delinquent !== undefined) record.delinquent = obj.delinquent;
      if (obj.default_source !== undefined) record.default_source = obj.default_source;
      if (obj.invoice_settings !== undefined) record.invoice_settings = JSON.stringify(obj.invoice_settings);
      if (obj.deleted !== undefined) record.deleted = obj.deleted;
      break;

    case "subscriptions":
      if (obj.status !== undefined) record.status = obj.status;
      if (obj.customer !== undefined) record.customer = typeof obj.customer === 'string' ? obj.customer : obj.customer?.id;
      if (obj.current_period_start !== undefined) record.current_period_start = obj.current_period_start;
      if (obj.current_period_end !== undefined) record.current_period_end = obj.current_period_end;
      if (obj.cancel_at_period_end !== undefined) record.cancel_at_period_end = obj.cancel_at_period_end;
      if (obj.canceled_at !== undefined) record.canceled_at = obj.canceled_at;
      if (obj.items !== undefined) record.items = JSON.stringify(obj.items);
      if (obj.latest_invoice !== undefined) record.latest_invoice = typeof obj.latest_invoice === 'string' ? obj.latest_invoice : obj.latest_invoice?.id;
      if (obj.default_payment_method !== undefined) record.default_payment_method = typeof obj.default_payment_method === 'string' ? obj.default_payment_method : obj.default_payment_method?.id;
      if (obj.collection_method !== undefined) record.collection_method = obj.collection_method;
      break;

    case "invoices":
      if (obj.status !== undefined) record.status = obj.status;
      if (obj.customer !== undefined) record.customer = typeof obj.customer === 'string' ? obj.customer : obj.customer?.id;
      if (obj.subscription !== undefined) record.subscription = typeof obj.subscription === 'string' ? obj.subscription : obj.subscription?.id;
      if (obj.total !== undefined) record.total = obj.total;
      if (obj.amount_due !== undefined) record.amount_due = obj.amount_due;
      if (obj.amount_paid !== undefined) record.amount_paid = obj.amount_paid;
      if (obj.currency !== undefined) record.currency = obj.currency;
      if (obj.paid !== undefined) record.paid = obj.paid;
      if (obj.number !== undefined) record.number = obj.number;
      if (obj.hosted_invoice_url !== undefined) record.hosted_invoice_url = obj.hosted_invoice_url;
      if (obj.invoice_pdf !== undefined) record.invoice_pdf = obj.invoice_pdf;
      if (obj.lines !== undefined) record.lines = JSON.stringify(obj.lines);
      if (obj.period_start !== undefined) record.period_start = obj.period_start;
      if (obj.period_end !== undefined) record.period_end = obj.period_end;
      break;

    case "charges":
      if (obj.amount !== undefined) record.amount = obj.amount;
      if (obj.currency !== undefined) record.currency = obj.currency;
      if (obj.status !== undefined) record.status = obj.status;
      if (obj.paid !== undefined) record.paid = obj.paid;
      if (obj.refunded !== undefined) record.refunded = obj.refunded;
      if (obj.customer !== undefined) record.customer = typeof obj.customer === 'string' ? obj.customer : obj.customer?.id;
      if (obj.payment_intent !== undefined) record.payment_intent = typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent?.id;
      if (obj.invoice !== undefined) record.invoice = typeof obj.invoice === 'string' ? obj.invoice : obj.invoice?.id;
      if (obj.description !== undefined) record.description = obj.description;
      break;

    case "payment_intents":
      if (obj.amount !== undefined) record.amount = obj.amount;
      if (obj.currency !== undefined) record.currency = obj.currency;
      if (obj.status !== undefined) record.status = obj.status;
      if (obj.customer !== undefined) record.customer = typeof obj.customer === 'string' ? obj.customer : obj.customer?.id;
      if (obj.payment_method !== undefined) record.payment_method = typeof obj.payment_method === 'string' ? obj.payment_method : obj.payment_method?.id;
      if (obj.description !== undefined) record.description = obj.description;
      if (obj.invoice !== undefined) record.invoice = typeof obj.invoice === 'string' ? obj.invoice : obj.invoice?.id;
      break;

    case "payment_methods":
      if (obj.type !== undefined) record.type = obj.type;
      if (obj.customer !== undefined) record.customer = typeof obj.customer === 'string' ? obj.customer : obj.customer?.id;
      if (obj.billing_details !== undefined) record.billing_details = JSON.stringify(obj.billing_details);
      if (obj.card !== undefined) record.card = JSON.stringify(obj.card);
      break;

    case "coupons":
      if (obj.name !== undefined) record.name = obj.name;
      if (obj.percent_off !== undefined) record.percent_off = obj.percent_off;
      if (obj.amount_off !== undefined) record.amount_off = obj.amount_off;
      if (obj.currency !== undefined) record.currency = obj.currency;
      if (obj.duration !== undefined) record.duration = obj.duration;
      if (obj.duration_in_months !== undefined) record.duration_in_months = obj.duration_in_months;
      if (obj.valid !== undefined) record.valid = obj.valid;
      if (obj.times_redeemed !== undefined) record.times_redeemed = obj.times_redeemed;
      if (obj.max_redemptions !== undefined) record.max_redemptions = obj.max_redemptions;
      break;

    case "plans":
      if (obj.active !== undefined) record.active = obj.active;
      if (obj.amount !== undefined) record.amount = obj.amount;
      if (obj.currency !== undefined) record.currency = obj.currency;
      if (obj.interval !== undefined) record.interval = obj.interval;
      if (obj.interval_count !== undefined) record.interval_count = obj.interval_count;
      if (obj.product !== undefined) record.product = typeof obj.product === 'string' ? obj.product : obj.product?.id;
      if (obj.nickname !== undefined) record.nickname = obj.nickname;
      break;

    case "refunds":
      if (obj.amount !== undefined) record.amount = obj.amount;
      if (obj.currency !== undefined) record.currency = obj.currency;
      if (obj.status !== undefined) record.status = obj.status;
      if (obj.charge !== undefined) record.charge = typeof obj.charge === 'string' ? obj.charge : obj.charge?.id;
      if (obj.payment_intent !== undefined) record.payment_intent = typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent?.id;
      if (obj.reason !== undefined) record.reason = obj.reason;
      break;

    case "disputes":
      if (obj.amount !== undefined) record.amount = obj.amount;
      if (obj.currency !== undefined) record.currency = obj.currency;
      if (obj.status !== undefined) record.status = obj.status;
      if (obj.charge !== undefined) record.charge = typeof obj.charge === 'string' ? obj.charge : obj.charge?.id;
      if (obj.payment_intent !== undefined) record.payment_intent = typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent?.id;
      if (obj.reason !== undefined) record.reason = obj.reason;
      break;

    case "setup_intents":
      if (obj.status !== undefined) record.status = obj.status;
      if (obj.customer !== undefined) record.customer = typeof obj.customer === 'string' ? obj.customer : obj.customer?.id;
      if (obj.payment_method !== undefined) record.payment_method = typeof obj.payment_method === 'string' ? obj.payment_method : obj.payment_method?.id;
      if (obj.description !== undefined) record.description = obj.description;
      if (obj.usage !== undefined) record.usage = obj.usage;
      break;

    case "subscription_schedules":
      if (obj.status !== undefined) record.status = obj.status;
      if (obj.customer !== undefined) record.customer = typeof obj.customer === 'string' ? obj.customer : obj.customer?.id;
      if (obj.subscription !== undefined) record.subscription = typeof obj.subscription === 'string' ? obj.subscription : obj.subscription?.id;
      if (obj.phases !== undefined) record.phases = JSON.stringify(obj.phases);
      if (obj.current_phase !== undefined) record.current_phase = JSON.stringify(obj.current_phase);
      if (obj.end_behavior !== undefined) record.end_behavior = obj.end_behavior;
      break;

    case "credit_notes":
      if (obj.amount !== undefined) record.amount = obj.amount;
      if (obj.currency !== undefined) record.currency = obj.currency;
      if (obj.status !== undefined) record.status = obj.status;
      if (obj.customer !== undefined) record.customer = typeof obj.customer === 'string' ? obj.customer : obj.customer?.id;
      if (obj.invoice !== undefined) record.invoice = typeof obj.invoice === 'string' ? obj.invoice : obj.invoice?.id;
      if (obj.reason !== undefined) record.reason = obj.reason;
      if (obj.total !== undefined) record.total = obj.total;
      break;

    case "checkout_sessions":
      if (obj.status !== undefined) record.status = obj.status;
      if (obj.customer !== undefined) record.customer = typeof obj.customer === 'string' ? obj.customer : obj.customer?.id;
      if (obj.payment_intent !== undefined) record.payment_intent = typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent?.id;
      if (obj.subscription !== undefined) record.subscription = typeof obj.subscription === 'string' ? obj.subscription : obj.subscription?.id;
      if (obj.mode !== undefined) record.mode = obj.mode;
      if (obj.payment_status !== undefined) record.payment_status = obj.payment_status;
      if (obj.amount_total !== undefined) record.amount_total = obj.amount_total;
      if (obj.currency !== undefined) record.currency = obj.currency;
      if (obj.url !== undefined) record.url = obj.url;
      break;
  }

  return record;
}

async function syncResource(stripe, pool, resourceConfig, logger) {
  const { key, table, label, stripeMethod } = resourceConfig;
  let synced = 0;
  let failed = 0;
  let hasMore = true;
  let startingAfter = null;
  let pageCount = 0;

  // Get the Stripe resource
  const methodParts = stripeMethod.split(".");
  let stripeResource = stripe;
  for (const part of methodParts) {
    stripeResource = stripeResource[part];
  }

  while (hasMore) {
    pageCount++;
    const params = { limit: BATCH_SIZE };
    if (startingAfter) {
      params.starting_after = startingAfter;
    }

    let response;
    let retries = 0;

    while (retries < MAX_RETRIES) {
      try {
        response = await rateLimitedRequest(() => stripeResource.list(params));
        break;
      } catch (error) {
        retries++;
        const isRateLimit = error.statusCode === 429 || error.message?.toLowerCase().includes("rate limit");

        if (retries >= MAX_RETRIES) {
          throw error;
        }

        const delay = isRateLimit
          ? INITIAL_RETRY_DELAY_MS * Math.pow(2, retries - 1)
          : INITIAL_RETRY_DELAY_MS;

        logger.log(`   ⚠️  ${isRateLimit ? "Rate limited" : error.message}. Retry ${retries}/${MAX_RETRIES} in ${delay / 1000}s...`);
        await sleep(delay);
      }
    }

    const items = response.data;
    hasMore = response.has_more;

    if (items.length > 0) {
      startingAfter = items[items.length - 1].id;

      for (const item of items) {
        const record = transformStripeObject(item, table);
        const success = await upsertRecord(pool, table, record, logger);
        if (success) {
          synced++;
        } else {
          failed++;
        }
      }

      // Progress update every page
      process.stdout.write(`\r   📥 Page ${pageCount}: ${synced} synced${failed > 0 ? `, ${failed} failed` : ""}...`);
    }
  }

  // Clear the progress line
  process.stdout.write("\r" + " ".repeat(60) + "\r");

  return { synced, failed };
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

    const updatedFiles = saveToEnvFiles([{ key: "DATABASE_URL", value: databaseUrl }]);
    if (updatedFiles.length > 0) {
      logger.log(`\n📝 Saved DATABASE_URL to ${updatedFiles.join(", ")}`);
    }
    env.DATABASE_URL = databaseUrl;
  }

  // Step 2: Test database connection
  logger.log("\n🔌 Checking database connection...");
  const connectionResult = await checkDatabaseConnection(databaseUrl);
  if (!connectionResult.success) {
    logger.error(`❌ Failed to connect to database: ${connectionResult.error}`);
    if (exitOnError) process.exit(1);
    return { success: false, error: `Database connection failed: ${connectionResult.error}` };
  }
  logger.log("✅ Database connection successful.");

  // Step 3: Check if migrations have been run
  logger.log("\n🔍 Checking if migrations have been run...");
  const tablesResult = await checkTablesExist(databaseUrl);
  if (!tablesResult.success) {
    if (tablesResult.error === "schema_missing") {
      logger.error("\n❌ The 'stripe' schema does not exist.");
      logger.log("\nPlease run migrations first:");
      logger.log("  npx stripe-no-webhooks migrate");
      if (exitOnError) process.exit(1);
      return { success: false, error: "Stripe schema not found. Run migrate first." };
    }
    if (tablesResult.error === "tables_missing") {
      logger.error("\n❌ Required tables are missing from the 'stripe' schema.");
      logger.log(`   Missing: ${tablesResult.missingTables.join(", ")}`);
      logger.log("\nPlease run migrations first:");
      logger.log("  npx stripe-no-webhooks migrate");
      if (exitOnError) process.exit(1);
      return { success: false, error: "Required tables missing. Run migrate first." };
    }
    logger.error(`\n❌ Failed to check tables: ${tablesResult.error}`);
    if (exitOnError) process.exit(1);
    return { success: false, error: tablesResult.error };
  }
  logger.log("✅ Stripe schema and tables found.");

  // Step 4: Get Stripe API key
  let stripeSecretKey = env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    stripeSecretKey = await questionHidden(null, "\nEnter your Stripe Secret Key (sk_...)");
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

  const syncObject = objectType || "all";

  if (!SYNC_OBJECTS.includes(syncObject)) {
    logger.error(`❌ Invalid object type: ${syncObject}`);
    logger.log(`\nValid object types: ${SYNC_OBJECTS.join(", ")}`);
    if (exitOnError) process.exit(1);
    return { success: false, error: `Invalid object type: ${syncObject}` };
  }

  logger.log(`\n🚀 Starting Stripe backfill (${mode} mode)...`);
  logger.log(`   Syncing: ${syncObject}`);
  logger.log(`   Rate limit: ${REQUESTS_PER_SECOND} requests/second\n`);

  const stripe = new Stripe(stripeSecretKey);
  const pool = new Pool({ connectionString: databaseUrl });

  const startTime = Date.now();
  const results = {};
  const errors = [];

  try {
    const resourcesToSync = syncObject === "all"
      ? SYNC_ORDER
      : SYNC_ORDER.filter(r => r.key === syncObject);

    const totalResources = resourcesToSync.length;

    for (let i = 0; i < resourcesToSync.length; i++) {
      const resourceConfig = resourcesToSync[i];
      const progress = `[${i + 1}/${totalResources}]`;

      logger.log(`${progress} 🔄 Syncing ${resourceConfig.label}...`);

      try {
        const { synced, failed } = await syncResource(stripe, pool, resourceConfig, logger);
        results[resourceConfig.key] = { synced, failed };

        if (failed > 0) {
          logger.log(`${progress} ⚠️  ${resourceConfig.label}: ${synced} synced, ${failed} failed`);
        } else {
          logger.log(`${progress} ✅ ${resourceConfig.label}: ${synced} synced`);
        }
      } catch (error) {
        errors.push({ resource: resourceConfig.label, error: error.message });
        logger.log(`${progress} ❌ ${resourceConfig.label}: Failed - ${error.message}`);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    logger.log("\n" + "=".repeat(50));
    logger.log("📊 Backfill Summary");
    logger.log("=".repeat(50));

    let totalSynced = 0;
    let totalFailed = 0;
    for (const [key, value] of Object.entries(results)) {
      totalSynced += value.synced || 0;
      totalFailed += value.failed || 0;
    }

    const successCount = Object.keys(results).length;

    logger.log(`   Resources: ${successCount}/${totalResources}`);
    logger.log(`   Objects synced: ${totalSynced}`);
    if (totalFailed > 0) {
      logger.log(`   Objects failed: ${totalFailed}`);
    }

    if (errors.length > 0) {
      logger.log(`\n❌ Resource errors (${errors.length}):`);
      for (const { resource, error } of errors) {
        logger.log(`   - ${resource}: ${error}`);
      }
    }

    logger.log(`\n⏱️  Completed in ${elapsed}s`);

    if (errors.length === 0 && totalFailed === 0) {
      logger.log("✅ Backfill completed successfully!\n");
    } else {
      logger.log(`⚠️  Backfill completed with issues.\n`);
    }

    await pool.end();

    return {
      success: errors.length < totalResources,
      results,
      errors,
      stats: { totalSynced, totalFailed, successCount, totalResources }
    };
  } catch (error) {
    logger.error("\n❌ Backfill failed unexpectedly:", error.message);
    try { await pool.end(); } catch {}
    if (exitOnError) process.exit(1);
    return { success: false, error: error.message };
  }
}

module.exports = { backfill, SYNC_OBJECTS };
