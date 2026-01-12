const fs = require("fs");
const path = require("path");
const { getTemplatesDir, detectRouterType } = require("./helpers/utils");

const GENERATORS = {
  "pricing-page": {
    description: "A ready-to-use pricing page component with embedded styles",
    template: "PricingPage.tsx",
    defaultOutput: "components/PricingPage.tsx",
  },
};

async function generate(component, options = {}) {
  const {
    cwd = process.cwd(),
    logger = console,
    output,
  } = options;

  if (!component) {
    logger.log("\nUsage: npx stripe-no-webhooks generate <component>\n");
    logger.log("Available components:");
    for (const [name, config] of Object.entries(GENERATORS)) {
      logger.log(`  ${name.padEnd(20)} ${config.description}`);
    }
    logger.log("\nExample:");
    logger.log("  npx stripe-no-webhooks generate pricing-page");
    logger.log("  npx stripe-no-webhooks generate pricing-page --output src/components/Pricing.tsx");
    return { success: false };
  }

  const generator = GENERATORS[component];
  if (!generator) {
    logger.error(`\n❌ Unknown component: ${component}`);
    logger.log("\nAvailable components:");
    for (const name of Object.keys(GENERATORS)) {
      logger.log(`  ${name}`);
    }
    return { success: false, error: `Unknown component: ${component}` };
  }

  const { useSrc } = detectRouterType(cwd);

  // Determine output path
  let outputPath;
  if (output) {
    outputPath = path.isAbsolute(output) ? output : path.join(cwd, output);
  } else {
    const defaultOutput = useSrc
      ? `src/${generator.defaultOutput}`
      : generator.defaultOutput;
    outputPath = path.join(cwd, defaultOutput);
  }

  // Check if file already exists
  if (fs.existsSync(outputPath)) {
    logger.log(`\n⚠️  File already exists: ${path.relative(cwd, outputPath)}`);
    logger.log("   Use --output to specify a different path");
    return { success: false, error: "File already exists" };
  }

  // Read template
  const templatesDir = getTemplatesDir();
  const templatePath = path.join(templatesDir, generator.template);

  if (!fs.existsSync(templatePath)) {
    logger.error(`\n❌ Template not found: ${generator.template}`);
    return { success: false, error: "Template not found" };
  }

  const template = fs.readFileSync(templatePath, "utf8");

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Write file
  fs.writeFileSync(outputPath, template);

  const relativePath = path.relative(cwd, outputPath);
  logger.log(`\n✅ Created ${relativePath}\n`);

  // Print usage instructions
  logger.log("Usage:");
  logger.log("─".repeat(50));
  logger.log(`
import { PricingPage } from "./${path.relative(path.join(cwd, useSrc ? "src" : ""), outputPath).replace(/\\/g, "/").replace(/\.tsx$/, "")}";
import billingConfig from "@/billing.config";

// Get plans for your environment
const plans = billingConfig.test?.plans || [];

// In your page:
export default function PricingRoute() {
  return (
    <PricingPage
      plans={plans}
      currentPlanId="free"  // Pass the user's current plan
    />
  );
}
`);
  logger.log("─".repeat(50));

  return { success: true, path: outputPath };
}

module.exports = { generate };
