import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  setupDev,
  getNextDevPort,
} from "../bin/commands/helpers/dev-webhook-listener.js";
import fs from "fs";
import path from "path";
import os from "os";

describe("getNextDevPort", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dev-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns default port 3000 when no package.json", () => {
    const port = getNextDevPort(tempDir);
    expect(port).toBe("3000");
  });

  test("returns default port 3000 when no custom port in dev script", () => {
    fs.writeFileSync(
      path.join(tempDir, "package.json"),
      JSON.stringify({ scripts: { dev: "next dev" } })
    );
    const port = getNextDevPort(tempDir);
    expect(port).toBe("3000");
  });

  test("extracts port from -p flag", () => {
    fs.writeFileSync(
      path.join(tempDir, "package.json"),
      JSON.stringify({ scripts: { dev: "next dev -p 4000" } })
    );
    const port = getNextDevPort(tempDir);
    expect(port).toBe("4000");
  });

  test("extracts port from --port flag", () => {
    fs.writeFileSync(
      path.join(tempDir, "package.json"),
      JSON.stringify({ scripts: { dev: "next dev --port 5000" } })
    );
    const port = getNextDevPort(tempDir);
    expect(port).toBe("5000");
  });
});

describe("setupDev", () => {
  let tempDir;
  let logs;
  let errors;

  const mockLogger = {
    log: (...args) => logs.push(args.join(" ")),
    error: (...args) => errors.push(args.join(" ")),
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dev-test-"));
    logs = [];
    errors = [];
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns error when package.json not found", async () => {
    const result = await setupDev({
      cwd: tempDir,
      logger: mockLogger,
      exitOnError: false,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("package.json not found");
  });

  test("configures package.json with webhook forwarding", async () => {
    fs.writeFileSync(
      path.join(tempDir, "package.json"),
      JSON.stringify({
        name: "test-app",
        scripts: { dev: "next dev" },
      })
    );

    const result = await setupDev({
      cwd: tempDir,
      logger: mockLogger,
      exitOnError: false,
    });

    expect(result.success).toBe(true);
    expect(result.scripts).toBeDefined();
    expect(result.scripts["dev:stripe"]).toContain("stripe listen");

    // Verify package.json was updated
    const pkg = JSON.parse(
      fs.readFileSync(path.join(tempDir, "package.json"), "utf8")
    );
    expect(pkg.scripts["dev:stripe"]).toContain(
      "localhost:3000/api/stripe/webhook"
    );
    // dev script should be unchanged
    expect(pkg.scripts.dev).toBe("next dev");
  });

  test("uses custom port from existing dev script", async () => {
    fs.writeFileSync(
      path.join(tempDir, "package.json"),
      JSON.stringify({
        name: "test-app",
        scripts: { dev: "next dev -p 4000" },
      })
    );

    const result = await setupDev({
      cwd: tempDir,
      logger: mockLogger,
      exitOnError: false,
    });

    expect(result.success).toBe(true);
    expect(result.scripts["dev:stripe"]).toContain(
      "localhost:4000/api/stripe/webhook"
    );
  });

  test("returns alreadyConfigured when dev:webhooks exists", async () => {
    fs.writeFileSync(
      path.join(tempDir, "package.json"),
      JSON.stringify({
        name: "test-app",
        scripts: {
          dev: "next dev",
          "dev:webhooks": "stripe listen",
        },
      })
    );

    const result = await setupDev({
      cwd: tempDir,
      logger: mockLogger,
      exitOnError: false,
    });

    expect(result.success).toBe(true);
    expect(result.alreadyConfigured).toBe(true);
  });

  test("returns alreadyConfigured when stripe listen in dev script", async () => {
    fs.writeFileSync(
      path.join(tempDir, "package.json"),
      JSON.stringify({
        name: "test-app",
        scripts: {
          dev: "next dev & stripe listen --forward-to localhost:3000",
        },
      })
    );

    const result = await setupDev({
      cwd: tempDir,
      logger: mockLogger,
      exitOnError: false,
    });

    expect(result.success).toBe(true);
    expect(result.alreadyConfigured).toBe(true);
  });

  test("creates scripts object if missing", async () => {
    fs.writeFileSync(
      path.join(tempDir, "package.json"),
      JSON.stringify({ name: "test-app" })
    );

    const result = await setupDev({
      cwd: tempDir,
      logger: mockLogger,
      exitOnError: false,
    });

    expect(result.success).toBe(true);
    expect(result.scripts["dev:stripe"]).toContain("stripe listen");
  });
});
