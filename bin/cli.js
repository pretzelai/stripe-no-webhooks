#!/usr/bin/env node

const { runMigrations } = require("@supabase/stripe-sync-engine");
const readline = require("readline");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const command = args[0];
const databaseUrl = args[1];

function createPrompt() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function question(rl, query, defaultValue = "") {
  return new Promise((resolve) => {
    const prompt = defaultValue ? `${query} (${defaultValue}): ` : `${query}: `;
    rl.question(prompt, (answer) => {
      resolve(answer || defaultValue);
    });
  });
}

function questionHidden(rl, query) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    stdout.write(`${query}: `);

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let input = "";
    const onData = (char) => {
      if (char === "\n" || char === "\r" || char === "\u0004") {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        stdout.write("\n");
        resolve(input);
      } else if (char === "\u0003") {
        // Ctrl+C
        process.exit();
      } else if (char === "\u007F" || char === "\b") {
        // Backspace
        if (input.length > 0) {
          input = input.slice(0, -1);
          stdout.write("\b \b"); // Erase character from display
        }
      } else {
        input += char;
        stdout.write("**************"); // Show asterisk for each character
      }
    };

    stdin.on("data", onData);
  });
}

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

async function config() {
  let Stripe;
  try {
    Stripe = require("stripe").default || require("stripe");
  } catch (e) {
    console.error("❌ Stripe package not found.");
    console.log("Please install it first: npm install stripe");
    process.exit(1);
  }

  const rl = createPrompt();

  console.log("\n🔧 Stripe Webhook Configuration\n");

  // Get Stripe API key (hidden input)
  rl.close(); // Close readline for hidden input
  const stripeSecretKey = await questionHidden(
    null,
    "Enter your Stripe Secret Key (sk_...)"
  );

  if (!stripeSecretKey || !stripeSecretKey.startsWith("sk_")) {
    console.error("❌ Invalid Stripe Secret Key. It should start with 'sk_'");
    process.exit(1);
  }

  // Reopen readline for remaining questions
  const rl2 = createPrompt();

  // Get site URL with default from env
  const defaultSiteUrl = process.env.NEXT_PUBLIC_SITE_URL || "";
  const siteUrl = await question(rl2, "Enter your site URL", defaultSiteUrl);

  if (!siteUrl) {
    console.error("❌ Site URL is required");
    rl2.close();
    process.exit(1);
  }

  // Validate URL
  let webhookUrl;
  try {
    const url = new URL(siteUrl);
    webhookUrl = `${url.origin}/api/stripe/webhook`;
  } catch (e) {
    console.error("❌ Invalid URL format");
    rl2.close();
    process.exit(1);
  }

  rl2.close();

  console.log(`\n📡 Creating webhook endpoint: ${webhookUrl}\n`);

  const stripe = new Stripe(stripeSecretKey);

  try {
    // Get all available event types
    const webhook = await stripe.webhookEndpoints.create({
      url: webhookUrl,
      enabled_events: ["*"], // Listen to all events
      description: "Created by stripe-no-webhooks CLI",
    });

    console.log("✅ Webhook created successfully!\n");

    // Try to add webhook secret to env files
    const envFiles = [
      ".env",
      ".env.local",
      ".env.development",
      ".env.production",
    ];
    const cwd = process.cwd();
    const updatedFiles = [];

    for (const envFile of envFiles) {
      const envPath = path.join(cwd, envFile);
      if (fs.existsSync(envPath)) {
        let content = fs.readFileSync(envPath, "utf8");
        const secretLine = `STRIPE_WEBHOOK_SECRET=${webhook.secret}`;

        if (content.includes("STRIPE_WEBHOOK_SECRET=")) {
          // Replace existing value
          content = content.replace(/STRIPE_WEBHOOK_SECRET=.*/, secretLine);
        } else {
          // Append to file
          const newline = content.endsWith("\n") ? "" : "\n";
          content = content + newline + secretLine + "\n";
        }

        fs.writeFileSync(envPath, content);
        updatedFiles.push(envFile);
      }
    }

    if (updatedFiles.length > 0) {
      console.log(
        `📝 Updated ${updatedFiles.join(
          ", "
        )} with STRIPE_WEBHOOK_SECRET\nREMEMBER: Update the enviroment variable in Vercel too\nSTRIPE_WEBHOOK_SECRET=${
          webhook.secret
        }`
      );
    } else {
      console.log("Add this to your environment variables:\n");
      console.log(`STRIPE_WEBHOOK_SECRET=${webhook.secret}\n`);
    }

    console.log("─".repeat(50));
    console.log("Webhook ID:", webhook.id);
    console.log("Webhook URL:", webhook.url);
    console.log("Events: All events (*)");
    if (updatedFiles.length === 0) {
      console.log("Secret:", webhook.secret);
    }
    console.log("─".repeat(50));
  } catch (error) {
    if (error.type === "StripeAuthenticationError") {
      console.error("❌ Authentication failed. Check your Stripe Secret Key.");
    } else if (error.type === "StripeInvalidRequestError") {
      console.error("❌ Invalid request:", error.message);
    } else {
      console.error("❌ Failed to create webhook:");
      console.error(error.message);
    }
    process.exit(1);
  }
}

async function main() {
  switch (command) {
    case "migrate":
      await migrate(databaseUrl);
      break;

    case "config":
      await config();
      break;

    default:
      console.log("Usage:");
      console.log("  npx stripe-no-webhooks migrate <connection_string>");
      console.log("  npx stripe-no-webhooks config");
      process.exit(1);
  }
}

main();
