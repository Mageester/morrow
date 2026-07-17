import { describe, expect, it } from "vitest";
import { resolveModelBudget } from "../src/routing/model-budget.js";
import { admitProviderRequest, measureProviderRequest } from "../src/execution/context-budget.js";
import { prepareContextForProvider } from "../src/execution/context-budget.js";

describe("canonical model budget (single source of truth)", () => {
  it("resolves verified model capacity and derives one usable-input number", () => {
    const budget = resolveModelBudget({
      providerId: "anthropic",
      selectedModel: "claude-sonnet-5",
      endpoint: { kind: "default", host: null, protocol: "anthropic-messages", limitTokens: null, limitSource: "unknown" },
      presetContextBudgetBytes: 786432,
      outputBudgetTokens: 4096,
      toolCount: 3,
    });
    expect(budget.contextWindowTokens).toBe(1_000_000);
    expect(budget.contextWindowSource).toBe("model-metadata");
    expect(budget.contextWindowConfidence).toBe("verified");
    expect(budget.totalReserveTokens).toBeGreaterThan(4096);
    expect(budget.usableInputTokens).toBeLessThan(1_000_000);
    expect(budget.usableInputTokens).toBeGreaterThan(0);
  });

  it("labels an unresolved model honestly instead of fabricating a limit", () => {
    const budget = resolveModelBudget({
      providerId: "openai-compatible",
      selectedModel: "unknown-model",
      endpoint: { kind: "custom", host: "gateway.internal", protocol: "openai-chat", limitTokens: null, limitSource: "unknown" },
      presetContextBudgetBytes: 524288,
      outputBudgetTokens: 2048,
    });
    expect(budget.contextWindowSource).toBe("fallback");
    expect(budget.contextWindowConfidence).toBe("unverified");
  });

  it("resolves aliases to the canonical model while preserving the selection and display name", () => {
    const budget = resolveModelBudget({
      providerId: "deepseek",
      selectedModel: "deepseek-flash",
      endpoint: { kind: "default", host: "api.deepseek.com", protocol: "openai-chat", limitTokens: 131_072, limitSource: "provider-metadata" },
      outputBudgetTokens: 8_192,
    });
    expect(budget.selectedModelId).toBe("deepseek-flash");
    expect(budget.canonicalModelId).toBe("deepseek-v4-flash");
    expect(budget.displayName).toBe("DeepSeek V4 Flash");
  });

  it("agrees with itself across two independent call sites for the identical route", () => {
    // Regression for the historical defect: compaction (execution/context-budget.ts)
    // and provider admission (routing/effective-context.ts) used to compute two
    // different "how much can we send" numbers for the same request. Both the
    // deterministic-compaction path and the wire-admission path must now read
    // usableInputTokens from the same resolution.
    const routeInput = {
      providerId: "deepseek" as const,
      selectedModel: "deepseek-v4-flash",
      endpoint: { kind: "default" as const, host: "api.deepseek.com", protocol: "openai-chat" as const, limitTokens: 131_072, limitSource: "provider-metadata" as const },
      presetContextBudgetBytes: 999_999_999,
      outputBudgetTokens: 16_384,
      toolCount: 8,
    };
    const forCompaction = resolveModelBudget(routeInput);
    const forAdmission = resolveModelBudget(routeInput);
    expect(forCompaction.usableInputTokens).toBe(forAdmission.usableInputTokens);

    const prepared = prepareContextForProvider(
      [{ role: "user", content: "hello ".repeat(10) }],
      { providerId: routeInput.providerId, model: routeInput.selectedModel, maxInputTokens: forCompaction.usableInputTokens, compact: true },
    );
    expect(prepared.ok).toBe(true);

    const measurement = measureProviderRequest({
      providerId: routeInput.providerId,
      model: routeInput.selectedModel,
      protocol: "openai-chat",
      messages: [{ role: "user", content: "hello ".repeat(10) }],
      tools: [],
      outputReserveTokens: routeInput.outputBudgetTokens,
    });
    const admission = admitProviderRequest(
      { providerId: routeInput.providerId, model: routeInput.selectedModel, protocol: "openai-chat", messages: [{ role: "user", content: "hello ".repeat(10) }], tools: [], outputReserveTokens: routeInput.outputBudgetTokens },
      forAdmission,
    );
    expect(measurement.inputTokens).toBeLessThanOrEqual(forAdmission.usableInputTokens);
    expect(admission.ok).toBe(true);
  });

  it("does not reserve tool schemas twice before exact envelope admission", () => {
    const route = {
      providerId: "openai-compatible",
      selectedModel: "small-test-model",
      endpoint: { kind: "injected" as const, host: null, protocol: "openai-chat" as const, limitTokens: 16_000, limitSource: "provider-metadata" as const },
      outputBudgetTokens: 2_048,
    };
    const withoutTools = resolveModelBudget({ ...route, toolCount: 0 });
    const withCatalog = resolveModelBudget({ ...route, toolCount: 27 });

    expect(withCatalog.toolReserveTokens).toBe(0);
    expect(withCatalog.usableInputTokens).toBe(withoutTools.usableInputTokens);
  });

  it("caps the endpoint-configured ceiling for the exact custom route only, never inherited across routes", () => {
    const overridden = resolveModelBudget({
      providerId: "openai-compatible",
      selectedModel: "custom-large",
      endpoint: { kind: "custom", host: "gateway.internal", protocol: "openai-chat", limitTokens: 65_536, limitSource: "endpoint-override" },
      outputBudgetTokens: 4_096,
    });
    expect(overridden.contextWindowTokens).toBe(65_536);
    expect(overridden.contextWindowSource).toBe("endpoint-override");
    // A configured endpoint limit is a claim Morrow cannot independently
    // verify against the real provider — it must never read as "verified".
    expect(overridden.contextWindowConfidence).toBe("configured");
    expect(overridden.endpointLimitTokens).toBe(65_536);
    expect(overridden.endpointLimitSource).toBe("endpoint-override");
  });

  it("labels a genuinely provider-reported endpoint limit as verified, distinct from a configured override", () => {
    const budget = resolveModelBudget({
      providerId: "deepseek",
      selectedModel: "deepseek-v4-flash",
      endpoint: { kind: "default", host: "api.deepseek.com", protocol: "openai-chat", limitTokens: 131_072, limitSource: "provider-metadata" },
      outputBudgetTokens: 16_384,
    });
    expect(budget.contextWindowSource).toBe("provider-metadata");
    expect(budget.contextWindowConfidence).toBe("verified");
  });

  it("labels an explicit user context-window override as configured, never verified", () => {
    const budget = resolveModelBudget({
      providerId: "openai",
      selectedModel: "custom-large",
      endpoint: { kind: "injected", host: null, protocol: "openai-chat", limitTokens: null, limitSource: "unknown" },
      outputBudgetTokens: 1024,
      userContextWindowTokens: 16000,
    });
    expect(budget.contextWindowTokens).toBe(16000);
    expect(budget.contextWindowConfidence).toBe("configured");
  });
});
