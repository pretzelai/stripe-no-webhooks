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

function getTemplatesDir() {
  return path.join(__dirname, "..", "src", "templates");
}

function getAppRouterTemplate() {
  const templatePath = path.join(getTemplatesDir(), "app-router-webhook.ts");
  return fs.readFileSync(templatePath, "utf8");
}

function getPagesRouterTemplate() {
  const templatePath = path.join(getTemplatesDir(), "pages-router-webhook.ts");
  return fs.readFileSync(templatePath, "utf8");
}

function detectRouterType() {
  const cwd = process.cwd();
  const hasAppDir = fs.existsSync(path.join(cwd, "app"));
  const hasPagesDir = fs.existsSync(path.join(cwd, "pages"));

  // Also check for src/app and src/pages (common Next.js structure)
  const hasSrcAppDir = fs.existsSync(path.join(cwd, "src", "app"));
  const hasSrcPagesDir = fs.existsSync(path.join(cwd, "src", "pages"));

  // Prefer App Router if app directory exists
  if (hasAppDir || hasSrcAppDir) {
    return { type: "app", useSrc: hasSrcAppDir && !hasAppDir };
  }

  if (hasPagesDir || hasSrcPagesDir) {
    return { type: "pages", useSrc: hasSrcPagesDir && !hasPagesDir };
  }

  // Default to App Router if no directories found
  return { type: "app", useSrc: false };
}

function createApiRoute(routerType, useSrc) {
  const cwd = process.cwd();
  const baseDir = useSrc ? path.join(cwd, "src") : cwd;

  if (routerType === "app") {
    // App Router: app/api/stripe/webhook/route.ts
    const routeDir = path.join(baseDir, "app", "api", "stripe", "webhook");
    const routeFile = path.join(routeDir, "route.ts");

    // Create directories if they don't exist
    fs.mkdirSync(routeDir, { recursive: true });

    // Get template content (remove the comment with file path)
    let template = getAppRouterTemplate();
    template = template.replace(
      /^\/\/ app\/api\/stripe\/webhook\/route\.ts\n/,
      ""
    );

    // Write the file
    fs.writeFileSync(routeFile, template);

    const prefix = useSrc ? "src/" : "";
    return `${prefix}app/api/stripe/webhook/route.ts`;
  } else {
    // Pages Router: pages/api/stripe/webhook.ts
    const routeDir = path.join(baseDir, "pages", "api", "stripe");
    const routeFile = path.join(routeDir, "webhook.ts");

    // Create directories if they don't exist
    fs.mkdirSync(routeDir, { recursive: true });

    // Get template content (remove the comment with file path)
    let template = getPagesRouterTemplate();
    template = template.replace(/^\/\/ pages\/api\/stripe\/webhook\.ts\n/, "");

    // Write the file
    fs.writeFileSync(routeFile, template);

    const prefix = useSrc ? "src/" : "";
    return `${prefix}pages/api/stripe/webhook.ts`;
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

  console.log("\n🔧 Stripe Webhook Configuration\n");

  // Detect router type from folder structure
  const { type: routerType, useSrc } = detectRouterType();
  const routerLabel = routerType === "app" ? "App Router" : "Pages Router";
  const srcLabel = useSrc ? " (src/)" : "";
  console.log(`📂 Detected: ${routerLabel}${srcLabel}\n`);

  // Get Stripe API key (hidden input)
  const stripeSecretKey = await questionHidden(
    null,
    "Enter your Stripe Secret Key (sk_...)"
  );

  if (!stripeSecretKey || !stripeSecretKey.startsWith("sk_")) {
    console.error("❌ Invalid Stripe Secret Key. It should start with 'sk_'");
    process.exit(1);
  }

  // Create readline for site URL question
  const rl = createPrompt();

  // Get site URL with default from env
  const defaultSiteUrl = process.env.NEXT_PUBLIC_SITE_URL || "";
  const siteUrl = await question(rl, "Enter your site URL", defaultSiteUrl);

  if (!siteUrl) {
    console.error("❌ Site URL is required");
    rl.close();
    process.exit(1);
  }

  // Validate URL
  let webhookUrl;
  try {
    const url = new URL(siteUrl);
    webhookUrl = `${url.origin}/api/stripe/webhook`;
  } catch (e) {
    console.error("❌ Invalid URL format");
    rl.close();
    process.exit(1);
  }

  // Get DATABASE_URL (optional)
  const defaultDatabaseUrl = process.env.DATABASE_URL || "";
  const databaseUrlInput = await question(
    rl,
    "Enter your DATABASE_URL (optional, press Enter to skip)",
    defaultDatabaseUrl
  );

  rl.close();

  // Create the API route
  console.log(`📁 Creating API route...`);
  try {
    const createdFile = createApiRoute(routerType, useSrc);
    console.log(`✅ Created ${createdFile}\n`);
  } catch (error) {
    console.error("❌ Failed to create API route:", error.message);
    process.exit(1);
  }

  console.log(`📡 Creating webhook endpoint: ${webhookUrl}\n`);

  const stripe = new Stripe(stripeSecretKey);

  try {
    // Check if a webhook with the same URL already exists
    const existingWebhooks = await stripe.webhookEndpoints.list({ limit: 100 });
    const existingWebhook = existingWebhooks.data.find(
      (wh) => wh.url === webhookUrl
    );

    if (existingWebhook) {
      console.log(`🔄 Found existing webhook with same URL, deleting it...`);
      await stripe.webhookEndpoints.del(existingWebhook.id);
      console.log(`✅ Deleted existing webhook (${existingWebhook.id})\n`);
    }

    // Create webhook endpoint
    console.log(`🔄 Creating new webhook endpoint...`);
    const webhook = await stripe.webhookEndpoints.create({
      url: webhookUrl,
      enabled_events: ["*"], // Listen to all events
      description: "Created by stripe-no-webhooks CLI",
    });
    console.log("✅ Webhook created successfully!\n");

    // Try to add secrets to env files
    const envFiles = [
      ".env",
      ".env.local",
      ".env.development",
      ".env.production",
    ];
    const cwd = process.cwd();
    const updatedFiles = [];

    // Build list of env vars to update
    const envVars = [
      { key: "STRIPE_SECRET_KEY", value: stripeSecretKey },
      { key: "STRIPE_WEBHOOK_SECRET", value: webhook.secret },
      { key: "NEXT_PUBLIC_SITE_URL", value: siteUrl },
    ];
    if (databaseUrlInput) {
      envVars.push({ key: "DATABASE_URL", value: databaseUrlInput });
    }

    for (const envFile of envFiles) {
      const envPath = path.join(cwd, envFile);
      if (fs.existsSync(envPath)) {
        let content = fs.readFileSync(envPath, "utf8");

        for (const { key, value } of envVars) {
          const line = `${key}=${value}`;
          const regex = new RegExp(`^${key}=.*`, "m");

          if (regex.test(content)) {
            // Replace existing value
            content = content.replace(regex, line);
          } else {
            // Append to file
            const newline = content.endsWith("\n") ? "" : "\n";
            content = content + newline + line + "\n";
          }
        }

        fs.writeFileSync(envPath, content);
        updatedFiles.push(envFile);
      }
    }

    const envVarNames = envVars.map((v) => v.key).join(", ");
    if (updatedFiles.length > 0) {
      console.log(`📝 Updated ${updatedFiles.join(", ")} with ${envVarNames}`);
      console.log(
        "\nREMEMBER: Update the environment variables in Vercel too:"
      );
      for (const { key, value } of envVars) {
        console.log(`${key}=${value}`);
      }
    } else {
      console.log("Add these to your environment variables:\n");
      for (const { key, value } of envVars) {
        console.log(`${key}=${value}`);
      }
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
