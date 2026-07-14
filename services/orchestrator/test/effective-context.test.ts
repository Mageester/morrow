import { describe, expect, it } from "vitest";
import { providerRouteFingerprint, resolveEffectiveContext } from "../src/routing/effective-context.js";

describe("route-aware effective context", () => {
  it("uses a 131072 endpoint limit for an advertised 1M model", () => {
    const resolved = resolveEffectiveContext({
      providerId: "deepseek",
      selectedModel: "deepseek-v4-flash",
      endpoint: {
        kind: "default",
        host: "api.deepseek.com",
        protocol: "openai-chat",
        limitTokens: 131_072,
        limitSource: "provider-metadata",
      },
      outputReserveTokens: 16_384,
    });

    expect(resolved.selectedModelId).toBe("deepseek-v4-flash");
    expect(resolved.canonicalModelId).toBe("deepseek-v4-flash");
    expect(resolved.advertisedModelCapacityTokens).toBe(1_000_000);
    expect(resolved.advertisedModelCapacitySource).toBe("model-metadata");
    expect(resolved.configuredEndpointLimitTokens).toBe(131_072);
    expect(resolved.endpointLimitSource).toBe("provider-metadata");
    expect(resolved.effectiveRequestLimitTokens).toBe(131_072);
    expect(resolved.maximumInputTokens).toBe(114_688);
  });

  it("uses an endpoint override only for the actual custom route", () => {
    const resolved = resolveEffectiveContext({
      providerId: "openai-compatible",
      selectedModel: "custom-large",
      endpoint: {
        kind: "custom",
        host: "gateway.internal",
        protocol: "openai-chat",
        limitTokens: 65_536,
        limitSource: "endpoint-override",
      },
      outputReserveTokens: 4_096,
    });

    expect(resolved.advertisedModelCapacityTokens).toBeNull();
    expect(resolved.configuredEndpointLimitTokens).toBe(65_536);
    expect(resolved.effectiveRequestLimitTokens).toBe(65_536);
    expect(resolved.effectiveLimitSource).toBe("endpoint-override");
    expect(resolved.maximumInputTokens).toBe(61_440);
  });

  it("keeps unknown capacities unknown while using a labelled safe fallback", () => {
    const resolved = resolveEffectiveContext({
      providerId: "openai-compatible",
      selectedModel: "unknown-model",
      endpoint: {
        kind: "custom",
        host: "gateway.internal",
        protocol: "openai-chat",
        limitTokens: null,
        limitSource: "unknown",
      },
      outputReserveTokens: 2_048,
      fallbackLimitTokens: 32_768,
    });

    expect(resolved.advertisedModelCapacityTokens).toBeNull();
    expect(resolved.configuredEndpointLimitTokens).toBeNull();
    expect(resolved.effectiveRequestLimitTokens).toBe(32_768);
    expect(resolved.effectiveLimitSource).toBe("fallback");
    expect(resolved.maximumInputTokens).toBe(30_720);
  });

  it("resolves aliases to the canonical model while preserving the selection", () => {
    const resolved = resolveEffectiveContext({
      providerId: "deepseek",
      selectedModel: "deepseek-flash",
      endpoint: {
        kind: "default",
        host: "api.deepseek.com",
        protocol: "openai-chat",
        limitTokens: 131_072,
        limitSource: "provider-metadata",
      },
      outputReserveTokens: 8_192,
    });

    expect(resolved.selectedModelId).toBe("deepseek-flash");
    expect(resolved.canonicalModelId).toBe("deepseek-v4-flash");
  });

  it("binds private continuation to the exact endpoint identity, not only its host", () => {
    const common = {
      providerId: "openai-compatible",
      model: "reasoner",
      protocol: "openai-chat" as const,
      endpointKind: "custom" as const,
      endpointHost: "gateway.internal",
    };
    const first = providerRouteFingerprint({ ...common, endpointIdentityHash: "route-v1-hash" });
    const second = providerRouteFingerprint({ ...common, endpointIdentityHash: "route-v2-hash" });
    expect(second).not.toBe(first);
  });
});
