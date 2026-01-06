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
    rl.question(prompt, (answer) => {
      resolve(answer || defaultValue);
    });
  });
}

function maskSecretKey(key) {
  if (!key || key.length < 8) return "*****";
  return key.slice(0, 3) + "*****" + key.slice(-4);
}

function questionHidden(rl, query, defaultValue = "") {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    const maskedDefault = defaultValue ? maskSecretKey(defaultValue) : "";
    const prompt = maskedDefault
      ? `${query} (${maskedDefault}): `
      : `${query}: `;
    stdout.write(prompt);

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
        // Ctrl+C
        process.exit();
      } else if (char === "\u007F" || char === "\b") {
        // Backspace
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
    if (fs.existsSync(envPath)) {
      let content = fs.readFileSync(envPath, "utf8");

      for (const { key, value } of envVars) {
        const line = `${key}=${value}`;
        const regex = new RegExp(`^${key}=.*`, "m");

        if (regex.test(content)) {
          content = content.replace(regex, line);
        } else {
          const newline = content.endsWith("\n") ? "" : "\n";
          content = content + newline + line + "\n";
        }
      }

      fs.writeFileSync(envPath, content);
      updatedFiles.push(envFile);
    }
  }

  return updatedFiles;
}

function getTemplatesDir() {
  return path.join(__dirname, "..", "..", "src", "templates");
}

function getAppRouterTemplate() {
  const templatePath = path.join(getTemplatesDir(), "app-router.ts");
  return fs.readFileSync(templatePath, "utf8");
}

function getPagesRouterTemplate() {
  const templatePath = path.join(getTemplatesDir(), "pages-router.ts");
  return fs.readFileSync(templatePath, "utf8");
}

function detectRouterType(cwd = process.cwd()) {
  const hasAppDir = fs.existsSync(path.join(cwd, "app"));
  const hasPagesDir = fs.existsSync(path.join(cwd, "pages"));
  const hasSrcAppDir = fs.existsSync(path.join(cwd, "src", "app"));
  const hasSrcPagesDir = fs.existsSync(path.join(cwd, "src", "pages"));

  if (hasAppDir || hasSrcAppDir) {
    return { type: "app", useSrc: hasSrcAppDir && !hasAppDir };
  }

  if (hasPagesDir || hasSrcPagesDir) {
    return { type: "pages", useSrc: hasSrcPagesDir && !hasPagesDir };
  }

  return { type: "app", useSrc: false };
}

function createApiRoute(routerType, useSrc, cwd = process.cwd()) {
  const baseDir = useSrc ? path.join(cwd, "src") : cwd;

  if (routerType === "app") {
    const routeDir = path.join(baseDir, "app", "api", "stripe", "[...all]");
    const routeFile = path.join(routeDir, "route.ts");
    fs.mkdirSync(routeDir, { recursive: true });

    let template = getAppRouterTemplate();
    template = template.replace(
      /^\/\/ app\/api\/stripe\/\[\.\.\.all\]\/route\.ts\n/,
      ""
    );

    fs.writeFileSync(routeFile, template);

    const prefix = useSrc ? "src/" : "";
    return `${prefix}app/api/stripe/[...all]/route.ts`;
  } else {
    const routeDir = path.join(baseDir, "pages", "api", "stripe");
    const routeFile = path.join(routeDir, "[...all].ts");

    fs.mkdirSync(routeDir, { recursive: true });

    let template = getPagesRouterTemplate();
    template = template.replace(
      /^\/\/ pages\/api\/stripe\/\[\.\.\.all\]\.ts\n/,
      ""
    );
    fs.writeFileSync(routeFile, template);

    const prefix = useSrc ? "src/" : "";
    return `${prefix}pages/api/stripe/[...all].ts`;
  }
}

function getMode(stripeKey) {
  if (stripeKey.includes("_test_")) {
    return "test";
  } else if (stripeKey.includes("_live_")) {
    return "production";
  } else {
    throw new Error("Invalid Stripe key");
  }
}

function loadStripe() {
  try {
    return require("stripe").default || require("stripe");
  } catch (e) {
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
  getAppRouterTemplate,
  getPagesRouterTemplate,
  detectRouterType,
  createApiRoute,
  getMode,
  loadStripe,
};
