#!/usr/bin/env node

const path = require("path");

// Load environment variables from .env files in the user's project directory
require("dotenv").config({ path: path.join(process.cwd(), ".env.local") });
require("dotenv").config({ path: path.join(process.cwd(), ".env") });

const { migrate } = require("./commands/migrate");
const { init } = require("./commands/init");
const { sync, setupWebhooks } = require("./commands/sync");
const { generate } = require("./commands/generate");
const { backfill } = require("./commands/backfill");

const args = process.argv.slice(2);
const command = args[0];

function parseArgs(args) {
  const result = { positional: [], options: {} };
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const value =
        args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
      result.options[key] = value;
    } else {
      result.positional.push(args[i]);
    }
  }
  return result;
}

async function main() {
  const { positional, options } = parseArgs(args.slice(1));

  switch (command) {
    case "migrate":
      await migrate(positional[0], { schema: options.schema });
      break;

    case "init":
      await init();
      break;

    case "sync":
      const syncResult = await sync();
      if (syncResult.success && syncResult._context) {
        await setupWebhooks(syncResult._context);
      }
      break;

    case "generate":
      await generate(positional[0], { output: options.output });
      break;

    case "backfill":
      await backfill(positional[0], {
        since: options.since,
        skip: options.skip,
      });
      break;

    default:
      console.log("Usage:");
      console.log("  npx stripe-no-webhooks init");
      console.log("  npx stripe-no-webhooks migrate <connection_string>");
      console.log("  npx stripe-no-webhooks sync");
      console.log(
        "  npx stripe-no-webhooks generate <component> [--output <path>]"
      );
      console.log("  npx stripe-no-webhooks backfill [object_type]");
      console.log("");
      console.log("Commands:");
      console.log("  init      Set up project files and environment variables");
      console.log("  migrate   Run database migrations");
      console.log("  sync      Sync plans to Stripe + webhook setup");
      console.log("  generate  Generate components (e.g., PricingTable)");
      console.log("  backfill  Backfill Stripe data to database");
      console.log("");
      console.log("Backfill options:");
      console.log("  [object_type]       Object type to sync (default: all)");
      console.log("  --since <date>      Only sync objects created after this date");
      console.log("                      Format: YYYY-MM-DD (e.g., 2024-01-01)");
      console.log("  --skip <types>      Skip specific object types (comma-separated)");
      console.log("                      Example: --skip checkout_session,dispute");
      console.log("");
      console.log("Object types: all, customer, product, price, subscription,");
      console.log("  invoice, charge, payment_intent, payment_method, and more");
      process.exit(1);
  }
}

main();
