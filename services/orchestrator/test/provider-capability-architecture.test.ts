import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { reasoningModesForRoute, type DiscoveredModel, type RouteReasoningCapability } from "@morrow/contracts";
import { resolveEffectiveContext } from "../src/routing/effective-context.js";
import { resolveModelBudget } from "../src/routing/model-budget.js";
import { resolveReasoningCapability } from "../src/routing/models.js";
import { reasoningCapabilityFromSupportedParameters } from "../src/routing/request-capabilities.js";
import {
  buildExactProviderRoute,
  capabilityFact,
  resolveModelCapabilities,
  resolveProviderModelCapabilities,
  type CapabilityLayer,
} from "../src/provider/model-capabilities.js";
import { translateReasoning } from "../src/provider/reasoning.js";
import {
  clearObservedContextLimits,
  learnContextLimitFromProviderError,
  parseContextLimitFromProviderError,
} from "../src/provider/context-limit-discovery.js";
import {
  installProviderModelDiscoveries,
  invalidateProviderModelDiscoveries,
} from "../src/provider/registry.js";

const SRC = join(import.meta.dirname, "..", "src");

function route(input: {
  providerId: string;
  modelId: string;
  protocol?: "openai-chat" | "gemini-generate-content" | "anthropic-messages";
  endpointKind?: "default" | "custom";
  endpointHost?: string | null;
  endpointIdentityHash?: string | null;
}) {
  return buildExactProviderRoute({
    providerId: input.providerId,
    modelId: input.modelId,
    protocol: input.protocol ?? "openai-chat",
    endpointKind: input.endpointKind ?? "default",
    endpointHost: input.endpointHost ?? null,
    endpointIdentityHash: input.endpointIdentityHash ?? null,
  });
}

function discovered(overrides: Partial<DiscoveredModel> & { providerModelId: string }): DiscoveredModel {
  return {
    displayName: overrides.providerModelId,
    contextWindow: null,
    maxOutputTokens: null,
    capabilities: { streaming: true, toolCalls: true, vision: false },
    metadataSource: "provider-reported",
    ...overrides,
  } as DiscoveredModel;
}

beforeEach(() => {
  invalidateProviderModelDiscoveries();
  clearObservedContextLimits();
});

describe("no fabricated context fallback survives anywhere", () => {
  it("has no generic 32k (or any) universal context constant in the resolution path", () => {
    // A fabricated fallback is easy to reintroduce as an innocuous-looking
    // default. Assert against the source of the modules that actually decide a
    // request ceiling, so a new one fails here rather than in production.
    const guarded = [
      "routing/effective-context.ts",
      "routing/model-budget.ts",
      "routing/models.ts",
      "provider/model-capabilities.ts",
    ];
    for (const relative of guarded) {
      const source = readFileSync(join(SRC, relative), "utf8");
      expect(source, `${relative} must not hardcode a 32k context fallback`).not.toMatch(/32_?768|32_?000/);
    }
  });

  it("resolves unknown for an unknown model on an unknown endpoint, on every provider protocol", () => {
    for (const [providerId, protocol] of [
      ["gemini", "gemini-generate-content"],
      ["deepseek", "openai-chat"],
      ["nvidia-nim", "openai-chat"],
      ["tokenrouter", "openai-chat"],
      ["opencode-zen", "openai-chat"],
      ["openai-compatible", "openai-chat"],
      ["anthropic", "anthropic-messages"],
    ] as const) {
      const budget = resolveModelBudget({
        providerId,
        selectedModel: "some-model-nobody-has-catalogued",
        endpoint: { kind: "custom", host: "gateway.internal", protocol, limitTokens: null, limitSource: "unknown" },
      });
      expect(budget.contextWindowTokens, providerId).toBeNull();
      expect(budget.usableInputTokens, providerId).toBeNull();
      expect(budget.effectiveContextWindowTokens, providerId).toBeNull();
      expect(budget.contextWindowConfidence, providerId).toBe("unverified");
      expect(budget.contextWindowSource, providerId).toBe("unknown");
    }
  });
});

describe("capability resolution order: discovery > route config > catalog", () => {
  const exact = route({ providerId: "deepseek", modelId: "deepseek-v4-flash", endpointHost: "api.deepseek.com" });

  it("lets live provider discovery override provider-catalog metadata", () => {
    installProviderModelDiscoveries([{
      providerId: "deepseek",
      authMode: "deepseek-api-key",
      models: [discovered({
        providerModelId: "deepseek-v4-flash",
        displayName: "DeepSeek V4 Flash (live)",
        contextWindow: 262_144,
        fetchedAt: "2026-08-16T00:00:00.000Z",
      })],
      status: "available",
      errorKind: null,
      fetchedAt: "2026-08-16T00:00:00.000Z",
    }]);

    const resolved = resolveProviderModelCapabilities(exact);
    // The bundled catalog says 1,000,000 for this model; the live route says
    // 262,144. The live answer wins and says so.
    expect(resolved.contextWindow.value).toBe(262_144);
    expect(resolved.contextWindow.source).toBe("provider-reported");
    expect(resolved.contextWindow.authority).toBe("provider");
  });

  it("ranks an explicit route/user override above the catalog but below live discovery", () => {
    const catalogAndOverride = (extra: CapabilityLayer[]) => resolveModelCapabilities(exact, [
      { source: "provider-catalog", capabilities: { contextWindow: capabilityFact(1_000_000, "provider-catalog", "provider", "reported") } },
      { source: "route-config", capabilities: { contextWindow: capabilityFact(120_000, "route-config", "operator", "configured") } },
      ...extra,
    ]);

    const withoutDiscovery = catalogAndOverride([]);
    expect(withoutDiscovery.contextWindow.value).toBe(120_000);
    expect(withoutDiscovery.contextWindow.source).toBe("route-config");

    const withDiscovery = catalogAndOverride([
      { source: "provider-reported", capabilities: { contextWindow: capabilityFact(200_000, "provider-reported", "provider", "reported") } },
    ]);
    expect(withDiscovery.contextWindow.value).toBe(200_000);
    expect(withDiscovery.contextWindow.source).toBe("provider-reported");
  });

  it("does not let an id-only discovery response erase a known catalog capacity", () => {
    // Regression: the live probe showed DeepSeek resolving to an unknown
    // context window purely because its model listing succeeded. Most listings
    // report nothing but ids (verified 2026-08-16 across DeepSeek, NVIDIA NIM,
    // TokenRouter and OpenCode Zen), so a successful discovery call that omits
    // capacity must be silence — never a retraction.
    installProviderModelDiscoveries([{
      providerId: "deepseek",
      authMode: "deepseek-api-key",
      models: [discovered({ providerModelId: "deepseek-v4-flash", displayName: "deepseek-v4-flash" })],
      status: "available",
      errorKind: null,
      fetchedAt: "2026-08-16T00:00:00.000Z",
    }]);

    const budget = resolveModelBudget({
      providerId: "deepseek",
      selectedModel: "deepseek-v4-flash",
      endpoint: { kind: "default", host: "api.deepseek.com", protocol: "openai-chat", limitTokens: null, limitSource: "unknown" },
    });
    expect(budget.nativeContextWindowTokens).toBe(1_000_000);
    expect(budget.effectiveContextWindowTokens).toBe(1_000_000);
    // The capacity still came from the catalog, and still says so.
    expect(budget.contextWindowSource).toBe("model-metadata");
    expect(budget.contextWindowConfidence).toBe("verified");

    // The provider-owned reasoning modes survive the same way.
    expect(reasoningModesForRoute(resolveReasoningCapability("deepseek", "deepseek-v4-flash")).map((m) => m.id))
      .toEqual(["low", "high", "xhigh", "max"]);
  });

  it("carries source, authority, confidence and freshness through resolution", () => {
    const resolved = resolveModelCapabilities(exact, [
      {
        source: "provider-catalog",
        capabilities: {
          contextWindow: capabilityFact(1_000_000, "provider-catalog", "provider", "reported", "2026-07-01T00:00:00.000Z"),
        },
      },
      {
        source: "provider-reported",
        capabilities: {
          contextWindow: capabilityFact(262_144, "provider-reported", "provider", "verified", "2026-08-16T09:00:00.000Z"),
        },
      },
    ]);
    expect(resolved.contextWindow).toMatchObject({
      state: "known",
      value: 262_144,
      source: "provider-reported",
      authority: "provider",
      confidence: "verified",
      fetchedAt: "2026-08-16T09:00:00.000Z",
    });
  });

  it("keeps a known fact when a lower-authority layer reports unknown", () => {
    const resolved = resolveModelCapabilities(exact, [
      { source: "provider-reported", capabilities: { contextWindow: capabilityFact(262_144, "provider-reported", "provider", "reported") } },
      { source: "provider-catalog", capabilities: { contextWindow: capabilityFact(1_000_000, "provider-catalog", "provider", "reported") } },
    ]);
    expect(resolved.contextWindow.value).toBe(262_144);
  });

  it("propagates catalog freshness onto the facts it contributes", () => {
    const resolved = resolveProviderModelCapabilities(
      route({ providerId: "deepseek", modelId: "deepseek-v4-pro", endpointHost: "api.deepseek.com" }),
    );
    expect(resolved.contextWindow.source).toBe("provider-catalog");
    expect(resolved.contextWindow.fetchedAt).toBeTruthy();
  });
});

describe("route limits stay separate from native model limits", () => {
  it("caps a large native context with a smaller explicit route limit", () => {
    const budget = resolveModelBudget({
      providerId: "deepseek",
      selectedModel: "deepseek-v4-flash",
      endpoint: { kind: "custom", host: "proxy.corp", protocol: "openai-chat", limitTokens: 128_000, limitSource: "endpoint-override" },
    });
    expect(budget.nativeContextWindowTokens).toBe(1_000_000);
    expect(budget.routeLimitTokens).toBe(128_000);
    expect(budget.effectiveContextWindowTokens).toBe(128_000);
    expect(budget.contextWindowConfidence).toBe("configured");
  });

  it("does not raise a small native limit to a larger route limit", () => {
    const budget = resolveModelBudget({
      providerId: "anthropic",
      selectedModel: "claude-haiku-4-5-20251001",
      endpoint: { kind: "custom", host: "proxy.corp", protocol: "anthropic-messages", limitTokens: 900_000, limitSource: "endpoint-override" },
    });
    expect(budget.nativeContextWindowTokens).toBe(200_000);
    expect(budget.effectiveContextWindowTokens).toBe(200_000);
  });

  it("resolves the same model id differently on two distinct endpoints", () => {
    const shared = { providerId: "openai-compatible", selectedModel: "llama-3.3-70b-instruct" } as const;
    const a = resolveModelBudget({
      ...shared,
      endpoint: { kind: "custom", host: "a.internal", protocol: "openai-chat", limitTokens: 65_536, limitSource: "endpoint-override" },
    });
    const b = resolveModelBudget({
      ...shared,
      endpoint: { kind: "custom", host: "b.internal", protocol: "openai-chat", limitTokens: 16_384, limitSource: "endpoint-override" },
    });
    expect(a.effectiveContextWindowTokens).toBe(65_536);
    expect(b.effectiveContextWindowTokens).toBe(16_384);
    // Same provider and model id, genuinely different exact routes.
    expect(route({ ...shared, modelId: shared.selectedModel, endpointIdentityHash: "hash-a" }).routeFingerprint)
      .not.toBe(route({ ...shared, modelId: shared.selectedModel, endpointIdentityHash: "hash-b" }).routeFingerprint);
  });
});

describe("runtime limit discovery from a provider's own rejection", () => {
  // Message shapes captured verbatim from the live endpoints on 2026-08-16.
  it("reads the real limit out of each configured gateway's over-limit error", () => {
    expect(parseContextLimitFromProviderError(
      "This model's maximum context length is 202749 tokens. However, your messages resulted in 900007 tokens. Please reduce the length of the messages.",
    )).toEqual({ tokens: 202_749, scope: "model" });

    expect(parseContextLimitFromProviderError(
      "Error from provider (Console): Upstream request failed: [400] This endpoint's maximum context length is 1000000 tokens. However, you requested about 1125016 tokens (1125000 of text input, 16 in the output).",
    )).toEqual({ tokens: 1_000_000, scope: "endpoint" });

    expect(parseContextLimitFromProviderError(
      "The input (900056 tokens) is longer than the model's context length (262144 tokens).",
    )).toEqual({ tokens: 262_144, scope: "model" });
  });

  it("learns nothing from a rejection that states no capacity", () => {
    expect(parseContextLimitFromProviderError("Rate limit exceeded, please retry in 30s")).toBeUndefined();
    expect(parseContextLimitFromProviderError("Invalid API key")).toBeUndefined();
    // A bare token count is not a claim about capacity.
    expect(parseContextLimitFromProviderError("your messages resulted in 900007 tokens")).toBeUndefined();
  });

  it("applies a learned limit as a ROUTE limit, leaving the native model size intact", () => {
    const identity = "identity-nvidia-nim-route";
    learnContextLimitFromProviderError(
      { providerId: "nvidia-nim", protocol: "openai-chat", endpointKind: "default", endpointHost: "integrate.api.nvidia.com", endpointIdentityHash: identity, endpointLimitTokens: null, endpointLimitSource: "unknown" },
      "https://integrate.api.nvidia.com/v1",
      "deepseek-v4-flash",
      "This model's maximum context length is 202749 tokens. However, your messages resulted in 900007 tokens.",
    );

    const resolution = resolveEffectiveContext({
      providerId: "deepseek",
      selectedModel: "deepseek-v4-flash",
      endpoint: {
        kind: "custom",
        host: "integrate.api.nvidia.com",
        protocol: "openai-chat",
        limitTokens: null,
        limitSource: "unknown",
        endpointIdentityHash: identity,
      },
      outputReserveTokens: 2048,
    });

    expect(resolution.advertisedModelCapacityTokens).toBe(1_000_000);
    expect(resolution.configuredEndpointLimitTokens).toBe(202_749);
    expect(resolution.endpointLimitSource).toBe("provider-metadata");
    expect(resolution.effectiveRequestLimitTokens).toBe(202_749);
  });

  it("keeps the tighter of two observations for one route", () => {
    const meta = { providerId: "tokenrouter", protocol: "openai-chat" as const, endpointKind: "default" as const, endpointHost: "api.tokenrouter.com", endpointIdentityHash: "tr-identity", endpointLimitTokens: null, endpointLimitSource: "unknown" as const };
    learnContextLimitFromProviderError(meta, "https://api.tokenrouter.com/v1", "qwen/qwen3.8-max-free", "maximum context length is 262144 tokens");
    learnContextLimitFromProviderError(meta, "https://api.tokenrouter.com/v1", "qwen/qwen3.8-max-free", "maximum context length is 999999 tokens");

    const resolution = resolveEffectiveContext({
      providerId: "tokenrouter",
      selectedModel: "qwen/qwen3.8-max-free",
      endpoint: { kind: "custom", host: "api.tokenrouter.com", protocol: "openai-chat", limitTokens: null, limitSource: "unknown", endpointIdentityHash: "tr-identity" },
      outputReserveTokens: 2048,
    });
    expect(resolution.effectiveRequestLimitTokens).toBe(262_144);
  });

  it("does not leak one route's observation onto a different endpoint", () => {
    learnContextLimitFromProviderError(
      { providerId: "openai-compatible", protocol: "openai-chat", endpointKind: "custom", endpointHost: "a.internal", endpointIdentityHash: "identity-a", endpointLimitTokens: null, endpointLimitSource: "unknown" },
      "https://a.internal/v1",
      "shared-model-name",
      "This model's maximum context length is 8192 tokens.",
    );
    const other = resolveEffectiveContext({
      providerId: "openai-compatible",
      selectedModel: "shared-model-name",
      endpoint: { kind: "custom", host: "b.internal", protocol: "openai-chat", limitTokens: null, limitSource: "unknown", endpointIdentityHash: "identity-b" },
      outputReserveTokens: 2048,
    });
    expect(other.effectiveRequestLimitTokens).toBeNull();
  });
});

describe("reasoning modes are provider-owned and opaque", () => {
  it("exposes no global low/medium/high contract — each route reports its own set", () => {
    const sets = new Map<string, string[]>();
    for (const [providerId, modelId] of [
      ["gemini", "gemini-3.7-flash"],
      ["gemini", "gemini-3.5-flash"],
      ["deepseek", "deepseek-v4-pro"],
      ["openai", "gpt-5.6-sol"],
      ["anthropic", "claude-haiku-4-5-20251001"],
    ] as const) {
      sets.set(`${providerId}/${modelId}`, reasoningModesForRoute(resolveReasoningCapability(providerId, modelId)).map((m) => m.id));
    }

    // Verified live on 2026-08-16: 3.7 Flash rejects MINIMAL, 3.5 Flash accepts it.
    expect(sets.get("gemini/gemini-3.7-flash")).toEqual(["low", "medium", "high"]);
    expect(sets.get("gemini/gemini-3.5-flash")).toEqual(["minimal", "low", "medium", "high"]);
    // DeepSeek's depths are not OpenAI's.
    expect(sets.get("deepseek/deepseek-v4-pro")).toEqual(["low", "high", "xhigh", "max"]);
    expect(sets.get("openai/gpt-5.6-sol")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // A model with no reasoning control offers nothing at all.
    expect(sets.get("anthropic/claude-haiku-4-5-20251001")).toEqual([]);

    const distinct = new Set([...sets.values()].map((ids) => ids.join(",")));
    expect(distinct.size, "routes must not collapse onto one shared effort ladder").toBeGreaterThan(3);
  });

  it("treats mode ids as opaque and rejects one the exact route never advertised", () => {
    const gemini = resolveReasoningCapability("gemini", "gemini-3.7-flash");
    expect(translateReasoning({ mode: "effort", effort: "high" }, "gemini-generate-content", gemini)).toEqual({
      ok: true,
      params: { thinkingConfig: { thinkingLevel: "high" } },
    });
    // "minimal" is a real Gemini level, and a real level on OTHER Gemini
    // models — but not on this one. It must be refused before the wire.
    const refused = translateReasoning({ mode: "effort", effort: "minimal" }, "gemini-generate-content", gemini);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toMatch(/unsupported reasoning effort "minimal"/i);
  });

  it("lets the provider own the wire spelling rather than deriving it from the id", () => {
    const deepseek = resolveReasoningCapability("deepseek", "deepseek-v4-pro");
    // Four selectable depths collapse onto two wire values, declared by the
    // provider catalog — the resolver never computes this mapping.
    expect(translateReasoning({ mode: "effort", effort: "low" }, "openai-chat", deepseek)).toEqual({
      ok: true,
      params: { reasoning_effort: "high", thinking: { type: "enabled" } },
    });
    expect(translateReasoning({ mode: "effort", effort: "max" }, "openai-chat", deepseek)).toEqual({
      ok: true,
      params: { reasoning_effort: "max", thinking: { type: "enabled" } },
    });
    // OpenAI sends the id verbatim, on the same protocol.
    expect(translateReasoning({ mode: "effort", effort: "high" }, "openai-chat", resolveReasoningCapability("openai", "gpt-5.6-sol"))).toEqual({
      ok: true,
      params: { reasoning_effort: "high" },
    });
  });

  it("keeps an unverified reasoning route on Auto instead of inventing modes", () => {
    const unverified = resolveReasoningCapability("gemini", "gemini-3.1-pro-preview");
    expect(unverified.control).toBe("unknown");
    expect(reasoningModesForRoute(unverified)).toEqual([]);
    expect(translateReasoning({ mode: "auto" }, "gemini-generate-content", unverified)).toEqual({ ok: true, params: {} });
    expect(translateReasoning({ mode: "effort", effort: "high" }, "gemini-generate-content", unverified).ok).toBe(false);
  });

  it("offers a UI only the modes the selected exact route supports", () => {
    // reasoningModesForRoute is the single list every picker renders.
    const offered = (capability: RouteReasoningCapability) => reasoningModesForRoute(capability).map((m) => m.label);
    expect(offered(resolveReasoningCapability("gemini", "gemini-3.7-flash"))).toEqual(["Low", "Medium", "High"]);
    expect(offered(resolveReasoningCapability("deepseek", "deepseek-v4-pro"))).toEqual(["Low", "High", "xHigh", "Max"]);
    // Not-configurable and unknown routes offer nothing to select.
    expect(offered(resolveReasoningCapability("anthropic", "claude-sonnet-5"))).toEqual([]);
    expect(offered(resolveReasoningCapability("gemini", "gemini-3.1-pro-preview"))).toEqual([]);
  });

  it("resolves modes for a live-discovered model with no catalog entry", () => {
    installProviderModelDiscoveries([{
      providerId: "nvidia-nim",
      authMode: "catalog-api-key",
      models: [discovered({
        providerModelId: "vendor/some-reasoner",
        contextWindow: 131_072,
        reasoning: { control: "effort", efforts: ["fast", "deep"], budgets: [], source: "provider-metadata" },
      })],
      status: "available",
      errorKind: null,
      fetchedAt: "2026-08-16T00:00:00.000Z",
    }]);
    const resolved = resolveProviderModelCapabilities(route({ providerId: "nvidia-nim", modelId: "vendor/some-reasoner" }));
    // Opaque, vendor-defined ids survive resolution untouched.
    expect(resolved.reasoning.value?.efforts.map((e) => e.id)).toEqual(["fast", "deep"]);
    expect(resolved.reasoning.source).toBe("provider-reported");
  });
});

describe("provider-specific behavior stays out of generic routing", () => {
  it("keeps model-name and provider-family branches out of the generic modules", () => {
    // The failure this guards against is a `model === "..."` or
    // `providerId === "gemini"` branch creeping back into shared routing.
    const generic = ["routing/effective-context.ts", "routing/model-budget.ts", "provider/model-capabilities.ts"];
    for (const relative of generic) {
      const source = readFileSync(join(SRC, relative), "utf8");
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, `${relative} must not branch on a provider name`).not.toMatch(
        /providerId\s*===\s*["'](gemini|deepseek|openai|anthropic|nvidia-nim|tokenrouter|opencode-zen)["']/,
      );
      expect(code, `${relative} must not branch on a model name`).not.toMatch(/model(Id)?\s*===\s*["'][\w.\/-]{4,}["']/);
    }
  });

  it("keeps every reasoning wire spelling inside the single translator", () => {
    // routing/request-capabilities.ts is the one legitimate mention outside the
    // translator: it READS a provider's declared `supported_parameters` field
    // names. It never builds request params, which is the thing being guarded.
    const readsProviderFieldNames = new Set(["request-capabilities.ts"]);
    for (const dir of ["routing", "execution"]) {
      for (const file of readdirSync(join(SRC, dir))) {
        if (!file.endsWith(".ts") || readsProviderFieldNames.has(file)) continue;
        const source = readFileSync(join(SRC, dir, file), "utf8");
        expect(source, `${dir}/${file} must not spell a reasoning wire field`).not.toMatch(
          /reasoning_effort|thinkingLevel|budget_tokens/,
        );
      }
    }
    // The translator is where those spellings belong, for every dialect.
    const translator = readFileSync(join(SRC, "provider", "reasoning.ts"), "utf8");
    for (const field of ["reasoning_effort", "thinkingLevel", "budget_tokens"]) {
      expect(translator, `translator must own the ${field} spelling`).toContain(field);
    }
  });

  it("does not invent an effort ladder from a provider's declared field names", () => {
    // `supported_parameters` names fields, not values: claiming levels here
    // would reintroduce the global low/medium/high contract by the back door.
    const capability = reasoningCapabilityFromSupportedParameters(["reasoning_effort", "temperature"]);
    expect(capability?.control).toBe("effort");
    expect(capability?.efforts).toEqual([]);
    expect(capability?.wire).toBeUndefined();
    expect(reasoningModesForRoute(capability)).toEqual([]);
  });
});

describe("custom and unknown routes remain executable", () => {
  it("keeps an exact custom model id usable when every capability is unknown", () => {
    const resolved = resolveProviderModelCapabilities(route({
      providerId: "openai-compatible",
      modelId: "my-org/private-finetune-v7",
      endpointKind: "custom",
      endpointHost: "llm.internal",
    }));
    expect(resolved.contextWindow.state).toBe("unknown");
    expect(resolved.reasoning.state).toBe("unknown");
    // Unknown capability must not erase the route: the model id is preserved
    // exactly as typed, so the request can still be issued.
    expect(resolved.route.modelId).toBe("my-org/private-finetune-v7");
    expect(resolved.route.routeFingerprint).toHaveLength(64);

    const budget = resolveModelBudget({
      providerId: "openai-compatible",
      selectedModel: "my-org/private-finetune-v7",
      endpoint: { kind: "custom", host: "llm.internal", protocol: "openai-chat", limitTokens: null, limitSource: "unknown" },
    });
    expect(budget.selectedModelId).toBe("my-org/private-finetune-v7");
    expect(budget.usableInputTokens).toBeNull();
  });
});
