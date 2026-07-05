import { describe, it, expect } from "vitest";
import { Output } from "../src/cli/output.js";
import { SLASH_COMMANDS } from "../src/terminal/commands.js";
import { clampSelection, filterCommands, matchScore, renderMenu } from "../src/terminal/completion.js";

const plain = new Output({ json: false, quiet: false, color: false });

describe("slash-command completion", () => {
  it("scores exact, prefix, and subsequence matches in that order", () => {
    expect(matchScore("mode", "mode")).toBe(1000);
    expect(matchScore("mo", "mode")! > 0).toBe(true);
    expect(matchScore("mo", "mode")! > matchScore("md", "model")!).toBe(true); // prefix beats subsequence
    expect(matchScore("xyz", "mode")).toBeNull();
  });

  it("returns the full list for an empty/slash-only query", () => {
    expect(filterCommands("/", SLASH_COMMANDS)).toHaveLength(SLASH_COMMANDS.length);
  });

  it("ranks a prefix match first", () => {
    const ranked = filterCommands("/mo", SLASH_COMMANDS).map((c) => c.name);
    expect(ranked[0]).toBe("mode"); // shorter prefix beats "model"
    expect(ranked).toContain("model");
  });

  it("finds 'yolo' from a partial", () => {
    expect(filterCommands("/yo", SLASH_COMMANDS)[0]!.name).toBe("yolo");
  });

  it("filters out non-matches", () => {
    expect(filterCommands("/zzz", SLASH_COMMANDS)).toHaveLength(0);
  });

  it("exposes the verified-mission inspection commands", () => {
    const names = SLASH_COMMANDS.map((c) => c.name);
    for (const cmd of ["criteria", "evidence", "failures", "checkpoints", "result"]) {
      expect(names).toContain(cmd);
    }
    expect(filterCommands("/crit", SLASH_COMMANDS)[0]!.name).toBe("criteria");
  });

  it("renders a menu marking the selected row and showing descriptions", () => {
    const matches = filterCommands("/m", SLASH_COMMANDS);
    const lines = renderMenu(matches, plain, { selected: 0, max: 8, unicode: true });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain("›"); // pointer on the selected row
    expect(lines.join("\n")).toContain("set the capability mode");
  });

  it("caps the menu and reports the overflow", () => {
    const lines = renderMenu(SLASH_COMMANDS, plain, { selected: 0, max: 5, unicode: false });
    expect(lines.length).toBe(6); // 5 rows + overflow line
    expect(lines[5]).toContain("more");
  });

  it("wraps selection at both ends", () => {
    expect(clampSelection(-1, 3)).toBe(2);
    expect(clampSelection(3, 3)).toBe(0);
    expect(clampSelection(1, 3)).toBe(1);
    expect(clampSelection(0, 0)).toBe(0);
  });
});
