import { describe, expect, it } from "vitest";
import { isReasoningCompatible, normalizeReasoningForRoute, RoutingDecisionSchema } from "../src/index.js";
import type { RouteReasoningCapability } from "../src/index.js";

const effort: RouteReasoningCapability = { control: "effort", efforts: ["low", "medium", "high"], budgets: [], source: "registry" };
const budget: RouteReasoningCapability = { control: "budget", efforts: [], budgets: [2048, 8192], source: "provider-metadata" };
const fixed: RouteReasoningCapability = { control: "fixed", efforts: [], budgets: [], source: "registry" };
const none: RouteReasoningCapability = { control: "none", efforts: [], budgets: [], source: "registry" };

describe("isReasoningCompatible (protocol-agnostic capability check)", () => {
  it("auto is always compatible", () => {
    for (const cap of [effort, budget, fixed, none]) expect(isReasoningCompatible({ mode: "auto" }, cap)).toBe(true);
  });
  it("effort control accepts only its advertised levels", () => {
    expect(isReasoningCompatible({ mode: "effort", effort: "high" }, effort)).toBe(true);
    expect(isReasoningCompatible({ mode: "effort", effort: "high" }, { ...effort, efforts: ["low"] })).toBe(false);
    expect(isReasoningCompatible({ mode: "effort", effort: "high" }, budget)).toBe(false);
    expect(isReasoningCompatible({ mode: "effort", effort: "high" }, none)).toBe(false);
  });
  it("budget control accepts off and its advertised budgets", () => {
    expect(isReasoningCompatible({ mode: "off" }, budget)).toBe(true);
    expect(isReasoningCompatible({ mode: "budget", tokens: 8192 }, budget)).toBe(true);
    expect(isReasoningCompatible({ mode: "budget", tokens: 4096 }, budget)).toBe(false);
    expect(isReasoningCompatible({ mode: "budget", tokens: 4096 }, { ...budget, budgets: [] })).toBe(true); // unknown budget set = permissive
  });
  it("fixed control only accepts provider-fixed", () => {
    expect(isReasoningCompatible({ mode: "provider-fixed" }, fixed)).toBe(true);
    expect(isReasoningCompatible({ mode: "off" }, fixed)).toBe(false);
  });
  it("none control only accepts off", () => {
    expect(isReasoningCompatible({ mode: "off" }, none)).toBe(true);
    expect(isReasoningCompatible({ mode: "effort", effort: "low" }, none)).toBe(false);
  });
});

describe("normalizeReasoningForRoute", () => {
  it("keeps a compatible config unchanged", () => {
    expect(normalizeReasoningForRoute({ mode: "effort", effort: "high" }, effort)).toEqual({ config: { mode: "effort", effort: "high" }, changed: false });
  });
  it("resets an incompatible config to Auto and flags the change", () => {
    expect(normalizeReasoningForRoute({ mode: "effort", effort: "high" }, none)).toEqual({ config: { mode: "auto" }, changed: true });
  });
  it("treats an absent config as Auto (never a spurious reset)", () => {
    expect(normalizeReasoningForRoute(undefined, effort)).toEqual({ config: { mode: "auto" }, changed: false });
  });
});

describe("RoutingDecisionSchema carries an optional reasoning selection", () => {
  const base = {
    version: 1 as const, presetId: "balanced" as const, providerId: "openai" as const, model: "gpt-5.5",
    reason: "test", fallbackUsed: false, overridden: false, privacy: "cloud" as const, candidates: [],
  };
  it("parses without reasoning (backward compatible)", () => {
    expect(RoutingDecisionSchema.parse(base).reasoning).toBeUndefined();
  });
  it("parses with a reasoning selection attached", () => {
    const parsed = RoutingDecisionSchema.parse({ ...base, reasoning: { mode: "effort", effort: "high" } });
    expect(parsed.reasoning).toEqual({ mode: "effort", effort: "high" });
  });
});
