const { runMigrations } = require("@supabase/stripe-sync-engine");
const { Client } = require("pg");
const { saveToEnvFiles } = require("./helpers/utils");

async function migrate(dbUrl, options = {}) {
  const { env = process.env, logger = console, exitOnError = true } = options;

  const SCHEMA = "stripe";

  const databaseUrl = dbUrl || env.DATABASE_URL;

  if (!databaseUrl) {
    logger.error("❌ Missing database URL.\n");
    logger.log(
      "Usage:\n  npx stripe-no-webhooks migrate <postgres_connection_string> [--schema <name>]"
    );
    if (exitOnError) process.exit(1);
    return { success: false, error: "Missing database URL" };
  }

  logger.log(`🚀 Running Stripe migrations (schema: ${SCHEMA})...`);

  let client;
  try {
    await runMigrations({
      databaseUrl,
      schema: SCHEMA,
      logger,
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

    // Credit system tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.credit_balances (
        user_id text NOT NULL,
        credit_type_id text NOT NULL,
        balance bigint NOT NULL DEFAULT 0,
        updated_at timestamptz DEFAULT now(),
        PRIMARY KEY (user_id, credit_type_id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.credit_ledger (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id text NOT NULL,
        credit_type_id text NOT NULL,
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

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_credit_ledger_user_type_time
        ON ${SCHEMA}.credit_ledger(user_id, credit_type_id, created_at DESC);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_credit_ledger_source_id
        ON ${SCHEMA}.credit_ledger(source_id);
    `);

    await client.end();
    logger.log("✅ Stripe schema migrations completed!");

    if (!env.DATABASE_URL) {
      const envVars = [{ key: "DATABASE_URL", value: databaseUrl }];
      const updatedFiles = saveToEnvFiles(envVars);
      if (updatedFiles.length > 0) {
        logger.log(`📝 Updated ${updatedFiles.join(", ")} with DATABASE_URL`);
      }
    }

    return { success: true };
  } catch (error) {
    if (client) {
      await client.end().catch(() => {});
    }
    logger.error("❌ Migration failed:");
    logger.error(error);
    if (exitOnError) process.exit(1);
    return { success: false, error: error.message };
  }
}

module.exports = { migrate };
