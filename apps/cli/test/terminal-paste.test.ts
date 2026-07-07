import { describe, it, expect } from "vitest";
import { PasteDecoder, normalizePaste, PASTE_START, PASTE_END } from "../src/terminal/paste.js";
import { initialInputState, insertPaste } from "../src/terminal/input-state.js";

describe("bracketed paste decoder", () => {
  it("passes normal keystrokes straight through", () => {
    const d = new PasteDecoder();
    expect(d.feed("a", { name: "a", sequence: "a" })).toEqual({ kind: "key", str: "a" });
    expect(d.feed(undefined, { name: "return", sequence: "\r" })).toEqual({ kind: "key", str: undefined });
    expect(d.active).toBe(false);
  });

  it("buffers a multi-line paste and flushes it once, newlines intact", () => {
    const d = new PasteDecoder();
    expect(d.feed(undefined, { sequence: PASTE_START, code: "[200~" }).kind).toBe("buffering");
    expect(d.active).toBe(true);
    d.feed("l", { name: "l", sequence: "l" });
    d.feed("i", { name: "i", sequence: "i" });
    d.feed(undefined, { name: "return", sequence: "\r" }); // embedded newline — must NOT submit
    d.feed("2", { name: "2", sequence: "2" });
    const end = d.feed(undefined, { sequence: PASTE_END, code: "[201~" });
    expect(end).toEqual({ kind: "paste", text: "li\r2" });
    expect(d.active).toBe(false);
  });

  it("detects markers even when only the code/needle is present", () => {
    const d = new PasteDecoder();
    expect(d.feed(undefined, { code: "[200~" }).kind).toBe("buffering");
    d.feed("x", { sequence: "x" });
    expect(d.feed(undefined, { code: "[201~" })).toEqual({ kind: "paste", text: "x" });
  });

  it("normalizes CRLF and strips control chars but keeps newlines and tabs", () => {
    expect(normalizePaste("a\r\nb\rc\n")).toBe("a\nb\nc\n");
    expect(normalizePaste("a\tb")).toBe("a\tb");
    expect(normalizePaste("a\x00\x07b")).toBe("ab");
  });

  it("inserts a multi-line paste at the cursor as one atomic edit (no submit)", () => {
    let s = initialInputState();
    s = { ...s, buffer: "XY", cursor: 1 };
    s = insertPaste(s, normalizePaste("a\r\nb"));
    expect(s.buffer).toBe("Xa\nbY");
    expect(s.cursor).toBe(4);
  });
});
