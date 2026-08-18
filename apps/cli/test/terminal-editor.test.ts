import { describe, expect, it } from "vitest";
import {
  applyKey,
  clearText,
  expandPastes,
  initialEditorState,
  insertPaste,
  layout,
  PASTE_LINE_THRESHOLD,
  remember,
  wordLeft,
  wordRight,
  activePastes,
  type EditorState,
  type KeyPress,
} from "../src/terminal/ink/editor.js";

/**
 * The composer's behaviour, asserted without a terminal.
 *
 * Every failure listed here was a real defect in the shell this replaced: left
 * arrow did nothing, Home did nothing, history did nothing, a multiline paste
 * destroyed the line, and Backspace always removed the last character no matter
 * where the caret was.
 */

const CTX = { width: 40 };

/** Type a literal string, one keypress at a time. */
function type(state: EditorState, text: string): EditorState {
  let current = state;
  for (const char of text) current = applyKey(current, { input: char }, CTX).state;
  return current;
}

function press(state: EditorState, key: Partial<KeyPress> & { name?: string }): EditorState {
  return applyKey(state, { input: "", ...key }, CTX).state;
}

describe("composer: typing and the caret", () => {
  it("inserts at the caret rather than always appending", () => {
    let state = type(initialEditorState(), "hello world");
    state = press(state, { name: "left" });
    state = press(state, { name: "left" });
    state = press(state, { name: "left" });
    state = type(state, "XYZ");
    expect(state.text).toBe("hello woXYZrld");
  });

  it("moves left and right one character at a time", () => {
    let state = type(initialEditorState(), "abc");
    expect(state.cursor).toBe(3);
    state = press(state, { name: "left" });
    expect(state.cursor).toBe(2);
    state = press(state, { name: "right" });
    expect(state.cursor).toBe(3);
    // Off the ends is a no-op, never a negative index.
    state = press(state, { name: "right" });
    expect(state.cursor).toBe(3);
  });

  it("crosses a whole emoji in one press", () => {
    // A family emoji is several code points joined by zero-width joiners. One
    // arrow press has to skip the cluster, not land inside it.
    const family = "👨‍👩‍👧";
    let state = type(initialEditorState(), `a${family}b`);
    state = press(state, { name: "left" });
    state = press(state, { name: "left" });
    expect(state.cursor).toBe(1);
    expect(state.text.slice(0, state.cursor)).toBe("a");
  });

  it("deletes backwards from the caret, not from the end", () => {
    let state = type(initialEditorState(), "abcdef");
    state = press(state, { name: "left" });
    state = press(state, { name: "left" });
    state = press(state, { name: "backspace" });
    expect(state.text).toBe("abcef");
  });

  it("deletes forwards with Delete", () => {
    let state = type(initialEditorState(), "abcdef");
    state = press(state, { name: "home" });
    state = press(state, { name: "delete" });
    expect(state.text).toBe("bcdef");
  });
});

describe("composer: line and word motion", () => {
  it("honours Home/End and Ctrl+A/Ctrl+E", () => {
    let state = type(initialEditorState(), "one two");
    state = press(state, { name: "home" });
    expect(state.cursor).toBe(0);
    state = press(state, { name: "end" });
    expect(state.cursor).toBe(7);
    state = press(state, { input: "a", ctrl: true });
    expect(state.cursor).toBe(0);
    state = press(state, { input: "e", ctrl: true });
    expect(state.cursor).toBe(7);
  });

  it("walks by word, stopping at separators", () => {
    expect(wordLeft("src/terminal/app.tsx", 20)).toBe(17);
    expect(wordLeft("src/terminal/app.tsx", 17)).toBe(13);
    expect(wordRight("src/terminal/app.tsx", 0)).toBe(3);
  });

  it("moves by word with Ctrl+arrow and Alt+B/F", () => {
    let state = type(initialEditorState(), "alpha beta gamma");
    state = press(state, { name: "left", ctrl: true });
    expect(state.text.slice(state.cursor)).toBe("gamma");
    state = press(state, { input: "b", meta: true });
    expect(state.text.slice(state.cursor)).toBe("beta gamma");
    state = press(state, { input: "f", meta: true });
    expect(state.text.slice(state.cursor)).toBe(" gamma");
  });
});

describe("composer: kill and yank", () => {
  it("Ctrl+W removes the word before the caret and Ctrl+Y puts it back", () => {
    let state = type(initialEditorState(), "keep this");
    state = press(state, { input: "w", ctrl: true });
    expect(state.text).toBe("keep ");
    state = press(state, { input: "y", ctrl: true });
    expect(state.text).toBe("keep this");
  });

  it("accumulates consecutive kills into one yank", () => {
    let state = type(initialEditorState(), "one two three");
    state = press(state, { input: "w", ctrl: true });
    state = press(state, { input: "w", ctrl: true });
    expect(state.text).toBe("one ");
    state = press(state, { input: "y", ctrl: true });
    expect(state.text).toBe("one two three");
  });

  it("Ctrl+U kills to line start and Ctrl+K to line end", () => {
    let state = type(initialEditorState(), "abcdef");
    state = press(state, { name: "left" });
    state = press(state, { name: "left" });
    state = press(state, { input: "u", ctrl: true });
    expect(state.text).toBe("ef");
    state = press(state, { name: "home" });
    state = press(state, { input: "k", ctrl: true });
    expect(state.text).toBe("");
  });
});

describe("composer: multiline", () => {
  it("Alt+Enter opens a line instead of submitting", () => {
    let state = type(initialEditorState(), "first");
    const step = applyKey(state, { input: "", name: "return", meta: true }, CTX);
    expect(step.action.type).toBe("none");
    state = type(step.state, "second");
    expect(state.text).toBe("first\nsecond");
  });

  it("a trailing backslash continues the line", () => {
    let state = type(initialEditorState(), "first\\");
    const step = applyKey(state, { input: "", name: "return" }, CTX);
    expect(step.action.type).toBe("none");
    expect(step.state.text).toBe("first\n");
  });

  it("Enter submits, and never submits whitespace", () => {
    const empty = applyKey(type(initialEditorState(), "   "), { input: "", name: "return" }, CTX);
    expect(empty.action.type).toBe("none");
    const real = applyKey(type(initialEditorState(), "go"), { input: "", name: "return" }, CTX);
    expect(real.action).toEqual({ type: "submit", text: "go" });
  });

  it("up and down move between visual rows before touching history", () => {
    let state = initialEditorState(["earlier"]);
    state = type(state, "aaa");
    state = applyKey(state, { input: "", name: "return", meta: true }, CTX).state;
    state = type(state, "bbb");
    // Caret is on row 2; Up moves to row 1, not into history.
    state = press(state, { name: "up" });
    expect(state.text).toBe("aaa\nbbb");
    expect(state.cursor).toBe(3);
    // Now on the first row, Up recalls.
    state = press(state, { name: "up" });
    expect(state.text).toBe("earlier");
  });

  it("keeps the goal column across a short line", () => {
    let state = initialEditorState();
    state = type(state, "longer line");
    state = applyKey(state, { input: "", name: "return", meta: true }, CTX).state;
    state = type(state, "ab");
    state = applyKey(state, { input: "", name: "return", meta: true }, CTX).state;
    state = type(state, "another long line");
    // "longer line\nab\nanother long line" — the caret starts at column 17 of
    // the last row. Up lands on "ab", which is only two columns wide.
    expect(state.cursor).toBe(32);
    state = press(state, { name: "up" });
    expect(state.cursor).toBe(14); // clamped to the end of "ab"
    // Coming back down restores column 17 rather than staying at column 2 —
    // without a remembered goal column, one pass through a short line
    // permanently loses your place.
    state = press(state, { name: "down" });
    expect(state.cursor).toBe(32);
  });
});

describe("composer: history", () => {
  it("recalls previous entries newest-first and returns to the draft", () => {
    let state = initialEditorState(["first", "second"]);
    state = type(state, "draft");
    state = press(state, { name: "up" });
    expect(state.text).toBe("second");
    state = press(state, { name: "up" });
    expect(state.text).toBe("first");
    state = press(state, { name: "up" });
    expect(state.text).toBe("first"); // no further back
    state = press(state, { name: "down" });
    expect(state.text).toBe("second");
    state = press(state, { name: "down" });
    expect(state.text).toBe("draft");
  });

  it("records submissions without adjacent duplicates", () => {
    let state = remember(initialEditorState(), "run tests");
    state = remember(state, "run tests");
    state = remember(state, "  ");
    expect(state.history).toEqual(["run tests"]);
  });
});

describe("composer: paste", () => {
  it("inserts a short paste as ordinary text", () => {
    const state = insertPaste(initialEditorState(), "one\ntwo");
    expect(state.text).toBe("one\ntwo");
    expect(state.pastes).toHaveLength(0);
  });

  it("holds a tall paste behind a placeholder and sends it in full", () => {
    const payload = Array.from({ length: PASTE_LINE_THRESHOLD + 20 }, (_, i) => `line ${i}`).join("\n");
    let state = type(initialEditorState(), "review this: ");
    state = insertPaste(state, payload);
    expect(state.text).toContain("[#1 pasted");
    expect(state.text.split("\n")).toHaveLength(1);
    expect(expandPastes(state)).toBe(`review this: ${payload}`);
  });

  it("normalises CRLF so a Windows paste does not double-space", () => {
    const state = insertPaste(initialEditorState(), "a\r\nb\r\nc");
    expect(state.text).toBe("a\nb\nc");
  });

  it("submits the expanded payload, not the placeholder", () => {
    const payload = Array.from({ length: PASTE_LINE_THRESHOLD + 2 }, () => "x").join("\n");
    const state = insertPaste(initialEditorState(), payload);
    const step = applyKey(state, { input: "", name: "return" }, CTX);
    expect(step.action).toEqual({ type: "submit", text: payload });
  });
});

describe("composer: layout", () => {
  it("wraps at the given width and reports the caret's row and column", () => {
    const view = layout("abcdefghij", 10, 4);
    expect(view.rows).toEqual(["abcd", "efgh", "ij"]);
    expect(view.row).toBe(2);
    expect(view.column).toBe(2);
  });

  it("never collapses to zero-width rows", () => {
    const view = layout("abc", 0, 0);
    expect(view.rows.every((row) => row.length <= 1)).toBe(true);
    expect(view.rows.join("")).toBe("abc");
  });

  it("puts the caret on the last row when it sits at the very end", () => {
    const view = layout("abcd", 4, 4);
    expect(view.row).toBe(0);
    expect(view.column).toBe(4);
  });
});

describe("composer: unbound keys", () => {
  it("does not type a stray character for an unbound control chord", () => {
    const state = type(initialEditorState(), "hi");
    const step = applyKey(state, { input: "p", ctrl: true }, CTX);
    expect(step.handled).toBe(false);
    expect(step.state.text).toBe("hi");
  });

  it("clearText keeps history and the kill ring", () => {
    let state = remember(type(initialEditorState(), "text"), "earlier");
    state = press(state, { input: "u", ctrl: true });
    state = clearText(state);
    expect(state.text).toBe("");
    expect(state.history).toEqual(["earlier"]);
    expect(state.kill.length).toBeGreaterThan(0);
  });
});

describe("composer: paste lifecycle", () => {
  it("forgets a paste once its placeholder is deleted", () => {
    const payload = Array.from({ length: PASTE_LINE_THRESHOLD + 5 }, () => "y").join("\n");
    let state = insertPaste(initialEditorState(), payload);
    expect(activePastes(state)).toHaveLength(1);
    // Ctrl+U back to the start of the line removes the placeholder.
    state = applyKey(state, { input: "u", ctrl: true }, CTX).state;
    expect(activePastes(state)).toHaveLength(0);
    // And the payload must not ride along on whatever is sent next.
    expect(expandPastes(state)).toBe("");
  });
});

describe("composer: batched input", () => {
  it("sends when the text and its Enter arrive in one chunk", () => {
    // A terminal batches keystrokes under fast typing, and Ink passes the whole
    // run through as one string. Treating that as literal text meant a quick
    // typist's message was never sent — it just sat in the composer.
    const step = applyKey(initialEditorState(), { input: "hello there\r" }, CTX);
    expect(step.action).toEqual({ type: "submit", text: "hello there" });
  });

  it("appends a batched chunk to what is already typed", () => {
    const state = type(initialEditorState(), "start ");
    const step = applyKey(state, { input: "and finish\r" }, CTX);
    expect(step.action).toEqual({ type: "submit", text: "start and finish" });
  });

  it("keeps interior newlines as newlines and only sends on a trailing one", () => {
    const held = applyKey(initialEditorState(), { input: "one\ntwo" }, CTX);
    expect(held.action.type).toBe("none");
    expect(held.state.text).toBe("one\ntwo");
    const sent = applyKey(initialEditorState(), { input: "one\ntwo\n" }, CTX);
    expect(sent.action).toEqual({ type: "submit", text: "one\ntwo" });
  });

  it("does not send an all-whitespace batch", () => {
    const step = applyKey(initialEditorState(), { input: "   \r" }, CTX);
    expect(step.action.type).toBe("none");
  });
});
