import { describe, expect, it } from "vitest";
import { BudgetGovernor } from "../src/optimization/budget-governor.js";

const noCeiling = { soft: null, hard: null };

describe("budget governor", () => {
  it("stops before a provider call that would cross a hard monetary ceiling", () => {
    const governor = new BudgetGovernor({
      providerCalls: noCeiling,
      tokens: noCeiling,
      wallClockMs: noCeiling,
      costMicros: { soft: null, hard: 100 },
    });

    const decision = governor.decide({
      providerCalls: 1,
      tokens: 500,
      wallClockMs: 200,
      knownCostMicros: 90,
      nextCall: { tokens: 100, costMicros: 20 },
    });

    expect(decision.action).toBe("stop");
    expect(decision.reason).toMatch(/cost|ceiling|before.*call/i);
  });

  it("asks before crossing a soft limit while remaining below the hard limit", () => {
    const governor = new BudgetGovernor({
      providerCalls: { soft: 1, hard: 3 },
      tokens: noCeiling,
      wallClockMs: noCeiling,
      costMicros: noCeiling,
    });

    const decision = governor.decide({
      providerCalls: 1,
      tokens: 100,
      wallClockMs: 200,
      knownCostMicros: 0,
      nextCall: { tokens: 20, costMicros: 0 },
    });

    expect(decision.action).toBe("ask");
  });

  it("does not treat unknown cost as free when a monetary ceiling is configured", () => {
    const governor = new BudgetGovernor({
      providerCalls: noCeiling,
      tokens: noCeiling,
      wallClockMs: noCeiling,
      costMicros: { soft: null, hard: 100 },
    });

    const decision = governor.decide({
      providerCalls: 0,
      tokens: 0,
      wallClockMs: 0,
      knownCostMicros: null,
      nextCall: { tokens: 1, costMicros: null },
    });

    expect(decision.action).toBe("stop");
    expect(decision.reason).toMatch(/unknown|unavailable|not.*free/i);
  });
});
