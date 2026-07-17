import { describe, expect, it } from "vitest";
import type { ProviderStatus } from "@morrow/contracts";
import { calculateUsageCost, getModel, listConfiguredCustomModels, resolveModelMetadata, resolveModelStatuses } from "../src/routing/models.js";

function providerStatus(overrides: Partial<ProviderStatus>): ProviderStatus {
  return {
    version: 1,
    id: "openai-compatible",
    label: "OpenAI-compatible",
    kind: "api-key",
    configured: false,
    available: false,
    endpointType: "custom",
    endpointHost: null,
    authStatus: "missing",
    capabilities: { streaming: true, toolCalls: true, systemMessages: true, vision: false, customEndpoint: true, local: false },
    models: [],
    defaultModel: null,
    note: null,
    setupHint: null,
    ...overrides,
  };
}

describe("authoritative model metadata", () => {
  it("knows the DeepSeek Flash context limit and usage capabilities", () => {
    const meta = resolveModelMetadata("deepseek", "deepseek-v4-flash");
    expect(meta?.canonicalId).toBe("deepseek-v4-flash");
    expect(meta?.providerId).toBe("deepseek");
    expect(meta?.contextWindow).toBe(1_000_000);
    expect(meta?.tokenUsage).toBe(true);
    expect(meta?.streamingUsage).toBe(true);
    expect(meta?.capabilities.toolCalls).toBe(true);
  });

  it("resolves aliases to canonical metadata", () => {
    const meta = resolveModelMetadata("deepseek", "deepseek-flash");
    expect(meta?.canonicalId).toBe("deepseek-v4-flash");
    expect(getModel("deepseek-flash")?.id).toBe("deepseek-v4-flash");
  });

  it("returns safe unknown metadata for unknown models", () => {
    const meta = resolveModelMetadata("deepseek", "custom-model");
    expect(meta?.canonicalId).toBe("custom-model");
    expect(meta?.contextWindow).toBeNull();
    expect(meta?.pricing).toBeNull();
    expect(meta?.builtIn).toBe(false);
    expect(meta?.metadataSource).toBe("unknown");
    expect(meta?.confidence).toBe("unknown");
    expect(meta?.family).toBeNull();
  });

  it("describes current bundled models with normalized provenance instead of name inference", () => {
    const meta = resolveModelMetadata("openai", "gpt-5.6-sol");
    expect(meta).toMatchObject({
      providerModelId: "gpt-5.6-sol",
      canonicalId: "gpt-5.6-sol",
      family: "gpt-5.6",
      generation: "5.6",
      lifecycle: "current",
      metadataSource: "bundled-catalog",
      metadataVersion: expect.any(String),
      confidence: "verified",
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
    });
  });

  it("does not confuse the same model slug across provider changes", () => {
    const deepseek = resolveModelMetadata("deepseek", "deepseek-v4-flash");
    const openrouter = resolveModelMetadata("openrouter", "deepseek/deepseek-v4-flash");
    expect(deepseek?.providerId).toBe("deepseek");
    expect(openrouter?.providerId).toBe("openrouter");
    expect(openrouter?.canonicalId).toBe("deepseek/deepseek-v4-flash");
  });

  it("keeps unavailable context and pricing unknown", () => {
    const chat = resolveModelMetadata("deepseek", "deepseek-chat");
    expect(chat?.contextWindow).toBeNull();
    expect(chat?.pricing).toBeNull();
    expect(calculateUsageCost({ inputTokens: 100, outputTokens: 50 }, chat)).toEqual({ known: false, label: "unknown" });
  });

  it("calculates cost only with authoritative pricing", () => {
    const local = resolveModelMetadata("ollama", "llama3.1");
    expect(calculateUsageCost({ inputTokens: 1000, outputTokens: 500 }, local)).toEqual({ known: true, usd: 0, label: "$0.0000" });
  });
});

// Regression coverage for a real bug: openai-compatible (a "bring your own
// model" provider) has zero entries in BUILT_IN_MODELS, so a correctly
// configured openai-compatible endpoint never showed up in /api/models or
// /api/models/budgets at all — not even as "unavailable" the way a
// provider-with-real-registry-entries would. That made a configured
// openai-compatible model invisible in the /model picker.
describe("listConfiguredCustomModels", () => {
  it("synthesizes a model entry for a configured provider with no registry entries", () => {
    const models = listConfiguredCustomModels([
      providerStatus({ id: "openai-compatible", configured: true, defaultModel: "hy3-free", endpointHost: "opencode.ai" }),
    ]);
    expect(models).toHaveLength(1);
    expect(models[0]?.providerId).toBe("openai-compatible");
    expect(models[0]?.id).toBe("hy3-free");
    expect(models[0]?.canonicalId).toBe("hy3-free");
    expect(models[0]?.builtIn).toBe(false);
    expect(models[0]?.contextWindow).toBeNull();
    expect(models[0]?.pricing).toBeNull();
  });

  it("yields nothing for a provider that is not configured", () => {
    const models = listConfiguredCustomModels([
      providerStatus({ id: "openai-compatible", configured: false, defaultModel: "hy3-free" }),
    ]);
    expect(models).toHaveLength(0);
  });

  it("yields nothing for a configured provider with no default model set yet", () => {
    const models = listConfiguredCustomModels([
      providerStatus({ id: "openai-compatible", configured: true, defaultModel: null }),
    ]);
    expect(models).toHaveLength(0);
  });

  it("does not duplicate a provider that already has real registry entries", () => {
    const models = listConfiguredCustomModels([
      providerStatus({ id: "deepseek", configured: true, defaultModel: "deepseek-v4-flash" }),
    ]);
    expect(models).toHaveLength(0);
  });
});

// Regression coverage for the beta.31 context split-brain: the consumer set
// OPENAI_COMPAT_CONTEXT_LIMIT=215000, the runtime preflight used it (task
// report said "46k / 215k"), yet `morrow models info` still reported context
// window unknown. The catalog view must consume the SAME override the route
// metadata does, and must say where the number came from.
describe("context-limit override visibility in model statuses", () => {
  const compatProvider = providerStatus({
    id: "openai-compatible",
    configured: true,
    defaultModel: "hy3-free",
    models: ["hy3-free"],
    endpointHost: "opencode.ai",
    authMode: "opencode-zen",
  });

  it("surfaces an explicit env override as the context window with user-supplied provenance", () => {
    const statuses = resolveModelStatuses([compatProvider], [], { OPENAI_COMPAT_CONTEXT_LIMIT: "215000" } as NodeJS.ProcessEnv);
    const model = statuses.find((s) => s.model.id === "hy3-free");
    expect(model?.model.contextWindow).toBe(215_000);
    expect(model?.model.metadataSource).toBe("user-supplied");
    expect(model?.model.confidence).toBe("configured");
  });

  it("keeps context unknown without an override", () => {
    const statuses = resolveModelStatuses([compatProvider], [], {} as NodeJS.ProcessEnv);
    const model = statuses.find((s) => s.model.id === "hy3-free");
    expect(model?.model.contextWindow).toBeNull();
    expect(model?.model.metadataSource).toBe("unknown");
  });

  it("caps a known catalog window with a lower override but never raises it", () => {
    const deepseek = providerStatus({ id: "deepseek", configured: true, defaultModel: "deepseek-v4-flash", models: ["deepseek-v4-flash"] });
    const capped = resolveModelStatuses([deepseek], [], { DEEPSEEK_CONTEXT_LIMIT: "64000" } as NodeJS.ProcessEnv)
      .find((s) => s.model.id === "deepseek-v4-flash");
    expect(capped?.model.contextWindow).toBe(64_000);
    expect(capped?.model.metadataSource).toBe("user-supplied");
    const notRaised = resolveModelStatuses([deepseek], [], { DEEPSEEK_CONTEXT_LIMIT: "9000000" } as NodeJS.ProcessEnv)
      .find((s) => s.model.id === "deepseek-v4-flash");
    expect(notRaised?.model.contextWindow).toBe(1_000_000);
    expect(notRaised?.model.metadataSource).toBe("bundled-catalog");
  });

  it("ignores an invalid override instead of failing the listing", () => {
    const statuses = resolveModelStatuses([compatProvider], [], { OPENAI_COMPAT_CONTEXT_LIMIT: "not-a-number" } as NodeJS.ProcessEnv);
    const model = statuses.find((s) => s.model.id === "hy3-free");
    expect(model?.model.contextWindow).toBeNull();
  });
});
