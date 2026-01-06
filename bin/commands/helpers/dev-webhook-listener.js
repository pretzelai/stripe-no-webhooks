const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function checkStripeCLI() {
  try {
    execSync("stripe --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function getNextDevPort(cwd = process.cwd()) {
  const pkgPath = path.join(cwd, "package.json");

  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      const devScript = pkg.scripts?.dev || "";
      const portMatch = devScript.match(/-p\s*(\d+)|--port\s*(\d+)/);
      if (portMatch) {
        return portMatch[1] || portMatch[2];
      }
    } catch {}
  }

  return "3000";
}

async function setupDev(options = {}) {
  const { cwd = process.cwd(), logger = console, exitOnError = true } = options;

  const pkgPath = path.join(cwd, "package.json");

  if (!fs.existsSync(pkgPath)) {
    logger.error("❌ package.json not found in current directory.");
    if (exitOnError) process.exit(1);
    return { success: false, error: "package.json not found" };
  }

  const hasStripeCLI = checkStripeCLI();
  if (!hasStripeCLI) {
    logger.log("⚠️  Stripe CLI not found. Webhook forwarding will be skipped.");
    logger.log("   Install it from: https://stripe.com/docs/stripe-cli\n");
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

  if (!pkg.scripts) {
    pkg.scripts = {};
  }

  const currentDevScript = pkg.scripts.dev || "next dev";
  const port = getNextDevPort(cwd);
  const webhookUrl = `localhost:${port}/api/stripe/webhook`;

  if (
    pkg.scripts["dev:webhooks"] ||
    currentDevScript.includes("stripe listen")
  ) {
    logger.log("✓ Webhook forwarding already configured in package.json");
    return { success: true, alreadyConfigured: true };
  }

  const stripeListenScript = `if command -v stripe >/dev/null 2>&1; then stripe listen --forward-to ${webhookUrl}; else echo "⚠️  Stripe CLI not available, skipping webhook forwarding"; fi`;

  pkg.scripts["dev:stripe"] = stripeListenScript;

  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  logger.log("✅ Added dev:stripe script to package.json\n");
  logger.log(
    `  npm run dev:stripe - stripe listen --forward-to ${webhookUrl}\n`
  );
  logger.log(`Webhook endpoint: ${webhookUrl}`);

  if (!hasStripeCLI) {
    logger.log(
      "\n⚠️  Note: Install the Stripe CLI to enable webhook forwarding:"
    );
    logger.log("   https://stripe.com/docs/stripe-cli");
  }

  return {
    success: true,
    scripts: {
      "dev:stripe": stripeListenScript,
    },
  };
}

module.exports = {
  setupDev,
  checkStripeCLI,
  getNextDevPort,
};
