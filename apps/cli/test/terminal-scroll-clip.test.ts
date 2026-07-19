import { describe, it, expect } from "vitest";
import { Output, stripAnsi } from "../src/cli/output.js";
import { scrollClip } from "../src/terminal/app-view.js";

/**
 * The scrollable-overlay viewport (the fix for "long output just scrolls the
 * terminal and I can't read it"). `scrollClip` is the pure core: given a body,
 * a viewport height, and a requested offset, it returns the visible window plus
 * the *settled* offset the controller stores back so End/PageDown land exactly
 * at the bottom and the next Up moves immediately.
 */
const out = new Output({ json: false, quiet: false, color: false });
const lines = Array.from({ length: 50 }, (_, i) => `line-${i}`);

function bodyOf(shown: string[]): string[] {
  // Drop the trailing indicator row for content assertions.
  return shown.slice(0, -1).map((l) => stripAnsi(l));
}

describe("scrollClip: scrollable overlay viewport", () => {
  it("returns content whole and pins scroll to 0 when it fits", () => {
    const r = scrollClip(["a", "b", "c"], 10, 5, out, true);
    expect(r.shown).toEqual(["a", "b", "c"]);
    expect(r.scroll).toBe(0);
  });

  it("shows the head at offset 0 and reserves one row for the indicator", () => {
    const r = scrollClip(lines, 10, 0, out, true);
    expect(r.scroll).toBe(0);
    expect(bodyOf(r.shown)).toEqual(lines.slice(0, 9)); // 10 rows − 1 indicator
    expect(stripAnsi(r.shown.at(-1)!)).toContain("0 above");
    expect(stripAnsi(r.shown.at(-1)!)).toContain("41 below");
  });

  it("scrolls to an interior window and reports lines above and below", () => {
    const r = scrollClip(lines, 10, 20, out, true);
    expect(r.scroll).toBe(20);
    expect(bodyOf(r.shown)[0]).toBe("line-20");
    expect(stripAnsi(r.shown.at(-1)!)).toContain("20 above");
  });

  it("clamps an overshoot (End / huge offset) to the true bottom and returns it", () => {
    const r = scrollClip(lines, 10, Number.MAX_SAFE_INTEGER, out, true);
    const bodyRows = 9; // 10 − 1 indicator
    expect(r.scroll).toBe(lines.length - bodyRows); // 41
    expect(bodyOf(r.shown).at(-1)).toBe("line-49"); // last real line visible
    expect(stripAnsi(r.shown.at(-1)!)).toContain("0 below");
  });

  it("clamps a negative offset to the top", () => {
    const r = scrollClip(lines, 10, -100, out, true);
    expect(r.scroll).toBe(0);
    expect(bodyOf(r.shown)[0]).toBe("line-0");
  });

  it("uses ASCII arrows when unicode is off", () => {
    const r = scrollClip(lines, 10, 5, out, false);
    const indicator = stripAnsi(r.shown.at(-1)!);
    expect(indicator).toContain("^");
    expect(indicator).toContain("v");
    expect(indicator).not.toContain("▲");
  });
});
