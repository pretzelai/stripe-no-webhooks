#!/usr/bin/env node

import { runMigrations } from "@supabase/stripe-sync-engine";

const args = process.argv.slice(2);
const command = args[0];
const databaseUrl = args[1];

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
  } catch (error) {
    console.error("❌ Migration failed:");
    console.error(error);
    process.exit(1);
  }
}

switch (command) {
  case "migrate":
    await migrate(databaseUrl);
    break;

  default:
    console.log("Usage:");
    console.log("  npx stripe-no-webhooks migrate <connection_string>");
    process.exit(1);
}
