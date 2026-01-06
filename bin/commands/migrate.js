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
      "Usage:\n  npx stripe-no-webhooks migrate <postgres_connection_string>"
    );
    if (exitOnError) process.exit(1);
    return { success: false, error: "Missing database URL" };
  }

  logger.log("🚀 Running Stripe migrations...");

  try {
    await runMigrations({
      databaseUrl,
      schema: SCHEMA,
      logger,
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
    logger.error("❌ Migration failed:");
    logger.error(error);
    if (exitOnError) process.exit(1);
    return { success: false, error: error.message };
  }
}

module.exports = { migrate };
