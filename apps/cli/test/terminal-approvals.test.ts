import { describe, it, expect } from "vitest";
import { approvalDecisionForKey, approvalDecisionLabel, approvalActionsLine } from "../src/terminal/approvals.js";

describe("approval key semantics (safety)", () => {
  it("approves/denies only on explicit letter keys", () => {
    expect(approvalDecisionForKey({ str: "y" })).toBe("allow_once");
    expect(approvalDecisionForKey({ str: "Y" })).toBe("allow_once");
    expect(approvalDecisionForKey({ str: "s" })).toBe("trust_session");
    expect(approvalDecisionForKey({ str: "p" })).toBe("trust_project");
    expect(approvalDecisionForKey({ str: "n" })).toBe("deny");
  });

  it("treats Ctrl+C as an explicit deny", () => {
    expect(approvalDecisionForKey({ ctrl: true, name: "c" })).toBe("deny");
  });

  it("NEVER approves on Enter/Return — the core safety guarantee", () => {
    expect(approvalDecisionForKey({ name: "return", str: "\r" })).toBeNull();
    expect(approvalDecisionForKey({ name: "enter", str: "\n" })).toBeNull();
    expect(approvalDecisionForKey({ str: "\r" })).toBeNull();
    expect(approvalDecisionForKey({ str: "\n" })).toBeNull();
  });

  it("does nothing on Space, Tab, arrows, or stray characters", () => {
    expect(approvalDecisionForKey({ name: "space", str: " " })).toBeNull();
    expect(approvalDecisionForKey({ name: "tab" })).toBeNull();
    expect(approvalDecisionForKey({ name: "up" })).toBeNull();
    expect(approvalDecisionForKey({ str: "x" })).toBeNull();
    expect(approvalDecisionForKey({ str: "1" })).toBeNull();
    expect(approvalDecisionForKey({})).toBeNull();
  });

  it("does not let other Ctrl combos stand in for a letter choice", () => {
    // Ctrl+Y must not approve even though 'y' would.
    expect(approvalDecisionForKey({ ctrl: true, name: "y", str: "y" })).toBeNull();
  });

  it("labels decisions honestly", () => {
    expect(approvalDecisionLabel("allow_once")).toBe("approved");
    expect(approvalDecisionLabel("trust_session")).toBe("trusted (session)");
    expect(approvalDecisionLabel("trust_project")).toBe("trusted (project)");
    expect(approvalDecisionLabel("deny")).toBe("denied");
  });

  it("renders a compact action row with all three primary choices", () => {
    const row = approvalActionsLine("approve");
    expect(row).toContain("[y] approve once");
    expect(row).toContain("[s] trust session");
    expect(row).toContain("[n] deny");
    expect(approvalActionsLine("apply")).toContain("[y] apply once");
  });
});
