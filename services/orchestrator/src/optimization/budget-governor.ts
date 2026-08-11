export interface BudgetCeiling {
  soft: number | null;
  hard: number | null;
}

export interface BudgetLimits {
  providerCalls: BudgetCeiling;
  tokens: BudgetCeiling;
  wallClockMs: BudgetCeiling;
  costMicros: BudgetCeiling;
}

export interface BudgetNextCall {
  tokens: number;
  costMicros: number | null;
  wallClockMs?: number;
  fallbackAvailable?: boolean;
}

export interface BudgetUsage {
  providerCalls: number;
  tokens: number;
  wallClockMs: number;
  knownCostMicros: number | null;
  nextCall: BudgetNextCall;
}

export type BudgetDecisionAction = "continue" | "ask" | "stop" | "fallback";

export interface BudgetDecision {
  action: BudgetDecisionAction;
  reason: string;
  projected: {
    providerCalls: number;
    tokens: number;
    wallClockMs: number;
    costMicros: number | null;
  };
}

const NO_CEILING: BudgetCeiling = { soft: null, hard: null };

function readNonNegativeInteger(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function envCeiling(env: NodeJS.ProcessEnv, softKey: string, hardKey: string): BudgetCeiling {
  return {
    soft: readNonNegativeInteger(env[softKey]),
    hard: readNonNegativeInteger(env[hardKey]),
  };
}

export function budgetLimitsFromEnvironment(env: NodeJS.ProcessEnv = process.env): BudgetLimits {
  return {
    providerCalls: envCeiling(env, "MORROW_BUDGET_SOFT_PROVIDER_CALLS", "MORROW_BUDGET_MAX_PROVIDER_CALLS"),
    tokens: envCeiling(env, "MORROW_BUDGET_SOFT_TOKENS", "MORROW_BUDGET_MAX_TOKENS"),
    wallClockMs: envCeiling(env, "MORROW_BUDGET_SOFT_WALL_CLOCK_MS", "MORROW_BUDGET_MAX_WALL_CLOCK_MS"),
    costMicros: envCeiling(env, "MORROW_BUDGET_SOFT_COST_MICROS", "MORROW_BUDGET_MAX_COST_MICROS"),
  };
}

function exceeds(value: number | null, ceiling: number | null): boolean {
  return ceiling !== null && value !== null && value > ceiling;
}

function hasCeiling(ceiling: BudgetCeiling): boolean {
  return ceiling.soft !== null || ceiling.hard !== null;
}

export class BudgetGovernor {
  private readonly limits: BudgetLimits;

  constructor(limits: Partial<BudgetLimits> = {}) {
    this.limits = {
      providerCalls: limits.providerCalls ?? NO_CEILING,
      tokens: limits.tokens ?? NO_CEILING,
      wallClockMs: limits.wallClockMs ?? NO_CEILING,
      costMicros: limits.costMicros ?? NO_CEILING,
    };
  }

  decide(usage: BudgetUsage): BudgetDecision {
    const projectedCost = usage.knownCostMicros === null || usage.nextCall.costMicros === null
      ? null
      : usage.knownCostMicros + usage.nextCall.costMicros;
    const projected = {
      providerCalls: usage.providerCalls + 1,
      tokens: usage.tokens + usage.nextCall.tokens,
      wallClockMs: usage.wallClockMs + (usage.nextCall.wallClockMs ?? 0),
      costMicros: projectedCost,
    };
    const hardChecks: Array<[string, number | null, BudgetCeiling]> = [
      ["provider-call", projected.providerCalls, this.limits.providerCalls],
      ["token", projected.tokens, this.limits.tokens],
      ["wall-clock", projected.wallClockMs, this.limits.wallClockMs],
      ["cost", projected.costMicros, this.limits.costMicros],
    ];
    for (const [label, value, ceiling] of hardChecks) {
      if (exceeds(value, ceiling.hard)) {
        const reason = `Projected ${label} usage ${value} exceeds hard ceiling ${ceiling.hard}; provider call was stopped before dispatch.`;
        return {
          action: usage.nextCall.fallbackAvailable ? "fallback" : "stop",
          reason,
          projected,
        };
      }
      if (label === "cost" && hasCeiling(ceiling) && projected.costMicros === null) {
        const reason = "Projected provider cost is unknown; configured monetary ceiling means unknown cost is not free, so the provider call was stopped before dispatch.";
        return {
          action: usage.nextCall.fallbackAvailable ? "fallback" : "stop",
          reason,
          projected,
        };
      }
    }
    const softChecks: Array<[string, number | null, BudgetCeiling]> = [
      ["provider-call", projected.providerCalls, this.limits.providerCalls],
      ["token", projected.tokens, this.limits.tokens],
      ["wall-clock", projected.wallClockMs, this.limits.wallClockMs],
      ["cost", projected.costMicros, this.limits.costMicros],
    ];
    for (const [label, value, ceiling] of softChecks) {
      if (exceeds(value, ceiling.soft)) {
        return { action: "ask", reason: `Projected ${label} usage crosses the configured soft ceiling ${ceiling.soft}; approval is required before dispatch.`, projected };
      }
      if (label === "cost" && ceiling.soft !== null && value === null) {
        return { action: "ask", reason: "Projected provider cost is unknown and a soft monetary ceiling is configured; approval is required before dispatch.", projected };
      }
    }
    return { action: "continue", reason: "Projected provider usage remains within configured ceilings.", projected };
  }

  beforeProviderCall(usage: BudgetUsage): BudgetDecision {
    return this.decide(usage);
  }
}
