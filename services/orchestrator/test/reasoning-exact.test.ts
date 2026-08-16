import { describe, expect, it } from "vitest";
import type { RouteReasoningCapability } from "@morrow/contracts";
import { reasoningRequiresEchoedContent, suppressReasoningForEchoContinuity, translateReasoning } from "../src/provider/reasoning.js";

describe("opaque provider reasoning capabilities", () => {
  const capability = {
    mode: "selectable" as const,
    efforts: [{ id: "thinking:maximum", label: "Maximum", wireValue: "max" }],
    supportsOff: true,
  };

  it("translates the provider-owned opaque id using its wire value", () => {
    expect(translateReasoning({ mode: "effort", effort: "thinking:maximum" }, "openai-chat", capability)).toEqual({
      ok: true,
      params: { reasoning_effort: "max" },
    });
  });

  it("rejects an effort that the exact route did not report", () => {
    expect(translateReasoning({ mode: "effort", effort: "high" }, "openai-chat", capability)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('Unsupported reasoning effort "high"'),
    });
  });

  it("rejects active reasoning controls when the exact route is unknown", () => {
    expect(translateReasoning({ mode: "effort", effort: "thinking:maximum" }, "openai-chat", {
      mode: "unknown",
      efforts: [],
    })).toMatchObject({ ok: false });
  });
});

/**
 * Regression: Morrow Harness Benchmark v1, task A on deepseek:deepseek-v4-flash.
 * A reasoning-only turn triggered the bounded recovery turn, which deliberately
 * runs with thinking disabled. The resulting assistant turn carried no
 * reasoning_content, and the next request re-enabled thinking on that history —
 * which DeepSeek rejects with 400 "The `reasoning_content` in the thinking mode
 * must be passed back to the API", failing the whole task.
 */
describe("reasoning echo continuity", () => {
  const echoRoute: RouteReasoningCapability = { control: "effort", efforts: ["high"], budgets: [], source: "provider-metadata", supportsOff: true, wire: "deepseek-thinking" };
  const plainRoute: RouteReasoningCapability = { control: "effort", efforts: ["high"], budgets: [], source: "registry", supportsOff: true };

  it("identifies routes whose wire format echoes reasoning back", () => {
    expect(reasoningRequiresEchoedContent(echoRoute)).toBe(true);
    expect(reasoningRequiresEchoedContent(plainRoute)).toBe(false);
    expect(reasoningRequiresEchoedContent(undefined)).toBe(false);
  });

  it("disables reasoning when the newest assistant turn carries none", () => {
    expect(suppressReasoningForEchoContinuity({ capability: echoRoute, lastAssistantHasReasoning: false, supportsOff: true })).toBe(true);
  });

  it("leaves reasoning enabled while the history is intact", () => {
    expect(suppressReasoningForEchoContinuity({ capability: echoRoute, lastAssistantHasReasoning: true, supportsOff: true })).toBe(false);
    expect(suppressReasoningForEchoContinuity({ capability: echoRoute, lastAssistantHasReasoning: undefined, supportsOff: true })).toBe(false);
  });

  it("never suppresses reasoning on a route that cannot disable it", () => {
    expect(suppressReasoningForEchoContinuity({ capability: echoRoute, lastAssistantHasReasoning: false, supportsOff: false })).toBe(false);
  });

  it("does not touch routes that do not echo reasoning back", () => {
    expect(suppressReasoningForEchoContinuity({ capability: plainRoute, lastAssistantHasReasoning: false, supportsOff: true })).toBe(false);
  });
});
