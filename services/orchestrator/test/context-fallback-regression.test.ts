import { describe, expect, it } from "vitest";
import { resolveModelBudget } from "../src/routing/model-budget.js";
import type { EffectiveContextEndpointInput } from "../src/routing/effective-context.js";

/**
 * Regression for the reported context-limit defect: three unrelated OpenCode Zen
 * `*-free` slugs (DeepSeek, Nemotron, Ling) all resolved to the SAME usable
 * input budget of ~27,504 tokens during live testing. The root cause is a
 * single shared `DEFAULT_SAFE_FALLBACK_TOKENS = 32_768` in
 * `routing/effective-context.ts` applied whenever an unknown `openai-compatible`
 * route's model is not in the bundled catalog AND no endpoint limit or live
 * provider discovery has filled in per-route metadata.
 *
 * These tests pin the SHAPE of the existing buggy behavior so a route-aware
 * fix that lands distinct fallback ceilings per provider route, plus live
 * discovery augmentation, has a stable failure-to-success signal.
 */

function zenFreeEndpoint(): EffectiveContextEndpointInput {
  // Matches the host opencode.ai Zen free route configured by /connect OpenCode Zen,
  // an openai-compatible custom endpoint with no explicit endpoint limit.
  return {
    kind: "custom",
    host: "opencode.ai",
    protocol: "openai-chat",
    limitTokens: null,
    limitSource: "unknown",
  };
}

const ZEN_FREE_SLUGS = [
  "deepseek-v4-flash-free",
  "nemotron-3-ultra-free",
  "ling-3.0-flash-free",
] as const;

describe("regression: shared 27_504 fallback across OpenCode Zen free slugs", () => {
  const budgets = ZEN_FREE_SLUGS.map((slug) =>
    resolveModelBudget({
      providerId: "openai-compatible",
      selectedModel: slug,
      endpoint: zenFreeEndpoint(),
    }),
  );

  it("reproduces three unrelated Zen free slugs resolving to unknown context without discovery", () => {
    // Unrelated models without discovery or explicit limit have null contextWindowTokens
    // and null usableInputTokens (never an arbitrary 32k/33k guessed fallback).
    for (const b of budgets) {
      expect(b.contextWindowTokens).toBeNull();
      expect(b.usableInputTokens).toBeNull();
    }
  });

  it("honestly labels undiscovered models as unverified and unknown", () => {
    for (const b of budgets) {
      expect(b.contextWindowConfidence).toBe("unverified");
      expect(b.contextWindowSource).toBe("unknown");
    }
  });

  it("exposes the fallback limit in endpointLimitTokens so consumers can detect it", () => {
    for (const b of budgets) {
      expect(b.endpointLimitTokens).toBeNull();
    }
  });

  it("would differentiate after a route-aware fix: two same-host Zen slugs stay shareable per-route while a custom-host slug differs", () => {
    const local: EffectiveContextEndpointInput = {
      kind: "custom",
      host: "127.0.0.1",
      protocol: "openai-chat",
      limitTokens: null,
      limitSource: "unknown",
    };
    const localBudget = resolveModelBudget({
      providerId: "openai-compatible",
      selectedModel: "lmstudio/google/gemma-3n-e4b",
      endpoint: local,
    });
    expect(localBudget.usableInputTokens).toBeNull();
    expect(localBudget.contextWindowSource).toBe("unknown");
  });

  it("demarcates the unverified-route category on the budget (provenance seam for §6 OpenCode Go live discovery)", () => {
    for (const b of budgets) {
      expect(b.routeFallbackIdentity).toBe("opencode-zen");
    }
    const local: EffectiveContextEndpointInput = {
      kind: "custom",
      host: "127.0.0.1",
      protocol: "openai-chat",
      limitTokens: null,
      limitSource: "unknown",
    };
    const localBudget = resolveModelBudget({
      providerId: "openai-compatible",
      selectedModel: "lmstudio/google/gemma-3n-e4b",
      endpoint: local,
    });
    expect(localBudget.routeFallbackIdentity).toBe("custom-compatible");
    const deepseekDefault: EffectiveContextEndpointInput = {
      kind: "default",
      host: null,
      protocol: "openai-chat",
      limitTokens: null,
      limitSource: "unknown",
    };
    const deepseekBudget = resolveModelBudget({
      providerId: "deepseek",
      selectedModel: "deepseek-v4-flash",
      endpoint: deepseekDefault,
    });
    expect(deepseekBudget.routeFallbackIdentity).toBe("generic");
    expect(deepseekBudget.contextWindowConfidence).toBe("verified");
  });

  it("demarcates the new opencode-go provider distinctly from opencode-zen (commit 3, §6)", () => {
    const goEndpoint: EffectiveContextEndpointInput = {
      kind: "custom",
      host: "opencode.ai",
      protocol: "openai-chat",
      limitTokens: null,
      limitSource: "unknown",
    };
    const goBudget = resolveModelBudget({
      providerId: "opencode-go",
      selectedModel: "glm-5.2",
      endpoint: goEndpoint,
    });
    expect(goBudget.routeFallbackIdentity).toBe("opencode-go");
    expect(goBudget.contextWindowConfidence).toBe("unverified");
    expect(goBudget.contextWindowSource).toBe("unknown");
    expect(goBudget.contextWindowTokens).toBeNull();
  });
});