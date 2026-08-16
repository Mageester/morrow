import { describe, expect, it, beforeEach } from "vitest";
import { openDatabase } from "../src/database.js";
import { resolveEffectiveContext } from "../src/routing/effective-context.js";
import { resolveModelBudget } from "../src/routing/model-budget.js";
import { resolveModelMetadata, resolveCanonicalModelMetadata } from "../src/routing/models.js";
import { buildExactProviderRoute, resolveProviderModelCapabilities } from "../src/provider/model-capabilities.js";
import type { ProviderProtocol } from "../src/provider/base.js";
import {
  installProviderModelDiscoveries,
  invalidateProviderModelDiscoveries,
  findDiscoveredModel,
} from "../src/provider/registry.js";
import { providerModelDiscoveryRepository } from "../src/repositories/provider-model-discovery.js";
import type { DiscoveredModel } from "@morrow/contracts";

/** Build a route the same way execution does, so tests cannot drift from it. */
function exactRoute(input: {
  providerId: string;
  modelId: string;
  endpointHost: string | null;
  protocol?: ProviderProtocol;
  endpointKind?: "default" | "custom" | "injected";
}) {
  return buildExactProviderRoute({
    providerId: input.providerId,
    modelId: input.modelId,
    protocol: input.protocol ?? "openai-chat",
    endpointKind: input.endpointKind ?? "default",
    endpointHost: input.endpointHost,
  });
}

describe("dynamic and route-aware context capability resolution", () => {
  beforeEach(() => {
    invalidateProviderModelDiscoveries();
  });

  it("proves no global 32k fallback leaks into unrelated providers", () => {
    const effective = resolveEffectiveContext({
      providerId: "openai-compatible",
      selectedModel: "my-custom-llm",
      endpoint: {
        kind: "custom",
        host: "api.my-cluster.internal",
        protocol: "openai-chat",
        limitTokens: null,
        limitSource: "unknown",
      },
      outputReserveTokens: 2048,
    });

    expect(effective.advertisedModelCapacityTokens).toBeNull();
    expect(effective.configuredEndpointLimitTokens).toBeNull();
    expect(effective.effectiveRequestLimitTokens).toBeNull();
    expect(effective.effectiveLimitSource).toBe("unknown");
    expect(effective.maximumInputTokens).toBeNull();

    const budget = resolveModelBudget({
      providerId: "openai-compatible",
      selectedModel: "my-custom-llm",
      endpoint: {
        kind: "custom",
        host: "api.my-cluster.internal",
        protocol: "openai-chat",
        limitTokens: null,
        limitSource: "unknown",
      },
    });

    expect(budget.contextWindowTokens).toBeNull();
    expect(budget.usableInputTokens).toBeNull();
    expect(budget.contextWindowSource).toBe("unknown");
    expect(budget.contextWindowConfidence).toBe("unverified");
  });

  it("proves unknown stays unknown and does not fabricate a context ceiling", () => {
    const metadata = resolveModelMetadata("gemini", "gemini-nonexistent-future-model");
    expect(metadata.contextWindow).toBeNull();
    expect(metadata.metadataSource).toBe("unknown");

    const effective = resolveEffectiveContext({
      providerId: "gemini",
      selectedModel: "gemini-nonexistent-future-model",
      endpoint: {
        kind: "default",
        host: "generativelanguage.googleapis.com",
        protocol: "gemini-generate-content",
        limitTokens: null,
        limitSource: "unknown",
      },
      outputReserveTokens: 2048,
    });

    expect(effective.effectiveRequestLimitTokens).toBeNull();
    expect(effective.effectiveLimitSource).toBe("unknown");
  });

  it("proves route discovery overrides stale catalog metadata", () => {
    const discovered: DiscoveredModel = {
      providerModelId: "qwen/qwen-2.5-72b-instruct",
      displayName: "Qwen 2.5 72B Instruct (Live Discovered)",
      contextWindow: 131_072,
      maxOutputTokens: 8192,
      inputModalities: ["text"],
      outputModalities: ["text"],
      capabilities: { streaming: true, toolCalls: true, vision: false },
      fetchedAt: new Date().toISOString(),
      metadataSource: "provider-reported",
    };

    installProviderModelDiscoveries([
      {
        providerId: "nvidia-nim",
        authMode: "catalog-api-key",
        models: [discovered],
        status: "available",
        errorKind: null,
        fetchedAt: new Date().toISOString(),
      },
    ]);

    expect(findDiscoveredModel("nvidia-nim", "qwen/qwen-2.5-72b-instruct")).toBeDefined();

    const canonical = resolveCanonicalModelMetadata("nvidia-nim", "qwen/qwen-2.5-72b-instruct");
    expect(canonical.selected.contextWindow).toBe(131_072);
    expect(canonical.selected.metadataSource).toBe("provider-reported");
    expect(canonical.selected.confidence).toBe("reported");

    const budget = resolveModelBudget({
      providerId: "nvidia-nim",
      selectedModel: "qwen/qwen-2.5-72b-instruct",
      endpoint: {
        kind: "default",
        host: "integrate.api.nvidia.com",
        protocol: "openai-chat",
        limitTokens: null,
        limitSource: "unknown",
      },
    });

    expect(budget.nativeContextWindowTokens).toBe(131_072);
    expect(budget.nativeContextWindowSource).toBe("provider-metadata");
    expect(budget.contextWindowTokens).toBe(131_072);
    expect(budget.contextWindowConfidence).toBe("reported");

    const resolvedCaps = resolveProviderModelCapabilities(exactRoute({
      providerId: "nvidia-nim",
      modelId: "qwen/qwen-2.5-72b-instruct",
      endpointHost: "integrate.api.nvidia.com",
    }));
    expect(resolvedCaps.contextWindow.value).toBe(131_072);
    expect(resolvedCaps.contextWindow.source).toBe("provider-reported");
  });

  it("proves the same model ID can resolve differently on two distinct endpoints", () => {
    // Model on endpoint A with an operator limit of 64k
    const budgetA = resolveModelBudget({
      providerId: "openai-compatible",
      selectedModel: "llama-3.3-70b-instruct",
      endpoint: {
        kind: "custom",
        host: "endpoint-a.internal",
        protocol: "openai-chat",
        limitTokens: 65_536,
        limitSource: "endpoint-override",
      },
    });

    // Same model on endpoint B with an operator limit of 16k
    const budgetB = resolveModelBudget({
      providerId: "openai-compatible",
      selectedModel: "llama-3.3-70b-instruct",
      endpoint: {
        kind: "custom",
        host: "endpoint-b.internal",
        protocol: "openai-chat",
        limitTokens: 16_384,
        limitSource: "endpoint-override",
      },
    });

    expect(budgetA.effectiveContextWindowTokens).toBe(65_536);
    expect(budgetA.routeLimitTokens).toBe(65_536);
    expect(budgetA.endpointHost).toBe("endpoint-a.internal");

    expect(budgetB.effectiveContextWindowTokens).toBe(16_384);
    expect(budgetB.routeLimitTokens).toBe(16_384);
    expect(budgetB.endpointHost).toBe("endpoint-b.internal");
  });

  it("proves endpoint/runtime limits cap larger native model limits", () => {
    const budget = resolveModelBudget({
      providerId: "deepseek",
      selectedModel: "deepseek-chat",
      endpoint: {
        kind: "custom",
        host: "proxy.enterprise.corp",
        protocol: "openai-chat",
        limitTokens: 128_000,
        limitSource: "endpoint-override",
      },
    });

    expect(budget.nativeContextWindowTokens).toBe(1_000_000);
    expect(budget.nativeContextWindowSource).toBe("model-metadata");
    expect(budget.routeLimitTokens).toBe(128_000);
    expect(budget.routeLimitSource).toBe("endpoint-override");
    expect(budget.effectiveContextWindowTokens).toBe(128_000);
    expect(budget.contextWindowConfidence).toBe("configured");
  });

  it("proves cached discovery carries provenance/freshness and supports invalidation", () => {
    const db = openDatabase(":memory:");
    const repo = providerModelDiscoveryRepository(db);

    const validCred = "a".repeat(64);
    const otherCred = "b".repeat(64);
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
    repo.upsert({
      providerId: "opencode-zen",
      authMode: "opencode-zen",
      credentialIdentity: validCred,
      models: [
        {
          providerModelId: "zen-model-1",
          displayName: "Zen Model 1",
          contextWindow: 65536,
          maxOutputTokens: 4096,
          inputModalities: ["text"],
          outputModalities: ["text"],
          capabilities: { streaming: true, toolCalls: true, vision: false },
          metadataSource: "provider-reported",
        },
      ],
      status: "available",
      errorKind: null,
      fetchedAt: new Date().toISOString(),
      expiresAt,
    });

    expect(repo.isFresh("opencode-zen", "opencode-zen", new Date(), validCred)).toBe(true);
    expect(repo.isFresh("opencode-zen", "opencode-zen", new Date(), otherCred)).toBe(false);

    // Invalidation
    repo.invalidate("opencode-zen", "opencode-zen");
    expect(repo.get("opencode-zen", "opencode-zen")).toBeNull();
    db.close();
  });

  it("proves DeepSeek behavior remains correct", () => {
    const budget = resolveModelBudget({
      providerId: "deepseek",
      selectedModel: "deepseek-chat",
      endpoint: {
        kind: "default",
        host: "api.deepseek.com",
        protocol: "openai-chat",
        limitTokens: null,
        limitSource: "unknown",
      },
    });

    expect(budget.canonicalModelId).toBe("deepseek-v4-flash");
    expect(budget.nativeContextWindowTokens).toBe(1_000_000);
    expect(budget.nativeContextWindowSource).toBe("model-metadata");
    expect(budget.effectiveContextWindowTokens).toBe(1_000_000);
    expect(budget.contextWindowConfidence).toBe("verified");
    expect(budget.usableInputTokens).toBeGreaterThan(900_000);
  });
});
