import { describe, expect, it } from "vitest";
import { adaptiveTurnCeiling, toolProgressFingerprint, turnMadeProgress } from "../src/execution/adaptive-budget.js";

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

  it("treats changed observations from the same tool call as progress", () => {
    const first = toolProgressFingerprint("read_file", { path: "a.ts" }, "export const a = 1;");
    const second = toolProgressFingerprint("read_file", { path: "a.ts" }, "export const a = 2;");

    expect(first).not.toBe(second);
    expect(turnMadeProgress({ responseChars: 0, completedToolSignatures: [second], repeatedToolSignatures: [first] })).toBe(true);
  });

  it("does not treat identical observations as progress", () => {
    const first = toolProgressFingerprint("search_text", { query: "invoice" }, "script.js:10 invoice");
    const repeated = toolProgressFingerprint("search_text", { query: "invoice" }, "script.js:10 invoice");

    expect(first).toBe(repeated);
    expect(turnMadeProgress({ responseChars: 0, completedToolSignatures: [repeated], repeatedToolSignatures: [first] })).toBe(false);
  });
});
