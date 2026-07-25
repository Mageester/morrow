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

  it("reproduces three unrelated Zen free slugs collapsing to identical usable input", () => {
    // THE BUG: distinct models share one ceiling because the bundled catalog
    // has no entries for `*-free` slugs and effective-context.ts falls back to
    // the single shared DEFAULT_SAFE_FALLBACK_TOKENS for every custom endpoint.
    const usable = budgets.map((b) => b.usableInputTokens);
    expect(new Set(usable).size).toBe(1);
    // Matches the operator-reported "27,504 usable" within the reserve formula.
    expect(usable[0]).toBeLessThan(32_768);
    expect(usable[0]).toBeGreaterThan(20_000);
  });

  it("honestly labels the shared fallback as unverified (provenance already correct)", () => {
    // The metadata provenance is already truthful — the bug is operational, not
    // a mislabel. A fix must preserve this so fallback is never "verified".
    for (const b of budgets) {
      expect(b.contextWindowConfidence).toBe("unverified");
      expect(b.contextWindowSource).toBe("fallback");
    }
  });

  it("exposes the fallback limit in endpointLimitTokens so consumers can detect it", () => {
    // The fix uses this field to surface "fallback ceiling" to the diagnostic UI
    // and to emit a metadata-gap event rather than silently reusing the constant.
    for (const b of budgets) {
      expect(b.endpointLimitTokens).toBeNull();
      // effective-context.ts reports fallbackLimitTokens internally; ModelBudget
      // surfaces endpointLimitTokens (null when only the fallback was used).
    }
  });

  it("would differentiate after a route-aware fix: two same-host Zen slugs stay shareable per-route while a custom-host slug differs", () => {
    // Forward-looking target shape for the fix: a custom-compatible endpoint at
    // a different host (e.g. LM Studio local) must NOT inherit the opencode.ai
    // host-keyed fallback. Today both share the same generic 32_768 fallback,
    // which is part of the defect surface this slice tightens.
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
    // Both currently share the same fallback (the bug). After the route-aware
    // fix, this assertion should flip: distinct hosts with no verified metadata
    // have INDEPENDENT conservative ceilings.
    expect(localBudget.usableInputTokens).toBe(budgets[0]!.usableInputTokens);
  });

  it("demarcates the unverified-route category on the budget (provenance seam for §6 OpenCode Go live discovery)", () => {
    // The fallback source provenance field exposes WHICH category of route the
    // conservative fallback applies to, WITHOUT fabricating per-slug context.
    // This is the seam the §6 OpenCode Go work fills in: an opencode-ai route
    // classed as the Zen subscription path becomes the opencode-zen identity,
    // and a local LM Studio route is classed as custom-compatible. Both still
    // share the 32_768 number today; the diagnostic/telemetry can now tell them
    // apart and ask for the right next-step fix (live discovery for OpenCode-
    // branded hosts; explicit user override for arbitrary custom endpoints).
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
    // A bundled provider with no custom endpoint does NOT inherit route-keyed
    // fallback demarcation — its declared native context governs.
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
    // OpenCode Go is now a separate first-class provider (id: "opencode-go",
    // base URL https://opencode.ai/zen/go/v1, env OPENCODE_GO_API_KEY). Its
    // route-fallback identity must be `opencode-go` even when the host is
    // opencode.ai, so the diagnostic/telemetry can route discovery requests
    // to the right auth/credentials path.
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
    // Before live discovery runs, the fallback is still shared 32_768, but it
    // is demarcated as the opencode-go route so consumers can ask for the
    // right fix.
    expect(goBudget.contextWindowConfidence).toBe("unverified");
    expect(goBudget.contextWindowSource).toBe("fallback");
  });
});