import { describe, expect, it } from "vitest";
import { filterCommands, fuzzyScore } from "../src/terminal/ink/palette.js";
import { commandGroup, groupCommands } from "../src/terminal/command-groups.js";
import { SLASH_COMMANDS } from "../src/terminal/commands.js";

describe("command palette matching", () => {
  it("ranks an exact prefix above a scattered subsequence", () => {
    const results = filterCommands(SLASH_COMMANDS, "und");
    expect(results[0]?.command.name).toBe("undo");
  });

  it("matches the abbreviations people actually type", () => {
    expect(fuzzyScore("msearch", "memory-search")).toBeGreaterThan(0);
    expect(fuzzyScore("ckpt", "checkpoint")).toBeGreaterThan(0);
    expect(fuzzyScore("zzz", "checkpoint")).toBe(-1);
  });

  it("never ranks a description hit above the command that owns the word", () => {
    const results = filterCommands(SLASH_COMMANDS, "undo");
    expect(results[0]?.command.name).toBe("undo");
  });

  it("returns everything when the query is empty, so the palette can browse", () => {
    expect(filterCommands(SLASH_COMMANDS, "")).toHaveLength(SLASH_COMMANDS.length);
  });
});

describe("command taxonomy", () => {
  it("files every shipped command into a group", () => {
    const grouped = groupCommands(SLASH_COMMANDS);
    const total = grouped.reduce((sum, group) => sum + group.commands.length, 0);
    expect(total).toBe(SLASH_COMMANDS.length);
  });

  it("puts the commands people reach for under the group they would look in", () => {
    expect(commandGroup("undo")).toBe("work");
    expect(commandGroup("panic")).toBe("safety");
    expect(commandGroup("model")).toBe("route");
    expect(commandGroup("cortex")).toBe("intelligence");
  });

  it("files an unknown command conservatively instead of dropping it", () => {
    expect(commandGroup("some-future-command")).toBe("advanced");
  });

  it("keeps any single group small enough to scan", () => {
    // The whole point of grouping: no bucket may become the flat 71 again.
    for (const group of groupCommands(SLASH_COMMANDS)) {
      expect(group.commands.length, group.title).toBeLessThanOrEqual(20);
    }
  });
});
