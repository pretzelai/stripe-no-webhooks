const readline = require("readline");
const fs = require("fs");
const path = require("path");

function createPrompt() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function question(rl, query, defaultValue = "") {
  return new Promise((resolve) => {
    const prompt = defaultValue ? `${query} (${defaultValue}): ` : `${query}: `;
    rl.question(prompt, (answer) => resolve(answer || defaultValue));
  });
}

function maskSecretKey(key) {
  return !key || key.length < 8
    ? "*****"
    : key.slice(0, 3) + "*****" + key.slice(-4);
}

function questionHidden(rl, query, defaultValue = "") {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    const maskedDefault = defaultValue ? maskSecretKey(defaultValue) : "";
    stdout.write(
      maskedDefault ? `${query} (${maskedDefault}): ` : `${query}: `
    );

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
        resolve(input || defaultValue);
      } else if (char === "\u0003") {
        process.exit();
      } else if (char === "\u007F" || char === "\b") {
        if (input.length > 0) {
          input = input.slice(0, -1);
          stdout.write("\b \b");
        }
      } else {
        input += char;
        stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

function saveToEnvFiles(envVars, cwd = process.cwd()) {
  const envFiles = [
    ".env",
    ".env.local",
    ".env.development",
    ".env.production",
  ];
  const updatedFiles = [];

  for (const envFile of envFiles) {
    const envPath = path.join(cwd, envFile);
    if (!fs.existsSync(envPath)) continue;

    let content = fs.readFileSync(envPath, "utf8");
    for (const { key, value } of envVars) {
      const regex = new RegExp(`^${key}=.*`, "m");
      content = regex.test(content)
        ? content.replace(regex, `${key}=${value}`)
        : content + (content.endsWith("\n") ? "" : "\n") + `${key}=${value}\n`;
    }
    fs.writeFileSync(envPath, content);
    updatedFiles.push(envFile);
  }
  return updatedFiles;
}

function getTemplatesDir() {
  return path.join(__dirname, "..", "..", "..", "src", "templates");
}

function writeTemplate({
  templateName,
  destPath,
  cwd = process.cwd(),
  overwrite = false,
  transform,
  routerType = null,
  inProjectRoot = false,
}) {
  const detected = detectRouterType(cwd);
  const type = routerType || detected.type;
  const useSrc = inProjectRoot ? false : detected.useSrc;

  const baseDir = path.join(cwd, useSrc ? "src" : "");
  const absPath = path.join(baseDir, destPath);
  const relativePath = (useSrc ? "src/" : "") + destPath;

  if (fs.existsSync(absPath) && !overwrite) {
    return { created: false, path: relativePath, routerType: type };
  }

  const template = fs.readFileSync(
    path.join(getTemplatesDir(), templateName),
    "utf8"
  );
  const content = transform ? transform(template) : template;

  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);

  return { created: true, path: relativePath, routerType: type };
}

function detectRouterType(cwd = process.cwd()) {
  const hasAppDir = fs.existsSync(path.join(cwd, "app"));
  const hasSrcAppDir = fs.existsSync(path.join(cwd, "src", "app"));
  const hasPagesDir = fs.existsSync(path.join(cwd, "pages"));
  const hasSrcPagesDir = fs.existsSync(path.join(cwd, "src", "pages"));

  if (hasAppDir || hasSrcAppDir)
    return { type: "app", useSrc: hasSrcAppDir && !hasAppDir };
  if (hasPagesDir || hasSrcPagesDir)
    return { type: "pages", useSrc: hasSrcPagesDir && !hasPagesDir };
  return { type: "app", useSrc: false };
}

function isValidStripeKey(key) {
  return key && /^(sk|rk)_(live|test)_/.test(key);
}

function getMode(stripeKey) {
  if (stripeKey.includes("_test_")) return "test";
  if (stripeKey.includes("_live_")) return "production";
  throw new Error("Invalid Stripe key");
}

function loadStripe() {
  try {
    return require("stripe").default || require("stripe");
  } catch {
    return null;
  }
}

module.exports = {
  createPrompt,
  question,
  maskSecretKey,
  questionHidden,
  saveToEnvFiles,
  getTemplatesDir,
  writeTemplate,
  detectRouterType,
  isValidStripeKey,
  getMode,
  loadStripe,
};
