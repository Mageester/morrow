import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { configureProvider, removeProviderCredentials, parseSecretsFile } from "../src/provider/secrets.js";

const PROVIDER_KEYS = [
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "DEEPSEEK_MODEL",
  "DEEPSEEK_CONTEXT_LIMIT",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
];

describe("provider configuration (secrets module)", () => {
  let dir: string;
  let secretsFile: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "morrow-secrets-"));
    secretsFile = join(dir, "secrets.env");
    env = {};
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("persists a key to the file and hot-applies it to env (no restart)", () => {
    const res = configureProvider(secretsFile, "deepseek", { apiKey: "sk-deepseek-123" }, env);
    expect(res.written).toContain("DEEPSEEK_API_KEY");
    expect(env.DEEPSEEK_API_KEY).toBe("sk-deepseek-123"); // applied immediately
    const onDisk = parseSecretsFile(readFileSync(secretsFile, "utf-8"));
    expect(onDisk.DEEPSEEK_API_KEY).toBe("sk-deepseek-123");
  });

  it("stores a default model and base url", () => {
    configureProvider(secretsFile, "deepseek", { apiKey: "k", model: "deepseek-reasoner", baseUrl: "https://api.deepseek.com/v1" }, env);
    expect(env.DEEPSEEK_MODEL).toBe("deepseek-reasoner");
    expect(env.DEEPSEEK_BASE_URL).toBe("https://api.deepseek.com/v1");
  });

  it("stores, hot-applies, and removes an endpoint context limit", () => {
    const configured = configureProvider(secretsFile, "deepseek", {
      endpointContextLimit: 131_072,
    }, env);
    expect(configured.written).toContain("DEEPSEEK_CONTEXT_LIMIT");
    expect(env.DEEPSEEK_CONTEXT_LIMIT).toBe("131072");
    expect(parseSecretsFile(readFileSync(secretsFile, "utf-8")).DEEPSEEK_CONTEXT_LIMIT).toBe("131072");

    const removed = removeProviderCredentials(secretsFile, "deepseek", env);
    expect(removed.removed).toContain("DEEPSEEK_CONTEXT_LIMIT");
    expect(env.DEEPSEEK_CONTEXT_LIMIT).toBeUndefined();
  });

  it("rejects invalid endpoint context limits without partial state", () => {
    expect(() => configureProvider(secretsFile, "deepseek", {
      apiKey: "would-be-partial",
      endpointContextLimit: 0,
    }, env)).toThrow(/positive safe integer/i);
    expect(() => configureProvider(secretsFile, "deepseek", {
      endpointContextLimit: 131_072.5,
    }, env)).toThrow(/positive safe integer/i);
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(existsSync(secretsFile)).toBe(false);
  });

  it("clears a value when given an empty string", () => {
    configureProvider(secretsFile, "deepseek", { apiKey: "k" }, env);
    const res = configureProvider(secretsFile, "deepseek", { apiKey: "" }, env);
    expect(res.cleared).toContain("DEEPSEEK_API_KEY");
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    const onDisk = parseSecretsFile(readFileSync(secretsFile, "utf-8"));
    expect(onDisk.DEEPSEEK_API_KEY).toBeUndefined();
  });

  it("reports when a saved value is shadowed by a pre-existing different env var", () => {
    env.DEEPSEEK_API_KEY = "from-shell";
    const res = configureProvider(secretsFile, "deepseek", { apiKey: "from-app" }, env);
    expect(res.shadowedByEnv).toContain("DEEPSEEK_API_KEY");
    expect(env.DEEPSEEK_API_KEY).toBe("from-app"); // still applied for this process
  });

  it("removes all provider credentials from file and env", () => {
    configureProvider(secretsFile, "deepseek", { apiKey: "k", model: "deepseek-chat" }, env);
    const res = removeProviderCredentials(secretsFile, "deepseek", env);
    expect(res.removed).toEqual(expect.arrayContaining(["DEEPSEEK_API_KEY", "DEEPSEEK_MODEL"]));
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(parseSecretsFile(readFileSync(secretsFile, "utf-8")).DEEPSEEK_API_KEY).toBeUndefined();
  });

  it("does not clobber another provider's saved keys", () => {
    configureProvider(secretsFile, "openai", { apiKey: "openai-k" }, env);
    configureProvider(secretsFile, "deepseek", { apiKey: "deepseek-k" }, env);
    const onDisk = parseSecretsFile(readFileSync(secretsFile, "utf-8"));
    expect(onDisk.OPENAI_API_KEY).toBe("openai-k");
    expect(onDisk.DEEPSEEK_API_KEY).toBe("deepseek-k");
  });

  it("rejects a value containing a newline so it cannot smuggle extra env vars into the file", () => {
    // A value with a line break would split into a second `KEY=VALUE` line on the
    // next read, letting an apiKey write inject an unrelated var (e.g. redirect a
    // provider's base URL to an attacker). Reject it; nothing must be persisted.
    expect(() =>
      configureProvider(secretsFile, "openai", { apiKey: "sk-abc\nOPENAI_BASE_URL=http://attacker.example/v1" }, env)
    ).toThrow(/control character/i);
    expect(existsSync(secretsFile)).toBe(false); // no partial write
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENAI_BASE_URL).toBeUndefined(); // the smuggled var never lands
  });

  it("rejects carriage returns and other control characters in any field", () => {
    expect(() => configureProvider(secretsFile, "openai", { model: "gpt\r\nINJECT=1" }, env)).toThrow(/control character/i);
    expect(() => configureProvider(secretsFile, "openai", { apiKey: "tab\there" }, env)).toThrow(/control character/i);
  });

  it("validates all fields before applying any, so a bad field leaves no partial state", () => {
    expect(() =>
      configureProvider(secretsFile, "deepseek", { apiKey: "good-key", model: "bad\nmodel" }, env)
    ).toThrow(/control character/i);
    expect(env.DEEPSEEK_API_KEY).toBeUndefined(); // earlier good field not applied
    expect(existsSync(secretsFile)).toBe(false);
  });
});

describe("provider configuration API (DeepSeek acceptance flow)", () => {
  let db: Database.Database;
  let app: FastifyInstance;
  let dir: string;
  let secretsFile: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const k of PROVIDER_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    dir = mkdtempSync(join(tmpdir(), "morrow-api-secrets-"));
    secretsFile = join(dir, "secrets.env");
    db = openDatabase(":memory:");
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}), secretsFile });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
    for (const k of PROVIDER_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  async function json(method: string, url: string, payload?: any) {
    const res = await app.inject({ method: method as any, url, ...(payload ? { payload } : {}) });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
  }

  it("configures DeepSeek from the app, marking it configured without a restart", async () => {
    const before = (await json("GET", "/api/providers")).body.find((p: any) => p.id === "deepseek");
    expect(before.configured).toBe(false);

    const res = await json("POST", "/api/providers/deepseek/configure", { apiKey: "sk-accept-test" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status.configured).toBe(true);
    // Secret is never echoed back.
    expect(JSON.stringify(res.body)).not.toContain("sk-accept-test");

    const after = (await json("GET", "/api/providers")).body.find((p: any) => p.id === "deepseek");
    expect(after.configured).toBe(true);
  });

  it("sets a default model that shows up in provider status", async () => {
    await json("POST", "/api/providers/deepseek/configure", { apiKey: "k" });
    const res = await json("POST", "/api/providers/deepseek/configure", { model: "deepseek-reasoner" });
    expect(res.body.status.defaultModel).toBe("deepseek-reasoner");
  });

  it("accepts an endpoint context limit", async () => {
    const res = await json("POST", "/api/providers/deepseek/configure", {
      endpointContextLimit: 131_072,
    });
    expect(res.status).toBe(200);
    expect(process.env.DEEPSEEK_CONTEXT_LIMIT).toBe("131072");
  });

  it("removes credentials and reverts to not-configured", async () => {
    await json("POST", "/api/providers/deepseek/configure", { apiKey: "k" });
    const del = await json("DELETE", "/api/providers/deepseek/credentials");
    expect(del.status).toBe(200);
    expect(del.body.status.configured).toBe(false);
  });

  it("rejects an unknown provider", async () => {
    const res = await json("POST", "/api/providers/not-real/configure", { apiKey: "k" });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid base URL", async () => {
    const res = await json("POST", "/api/providers/deepseek/configure", { baseUrl: "not a url" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_BASE_URL");
  });

  it("rejects an empty configure payload", async () => {
    const res = await json("POST", "/api/providers/deepseek/configure", {});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("EMPTY_CONFIGURE");
  });

  it("reports unavailable when no secrets file is wired", async () => {
    const app2 = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
    await app2.ready();
    const res = await app2.inject({ method: "POST", url: "/api/providers/deepseek/configure", payload: { apiKey: "k" } });
    expect(res.statusCode).toBe(503);
    await app2.close();
  });
});
