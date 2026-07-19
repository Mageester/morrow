import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { OPENAI_CHAT_KEY_SPECS } from "../src/provider/openai-chat-specs.js";
import { providerEnvMapping } from "../src/provider/secrets.js";
import type { FastifyInstance } from "fastify";

describe("Provider / preset / memory API", () => {
  let db: Database.Database;
  let app: FastifyInstance;
  const savedMock = process.env.MOCK_PROVIDER;

  beforeEach(async () => {
    delete process.env.MOCK_PROVIDER;
    db = openDatabase(":memory:");
    // No-op executor: we assert persisted routing without running the agent.
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}), backgroundModelDiscovery: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    if (savedMock === undefined) delete process.env.MOCK_PROVIDER;
    else process.env.MOCK_PROVIDER = savedMock;
  });

  async function json(method: string, url: string, payload?: any) {
    const res = await app.inject({ method: method as any, url, ...(payload ? { payload } : {}) });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
  }

  it("lists provider statuses without leaking secrets", async () => {
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-route-leak-test";
    try {
      const { status, body } = await json("GET", "/api/providers");
      expect(status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(7);
      expect(JSON.stringify(body)).not.toContain("sk-route-leak-test");
      expect(body.find((p: any) => p.id === "openai").capabilities).toBeTruthy();
      expect(body.find((p: any) => p.id === "openai").authMode).toBe("openai-api-key");
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });

  it("does not claim account model availability from credentials alone and persists provider discovery", async () => {
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-model-discovery-test";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: "gpt-5.6-sol" }, { id: "account-fine-tune" }],
    }), { status: 200 }));
    try {
      const before = (await json("GET", "/api/models")).body;
      const beforeSol = before.find((item: any) => item.model.id === "gpt-5.6-sol");
      expect(beforeSol).toMatchObject({ available: false, availability: "unknown", authMode: "openai-api-key" });

      const tested = await json("POST", "/api/providers/openai/test");
      expect(tested.status).toBe(200);
      expect(tested.body.models.map((model: any) => model.providerModelId)).toEqual(["gpt-5.6-sol", "account-fine-tune"]);

      const after = (await json("GET", "/api/models")).body;
      expect(after.find((item: any) => item.model.id === "gpt-5.6-sol")).toMatchObject({
        available: true,
        availability: "available",
        availabilitySource: "provider-reported",
      });
      expect(after.find((item: any) => item.model.id === "account-fine-tune")).toMatchObject({
        available: true,
        model: { builtIn: false, contextWindow: null, metadataSource: "provider-reported" },
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
    }
  });

  it("refreshes configured account models in the background without blocking startup", async () => {
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-background-discovery-test";
    const backgroundDb = openDatabase(":memory:");
    const connectivity = vi.fn(async (id: any) => ({
      id,
      ok: true,
      configured: true,
      status: 200,
      latencyMs: 1,
      checkedEndpoint: "api.example.test",
      detail: "connected",
      errorKind: null,
      modelsSample: ["account-background-model"],
      models: [{
        providerModelId: "account-background-model",
        displayName: "Account Background Model",
        contextWindow: null,
        maxOutputTokens: null,
        capabilities: { streaming: null, toolCalls: null, vision: null },
        metadataSource: "provider-reported" as const,
      }],
    }));
    const backgroundApp = buildServer({
      db: backgroundDb,
      runner: new TaskRunner(backgroundDb, async () => {}),
      providerConnectivityTest: connectivity,
      backgroundModelDiscovery: true,
    });
    try {
      await backgroundApp.ready();
      expect((await backgroundApp.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
      await vi.waitFor(async () => {
        const response = await backgroundApp.inject({ method: "GET", url: "/api/models" });
        const models = JSON.parse(response.body);
        expect(models.find((item: any) => item.model.id === "account-background-model")).toMatchObject({
          available: true,
          availability: "available",
          authMode: "openai-api-key",
        });
      });
      expect(connectivity).toHaveBeenCalledWith("openai", process.env);
    } finally {
      await backgroundApp.close();
      backgroundDb.close();
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
    }
  });

  it("lists presets, models, capabilities, and honest OAuth findings", async () => {
    expect((await json("GET", "/api/presets")).body.length).toBe(7);
    const models = (await json("GET", "/api/models")).body;
    expect(models.length).toBeGreaterThan(0);
    expect(models[0]).toHaveProperty("available");
    expect((await json("GET", "/api/providers/capabilities")).body.length).toBeGreaterThanOrEqual(7);
    const oauth = (await json("GET", "/api/providers/oauth")).body;
    expect(oauth.length).toBe(3);
    // Claude + Codex subscription sign-in is implemented; Gemini stays API-key.
    expect(oauth.filter((f: any) => f.status === "available").map((f: any) => f.id).sort()).toEqual([
      "claude-oauth",
      "codex-oauth",
    ]);
    expect(oauth.find((f: any) => f.id === "gemini-oauth").status).toBe("unavailable");

    // Live status endpoint reports a connection state and never token material.
    const status = (await json("GET", "/api/providers/oauth/status")).body;
    expect(status.map((s: any) => s.id).sort()).toEqual(["anthropic", "openai"]);
    expect(status.every((s: any) => ["connected", "disconnected", "expired"].includes(s.status))).toBe(true);
    expect(JSON.stringify(status)).not.toMatch(/accessToken|refreshToken|access_token/);
  });

  // Regression: openai-compatible has no BUILT_IN_MODELS entries (it's a
  // bring-your-own-model endpoint), so a configured openai-compatible model
  // previously never appeared in /api/models or /api/models/budgets at all —
  // unlike a provider with real registry rows, which still lists as
  // "unavailable" when unconfigured. That made the /model picker unable to
  // show a configured OpenCode Zen (or any other openai-compatible) model.
  it("surfaces a configured openai-compatible model in /api/models and /api/models/budgets", async () => {
    const prevUrl = process.env.OPENAI_COMPAT_BASE_URL;
    const prevModel = process.env.OPENAI_COMPAT_MODEL;
    process.env.OPENAI_COMPAT_BASE_URL = "https://opencode.ai/zen/v1";
    process.env.OPENAI_COMPAT_MODEL = "hy3-free";
    try {
      const models = (await json("GET", "/api/models")).body;
      const hy3 = models.find((m: any) => m.model.providerId === "openai-compatible" && m.model.id === "hy3-free");
      expect(hy3).toBeTruthy();
      expect(hy3).toMatchObject({ available: false, availability: "unknown", authMode: "opencode-zen" });

      const budgets = (await json("GET", "/api/models/budgets")).body;
      const hy3Budget = budgets.find((b: any) => b.providerId === "openai-compatible" && b.selectedModelId === "hy3-free");
      expect(hy3Budget).toBeTruthy();
      expect(hy3Budget.configured).toBe(true);
      expect(hy3Budget.endpointHost).toBe("opencode.ai");
    } finally {
      if (prevUrl === undefined) delete process.env.OPENAI_COMPAT_BASE_URL; else process.env.OPENAI_COMPAT_BASE_URL = prevUrl;
      if (prevModel === undefined) delete process.env.OPENAI_COMPAT_MODEL; else process.env.OPENAI_COMPAT_MODEL = prevModel;
    }
  });

  it("does not list an unconfigured openai-compatible model", async () => {
    const prevUrl = process.env.OPENAI_COMPAT_BASE_URL;
    const prevModel = process.env.OPENAI_COMPAT_MODEL;
    delete process.env.OPENAI_COMPAT_BASE_URL;
    delete process.env.OPENAI_COMPAT_MODEL;
    try {
      const models = (await json("GET", "/api/models")).body;
      expect(models.some((m: any) => m.model.providerId === "openai-compatible")).toBe(false);
    } finally {
      if (prevUrl !== undefined) process.env.OPENAI_COMPAT_BASE_URL = prevUrl;
      if (prevModel !== undefined) process.env.OPENAI_COMPAT_MODEL = prevModel;
    }
  });

  it("resolves a canonical model budget per model without crashing on unconfigured providers", async () => {
    const prev = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      const { status, body } = await json("GET", "/api/models/budgets");
      expect(status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThan(0);
      const deepseekChat = body.find((b: any) => b.providerId === "deepseek" && b.selectedModelId === "deepseek-chat");
      expect(deepseekChat).toBeTruthy();
      expect(deepseekChat.configured).toBe(false);
      expect(["verified", "configured", "unverified"]).toContain(deepseekChat.contextWindowConfidence);
      expect(deepseekChat.usableInputTokens).toBeGreaterThan(0);
      expect(deepseekChat.totalReserveTokens).toBeGreaterThan(0);
      // An unconfigured provider must never crash this endpoint, and must
      // never be silently presented as "verified" — it stays honest.
      expect(deepseekChat.contextWindowConfidence).not.toBe("verified");
    } finally {
      if (prev === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = prev;
    }
  });

  it("reflects a configured endpoint override as 'configured' confidence, never 'verified'", async () => {
    const prevKey = process.env.DEEPSEEK_API_KEY;
    const prevLimit = process.env.DEEPSEEK_CONTEXT_LIMIT;
    process.env.DEEPSEEK_API_KEY = "sk-test-budget-endpoint";
    process.env.DEEPSEEK_CONTEXT_LIMIT = "40000";
    try {
      const { body } = await json("GET", "/api/models/budgets");
      const deepseekChat = body.find((b: any) => b.providerId === "deepseek" && b.selectedModelId === "deepseek-chat");
      expect(deepseekChat.configured).toBe(true);
      expect(deepseekChat.contextWindowConfidence).toBe("configured");
      expect(deepseekChat.contextWindowTokens).toBe(40000);
    } finally {
      if (prevKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = prevKey;
      if (prevLimit === undefined) delete process.env.DEEPSEEK_CONTEXT_LIMIT; else process.env.DEEPSEEK_CONTEXT_LIMIT = prevLimit;
    }
  });

  // The provider spectrum: every key-authenticated OpenAI-chat provider in the
  // spec table is fully wired — listed unconfigured by default, configured by
  // its canonical env var, exposed in the model picker's budgets view, and
  // reporting a provider-specific auth mode (the /connect surface).
  it("wires every openai-chat key provider end to end (list, configure, budgets, auth mode)", async () => {
    const before = (await json("GET", "/api/providers")).body;
    for (const spec of OPENAI_CHAT_KEY_SPECS) {
      const listed = before.find((p: any) => p.id === spec.id);
      expect(listed, `${spec.id} must be listed`).toBeTruthy();
      expect(listed.kind).toBe("api-key");

      const keyEnv = providerEnvMapping(spec.id)!.apiKeyEnv!;
      const prev = process.env[keyEnv];
      process.env[keyEnv] = `sk-test-${spec.id}`;
      try {
        const status = (await json("GET", "/api/providers")).body.find((p: any) => p.id === spec.id);
        expect(status.configured, `${spec.id} must configure via ${keyEnv}`).toBe(true);
        expect(status.authMode).toBe(`${spec.id}-api-key`);
        expect(status.defaultModel).toBe(spec.defaultModel);

        const budgets = (await json("GET", "/api/models/budgets")).body;
        const row = budgets.find((b: any) => b.providerId === spec.id && b.selectedModelId === spec.defaultModel);
        expect(row, `${spec.id} default model must appear in budgets`).toBeTruthy();
        expect(row.configured).toBe(true);
        expect(row.protocol).toBe("openai-chat");
      } finally {
        if (prev === undefined) delete process.env[keyEnv]; else process.env[keyEnv] = prev;
      }
    }
  });

  it("lists LM Studio as a local provider configured by base URL", async () => {
    const prev = process.env.LMSTUDIO_BASE_URL;
    try {
      delete process.env.LMSTUDIO_BASE_URL;
      const off = (await json("GET", "/api/providers")).body.find((p: any) => p.id === "lmstudio");
      expect(off).toBeTruthy();
      expect(off.kind).toBe("local");
      expect(off.configured).toBe(false);

      process.env.LMSTUDIO_BASE_URL = "http://127.0.0.1:1234/v1";
      const on = (await json("GET", "/api/providers")).body.find((p: any) => p.id === "lmstudio");
      expect(on.configured).toBe(true);
      expect(on.authMode).toBe("lmstudio");
      expect(on.authStatus).toBe("not-applicable");
    } finally {
      if (prev === undefined) delete process.env.LMSTUDIO_BASE_URL; else process.env.LMSTUDIO_BASE_URL = prev;
    }
  });

  it("reports Perplexity as unable to drive tools, at both provider and model level", async () => {
    const prev = process.env.PERPLEXITY_API_KEY;
    process.env.PERPLEXITY_API_KEY = "pplx-test";
    try {
      const status = (await json("GET", "/api/providers")).body.find((p: any) => p.id === "perplexity");
      expect(status.capabilities.toolCalls).toBe(false);
      const budgets = (await json("GET", "/api/models/budgets")).body;
      const sonarPro = budgets.find((b: any) => b.providerId === "perplexity" && b.selectedModelId === "sonar-pro");
      expect(sonarPro.capabilities.toolCalls).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.PERPLEXITY_API_KEY; else process.env.PERPLEXITY_API_KEY = prev;
    }
  });

  async function makeConversation() {
    const project = (await json("POST", "/api/projects", { name: "Test", workspacePath: process.cwd() })).body;
    const conv = (await json("POST", `/api/projects/${project.id}/conversations`, { title: "Chat" })).body;
    return { project, conv };
  }

  it("rejects an unavailable preset with a truthful reason", async () => {
    const { conv } = await makeConversation();
    const res = await json("POST", `/api/conversations/${conv.id}/messages`, { content: "hi", preset: "private-local" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("PRESET_UNAVAILABLE");
  });

  it("routes to the mock provider and reports the decision", async () => {
    process.env.MOCK_PROVIDER = "true";
    const { conv } = await makeConversation();
    const send = await json("POST", `/api/conversations/${conv.id}/messages`, { content: "hi" });
    expect(send.status).toBe(202);
    expect(send.body.routing.providerId).toBe("mock");
    expect(send.body.assistantMessage.provider).toBe("mock");

    const agg = await json("GET", `/api/tasks/${send.body.task.id}`);
    expect(agg.body.routing.providerId).toBe("mock");
  });

  it("supports the full memory lifecycle with project isolation", async () => {
    const { project, conv } = await makeConversation();
    const created = await json("POST", `/api/projects/${project.id}/memory`, { scope: "conversation", content: "remember this", conversationId: conv.id });
    expect(created.status).toBe(201);
    const id = created.body.id;
    const other = (await json("POST", "/api/projects", { name: "Other", workspacePath: process.cwd() })).body;

    expect((await json("GET", `/api/projects/${project.id}/memory`)).body.length).toBe(1);
    expect((await json("GET", `/api/conversations/${conv.id}/memory`)).body.length).toBe(1);

    const deniedPatch = await json("PATCH", `/api/memory/${id}`, { projectId: other.id, enabled: false });
    expect(deniedPatch.status).toBe(404);
    expect((await json("GET", `/api/conversations/${conv.id}/memory`)).body.length).toBe(1);

    const disabled = await json("PATCH", `/api/memory/${id}`, { projectId: project.id, enabled: false });
    expect(disabled.body.enabled).toBe(false);
    expect((await json("GET", `/api/conversations/${conv.id}/memory`)).body.length).toBe(0);

    const deniedDelete = await json("DELETE", `/api/memory/${id}`, { projectId: other.id });
    expect(deniedDelete.status).toBe(404);

    expect((await json("DELETE", `/api/memory/${id}`, { projectId: project.id })).status).toBe(204);
    expect((await json("GET", `/api/projects/${project.id}/memory`)).body.length).toBe(0);
  });

  it("requires a conversationId for conversation-scoped memory", async () => {
    const { project } = await makeConversation();
    const res = await json("POST", `/api/projects/${project.id}/memory`, { scope: "conversation", content: "x" });
    expect(res.status).toBe(400);
  });
});
