import { describe, it, expect } from "vitest";
import { parseTscDiagnostics, parseEslintDiagnostics, compareBaseline, summarizeDiagnostics, type Diagnostic } from "../src/workspace/diagnostics.js";

describe("parseTscDiagnostics", () => {
  it("parses tsc error/warning lines and normalizes path separators", () => {
    const out = [
      "src\\foo.ts(12,5): error TS2304: Cannot find name 'x'.",
      "src/bar.ts(3,1): warning TS6133: 'y' is declared but never used.",
      "Found 2 errors.", // non-diagnostic noise is ignored
    ].join("\n");
    const diags = parseTscDiagnostics(out);
    expect(diags).toHaveLength(2);
    expect(diags[0]).toEqual({ file: "src/foo.ts", line: 12, column: 5, severity: "error", code: "TS2304", message: "Cannot find name 'x'." });
    expect(diags[1]!.severity).toBe("warning");
  });

  it("returns an empty array for clean output", () => {
    expect(parseTscDiagnostics("")).toEqual([]);
    expect(parseTscDiagnostics("no errors here")).toEqual([]);
  });
});

describe("parseEslintDiagnostics", () => {
  it("parses eslint json into diagnostics with mapped severity", () => {
    const json = JSON.stringify([
      { filePath: "C:\\repo\\a.ts", messages: [{ line: 4, column: 2, severity: 2, ruleId: "no-unused-vars", message: "x is unused" }] },
      { filePath: "/repo/b.ts", messages: [{ line: 1, column: 1, severity: 1, ruleId: "semi", message: "Missing semicolon" }] },
    ]);
    const diags = parseEslintDiagnostics(json);
    expect(diags).toHaveLength(2);
    expect(diags[0]).toMatchObject({ file: "C:/repo/a.ts", severity: "error", code: "no-unused-vars" });
    expect(diags[1]!.severity).toBe("warning");
  });

  it("never throws on malformed or empty json", () => {
    expect(parseEslintDiagnostics("not json")).toEqual([]);
    expect(parseEslintDiagnostics("{}")).toEqual([]);
    expect(parseEslintDiagnostics("[]")).toEqual([]);
  });
});

describe("compareBaseline", () => {
  const err = (file: string, code: string, message: string, line = 1): Diagnostic => ({ file, line, column: 1, severity: "error", code, message });

  it("reports a regression when new errors appear", () => {
    const before = [err("a.ts", "TS1", "one")];
    const after = [err("a.ts", "TS1", "one"), err("a.ts", "TS2", "two")];
    const cmp = compareBaseline(before, after);
    expect(cmp.regressed).toBe(true);
    expect(cmp.newIssues.map((d) => d.code)).toEqual(["TS2"]);
    expect(cmp.fixedIssues).toEqual([]);
    expect(cmp.afterErrors).toBe(2);
  });

  it("does not regress when an error merely shifts to a different line", () => {
    const before = [err("a.ts", "TS1", "one", 10)];
    const after = [err("a.ts", "TS1", "one", 42)];
    const cmp = compareBaseline(before, after);
    expect(cmp.regressed).toBe(false);
    expect(cmp.newIssues).toEqual([]);
    expect(cmp.fixedIssues).toEqual([]);
  });

  it("reports fixed issues and no regression when errors are removed", () => {
    const before = [err("a.ts", "TS1", "one"), err("a.ts", "TS2", "two")];
    const after = [err("a.ts", "TS1", "one")];
    const cmp = compareBaseline(before, after);
    expect(cmp.regressed).toBe(false);
    expect(cmp.fixedIssues.map((d) => d.code)).toEqual(["TS2"]);
  });

  it("treats added warnings (no new errors) as not a regression", () => {
    const before: Diagnostic[] = [];
    const after: Diagnostic[] = [{ file: "a.ts", line: 1, column: 1, severity: "warning", code: "w", message: "warn" }];
    expect(compareBaseline(before, after).regressed).toBe(false);
  });
});

describe("summarizeDiagnostics", () => {
  it("counts errors and warnings", () => {
    const report = summarizeDiagnostics("tsc", [
      { file: "a", line: 1, column: 1, severity: "error", code: "TS1", message: "e" },
      { file: "a", line: 2, column: 1, severity: "warning", code: "TS2", message: "w" },
    ]);
    expect(report).toMatchObject({ tool: "tsc", count: 2, errorCount: 1, warningCount: 1 });
  });
});
