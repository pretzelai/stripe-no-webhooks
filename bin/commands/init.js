const fs = require("fs");
const path = require("path");
const {
  createPrompt,
  question,
  questionHidden,
  saveToEnvFiles,
  writeTemplate,
  detectRouterType,
  isValidStripeKey,
} = require("./helpers/utils");
const {
  header,
  success,
  error,
  info,
  divider,
  nextSteps,
  complete,
  COLORS,
  RESET,
  BOLD,
  DIM,
} = require("./helpers/output");

async function init(options = {}) {
  const {
    env = process.env,
    cwd = process.cwd(),
    logger = console,
    exitOnError = true,
  } = options;

  header("stripe-no-webhooks", "Project Setup");

  // Detect router type
  const { type: routerType, useSrc } = detectRouterType(cwd);
  info(
    `Detected: ${routerType === "app" ? "App Router" : "Pages Router"}${useSrc ? " (src/)" : ""}`
  );

  console.log();
  console.log(`${BOLD}Creating project files...${RESET}`);
  console.log();

  // Create lib/billing.ts
  try {
    const result = writeTemplate({
      templateName: "lib-billing.ts",
      destPath: "lib/billing.ts",
      cwd,
    });
    if (result.created) {
      success(`Created ${result.path}`);
    } else {
      info(`${result.path} already exists`);
    }
  } catch (err) {
    error(`Failed to create lib/billing.ts: ${err.message}`);
    if (exitOnError) process.exit(1);
    return { success: false, error: err.message };
  }

  // Create API route
  try {
    const isApp = routerType === "app";
    const result = writeTemplate({
      templateName: isApp ? "app-router.ts" : "pages-router.ts",
      destPath: isApp
        ? "app/api/stripe/[...all]/route.ts"
        : "pages/api/stripe/[...all].ts",
      cwd,
      routerType,
      transform: (t) =>
        t.replace(
          isApp
            ? /^\/\/ app\/api\/stripe\/\[\.\.\.all\]\/route\.ts\n/
            : /^\/\/ pages\/api\/stripe\/\[\.\.\.all\]\.ts\n/,
          ""
        ),
    });
    if (result.created) {
      success(`Created ${result.path}`);
    } else {
      info(`${result.path} already exists`);
    }
  } catch (err) {
    error(`Failed to create API route: ${err.message}`);
    if (exitOnError) process.exit(1);
    return { success: false, error: err.message };
  }

  // Create billing.config.ts
  try {
    const result = writeTemplate({
      templateName: "billing.config.ts",
      destPath: "billing.config.ts",
      cwd,
      inProjectRoot: true,
    });
    if (result.created) {
      success(`Created billing.config.ts`);
    } else {
      info(`billing.config.ts already exists`);
    }
  } catch (err) {
    error(`Failed to create billing.config.ts: ${err.message}`);
    if (exitOnError) process.exit(1);
    return { success: false, error: err.message };
  }

  divider();

  console.log(`${BOLD}Configure your environment:${RESET}`);
  console.log();

  const envVars = [];

  // STRIPE_SECRET_KEY
  console.log(
    `${COLORS.cyan}┌────────────────────────────────────────────────────────────┐${RESET}`
  );
  console.log(
    `${COLORS.cyan}│${RESET}  ${BOLD}STRIPE_SECRET_KEY${RESET}                                         ${COLORS.cyan}│${RESET}`
  );
  console.log(
    `${COLORS.cyan}│${RESET}  ${DIM}Find this at: https://dashboard.stripe.com/apikeys${RESET}        ${COLORS.cyan}│${RESET}`
  );
  console.log(
    `${COLORS.cyan}└────────────────────────────────────────────────────────────┘${RESET}`
  );

  let stripeSecretKey = env.STRIPE_SECRET_KEY || "";
  if (isValidStripeKey(stripeSecretKey)) {
    success(`STRIPE_SECRET_KEY already configured`);
  } else {
    stripeSecretKey = await questionHidden(
      null,
      "Enter your Stripe Secret Key (sk_test_... or sk_live_...)"
    );
    if (!isValidStripeKey(stripeSecretKey)) {
      error("Invalid Stripe Secret Key. It should start with 'sk_' or 'rk_'");
      if (exitOnError) process.exit(1);
      return { success: false, error: "Invalid Stripe Secret Key" };
    }
    envVars.push({ key: "STRIPE_SECRET_KEY", value: stripeSecretKey });
    success("STRIPE_SECRET_KEY saved");
  }

  console.log();

  // DATABASE_URL
  console.log(
    `${COLORS.cyan}┌────────────────────────────────────────────────────────────┐${RESET}`
  );
  console.log(
    `${COLORS.cyan}│${RESET}  ${BOLD}DATABASE_URL${RESET}                                              ${COLORS.cyan}│${RESET}`
  );
  console.log(
    `${COLORS.cyan}│${RESET}  ${DIM}PostgreSQL connection string (Neon, Supabase, etc.)${RESET}       ${COLORS.cyan}│${RESET}`
  );
  console.log(
    `${COLORS.cyan}└────────────────────────────────────────────────────────────┘${RESET}`
  );

  let databaseUrl = env.DATABASE_URL || "";
  if (databaseUrl) {
    success(`DATABASE_URL already configured`);
  } else {
    const rl = createPrompt();
    databaseUrl = await question(rl, "Enter your DATABASE_URL");
    rl.close();
    if (databaseUrl) {
      envVars.push({ key: "DATABASE_URL", value: databaseUrl });
      success("DATABASE_URL saved");
    } else {
      info("DATABASE_URL skipped (you can add it later)");
    }
  }

  console.log();

  // NEXT_PUBLIC_SITE_URL
  console.log(
    `${COLORS.cyan}┌────────────────────────────────────────────────────────────┐${RESET}`
  );
  console.log(
    `${COLORS.cyan}│${RESET}  ${BOLD}NEXT_PUBLIC_SITE_URL${RESET}                                      ${COLORS.cyan}│${RESET}`
  );
  console.log(
    `${COLORS.cyan}│${RESET}  ${DIM}Your app's base URL (e.g., http://localhost:3000 for local)${RESET}${COLORS.cyan}│${RESET}`
  );
  console.log(
    `${COLORS.cyan}└────────────────────────────────────────────────────────────┘${RESET}`
  );

  let siteUrl = env.NEXT_PUBLIC_SITE_URL || "";
  if (siteUrl) {
    success(`NEXT_PUBLIC_SITE_URL already configured`);
  } else {
    const rl = createPrompt();
    siteUrl = await question(
      rl,
      "Enter your site URL",
      "http://localhost:3000"
    );
    rl.close();
    if (siteUrl) {
      envVars.push({ key: "NEXT_PUBLIC_SITE_URL", value: siteUrl });
      success("NEXT_PUBLIC_SITE_URL saved");
    }
  }

  // Save env vars
  if (envVars.length > 0) {
    // Create .env if it doesn't exist
    const envPath = path.join(cwd, ".env");
    if (!fs.existsSync(envPath)) {
      fs.writeFileSync(envPath, "");
    }

    const updatedFiles = saveToEnvFiles(envVars, cwd);
    if (updatedFiles.length > 0) {
      console.log();
      success(`Saved to ${updatedFiles.join(", ")}`);
    }
  }

  // Show completion and next steps
  complete("INIT COMPLETE", [
    "Files created and environment configured",
  ]);

  nextSteps([
    "Run database migrations:",
    `   ${DIM}npx stripe-no-webhooks migrate${RESET}`,
    "",
    "Edit billing.config.ts with your plans",
    "",
    "Sync plans to Stripe:",
    `   ${DIM}npx stripe-no-webhooks sync${RESET}`,
    "",
    "For local webhook testing, use Stripe CLI:",
    `   ${DIM}stripe listen --forward-to localhost:3000/api/stripe/webhook${RESET}`,
    `   ${DIM}(no webhook secret needed for localhost)${RESET}`,
  ]);

  return { success: true };
}

module.exports = { init };
