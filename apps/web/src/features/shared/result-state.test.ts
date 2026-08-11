import { describe, expect, it } from "vitest";
import { resultStateForDelegation } from "./result-state.js";

describe("resultStateForDelegation", () => {
  it("maps pending_approval and approved to needs_attention (an open approval boundary)", () => {
    expect(resultStateForDelegation("pending_approval").state).toBe("needs_attention");
    expect(resultStateForDelegation("approved").state).toBe("needs_attention");
  });

  it("maps rejected to blocked, never a generic failure", () => {
    expect(resultStateForDelegation("rejected").state).toBe("blocked");
  });

  it("maps completed with all acceptance criteria met to completed", () => {
    const info = resultStateForDelegation("completed", [{ met: true }, { met: true }]);
    expect(info.state).toBe("completed");
    expect(info.variant).toBe("success");
  });

  it("never renders completed as successful when a required criterion is unmet — zero evidence must not look done", () => {
    const info = resultStateForDelegation("completed", [{ met: true }, { met: false }]);
    expect(info.state).toBe("needs_attention");
    expect(info.variant).not.toBe("success");
  });

  it("maps cancelled and failed distinctly, with different explanations", () => {
    expect(resultStateForDelegation("cancelled").explain).not.toBe(resultStateForDelegation("failed").explain);
    expect(resultStateForDelegation("cancelled").state).toBe("cancelled");
    expect(resultStateForDelegation("failed").state).toBe("failed");
  });

  it("every state has a non-empty explanation, never a bare label with no context", () => {
    for (const status of ["pending_approval", "approved", "rejected", "running", "completed", "failed", "cancelled"] as const) {
      expect(resultStateForDelegation(status).explain.length).toBeGreaterThan(0);
    }
  });
});
