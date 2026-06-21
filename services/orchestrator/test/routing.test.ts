import { describe, it, expect } from "vitest";
import { listProviderStatuses, isProviderConfigured, createProvider, getProviderDefaultModel } from "../src/provider/registry.js";
import { routePreset, listPresetStatuses } from "../src/routing/router.js";
import { listPresets } from "../src/routing/presets.js";
import { ProviderError } from "../src/provider/base.js";

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

  it("exposes default models for known providers", () => {
    expect(getProviderDefaultModel("openai", {})).toBe("gpt-4o-mini");
    expect(getProviderDefaultModel("anthropic", {})).toBe("claude-3-5-sonnet-20241022");
  });
});

describe("Preset router", () => {
  it("routes to the preferred configured provider", () => {
    const res = routePreset("balanced", { OPENAI_API_KEY: "k" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.decision.providerId).toBe("openai");
      expect(res.decision.fallbackUsed).toBe(false);
      expect(res.decision.model).toBe("gpt-4o-mini");
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
