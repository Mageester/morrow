import { describe, expect, it } from "vitest";
import { adaptiveTurnCeiling, turnMadeProgress } from "../src/execution/adaptive-budget.js";

describe("adaptive agent budget", () => {
  it("extends a productive mission while retaining a hard ceiling", () => {
    expect(adaptiveTurnCeiling(10)).toBe(30);
    expect(adaptiveTurnCeiling(1)).toBe(12);
    expect(adaptiveTurnCeiling(40)).toBe(36);
  });

  it("does not treat repeated tool calls as meaningful progress", () => {
    expect(turnMadeProgress({ responseChars: 0, completedToolSignatures: ["read_file:{\\\"path\\\":\\\"a.ts\\\"}"], repeatedToolSignatures: [] })).toBe(true);
    expect(turnMadeProgress({ responseChars: 0, completedToolSignatures: ["read_file:{\\\"path\\\":\\\"a.ts\\\"}"], repeatedToolSignatures: ["read_file:{\\\"path\\\":\\\"a.ts\\\"}"] })).toBe(false);
  });
});
