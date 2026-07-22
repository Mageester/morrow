import { describe, it, expect } from "vitest";
import { listProviderStatuses, isProviderConfigured, createProvider, getProviderDefaultModel, installProviderModelDiscoveries } from "../src/provider/registry.js";
import { routePreset, listPresetStatuses } from "../src/routing/router.js";
import { listPresets } from "../src/routing/presets.js";
import { listModels, resolveModelStatuses } from "../src/routing/models.js";
import { ProviderError } from "../src/provider/base.js";

describe("Model registry currency", () => {
  it("lets live OpenRouter metadata override bundled fallback fields for known model ids", () => {
    const provider = listProviderStatuses({ OPENROUTER_API_KEY: "catalogue-test-key" }).find((item) => item.id === "openrouter")!;
    const statuses = resolveModelStatuses([{ ...provider, configured: true, available: true }], [{
      providerId: "openrouter", authMode: "openrouter-api-key", status: "available", errorKind: null,
      fetchedAt: "2026-07-22T12:00:00.000Z", expiresAt: "2026-07-22T12:15:00.000Z", lastSuccessAt: "2026-07-22T12:00:00.000Z",
      models: [{
        providerModelId: "openrouter/auto", displayName: "Auto Router Live", author: "openrouter",
        contextWindow: 400_000, maxOutputTokens: 32_000, inputModalities: ["text", "image"], outputModalities: ["text"],
        capabilities: { streaming: true, toolCalls: true, vision: true, reasoning: true },
        pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0, source: "provider-reported" },
        costType: "free", availability: "available", fetchedAt: "2026-07-22T12:00:00.000Z", metadataSource: "provider-reported",
      }],
    }]);
    expect(statuses.find((item) => item.model.id === "openrouter/auto")?.model).toMatchObject({
      label: "Auto Router Live",
      author: "openrouter",
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      capabilities: { toolCalls: true, vision: true, reasoning: true },
      pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0, source: "provider-reported" },
      costType: "free",
      fetchedAt: "2026-07-22T12:00:00.000Z",
    });
  });
  it("exposes the current OpenAI, DeepSeek, and OpenRouter lineups and drops retired ids", () => {
    const ids = new Set(listModels().map((m) => m.id));
    for (const id of ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner", "deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash"]) {
      expect(ids.has(id), `expected model ${id} to be present`).toBe(true);
    }
    for (const retired of ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "o4-mini"]) {
      expect(ids.has(retired), `retired model ${retired} should be gone`).toBe(false);
    }
  });

  it("only references known model ids in presets (no dangling routing targets)", () => {
    const ids = new Set(listModels().map((m) => m.id));
    for (const preset of listPresets()) {
      for (const [, models] of Object.entries(preset.modelPreferences)) {
        for (const m of models as string[]) {
          expect(ids.has(m), `preset ${preset.id} references unknown model ${m}`).toBe(true);
        }
      }
    }
  });
});

describe("Provider registry", () => {
  it("reports nothing configured with an empty environment", () => {
    const statuses = listProviderStatuses({});
    expect(statuses.length).toBeGreaterThanOrEqual(7);
    expect(statuses.every((s) => !s.configured)).toBe(true);
    expect(statuses.find((s) => s.id === "openai")?.authStatus).toBe("missing");
  });

  it("never serializes secrets into provider status", () => {
    const json = JSON.stringify(listProviderStatuses({ OPENAI_API_KEY: "sk-leak-me", ANTHROPIC_API_KEY: "sk-ant-leak" }));
    expect(json).not.toContain("sk-leak-me");
    expect(json).not.toContain("sk-ant-leak");
  });

  it("detects a configured provider and exposes only the host", () => {
    const statuses = listProviderStatuses({ OPENAI_API_KEY: "k", OPENAI_BASE_URL: "https://gateway.example.com/v1" });
    const openai = statuses.find((s) => s.id === "openai")!;
    expect(openai.configured).toBe(true);
    expect(openai.endpointType).toBe("custom");
    expect(openai.endpointHost).toBe("gateway.example.com");
  });

  it("treats Ollama as an explicit local opt-in", () => {
    expect(isProviderConfigured("ollama", {})).toBe(false);
    expect(isProviderConfigured("ollama", { OLLAMA_BASE_URL: "http://127.0.0.1:11434/v1" })).toBe(true);
  });

  it("includes the mock provider only when MOCK_PROVIDER=true", () => {
    expect(listProviderStatuses({}).some((s) => s.id === "mock")).toBe(false);
    expect(listProviderStatuses({ MOCK_PROVIDER: "true" }).some((s) => s.id === "mock")).toBe(true);
  });

  it("builds a provider when configured and throws a typed error otherwise", () => {
    const provider = createProvider("openai", { OPENAI_API_KEY: "k" });
    expect(provider.id).toBe("openai");
    expect(() => createProvider("openai", {})).toThrow(ProviderError);
    expect(() => createProvider("ollama", {})).toThrow(ProviderError);
    expect(() => createProvider("openai-compatible", {})).toThrow(ProviderError);
  });

  it("attaches verified route limits to the exact endpoint being called", () => {
    const defaultRoute = createProvider("deepseek", {
      DEEPSEEK_API_KEY: "k",
    }, "deepseek-v4-flash").route;
    expect(defaultRoute).toMatchObject({
      providerId: "deepseek",
      endpointKind: "default",
      endpointHost: "api.deepseek.com",
      protocol: "openai-chat",
      endpointLimitTokens: 131_072,
      endpointLimitSource: "provider-metadata",
    });
    expect(defaultRoute?.endpointIdentityHash).toMatch(/^[a-f0-9]{64}$/);

    const customUnknown = createProvider("deepseek", {
      DEEPSEEK_API_KEY: "k",
      DEEPSEEK_BASE_URL: "https://gateway.example/v1",
    }, "deepseek-v4-flash").route;
    expect(customUnknown).toMatchObject({
      providerId: "deepseek",
      endpointKind: "custom",
      endpointHost: "gateway.example",
      protocol: "openai-chat",
      endpointLimitTokens: null,
      endpointLimitSource: "unknown",
    });
    expect(customUnknown?.endpointIdentityHash).toMatch(/^[a-f0-9]{64}$/);

    const customOverride = createProvider("deepseek", {
      DEEPSEEK_API_KEY: "k",
      DEEPSEEK_BASE_URL: "https://gateway.example/v1",
      DEEPSEEK_CONTEXT_LIMIT: "65536",
    }, "deepseek-v4-flash").route;
    expect(customOverride?.endpointLimitTokens).toBe(65_536);
    expect(customOverride?.endpointLimitSource).toBe("endpoint-override");
  });

  it("exposes default models for known providers", () => {
    expect(getProviderDefaultModel("openai", {})).toBe("gpt-5.6-sol");
    expect(getProviderDefaultModel("anthropic", {})).toBe("claude-opus-4-8");
    expect(getProviderDefaultModel("deepseek", {})).toBe("deepseek-v4-flash");
    expect(getProviderDefaultModel("openrouter", {})).toBe("openrouter/auto");
  });
});

describe("Preset router", () => {
  it("routes to the preferred configured provider", () => {
    const res = routePreset("balanced", { OPENAI_API_KEY: "k" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.decision.providerId).toBe("openai");
      expect(res.decision.fallbackUsed).toBe(false);
      expect(res.decision.model).toBe("gpt-5.6-terra");
    }
  });

  it("falls back honestly when the preferred provider is unconfigured", () => {
    const res = routePreset("balanced", { ANTHROPIC_API_KEY: "k" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.decision.providerId).toBe("anthropic");
      expect(res.decision.fallbackUsed).toBe(true);
      expect(res.decision.candidates.some((c) => c.providerId === "openai" && !c.configured)).toBe(true);
    }
  });

  it("reports unavailable when no provider is configured", () => {
    const res = routePreset("balanced", {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("no configured provider");
  });

  it("does not route to an arbitrary account model when no reviewed preset preference is available", () => {
    installProviderModelDiscoveries([{
      providerId: "openai",
      authMode: "openai-api-key",
      status: "available",
      models: [{
        providerModelId: "account-legacy-only",
        displayName: "Account Legacy Only",
        contextWindow: null,
        maxOutputTokens: null,
        capabilities: { streaming: null, toolCalls: null, vision: null },
        metadataSource: "provider-reported",
      }],
      errorKind: null,
      fetchedAt: "2026-07-16T20:00:00.000Z",
    }]);
    try {
      const result = routePreset("balanced", { OPENAI_API_KEY: "k" });
      expect(result.ok).toBe(false);
    } finally {
      installProviderModelDiscoveries([]);
    }
  });

  it("only routes private-local to a local provider", () => {
    expect(routePreset("private-local", {}).ok).toBe(false);
    const res = routePreset("private-local", { OLLAMA_BASE_URL: "http://127.0.0.1:11434/v1" });
    expect(res.ok && res.decision.providerId === "ollama").toBe(true);
  });

  it("enforces the privacy boundary on override", () => {
    const env = { OLLAMA_BASE_URL: "http://127.0.0.1:11434/v1", OPENAI_API_KEY: "k" };
    const blocked = routePreset("private-local", env, { providerId: "openai" });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toContain("local-only");
  });

  it("honors an explicit provider+model override", () => {
    const res = routePreset("balanced", { ANTHROPIC_API_KEY: "k" }, { providerId: "anthropic", model: "claude-3-opus-20240229" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.decision.overridden).toBe(true);
      expect(res.decision.model).toBe("claude-3-opus-20240229");
    }
  });

  it("lists every preset with availability and reasons", () => {
    const statuses = listPresetStatuses({ OPENAI_API_KEY: "k" });
    expect(statuses.length).toBe(listPresets().length);
    const privateLocal = statuses.find((s) => s.preset.id === "private-local")!;
    expect(privateLocal.available).toBe(false);
    expect(privateLocal.unavailableReason).toContain("local provider");
    const balanced = statuses.find((s) => s.preset.id === "balanced")!;
    expect(balanced.available).toBe(true);
    expect(balanced.resolved?.providerId).toBe("openai");
  });
});
