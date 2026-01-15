/**
 * Output formatting helpers for consistent CLI output
 */

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

const COLORS = {
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};

/**
 * Print a header box with title
 */
function header(title, subtitle = null) {
  const width = 60;
  const top = `┌${"─".repeat(width - 2)}┐`;
  const bottom = `└${"─".repeat(width - 2)}┘`;

  console.log();
  console.log(top);
  console.log(`│  ${BOLD}${title}${RESET}${" ".repeat(width - title.length - 4)}│`);
  if (subtitle) {
    console.log(`│  ${DIM}${subtitle}${RESET}${" ".repeat(width - subtitle.length - 4)}│`);
  }
  console.log(bottom);
  console.log();
}

/**
 * Print a mode indicator box (TEST MODE or PRODUCTION MODE)
 */
function modeBox(mode, key, configSection = null) {
  const width = 60;
  const isProduction = mode === "production";
  const color = isProduction ? COLORS.red : COLORS.yellow;
  const modeLabel = isProduction ? "PRODUCTION MODE" : "TEST MODE";

  const maskedKey = key ? `${key.slice(0, 7)}...${key.slice(-4)}` : "not set";
  const configLine = configSection
    ? `Config: billing.config.ts → ${configSection}`
    : null;

  const top = `┌${"─".repeat(width - 2)}┐`;
  const mid = `├${"─".repeat(width - 2)}┤`;
  const bottom = `└${"─".repeat(width - 2)}┘`;

  console.log();
  console.log(color + top + RESET);
  console.log(color + `│  ${BOLD}${modeLabel}${RESET}${color}${" ".repeat(width - modeLabel.length - 4)}│` + RESET);
  console.log(color + mid + RESET);
  console.log(color + `│  Key: ${maskedKey}${" ".repeat(width - maskedKey.length - 8)}│` + RESET);
  if (configLine) {
    console.log(color + `│  ${configLine}${" ".repeat(width - configLine.length - 4)}│` + RESET);
  }
  console.log(color + bottom + RESET);
  console.log();
}

/**
 * Print a prominent webhook secret box
 */
function webhookSecretBox(secret, environment) {
  const width = 62;

  console.log();
  console.log(COLORS.green + "┏" + "━".repeat(width - 2) + "┓" + RESET);
  console.log(COLORS.green + "┃" + " ".repeat(width - 2) + "┃" + RESET);
  console.log(
    COLORS.green +
      "┃  " +
      BOLD +
      "WEBHOOK SECRET" +
      RESET +
      COLORS.green +
      " ".repeat(width - 18) +
      "┃" +
      RESET
  );
  console.log(COLORS.green + "┃" + " ".repeat(width - 2) + "┃" + RESET);
  console.log(
    COLORS.green +
      "┃  " +
      RESET +
      secret +
      COLORS.green +
      " ".repeat(Math.max(0, width - secret.length - 4)) +
      "┃" +
      RESET
  );
  console.log(COLORS.green + "┃" + " ".repeat(width - 2) + "┃" + RESET);
  console.log(COLORS.green + "┠" + "─".repeat(width - 2) + "┨" + RESET);
  console.log(COLORS.green + "┃" + " ".repeat(width - 2) + "┃" + RESET);

  const instruction = `Add to your ${environment} environment variables:`;
  console.log(
    COLORS.green +
      "┃  " +
      RESET +
      instruction +
      COLORS.green +
      " ".repeat(width - instruction.length - 4) +
      "┃" +
      RESET
  );

  const envVar = `STRIPE_WEBHOOK_SECRET=${secret.slice(0, 20)}...`;
  console.log(
    COLORS.green +
      "┃  " +
      RESET +
      DIM +
      envVar +
      RESET +
      COLORS.green +
      " ".repeat(width - envVar.length - 4) +
      "┃" +
      RESET
  );
  console.log(COLORS.green + "┃" + " ".repeat(width - 2) + "┃" + RESET);
  console.log(COLORS.green + "┗" + "━".repeat(width - 2) + "┛" + RESET);
  console.log();
}

/**
 * Print a local development notice
 */
function localDevNotice(port = 3000) {
  console.log();
  console.log(`  ${COLORS.cyan}${BOLD}LOCAL DEVELOPMENT${RESET}`);
  console.log();
  console.log(`  ${DIM}Your site URL is localhost.${RESET}`);
  console.log(`  ${DIM}For webhook testing, use Stripe CLI:${RESET}`);
  console.log();
  console.log(`  ${COLORS.yellow}$${RESET} stripe listen --forward-to localhost:${port}/api/stripe/webhook`);
  console.log();
  console.log(`  ${COLORS.green}✓${RESET} No webhook secret needed - verification is skipped automatically.`);
  console.log();
}

/**
 * Print success message
 */
function success(message) {
  console.log(`${COLORS.green}✓${RESET} ${message}`);
}

/**
 * Print error message
 */
function error(message) {
  console.log(`${COLORS.red}✗${RESET} ${message}`);
}

/**
 * Print warning message
 */
function warning(message) {
  console.log(`${COLORS.yellow}⚠${RESET} ${message}`);
}

/**
 * Print info message
 */
function info(message) {
  console.log(`${COLORS.cyan}ℹ${RESET} ${message}`);
}

/**
 * Print a step message (for progress)
 */
function step(message) {
  console.log(`${DIM}→${RESET} ${message}`);
}

/**
 * Print a divider line
 */
function divider() {
  console.log();
  console.log(DIM + "─".repeat(60) + RESET);
  console.log();
}

/**
 * Print next steps section
 */
function nextSteps(steps) {
  console.log();
  console.log(`${BOLD}Next steps:${RESET}`);
  console.log();
  steps.forEach((s) => {
    console.log(`  ${s}`);
  });
  console.log();
}

/**
 * Print a completion box
 */
function complete(title, items = []) {
  const width = 60;
  const top = `┌${"─".repeat(width - 2)}┐`;
  const mid = `├${"─".repeat(width - 2)}┤`;
  const bottom = `└${"─".repeat(width - 2)}┘`;

  console.log();
  console.log(COLORS.green + top + RESET);
  console.log(
    COLORS.green + `│  ${BOLD}✓ ${title}${RESET}${COLORS.green}${" ".repeat(width - title.length - 6)}│` + RESET
  );

  if (items.length > 0) {
    console.log(COLORS.green + mid + RESET);
    items.forEach((item) => {
      const line = `│  ${item}`;
      console.log(COLORS.green + line + " ".repeat(width - item.length - 4) + "│" + RESET);
    });
  }

  console.log(COLORS.green + bottom + RESET);
  console.log();
}

module.exports = {
  header,
  modeBox,
  webhookSecretBox,
  localDevNotice,
  success,
  error,
  warning,
  info,
  step,
  divider,
  nextSteps,
  complete,
  COLORS,
  RESET,
  BOLD,
  DIM,
};
