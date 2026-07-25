import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "OPENROUTER_MODEL",
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

  it("uses a Windows user ACL boundary and reports the protection without exposing values", () => {
    const acl = vi.fn(() => true);
    const res = (configureProvider as any)(secretsFile, "openrouter", { apiKey: "windows-local-secret" }, env, {
      platform: "win32",
      applyWindowsAcl: acl,
    });
    expect(acl).toHaveBeenCalledOnce();
    expect(res).toMatchObject({ securePermissions: true, credentialProtection: "windows-user-acl" });
    expect(JSON.stringify(res)).not.toContain("windows-local-secret");
  });
});

describe("OpenRouter authenticated configuration", () => {
  let db: Database.Database;
  let app: FastifyInstance;
  let dir: string;
  let secretsFile: string;
  let connectivity: ReturnType<typeof vi.fn>;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const key of PROVIDER_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    dir = mkdtempSync(join(tmpdir(), "morrow-openrouter-secrets-"));
    secretsFile = join(dir, "secrets.env");
    db = openDatabase(":memory:");
    connectivity = vi.fn(async (_id: string, candidateEnv: NodeJS.ProcessEnv) => {
      const accepted = candidateEnv.OPENROUTER_API_KEY === "last-known-good";
      return {
        id: "openrouter", ok: accepted, configured: true, status: accepted ? 200 : 401,
        latencyMs: 1, checkedEndpoint: "openrouter.ai", detail: accepted ? "connected" : "rejected",
        errorKind: accepted ? null : "auth", modelsSample: accepted ? ["vendor/live"] : [],
        models: accepted ? [{ providerModelId: "vendor/live", displayName: "Live", author: "vendor", contextWindow: 100_000, maxOutputTokens: 8_000, inputModalities: ["text"], outputModalities: ["text"], capabilities: { streaming: true, toolCalls: true, vision: false, reasoning: false }, pricing: null, costType: "unknown", availability: "available", fetchedAt: "2026-07-22T12:00:00.000Z", metadataSource: "provider-reported" }] : [],
      };
    });
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}), secretsFile, providerConnectivityTest: connectivity as any, backgroundModelDiscovery: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
    for (const key of PROVIDER_KEYS) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });

  it("authenticates a candidate key before persisting and promoting it", async () => {
    const response = await app.inject({ method: "POST", url: "/api/providers/openrouter/configure", payload: { apiKey: "last-known-good", model: "vendor/live" } });
    expect(response.statusCode).toBe(200);
    expect(connectivity).toHaveBeenCalledWith("openrouter", expect.objectContaining({ OPENROUTER_API_KEY: "last-known-good", OPENROUTER_MODEL: "vendor/live" }));
    expect(process.env.OPENROUTER_API_KEY).toBe("last-known-good");
    expect(parseSecretsFile(readFileSync(secretsFile, "utf-8")).OPENROUTER_API_KEY).toBe("last-known-good");
    expect(JSON.stringify(response.json())).not.toContain("last-known-good");
    expect(response.json().status).toMatchObject({ configured: true, available: true, defaultModel: "vendor/live" });
  });

  it("preserves the last known-good credential when replacement validation fails", async () => {
    expect((await app.inject({ method: "POST", url: "/api/providers/openrouter/configure", payload: { apiKey: "last-known-good" } })).statusCode).toBe(200);
    const response = await app.inject({ method: "POST", url: "/api/providers/openrouter/configure", payload: { apiKey: "replacement-rejected" } });
    expect(response.statusCode).toBe(401);
    expect(process.env.OPENROUTER_API_KEY).toBe("last-known-good");
    expect(parseSecretsFile(readFileSync(secretsFile, "utf-8")).OPENROUTER_API_KEY).toBe("last-known-good");
    expect(response.json().error.code).toBe("PROVIDER_VALIDATION_FAILED");
    expect(JSON.stringify(response.json())).not.toMatch(/last-known-good|replacement-rejected/);
  });

  it("rejects every OpenRouter endpoint override before an existing key can be sent elsewhere", async () => {
    expect((await app.inject({ method: "POST", url: "/api/providers/openrouter/configure", payload: { apiKey: "last-known-good" } })).statusCode).toBe(200);
    connectivity.mockClear();

    for (const baseUrl of ["http://attacker.invalid/v1", "https://attacker.invalid/v1"]) {
      const response = await app.inject({ method: "POST", url: "/api/providers/openrouter/configure", payload: { baseUrl } });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("OPENROUTER_ENDPOINT_PINNED");
    }

    expect(connectivity).not.toHaveBeenCalled();
    expect(process.env.OPENROUTER_API_KEY).toBe("last-known-good");
    expect(process.env.OPENROUTER_BASE_URL).toBeUndefined();
    expect(parseSecretsFile(readFileSync(secretsFile, "utf-8")).OPENROUTER_API_KEY).toBe("last-known-good");
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
    // Configuring a provider now verifies the candidate credential against the
    // provider before persisting it, so these tests must stub the endpoint.
    // They previously issued real requests to api.deepseek.com, which is what
    // made this file intermittently fail with network errors.
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-pro" }] })));
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}), secretsFile });
    await app.ready();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
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
    expect(del.body.removed).toEqual(expect.arrayContaining(["DEEPSEEK_API_KEY"]));
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


describe("every provider is verified before its credential is stored", () => {
  let db: Database.Database;
  let app: FastifyInstance;
  let dir: string;
  let secretsFile: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const k of [...PROVIDER_KEYS, "GROQ_API_KEY", "GROQ_MODEL", "LMSTUDIO_BASE_URL"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    dir = mkdtempSync(join(tmpdir(), "morrow-verify-"));
    secretsFile = join(dir, "secrets.env");
    db = openDatabase(":memory:");
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}), secretsFile });
    await app.ready();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  const post = async (url: string, payload: unknown) => {
    const res = await app.inject({ method: "POST", url, payload: payload as any });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
  };

  /**
   * Verify-before-persist used to run for OpenRouter alone. Every other
   * provider stored whatever it was handed and then reported "connected", so a
   * mistyped key silently replaced a working one and the user only found out on
   * their next real request.
   */
  it("rejects a bad key without destroying the working one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "llama-3.3-70b" }] })));
    expect((await post("/api/providers/groq/configure", { apiKey: "good-key" })).status).toBe(200);
    expect(process.env.GROQ_API_KEY).toBe("good-key");

    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    const rejected = await post("/api/providers/groq/configure", { apiKey: "typo-key" });

    expect(rejected.status).toBe(401);
    expect(rejected.body.error.code).toBe("PROVIDER_VALIDATION_FAILED");
    expect(JSON.stringify(rejected.body)).not.toMatch(/good-key|typo-key/);
    // The working credential survives the failed replacement.
    expect(process.env.GROQ_API_KEY).toBe("good-key");
  });

  it("records the models a credential can reach, so the provider is usable at once", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "llama-3.3-70b" }, { id: "mixtral" }] })));
    await post("/api/providers/groq/configure", { apiKey: "good-key" });

    const res = await app.inject({ method: "GET", url: "/api/providers" });
    const groq = JSON.parse(res.body).find((p: any) => p.id === "groq");
    expect(groq.configured).toBe(true);
    // Without discovery-on-configure this list stays empty until a separate
    // refresh, leaving a freshly connected provider with no selectable model.
    expect(groq.models).toEqual(expect.arrayContaining(["llama-3.3-70b", "mixtral"]));
  });

  /**
   * A local server is opt-in by URL and is routinely pointed at before it is
   * started. Refusing to save the address because nothing is listening yet
   * would make it impossible to configure ahead of time.
   */
  it("still lets a local server be configured before it is running", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const res = await post("/api/providers/lmstudio/configure", { baseUrl: "http://127.0.0.1:1234/v1" });

    expect(res.status).toBe(200);
    expect(process.env.LMSTUDIO_BASE_URL).toBe("http://127.0.0.1:1234/v1");
  });

  it("does not let an unreachable hosted provider overwrite a stored key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "m" }] })));
    await post("/api/providers/groq/configure", { apiKey: "good-key" });

    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const res = await post("/api/providers/groq/configure", { apiKey: "replacement" });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("PROVIDER_VALIDATION_FAILED");
    expect(process.env.GROQ_API_KEY).toBe("good-key");
  });
});


describe("configuration that is not a credential", () => {
  /**
   * Setting a default model or a context limit touches nothing a provider could
   * reject. Requiring a live check for those made them impossible to save on a
   * provider that was not connected yet, or whenever the network was down.
   */
  it("saves a model and a context limit without a network round trip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morrow-noverify-"));
    const db = openDatabase(":memory:");
    const app = buildServer({ db, runner: new TaskRunner(db, async () => {}), secretsFile: join(dir, "secrets.env") });
    await app.ready();
    const fetchSpy = vi.fn(async () => { throw new Error("no network call should happen"); });
    vi.stubGlobal("fetch", fetchSpy);
    const savedLimit = process.env.DEEPSEEK_CONTEXT_LIMIT;
    delete process.env.DEEPSEEK_CONTEXT_LIMIT;
    try {
      const res = await app.inject({ method: "POST", url: "/api/providers/deepseek/configure", payload: { endpointContextLimit: 131_072 } });
      expect(res.statusCode).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      if (savedLimit === undefined) delete process.env.DEEPSEEK_CONTEXT_LIMIT; else process.env.DEEPSEEK_CONTEXT_LIMIT = savedLimit;
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
