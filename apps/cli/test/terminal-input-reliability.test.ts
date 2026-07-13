import { describe, it, expect } from "vitest";
import { initialInputState, reduceKey, type InputState, type KeyContext } from "../src/terminal/input-state.js";
import { Output, stripAnsi } from "../src/cli/output.js";
import { composeApp } from "../src/terminal/app-view.js";
import { initialState, reduce, type TerminalState } from "../src/terminal/state.js";
import type { SessionMeta } from "../src/terminal/events.js";
import { SLASH_COMMANDS } from "../src/terminal/commands.js";

const ctx: KeyContext = { commands: [], paletteItems: [] };
const plain = new Output({ json: false, quiet: false, color: false });

const meta: SessionMeta = {
  greeting: "Good morning",
  projectName: "Morrow",
  workspacePath: "C:/work/Morrow",
  branch: "main · clean",
  provider: "deepseek",
  model: "deepseek-chat",
  privacy: "cloud",
  mode: "Build · approvals required",
  memory: true,
  autoApprove: false,
  providerConfigured: true,
  gitRepo: true,
};

function frameFor(input: InputState, columns: number, rows: number) {
  const base: TerminalState = reduce(initialState(), { type: "session.started", meta });
  const active = reduce(base, { type: "user.message", text: "start" }); // leave empty-state
  return composeApp(active, input, plain, false, { commands: [], paletteItems: [] }, {
    columns,
    rows,
    tick: 0,
    promptLabel: "› ",
    promptWidth: 2,
  });
}

/** Type a literal string one printable key at a time, as readline would deliver it. */
function type(state: InputState, text: string): InputState {
  let s = state;
  for (const ch of text) s = reduceKey(s, { str: ch }, ctx).state;
  return s;
}

describe("input composer reliability (pure reducer proofs)", () => {
  it("inserts plain text and tracks the cursor", () => {
    const s = type(initialInputState(), "hello");
    expect(s.buffer).toBe("hello");
    expect(s.cursor).toBe(5);
  });

  it("supports multiline input via Shift+Enter without submitting", () => {
    let s = type(initialInputState(), "line1");
    const res = reduceKey(s, { name: "return", shift: true }, ctx);
    expect(res.action.type).toBe("repaint"); // NOT submit
    s = type(res.state, "line2");
    expect(s.buffer).toBe("line1\nline2");
  });

  it("preserves unicode, backticks, and quotes verbatim", () => {
    const sample = "héllo `code` \"q\" 'q' — 世界 🚀";
    const s = type(initialInputState(), sample);
    expect(s.buffer).toBe(sample);
  });

  it("moves the cursor with left/right and edits mid-buffer", () => {
    let s = type(initialInputState(), "abcd");
    s = reduceKey(s, { name: "left" }, ctx).state; // between c and d
    s = reduceKey(s, { name: "left" }, ctx).state; // between b and c
    s = type(s, "X");
    expect(s.buffer).toBe("abXcd");
  });

  it("jumps to home and end", () => {
    let s = type(initialInputState(), "abcd");
    s = reduceKey(s, { name: "home" }, ctx).state;
    expect(s.cursor).toBe(0);
    s = reduceKey(s, { name: "end" }, ctx).state;
    expect(s.cursor).toBe(4);
  });

  it("backspace deletes before the cursor, delete deletes after", () => {
    let s = type(initialInputState(), "abc");
    s = reduceKey(s, { name: "backspace" }, ctx).state;
    expect(s.buffer).toBe("ab");
    s = reduceKey(s, { name: "home" }, ctx).state;
    s = reduceKey(s, { name: "delete" }, ctx).state;
    expect(s.buffer).toBe("b");
  });

  it("recalls command history with up/down and preserves the in-progress draft", () => {
    let s = initialInputState(["first", "second"]);
    s = type(s, "draft-in-progress");
    s = reduceKey(s, { name: "up" }, ctx).state;
    expect(s.buffer).toBe("second");
    s = reduceKey(s, { name: "up" }, ctx).state;
    expect(s.buffer).toBe("first");
    s = reduceKey(s, { name: "down" }, ctx).state;
    expect(s.buffer).toBe("second");
    s = reduceKey(s, { name: "down" }, ctx).state; // back past newest → restore draft
    expect(s.buffer).toBe("draft-in-progress");
  });

  it("submits a line and records it in history", () => {
    let s = type(initialInputState(), "run tests");
    const res = reduceKey(s, { name: "return" }, ctx);
    expect(res.action).toEqual({ type: "submit", value: "run tests" });
    expect(res.state.buffer).toBe("");
    expect(res.state.history.at(-1)).toBe("run tests");
  });

  it("Ctrl+C clears a non-empty buffer, then arms and confirms exit on empty", () => {
    let s = type(initialInputState(), "half-typed");
    s = reduceKey(s, { name: "c", ctrl: true }, ctx).state; // clears buffer
    expect(s.buffer).toBe("");
    expect(s.confirmExit).toBe(false);
    const armed = reduceKey(s, { name: "c", ctrl: true }, ctx);
    expect(armed.state.confirmExit).toBe(true);
    const exit = reduceKey(armed.state, { name: "c", ctrl: true }, ctx);
    expect(exit.action).toEqual({ type: "exit" });
  });

  it("any key cancels a pending exit confirmation", () => {
    let s = reduceKey(initialInputState(), { name: "c", ctrl: true }, ctx).state;
    expect(s.confirmExit).toBe(true);
    s = type(s, "x");
    expect(s.confirmExit).toBe(false);
  });

  it("Escape dismisses slash completion without clearing the buffer", () => {
    let s = type(initialInputState(), "/mod");
    const res = reduceKey(s, { name: "escape" }, ctx);
    expect(res.state.completionDismissed).toBe(true);
    expect(res.state.buffer).toBe("/mod");
  });

  it("completes a slash subcommand after the command name", () => {
    const slashCtx: KeyContext = { commands: SLASH_COMMANDS, paletteItems: [] };
    let s = initialInputState();
    for (const char of "/mode b") s = reduceKey(s, { str: char }, slashCtx).state;

    const result = reduceKey(s, { name: "tab" }, slashCtx);

    expect(result.state.buffer).toBe("/mode build ");
  });

  it("treats a single large printable run (chunked paste) as text, never control bytes", () => {
    const big = "x".repeat(5000);
    const s = reduceKey(initialInputState(), { str: big }, ctx).state;
    expect(s.buffer.length).toBe(5000);
    expect(s.cursor).toBe(5000);
  });
});

describe("frame cursor math and narrow-terminal rendering", () => {
  it("reports the caret on the input line at the end of a single-line buffer", () => {
    const input = { ...initialInputState(), buffer: "hello", cursor: 5 };
    const frame = frameFor(input, 80, 24);
    const line = stripAnsi(frame.lines[frame.cursor.row] ?? "");
    // The caret must sit on the line that actually contains the buffer text,
    // not on the border above it.
    expect(line).toContain("hello");
    // margin(2) + left border char(1) + pad(1) + prompt width(2) + text.
    expect(frame.cursor.col).toBe(2 + 1 + 1 + 2 + "hello".length);
  });

  it("places the caret on the correct visual row for a multiline buffer", () => {
    const buffer = "first\nsecond\nthird";
    const input = { ...initialInputState(), buffer, cursor: buffer.length };
    const frame = frameFor(input, 80, 24);
    // The caret row must reference a real line containing the last segment.
    const caretLine = frame.lines[frame.cursor.row] ?? "";
    expect(caretLine).toContain("third");
  });

  it("clips a long streamed transcript to the row budget without overflow", () => {
    const base: TerminalState = reduce(initialState(), { type: "session.started", meta });
    let s = reduce(base, { type: "user.message", text: "explain everything" });
    // A very long streamed assistant answer (many wide lines).
    const long = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(120)}`).join("\n");
    s = reduce(s, { type: "assistant.turn_start", turnId: "t1" });
    s = reduce(s, { type: "assistant.delta", turnId: "t1", text: long });
    for (const [columns, rows] of [[80, 24], [40, 12]] as const) {
      const frame = composeApp(s, initialInputState(), plain, false, { commands: [], paletteItems: [] }, {
        columns, rows, tick: 0, promptLabel: "› ", promptWidth: 2,
      });
      expect(frame.lines.length).toBeLessThanOrEqual(rows);
      for (const line of frame.lines) expect(stripAnsi(line).length).toBeLessThanOrEqual(columns);
    }
  });

  it("never emits a line wider than the terminal, even when narrow", () => {
    const buffer = "a very long single line of input that clearly exceeds a narrow terminal width";
    const input = { ...initialInputState(), buffer, cursor: buffer.length };
    for (const columns of [20, 40, 80]) {
      const frame = frameFor(input, columns, 24);
      for (const line of frame.lines) {
        // clipToWidth strips ANSI then bounds by columns; no line may overflow.
        expect(stripAnsi(line).length).toBeLessThanOrEqual(columns);
      }
      // The frame must fit within the row budget (no redraw overrun).
      expect(frame.lines.length).toBeLessThanOrEqual(24);
    }
  });
});
