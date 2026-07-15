import { describe, expect, it } from "vitest";
import type { ReasoningConfiguration, RouteReasoningCapability } from "@morrow/contracts";
import { resolveReasoningCapability, resolveModelMetadata } from "../src/routing/models.js";
import { resolveModelBudget } from "../src/routing/model-budget.js";
import { translateReasoning } from "../src/provider/reasoning.js";

const effortCap: RouteReasoningCapability = { control: "effort", efforts: ["low", "medium", "high"], budgets: [], source: "registry" };
const budgetCap: RouteReasoningCapability = { control: "budget", efforts: [], budgets: [2048, 8192, 16384], source: "provider-metadata" };
const fixedCap: RouteReasoningCapability = { control: "fixed", efforts: [], budgets: [], source: "registry" };
const noneCap: RouteReasoningCapability = { control: "none", efforts: [], budgets: [], source: "registry" };

describe("registry reasoning capability, with provenance", () => {
  it("declares effort control for reasoning-capable OpenAI models", () => {
    const cap = resolveReasoningCapability("openai", "gpt-5.5");
    expect(cap.control).toBe("effort");
    expect(cap.efforts).toEqual(["low", "medium", "high"]);
    expect(cap.source).toBe("registry");
  });

  it("declares fixed control for the DeepSeek reasoner", () => {
    expect(resolveReasoningCapability("deepseek", "deepseek-reasoner").control).toBe("fixed");
  });

  it("declares no reasoning for plain chat models", () => {
    expect(resolveReasoningCapability("deepseek", "deepseek-chat").control).toBe("none");
    expect(resolveReasoningCapability("deepseek", "deepseek-chat").source).toBe("registry");
  });

  it("returns an explicit unknown capability for a model the registry has never seen", () => {
    const cap = resolveReasoningCapability("openai-compatible", "north-mini-code-free");
    expect(cap.control).toBe("none");
    expect(cap.source).toBe("unknown"); // never a guessed control
    expect(resolveModelMetadata("openai-compatible", "north-mini-code-free").builtIn).toBe(false);
  });

  it("threads the reasoning capability into the canonical ModelBudget", () => {
    const budget = resolveModelBudget({
      providerId: "openai",
      selectedModel: "gpt-5.5",
      endpoint: { kind: "default", host: null, protocol: "openai-chat", limitTokens: null, limitSource: "unknown" },
    });
    expect(budget.reasoning.control).toBe("effort");
  });
});

describe("translateReasoning — provider-specific, never uniform", () => {
  it("maps effort to reasoning_effort for the OpenAI family", () => {
    const cfg: ReasoningConfiguration = { mode: "effort", effort: "high" };
    const r = translateReasoning(cfg, "openai-chat", effortCap);
    expect(r).toEqual({ ok: true, params: { reasoning_effort: "high" } });
  });

  it("rejects effort on a protocol that has no effort API", () => {
    const r = translateReasoning({ mode: "effort", effort: "high" }, "anthropic-messages", effortCap);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not supported/i);
  });

  it("rejects an effort level the route does not advertise", () => {
    const lowOnly: RouteReasoningCapability = { control: "effort", efforts: ["low"], budgets: [], source: "registry" };
    const r = translateReasoning({ mode: "effort", effort: "high" }, "openai-chat", lowOnly);
    expect(r.ok).toBe(false);
  });

  it("maps a token budget to Anthropic thinking, and rejects an unlisted budget", () => {
    const ok = translateReasoning({ mode: "budget", tokens: 8192 }, "anthropic-messages", budgetCap);
    expect(ok).toEqual({ ok: true, params: { thinking: { type: "enabled", budget_tokens: 8192 } } });
    const bad = translateReasoning({ mode: "budget", tokens: 9999 }, "anthropic-messages", budgetCap);
    expect(bad.ok).toBe(false);
  });

  it("rejects a token budget on the OpenAI family (no budget API)", () => {
    const r = translateReasoning({ mode: "budget", tokens: 8192 }, "openai-chat", budgetCap);
    expect(r.ok).toBe(false);
  });

  it("auto always passes with no params, on every control", () => {
    for (const cap of [effortCap, budgetCap, fixedCap, noneCap]) {
      expect(translateReasoning({ mode: "auto" }, "openai-chat", cap)).toEqual({ ok: true, params: {} });
    }
  });

  it("rejects tuning a provider-fixed reasoner, but accepts its provider-fixed mode", () => {
    expect(translateReasoning({ mode: "effort", effort: "low" }, "openai-chat", fixedCap).ok).toBe(false);
    expect(translateReasoning({ mode: "off" }, "openai-chat", fixedCap).ok).toBe(false);
    expect(translateReasoning({ mode: "provider-fixed" }, "openai-chat", fixedCap)).toEqual({ ok: true, params: {} });
  });

  it("rejects any active reasoning on a route with no controls", () => {
    expect(translateReasoning({ mode: "effort", effort: "low" }, "openai-chat", noneCap).ok).toBe(false);
    expect(translateReasoning({ mode: "off" }, "openai-chat", noneCap)).toEqual({ ok: true, params: {} });
  });
});
