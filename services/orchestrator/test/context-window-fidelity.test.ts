import { describe, expect, it } from "vitest";
import { ProviderIdSchema, type ProviderId } from "@morrow/contracts";
import { createProvider, getProviderDefaultModel } from "../src/provider/registry.js";
import { providerEnvMapping } from "../src/provider/secrets.js";
import { resolveModelMetadata, BUILT_IN_MODELS } from "../src/routing/models.js";
import { resolveModelBudget, COMPACTION_TARGET_RATIO } from "../src/routing/model-budget.js";
import { admitMeasuredProviderRequest } from "../src/execution/context-budget.js";
import type { ProviderRouteMetadata } from "../src/provider/base.js";

/**
 * A route must not report less context than the model it is calling actually
 * has.
 *
 * This exists because Morrow shipped the opposite for a long time. DeepSeek's
 * bundled `defaultEndpointLimitTokens: 131_072` predated the V4 models and, via
 * the `min()` in `resolveEffectiveContext`, silently capped a published
 * 1,000,000-token window at roughly an eighth of itself. Nothing failed loudly:
 * the model answered, the suite stayed green, and long tasks simply compacted
 * eight times more often than they needed to — re-reading files they had
 * already read, until a task could spend 276 compactions and ~201 MB of
 * checkpoints without finishing.
 *
 * So the rule is enforced as a class over the whole registry rather than as one
 * assertion about DeepSeek. A provider that reintroduces a stale constant fails
 * here, whether or not anyone remembers this incident.
 */

/** Build a default route for a provider using a placeholder credential.
 * Returns null when the provider cannot be constructed without real setup
 * (local runtimes, OAuth-only routes, custom endpoints). */
function defaultRouteFor(providerId: ProviderId): { route: ProviderRouteMetadata; model: string } | null {
  const apiKeyEnv = providerEnvMapping(providerId)?.apiKeyEnv;
  if (!apiKeyEnv) return null;
  const env = { [apiKeyEnv]: "placeholder-not-a-real-key" };
  try {
    const model = getProviderDefaultModel(providerId, env);
    if (!model) return null;
    const route = createProvider(providerId, env, model).route;
    if (!route || route.endpointKind !== "default") return null;
    return { route, model };
  } catch {
    return null;
  }
}

function budgetForRoute(providerId: ProviderId, model: string, route: ProviderRouteMetadata) {
  return resolveModelBudget({
    providerId,
    selectedModel: model,
    endpoint: {
      kind: route.endpointKind,
      host: route.endpointHost,
      protocol: route.protocol,
      limitTokens: route.endpointLimitTokens,
      limitSource: route.endpointLimitSource,
    },
    presetContextBudgetBytes: 524_288,
    outputBudgetTokens: 4_096,
  });
}

describe("a default route never reports less context than its model has", () => {
  it("covers every provider that can build a default route", () => {
    const covered: string[] = [];
    for (const providerId of ProviderIdSchema.options as readonly ProviderId[]) {
      const resolved = defaultRouteFor(providerId);
      if (!resolved) continue;
      const advertised = resolveModelMetadata(providerId, resolved.model).contextWindow;
      if (advertised === null) continue;
      covered.push(providerId);

      const budget = budgetForRoute(providerId, resolved.model, resolved.route);
      expect(
        budget.contextWindowTokens,
        `${providerId}/${resolved.model} resolves ${budget.contextWindowTokens} tokens but the model advertises ${advertised}`,
      ).toBe(advertised);
      expect(budget.contextWindowConfidence).toBe("verified");
    }
    // The guard is worthless if it silently covers nothing.
    expect(covered).toContain("deepseek");
    expect(covered.length).toBeGreaterThan(1);
  });

  it("keeps a bundled endpoint constant from capping a verified model", () => {
    // The exact historical shape: a default route declaring far less than the
    // model, from provider metadata rather than an operator.
    const budget = resolveModelBudget({
      providerId: "deepseek",
      selectedModel: "deepseek-v4-flash",
      endpoint: { kind: "default", host: "api.deepseek.com", protocol: "openai-chat", limitTokens: 131_072, limitSource: "provider-metadata" },
      outputBudgetTokens: 4_096,
    });
    expect(budget.contextWindowTokens).toBe(1_000_000);
    expect(budget.contextWindowSource).toBe("model-metadata");
  });

  it("still uses the bundled constant for a model it has no metadata for", () => {
    // Demoting the constant must not push unknown ids onto the 32,768 safe
    // fallback — that would be a different regression in the same file.
    const budget = resolveModelBudget({
      providerId: "deepseek",
      selectedModel: "deepseek-some-unreleased-id",
      endpoint: { kind: "default", host: "api.deepseek.com", protocol: "openai-chat", limitTokens: 131_072, limitSource: "provider-metadata" },
      outputBudgetTokens: 4_096,
    });
    expect(budget.contextWindowTokens).toBe(131_072);
    expect(budget.contextWindowSource).toBe("provider-metadata");
  });
});

describe("DeepSeek V4 resolves its published window on every selection", () => {
  // deepseek-chat and deepseek-reasoner are the legacy aliases; they keep their
  // own thinking/non-thinking semantics but share V4's capacity.
  const selections = ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-flash", "deepseek-pro", "deepseek-chat", "deepseek-reasoner"];

  it.each(selections)("resolves %s to 1,000,000 verified tokens", (selectedModel) => {
    const budget = resolveModelBudget({
      providerId: "deepseek",
      selectedModel,
      endpoint: { kind: "default", host: "api.deepseek.com", protocol: "openai-chat", limitTokens: 131_072, limitSource: "provider-metadata" },
      outputBudgetTokens: 4_096,
    });
    expect(budget.contextWindowTokens).toBe(1_000_000);
    expect(budget.contextWindowSource).toBe("model-metadata");
    expect(budget.contextWindowConfidence).toBe("verified");
  });

  it("resolves the same DeepSeek selections through OpenRouter", () => {
    // Known issue 15: the legacy slugs were declared on the native route only,
    // so selecting one through the gateway resolved to no metadata and fell to
    // the 32,768-token safe fallback -- "36160 tokens needed, 24432 available"
    // on a model that accepts 1,000,000. A slug reachable on two routes must
    // resolve on both.
    for (const selectedModel of ["deepseek/deepseek-chat", "deepseek/deepseek-reasoner", "deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"]) {
      const budget = resolveModelBudget({
        providerId: "openrouter",
        selectedModel,
        endpoint: { kind: "default", host: "openrouter.ai", protocol: "openai-chat", limitTokens: null, limitSource: "unknown" },
        outputBudgetTokens: 4_096,
      });
      expect(budget.contextWindowTokens, selectedModel).toBe(1_000_000);
      expect(budget.contextWindowSource, selectedModel).toBe("model-metadata");
    }
  });

  it("admits the 148,403-token request the live incident refused", () => {
    // test/context-budget.test.ts pins the rejection when 131,072 is the route's
    // actual limit; that stays correct. This is the same request on the route
    // DeepSeek really serves, where refusing it was Morrow's own defect.
    const budget = resolveModelBudget({
      providerId: "deepseek",
      selectedModel: "deepseek-v4-flash",
      endpoint: { kind: "default", host: "api.deepseek.com", protocol: "openai-chat", limitTokens: 131_072, limitSource: "provider-metadata" },
      outputBudgetTokens: 16_384,
    });
    const admission = admitMeasuredProviderRequest({
      inputTokens: 132_019,
      outputReserveTokens: 16_384,
      totalRequestTokens: 148_403,
      method: "estimate",
      exact: false,
      confidence: "conservative",
      components: { messages: 132_000, imageInputs: 0, toolSchemas: 0, providerContinuation: 0, protocolOverhead: 19 },
    }, budget);
    expect(admission.ok).toBe(true);
  });
});

describe("an operator's context override still narrows the route", () => {
  it("caps a 1,000,000-token model at the configured limit", () => {
    const route = createProvider("deepseek", {
      DEEPSEEK_API_KEY: "placeholder-not-a-real-key",
      DEEPSEEK_CONTEXT_LIMIT: "65536",
    }, "deepseek-v4-flash").route!;
    const budget = budgetForRoute("deepseek", "deepseek-v4-flash", route);
    expect(budget.contextWindowTokens).toBe(65_536);
    expect(budget.contextWindowSource).toBe("endpoint-override");
    // Never "verified": a configured number is a claim Morrow cannot check.
    expect(budget.contextWindowConfidence).toBe("configured");
  });

  it("still wipes model metadata on an unverified custom endpoint", () => {
    const route = createProvider("deepseek", {
      DEEPSEEK_API_KEY: "placeholder-not-a-real-key",
      DEEPSEEK_BASE_URL: "https://gateway.example/v1",
    }, "deepseek-v4-flash").route!;
    const budget = budgetForRoute("deepseek", "deepseek-v4-flash", route);
    expect(budget.contextWindowSource).toBe("fallback");
    expect(budget.contextWindowConfidence).toBe("unverified");
  });
});

describe("the compaction target follows the route, not a preset constant", () => {
  it("gives a large window a proportional working context", () => {
    const budget = resolveModelBudget({
      providerId: "deepseek",
      selectedModel: "deepseek-v4-flash",
      endpoint: { kind: "default", host: "api.deepseek.com", protocol: "openai-chat", limitTokens: 131_072, limitSource: "provider-metadata" },
      presetContextBudgetBytes: 524_288,
      outputBudgetTokens: 4_096,
    });
    // The regression this replaces: 524_288 bytes / 4 = 131_072 tokens, applied
    // as a ceiling, so the working context did not grow with the model at all.
    expect(budget.compactionTargetTokens).toBeGreaterThan(131_072);
    expect(budget.compactionTargetTokens).toBe(Math.floor(budget.usableInputTokens * COMPACTION_TARGET_RATIO));
  });

  it("never lets the soft target exceed the hard admission ceiling", () => {
    for (const model of BUILT_IN_MODELS) {
      if (model.contextWindow === null) continue;
      const budget = resolveModelBudget({
        providerId: model.providerId,
        selectedModel: model.id,
        endpoint: { kind: "default", host: null, protocol: "openai-chat", limitTokens: null, limitSource: "unknown" },
        presetContextBudgetBytes: 786_432,
        outputBudgetTokens: 4_096,
      });
      expect(
        budget.compactionTargetTokens,
        `${model.providerId}/${model.id} would compact above its own admission ceiling`,
      ).toBeLessThanOrEqual(budget.usableInputTokens);
      expect(budget.compactionTargetTokens).toBeGreaterThan(0);
    }
  });

  it("leaves every small-window route exactly where the old ceiling put it", () => {
    // The change is only allowed to *raise* a target, and only on routes whose
    // proportional share exceeds the preset floor. Wherever the floor still
    // governs — every route small enough that 85% of its usable input is below
    // the floor — the result must be byte-identical to the previous
    // `min(presetBudget, usableInputTokens)`.
    const presetContextBudgetBytes = 524_288;
    const floorTokens = presetContextBudgetBytes / 4;
    let checkedSmallWindow = 0;

    for (const model of BUILT_IN_MODELS) {
      if (model.contextWindow === null) continue;
      const budget = resolveModelBudget({
        providerId: model.providerId,
        selectedModel: model.id,
        endpoint: { kind: "default", host: null, protocol: "openai-chat", limitTokens: null, limitSource: "unknown" },
        presetContextBudgetBytes,
        outputBudgetTokens: 4_096,
      });
      const previousBehavior = Math.min(floorTokens, budget.usableInputTokens);
      if (Math.floor(budget.usableInputTokens * COMPACTION_TARGET_RATIO) >= floorTokens) {
        // Large window: the target grew, which is the entire point.
        expect(budget.compactionTargetTokens).toBeGreaterThanOrEqual(previousBehavior);
        continue;
      }
      checkedSmallWindow++;
      expect(
        budget.compactionTargetTokens,
        `${model.providerId}/${model.id} changed behavior on a route the floor still governs`,
      ).toBe(previousBehavior);
    }
    expect(checkedSmallWindow).toBeGreaterThan(0);
  });
});
