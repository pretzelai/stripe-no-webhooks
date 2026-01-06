#!/usr/bin/env node

const path = require("path");

// Load environment variables from .env files in the user's project directory
require("dotenv").config({ path: path.join(process.cwd(), ".env.local") });
require("dotenv").config({ path: path.join(process.cwd(), ".env") });

const { migrate } = require("./commands/migrate");
const { config } = require("./commands/config");
const { sync } = require("./commands/sync");
const { backfill } = require("./commands/backfill");

const args = process.argv.slice(2);
const command = args[0];
const databaseUrl = args[1];

async function main() {
  switch (command) {
    case "migrate":
      await migrate(databaseUrl);
      break;

    case "config":
      await config();
      break;

    case "sync":
      await sync();
      break;

    case "backfill":
      await backfill(args[1]);
      break;

    default:
      console.log("Usage:");
      console.log("  npx stripe-no-webhooks migrate <connection_string>");
      console.log("  npx stripe-no-webhooks config");
      console.log("  npx stripe-no-webhooks sync");
      console.log("  npx stripe-no-webhooks backfill [object_type]");
      console.log("");
      console.log("Backfill object types:");
      console.log("  all (default), customer, product, price, subscription,");
      console.log("  invoice, charge, payment_intent, payment_method, and more");
      process.exit(1);
  }
}

main();
