import { describe, expect, it } from "vitest";
import type { DiscoveredModel } from "@morrow/contracts";
import {
  isNonAgenticModelId,
  resolveFlagshipModel,
  selectFlagshipModel,
} from "../src/acceptance/flagship-model-discovery.js";

/**
 * Model selection for a live canary, covered without a network.
 *
 * OpenCode Zen is one of the two declared gate providers and has never
 * produced a single run, because it exposes no dependable default model and
 * the live suite skipped any provider `getProviderDefaultModel` returned
 * nothing for. Selection had to become explicit before the gate could be
 * reached at all — and it is worth testing precisely because a bad choice here
 * silently contaminates the evidence log with runs that say nothing about
 * Morrow.
 */

function model(providerModelId: string, overrides: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return {
    providerModelId,
    displayName: providerModelId,
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    capabilities: { streaming: true, toolCalls: true, vision: false },
    costType: "free",
    availability: "available",
    metadataSource: "provider-reported",
    ...overrides,
  } as DiscoveredModel;
}

describe("selecting a model a flagship run can actually use", () => {
  it("prefers a free route over a paid one", () => {
    const selection = selectFlagshipModel([
      model("paid-giant", { costType: "paid", contextWindow: 1_000_000 }),
      model("free-small", { costType: "free", contextWindow: 64_000 }),
    ]);
    expect(selection.ok).toBe(true);
    if (selection.ok) expect(selection.providerModelId).toBe("free-small");
  });

  it("prefers the largest window within a cost class", () => {
    const selection = selectFlagshipModel([
      model("free-small", { contextWindow: 64_000 }),
      model("free-large", { contextWindow: 1_000_000 }),
    ]);
    expect(selection.ok).toBe(true);
    if (selection.ok) expect(selection.providerModelId).toBe("free-large");
  });

  it("returns the same choice every time for the same catalogue", () => {
    // A gate whose model varies run to run is not measuring one thing.
    const catalogue = [
      model("b-model", { contextWindow: 200_000 }),
      model("a-model", { contextWindow: 200_000 }),
      model("c-model", { contextWindow: 200_000 }),
    ];
    const first = selectFlagshipModel(catalogue);
    const reordered = selectFlagshipModel([...catalogue].reverse());
    expect(first.ok && reordered.ok && first.providerModelId === reordered.providerModelId).toBe(true);
    if (first.ok) expect(first.providerModelId).toBe("a-model");
  });

  it("excludes a model that cannot call tools", () => {
    // The workflow builds and runs an app; without tool calls it cannot start.
    const selection = selectFlagshipModel([
      model("no-tools", { capabilities: { streaming: true, toolCalls: false, vision: false } }),
    ]);
    expect(selection.ok).toBe(false);
    if (!selection.ok) expect(selection.rejected[0]?.reason).toContain("tool calls");
  });

  it("admits a model whose tool-call support is unreported", () => {
    // null is unknown, not false. Most endpoints do not report it, and treating
    // unknown as unsupported empties the catalogue and skips the provider.
    const selection = selectFlagshipModel([
      model("unreported", { capabilities: { streaming: true, toolCalls: null, vision: false } }),
    ]);
    expect(selection.ok).toBe(true);
  });

  it("excludes routes that are not agentic chat models", () => {
    for (const id of ["text-embedding-3-large", "whisper-1", "dall-e-3", "llama-guard-3", "voxtral-audio"]) {
      expect(isNonAgenticModelId(id), id).toBe(true);
    }
    for (const id of ["deepseek-v4-flash", "claude-sonnet-5", "gpt-5.6-terra", "glm-5.2"]) {
      expect(isNonAgenticModelId(id), id).toBe(false);
    }
  });

  it("skips a model the provider reports as unavailable", () => {
    const selection = selectFlagshipModel([
      model("retired", { availability: "unavailable" }),
      model("live-one", { availability: "available" }),
    ]);
    expect(selection.ok).toBe(true);
    if (selection.ok) expect(selection.providerModelId).toBe("live-one");
  });

  it("explains an empty result instead of reporting a bare failure", () => {
    const selection = selectFlagshipModel([
      model("text-embedding-ada"),
      model("no-tools", { capabilities: { streaming: true, toolCalls: false, vision: false } }),
    ]);
    expect(selection.ok).toBe(false);
    if (!selection.ok) {
      expect(selection.rejected).toHaveLength(2);
      expect(selection.reason).toContain("2 discovered model(s)");
    }
  });
});

describe("resolving which model a provider runs", () => {
  const neverCalled = async () => {
    throw new Error("discovery must not be called");
  };

  it("uses the configured default without any network call", async () => {
    const result = await resolveFlagshipModel({
      providerId: "deepseek",
      configuredDefault: "deepseek-v4-flash",
      requiresLiveModelDiscovery: false,
      discover: neverCalled,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.model).toBe("deepseek-v4-flash");
      expect(result.resolved.source).toBe("configured-default");
    }
  });

  it("discovers a model for a gateway that has no dependable default", async () => {
    // Exactly the OpenCode Zen case that has kept the gate at one provider.
    const result = await resolveFlagshipModel({
      providerId: "opencode-zen",
      configuredDefault: null,
      requiresLiveModelDiscovery: true,
      discover: async () => ({ ok: true, detail: "reachable", models: [model("deepseek-v4-flash-free", { contextWindow: 1_000_000 })] }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.model).toBe("deepseek-v4-flash-free");
      expect(result.resolved.source).toBe("live-discovery");
    }
  });

  it("falls back to a configured id when discovery is unreachable", async () => {
    // An unlistable endpoint is not necessarily an unusable one.
    const result = await resolveFlagshipModel({
      providerId: "openrouter",
      configuredDefault: "openrouter/auto",
      requiresLiveModelDiscovery: true,
      discover: async () => ({ ok: false, detail: "HTTP 503", models: [] }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.model).toBe("openrouter/auto");
      expect(result.resolved.detail).toContain("HTTP 503");
    }
  });

  it("refuses to guess when there is no default and nothing to discover", async () => {
    // Skipping honestly beats inventing an id and recording its failure as
    // evidence about the model.
    const result = await resolveFlagshipModel({
      providerId: "opencode-zen",
      configuredDefault: null,
      requiresLiveModelDiscovery: true,
      discover: async () => ({ ok: false, detail: "HTTP 401", models: [] }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("HTTP 401");
  });
});
