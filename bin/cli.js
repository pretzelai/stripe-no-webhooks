#!/usr/bin/env node

const path = require("path");

// Load environment variables from .env files in the user's project directory
require("dotenv").config({ path: path.join(process.cwd(), ".env.local") });
require("dotenv").config({ path: path.join(process.cwd(), ".env") });

const { migrate } = require("./commands/migrate");
const { config } = require("./commands/config");
const { sync } = require("./commands/sync");

const args = process.argv.slice(2);
const command = args[0];

function parseArgs(args) {
  const result = { positional: [], options: {} };
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const value = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
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

    case "config":
      await config();
      break;

    case "sync":
      await sync();
      break;

    default:
      console.log("Usage:");
      console.log("  npx stripe-no-webhooks migrate <connection_string> [--schema <name>]");
      console.log("  npx stripe-no-webhooks config");
      console.log("  npx stripe-no-webhooks sync");
      process.exit(1);
  }
}

main();
