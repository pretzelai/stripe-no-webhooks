const { runMigrations } = require("@pretzelai/stripe-sync-engine");
const { Client } = require("pg");
const { saveToEnvFiles } = require("./helpers/utils");
const {
  header,
  success,
  error,
  step,
  complete,
  nextSteps,
  DIM,
  RESET,
} = require("./helpers/output");

async function migrate(dbUrl, options = {}) {
  const { env = process.env, logger = console, exitOnError = true } = options;

  const SCHEMA = "stripe";

  const databaseUrl = dbUrl || env.DATABASE_URL;

  if (!databaseUrl) {
    error("Missing database URL.");
    console.log();
    console.log(
      "Usage:\n  npx stripe-no-webhooks migrate <postgres_connection_string>"
    );
    if (exitOnError) process.exit(1);
    return { success: false, error: "Missing database URL" };
  }

  header("stripe-no-webhooks", "Database Migrations");

  step("Running Stripe schema migrations...");

  let client;
  try {
    await runMigrations({
      databaseUrl,
      schema: SCHEMA,
      logger: { info: () => {}, error: logger.error }, // Suppress verbose output
    });

    client = new Client({ connectionString: databaseUrl });
    await client.connect();

    await client.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.user_stripe_customer_map (
        user_id text PRIMARY KEY,
        stripe_customer_id text UNIQUE NOT NULL,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now()
      );
    `);
    success("Created stripe.user_stripe_customer_map");

    // Credit system tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.credit_balances (
        user_id text NOT NULL,
        key text NOT NULL,
        balance bigint NOT NULL DEFAULT 0,
        currency text,
        updated_at timestamptz DEFAULT now(),
        PRIMARY KEY (user_id, key)
      );
    `);
    success("Created stripe.credit_balances");

    // Add currency column if it doesn't exist (for existing installations)
    await client.query(`
      ALTER TABLE ${SCHEMA}.credit_balances
        ADD COLUMN IF NOT EXISTS currency text;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.credit_ledger (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id text NOT NULL,
        key text NOT NULL,
        amount bigint NOT NULL,
        balance_after bigint NOT NULL,
        transaction_type text NOT NULL,
        source text NOT NULL,
        source_id text,
        description text,
        metadata jsonb,
        idempotency_key text UNIQUE,
        created_at timestamptz DEFAULT now()
      );
    `);
    success("Created stripe.credit_ledger");

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_credit_ledger_user_key_time
        ON ${SCHEMA}.credit_ledger(user_id, key, created_at DESC);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_credit_ledger_source_id
        ON ${SCHEMA}.credit_ledger(source_id);
    `);
    success("Created indexes");

    // Top-up failure tracking for cooldown logic
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.topup_failures (
        user_id TEXT NOT NULL,
        key TEXT NOT NULL,
        payment_method_id TEXT,
        decline_type TEXT NOT NULL,
        decline_code TEXT,
        failure_count INTEGER DEFAULT 1,
        last_failure_at TIMESTAMPTZ DEFAULT NOW(),
        disabled BOOLEAN DEFAULT FALSE,
        PRIMARY KEY (user_id, key)
      );
    `);
    success("Created stripe.topup_failures");

    await client.end();

    if (!env.DATABASE_URL) {
      const envVars = [{ key: "DATABASE_URL", value: databaseUrl }];
      const updatedFiles = saveToEnvFiles(envVars);
      if (updatedFiles.length > 0) {
        success(`Saved DATABASE_URL to ${updatedFiles.join(", ")}`);
      }
    }

    complete("MIGRATIONS COMPLETE", [
      "Stripe schema and tables created successfully",
    ]);

    nextSteps([
      "Edit billing.config.ts with your plans",
      "",
      "Sync plans to Stripe:",
      `   ${DIM}npx stripe-no-webhooks sync${RESET}`,
    ]);

    return { success: true };
  } catch (err) {
    if (client) {
      await client.end().catch(() => {});
    }
    error(`Migration failed: ${err.message}`);
    if (exitOnError) process.exit(1);
    return { success: false, error: err.message };
  }
}

module.exports = { migrate };
