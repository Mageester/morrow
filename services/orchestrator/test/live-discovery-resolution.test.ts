import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EffectiveContextEndpointInput } from "../src/routing/effective-context.js";
import {
  installModelCatalog,
  resolveModelMetadata,
  listModels,
  resolveModelStatuses,
} from "../src/routing/models.js";
import { resolveModelBudget } from "../src/routing/model-budget.js";
import type { DiscoveredModel, ModelInfo, ProviderStatus } from "@morrow/contracts";
import type { ProviderModelDiscovery } from "../src/repositories/provider-model-discovery.js";

/**
 * Regression for the §1 context-limit defect AFTER the §6 OpenCode Go live
 * discovery is wired: per-slug metadata sourced from
 * `https://opencode.ai/zen/go/v1/models` (verified endpoint) MUST replace the
 * shared 32_768 conservative fallback, so the three reported Zen free slugs
 * (and the new OpenCode Go slugs like glm-5.2) resolve to per-model context
 * windows from the live catalog, not the shared fallback.
 */

const ZEN_FREE_SLUGS = [
  "deepseek-v4-flash-free",
  "nemotron-3-ultra-free",
  "ling-3.0-flash-free",
] as const;

const OPENCODE_GO_SLUGS = [
  "glm-5.2",
  "glm-5.1",
  "qwen3.7-plus",
  "kimi-k3",
  "minimax-m3",
] as const;

const ZEN_PROVIDER_STATUS: ProviderStatus = {
  version: 1,
  id: "openai-compatible",
  label: "OpenAI-compatible endpoint",
  kind: "api-key",
  configured: true,
  available: true,
  endpointType: "custom",
  endpointHost: "opencode.ai",
  authStatus: "configured",
  authMode: "opencode-zen",
  capabilities: { streaming: true, toolCalls: true, systemMessages: true, vision: false, customEndpoint: true, local: false },
  models: [...ZEN_FREE_SLUGS],
  defaultModel: "deepseek-v4-flash-free",
  note: null,
  setupHint: null,
};

const OPENCODE_GO_PROVIDER_STATUS: ProviderStatus = {
  version: 1,
  id: "opencode-go",
  label: "OpenCode Go",
  kind: "api-key",
  configured: true,
  available: true,
  endpointType: "custom",
  endpointHost: "opencode.ai",
  authStatus: "configured",
  authMode: "opencode-go-api-key",
  capabilities: { streaming: true, toolCalls: true, systemMessages: true, vision: false, customEndpoint: false, local: false },
  models: [...OPENCODE_GO_SLUGS],
  defaultModel: "glm-5.2",
  note: null,
  setupHint: null,
};

const NOW = "2026-07-25T00:00:00.000Z";

function discovered(slug: string, contextWindow: number, maxOutputTokens: number, displayName: string): DiscoveredModel {
  return {
    providerModelId: slug,
    displayName,
    contextWindow,
    maxOutputTokens,
    capabilities: { streaming: true, toolCalls: true, vision: false },
    metadataSource: "provider-reported",
  };
}

function discoveryRecord(
  providerId: ProviderStatus["id"],
  authMode: ProviderStatus["authMode"] & string,
  models: DiscoveredModel[]
): ProviderModelDiscovery {
  return {
    providerId,
    authMode,
    status: "available",
    models,
    errorKind: null,
    fetchedAt: NOW,
  };
}

function builtin(slug: string, providerId: ProviderStatus["id"]): ModelInfo {
  return {
    version: 1,
    id: slug,
    providerModelId: slug,
    canonicalId: slug,
    aliases: [],
    providerId,
    label: slug,
    family: null,
    generation: null,
    lifecycle: "current",
    contextWindow: null,
    maxOutputTokens: null,
    pricing: null,
    tokenUsage: true,
    streamingUsage: true,
    capabilities: { streaming: true, toolCalls: true, vision: false },
    capabilitySource: "bundled-catalog",
    speedClass: "unknown",
    costClass: "unknown",
    privacy: "remote",
    builtIn: true,
    metadataSource: "bundled-catalog",
    metadataVersion: "2026-07-16",
    fetchedAt: NOW,
    confidence: "verified",
    reasoning: { control: "none", efforts: [], budgets: [], source: "registry" },
  };
}

const ZEN_BUNDLED: ModelInfo[] = ZEN_FREE_SLUGS.map((slug) => builtin(slug, "openai-compatible"));
const GO_BUNDLED: ModelInfo[] = OPENCODE_GO_SLUGS.map((slug) => builtin(slug, "opencode-go"));

let originalCatalog: readonly ModelInfo[] = listModels();

beforeEach(() => {
  originalCatalog = listModels();
});
afterEach(() => {
  installModelCatalog([...originalCatalog]);
});

function zenEndpoint(): EffectiveContextEndpointInput {
  return {
    kind: "custom",
    host: "opencode.ai",
    protocol: "openai-chat",
    limitTokens: null,
    limitSource: "unknown",
  };
}

describe("per-slug context resolution via live provider discovery (OpenCode Zen + Go)", () => {
  it("resolves three distinct Zen free slugs to three independent context windows", () => {
    // §1 acceptance: distinct free slugs no longer collapse to 27,504. After
    // the live discovery wire-up, each slug's catalog entry carries a real
    // per-slug contextWindow sourced from `opencode.ai/zen/v1/models`.
    // The resolution path: `resolveModelStatuses(providers, discoveries)` merges
    // per-slug discovery data into ModelInfo rows, and `installModelCatalog`
    // persists them so `resolveModelMetadata` returns the discovered numbers.
    const statuses = resolveModelStatuses(
      [ZEN_PROVIDER_STATUS],
      [
        discoveryRecord("openai-compatible", "opencode-zen", [
          discovered("deepseek-v4-flash-free", 1_000_000, 384_000, "DeepSeek V4 Flash Free"),
          discovered("nemotron-3-ultra-free", 128_000, 8_000, "Nemotron 3 Ultra Free"),
          discovered("ling-3.0-flash-free", 128_000, 8_000, "Ling-3.0-flash Free"),
        ]),
      ],
    );
    installModelCatalog([...originalCatalog, ...statuses.map((s) => s.model)]);
    const expectedPerSlug: Record<string, { context: number; output: number }> = {
      "deepseek-v4-flash-free": { context: 1_000_000, output: 384_000 },
      "nemotron-3-ultra-free": { context: 128_000, output: 8_000 },
      "ling-3.0-flash-free": { context: 128_000, output: 8_000 },
    };
    for (const [slug, expected] of Object.entries(expectedPerSlug)) {
      const meta = resolveModelMetadata("openai-compatible", slug);
      // Discovery augmentation: the meta carries the discovered per-slug window.
      expect(meta.contextWindow).toBe(expected.context);
      expect(meta.maxOutputTokens).toBe(expected.output);
    }
  });

  it("resolves glm-5.2 to its real 1,000,000 / 131,072 native context + output (not the 27,504 fallback)", () => {
    // Discoveries are merged into the runtime catalog via resolveModelStatuses,
    // then re-installed. The new `opencode-go` provider is a separate id.
    const statuses = resolveModelStatuses(
      [ZEN_PROVIDER_STATUS, OPENCODE_GO_PROVIDER_STATUS],
      [
        discoveryRecord("opencode-go", "opencode-go-api-key", [
          discovered("glm-5.2", 1_000_000, 131_072, "GLM 5.2"),
          discovered("glm-5.1", 202_752, 32_768, "GLM 5.1"),
          discovered("qwen3.7-plus", 1_000_000, 65_536, "Qwen 3.7 Plus"),
          discovered("kimi-k3", 1_048_576, 131_072, "Kimi K3 (2x usage)"),
          discovered("minimax-m3", 1_000_000, 131_072, "MiniMax-M3"),
        ]),
        discoveryRecord("openai-compatible", "opencode-zen", [
          discovered("deepseek-v4-flash-free", 1_000_000, 384_000, "DeepSeek V4 Flash Free"),
          discovered("nemotron-3-ultra-free", 128_000, 8_000, "Nemotron 3 Ultra Free"),
          discovered("ling-3.0-flash-free", 128_000, 8_000, "Ling-3.0-flash Free"),
        ]),
      ],
    );
    // Re-install the catalog with the augmented models so resolveModelMetadata
    // sees them in the same way server.ts:282 does.
    const mergedModels = statuses.map((entry) => entry.model);
    installModelCatalog([...originalCatalog, ...mergedModels]);

    const glmMeta = resolveModelMetadata("opencode-go", "glm-5.2");
    expect(glmMeta.contextWindow).toBe(1_000_000);
    expect(glmMeta.maxOutputTokens).toBe(131_072);
    expect(glmMeta.confidence).toBe("reported");
    expect(glmMeta.metadataSource).toBe("provider-reported");

    // And the model budget reflects the discovered ceiling — 1,000,000 minus
    // reserves — NOT the shared 32_768 fallback that previously held every
    // unknown opencode-compatible route at ~27,504 usable tokens.
    const budget = resolveModelBudget({
      providerId: "opencode-go",
      selectedModel: "glm-5.2",
      endpoint: zenEndpoint(),
    });
    expect(budget.contextWindowTokens).toBe(1_000_000);
    expect(budget.contextWindowSource).toBe("model-metadata");
    expect(budget.contextWindowConfidence).toBe("verified");
    expect(budget.usableInputTokens).toBeGreaterThan(900_000);
    expect(budget.routeFallbackIdentity).toBe("opencode-go");
  });

  it("keeps the shared fallback label honest when discovery is absent for a Go slug", () => {
    // If discovery hasn't run for an opencode-go model, the budget is still
    // a conservative 32_768 fallback — but it's marked `unverified` and
    // demarcated as the `opencode-go` route so the diagnostic can request
    // discovery. The number is never silently reported as "verified".
    installModelCatalog([...originalCatalog]);
    const budget = resolveModelBudget({
      providerId: "opencode-go",
      selectedModel: "never-discovered-slug",
      endpoint: zenEndpoint(),
    });
    expect(budget.routeFallbackIdentity).toBe("opencode-go");
    expect(budget.contextWindowConfidence).toBe("unverified");
    expect(budget.contextWindowSource).toBe("fallback");
    expect(budget.usableInputTokens).toBeLessThan(32_768);
  });

  it("OpenCode Go and OpenCode Zen appear as distinct provider groups in the runtime model list", () => {
    // §6: provider picker must group Go models under `OpenCode Go` and Zen
    // models under the Zen route. Distinct providerId values ensure that.
    installModelCatalog([...originalCatalog, ...GO_BUNDLED, ...ZEN_BUNDLED]);
    const goModels = listModels().filter((m) => m.providerId === "opencode-go");
    const zenModels = listModels().filter((m) => m.providerId === "openai-compatible");
    for (const slug of OPENCODE_GO_SLUGS) {
      expect(goModels.some((m) => m.id === slug)).toBe(true);
    }
    for (const slug of ZEN_FREE_SLUGS) {
      expect(zenModels.some((m) => m.id === slug)).toBe(true);
    }
    // Distinct groups — no overlap.
    const overlap = goModels.filter((g) => zenModels.some((z) => z.id === g.id));
    expect(overlap).toEqual([]);
  });
});