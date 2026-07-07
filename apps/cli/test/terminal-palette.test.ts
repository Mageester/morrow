import { describe, expect, it } from "vitest";
import { Output } from "../src/cli/output.js";
import { SLASH_COMMANDS } from "../src/terminal/commands.js";
import { fuzzyPalette, renderPalette, staticPaletteItems, type PaletteItem } from "../src/terminal/palette.js";
import { initialInputState, reduceKey, type InputState, type KeyContext } from "../src/terminal/input-state.js";

const ctx: KeyContext = { commands: SLASH_COMMANDS, paletteItems: staticPaletteItems(SLASH_COMMANDS) };

function press(state: InputState, keys: Array<Parameters<typeof reduceKey>[1]>): { state: InputState; action: ReturnType<typeof reduceKey>["action"] } {
  let s = state;
  let action: ReturnType<typeof reduceKey>["action"] = { type: "none" };
  for (const key of keys) {
    const res = reduceKey(s, key, ctx);
    s = res.state;
    action = res.action;
  }
  return { state: s, action };
}

describe("staticPaletteItems", () => {
  it("exposes every slash command plus the capability modes", () => {
    const items = staticPaletteItems(SLASH_COMMANDS);
    expect(items.filter((i) => i.kind === "command")).toHaveLength(SLASH_COMMANDS.length);
    const modeRuns = items.filter((i) => i.kind === "mode").map((i) => i.run);
    expect(modeRuns).toEqual(["/mode ask", "/mode plan", "/mode build", "/mode mission", "/yolo on", "/yolo off"]);
    // Every item resolves to a runnable slash line — nothing decorative.
    for (const item of items) expect(item.run.startsWith("/")).toBe(true);
  });
});

describe("fuzzyPalette", () => {
  const items: PaletteItem[] = [
    { kind: "command", label: "/checkpoint", hint: "named workspace checkpoints", run: "/checkpoint" },
    { kind: "command", label: "/clear", hint: "clear the screen", run: "/clear" },
    { kind: "mode", label: "Plan mode", hint: "no changes", run: "/mode plan" },
  ];

  it("returns everything for an empty query", () => {
    expect(fuzzyPalette("", items)).toHaveLength(3);
  });

  it("prefix matches rank above loose subsequence matches", () => {
    const ranked = fuzzyPalette("ch", items);
    expect(ranked[0]!.label).toBe("/checkpoint");
  });

  it("matches subsequences across label and hint, and drops non-matches", () => {
    expect(fuzzyPalette("plnmd", items).map((i) => i.label)).toEqual(["Plan mode"]);
    expect(fuzzyPalette("zzz", items)).toEqual([]);
  });
});

describe("Ctrl+K palette interaction", () => {
  it("opens with Ctrl+K, toggles closed with Ctrl+K, and closes with Esc", () => {
    let s = initialInputState();
    s = press(s, [{ ctrl: true, name: "k" }]).state;
    expect(s.overlay).toBe("palette");
    s = press(s, [{ ctrl: true, name: "k" }]).state;
    expect(s.overlay).toBe("none");
    s = press(s, [{ ctrl: true, name: "k" }, { name: "escape" }]).state;
    expect(s.overlay).toBe("none");
  });

  it("types to filter, navigates with arrows, and Enter submits the selected run", () => {
    const opened = press(initialInputState(), [
      { ctrl: true, name: "k" },
      { str: "p", name: "p" },
      { str: "a", name: "a" },
      { str: "n", name: "n" },
    ]).state;
    expect(opened.paletteQuery).toBe("pan");
    const visible = fuzzyPalette(opened.paletteQuery, ctx.paletteItems);
    expect(visible.length).toBeGreaterThan(0);
    expect(visible[0]!.run).toBe("/panic");

    const submitted = press(opened, [{ name: "return" }]);
    expect(submitted.action).toEqual({ type: "submit", value: "/panic" });
    expect(submitted.state.overlay).toBe("none");
    expect(submitted.state.paletteQuery).toBe("");
    // The chosen command lands in history for ↑ recall.
    expect(submitted.state.history).toContain("/panic");
  });

  it("down/tab move the selection and Enter honors it", () => {
    const opened = press(initialInputState(), [{ ctrl: true, name: "k" }]).state;
    const all = fuzzyPalette("", ctx.paletteItems);
    const second = press(opened, [{ name: "down" }, { name: "return" }]);
    expect(second.action).toEqual({ type: "submit", value: all[1]!.run });
    const viaTab = press(opened, [{ name: "tab" }, { name: "tab" }, { name: "return" }]);
    expect(viaTab.action).toEqual({ type: "submit", value: all[2]!.run });
  });

  it("backspace edits the query and Ctrl+U clears it", () => {
    let s = press(initialInputState(), [
      { ctrl: true, name: "k" },
      { str: "x", name: "x" },
      { str: "y", name: "y" },
    ]).state;
    s = press(s, [{ name: "backspace" }]).state;
    expect(s.paletteQuery).toBe("x");
    s = press(s, [{ ctrl: true, name: "u" }]).state;
    expect(s.paletteQuery).toBe("");
    expect(s.overlay).toBe("palette");
  });

  it("Ctrl+C closes the palette without arming exit, and Enter on no matches is a no-op", () => {
    let s = press(initialInputState(), [{ ctrl: true, name: "k" }]).state;
    const closed = press(s, [{ ctrl: true, name: "c" }]);
    expect(closed.state.overlay).toBe("none");
    expect(closed.action.type).not.toBe("exit");

    s = press(initialInputState(), [{ ctrl: true, name: "k" }, { str: "z", name: "z" }, { str: "q", name: "q" }, { str: "j", name: "j" }]).state;
    const noMatch = press(s, [{ name: "return" }]);
    expect(noMatch.action).toEqual({ type: "none" });
    expect(noMatch.state.overlay).toBe("palette");
  });

  it("preserves the in-progress buffer while the palette is open", () => {
    let s = press(initialInputState(), [{ str: "d", name: "d" }, { str: "r", name: "r" }]).state;
    expect(s.buffer).toBe("dr");
    s = press(s, [{ ctrl: true, name: "k" }, { str: "a", name: "a" }, { name: "escape" }]).state;
    expect(s.buffer).toBe("dr");
    expect(s.cursor).toBe(2);
  });
});

describe("renderPalette", () => {
  const out = new Output({ json: false, quiet: false, color: false });

  it("renders query, selection pointer, and an honest empty state", () => {
    const items = fuzzyPalette("", staticPaletteItems(SLASH_COMMANDS));
    const lines = renderPalette(items, out, { query: "", selected: 0, max: 5, unicode: false, columns: 80 });
    expect(lines[0]).toContain("Command palette");
    expect(lines.some((l) => l.includes("…"))).toBe(true); // more than max items
    const empty = renderPalette([], out, { query: "zzz", selected: 0, max: 5, unicode: false, columns: 80 });
    expect(empty.some((l) => l.includes("no matches"))).toBe(true);
  });
});
