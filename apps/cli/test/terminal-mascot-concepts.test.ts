import { describe, it, expect } from "vitest";
import { stripAnsi } from "../src/cli/output.js";
import { mascotWide, mascotNarrow, mascotCompact, mascotWideWidth } from "../src/terminal/mascot.js";

/**
 * Design fixture: three original Morrow mascot concepts, compared side by
 * side, so the choice actually shipped (concept 2, "diamond horizon" — see
 * mascot.ts) is a documented decision rather than the only option ever
 * drawn. Only concept 2 is wired into production (mascot.ts); the other two
 * live here as text-only records of what was considered and rejected, and
 * why.
 */

/** Concept 1 — "sunrise pyramid": a single ◇ rising over an M-shaped
 *  pyramid, with a horizon rule beneath. Rejected: the pyramid outline
 *  competes with the M for attention instead of framing it, and it is wider
 *  for a subtler result than concept 2. */
function concept1SunrisePyramid(unicode: boolean): string[] {
  return unicode
    ? ["       ◇", "      ╱ ╲", "     ╱ M ╲", "    ╱─────╲", "   ───────────"]
    : ["       *", "      / \\", "     / M \\", "    /-----\\", "   -----------"];
}

/** Concept 2 — "diamond horizon" (SHIPPED — see mascot.ts). Reuses the ◇
 *  mark already load-bearing in the header/footer/avatar, stays compact,
 *  and reads cleanly in monochrome. */
function concept2DiamondHorizon(unicode: boolean): string[] {
  return mascotWide(unicode);
}

/** Concept 3 — "block M": a five-row typographic M built from block glyphs
 *  plus a dotted horizon rule. Rejected: the most literally "pixel mascot"
 *  shaped of the three, but at ~19 columns and full block glyphs it reads
 *  as decorative art rather than an identity mark — the product brief
 *  explicitly warns against that trade. */
function concept3BlockM(unicode: boolean): string[] {
  return unicode
    ? [
        " █   █  ▄▄▄  █   █",
        " ██  █ █   █ ██  █",
        " █ █ █ █   █ █ █ █",
        " █  ██ █   █ █  ██",
        " █   █  ▀▀▀  █   █",
        " ◇ ─ ─ ─ ─ ─ ─ ─ ◇",
      ]
    : [
        " #   #  ...  #   #",
        " ##  # #   # ##  #",
        " # # # #   # # # #",
        " #  ## #   # #  ##",
        " #   #  ...  #   #",
        " * - - - - - - - *",
      ];
}

describe("Morrow mascot: three concepts drafted, one shipped", () => {
  const concepts = [
    { name: "sunrise pyramid", lines: concept1SunrisePyramid },
    { name: "diamond horizon (shipped)", lines: concept2DiamondHorizon },
    { name: "block M", lines: concept3BlockM },
  ];

  it("all three concepts render in monochrome (no ANSI codes) in both unicode and ASCII", () => {
    for (const { lines } of concepts) {
      for (const unicode of [true, false]) {
        const rendered = lines(unicode);
        for (const line of rendered) expect(stripAnsi(line)).toBe(line);
      }
    }
  });

  it("all three concepts fit the 5-9 row startup budget", () => {
    for (const { name, lines } of concepts) {
      for (const unicode of [true, false]) {
        const rendered = lines(unicode);
        expect(rendered.length, `${name} (unicode=${unicode})`).toBeGreaterThanOrEqual(5);
        expect(rendered.length, `${name} (unicode=${unicode})`).toBeLessThanOrEqual(9);
      }
    }
  });

  it("all three concepts have an ASCII fallback with no unicode box-drawing/geometry chars", () => {
    // eslint-disable-next-line no-control-regex
    const nonAscii = /[^\x00-\x7f]/;
    for (const { lines } of concepts) {
      for (const line of lines(false)) expect(nonAscii.test(line)).toBe(false);
    }
  });

  it("ships concept 2 (diamond horizon) as the production mascot", () => {
    expect(mascotWide(true)).toEqual(concept2DiamondHorizon(true));
    expect(mascotWide(false)).toEqual(concept2DiamondHorizon(false));
  });
});

describe("production mascot (mascot.ts)", () => {
  it("wide form is 5-9 rows and reuses the ◇ identity mark", () => {
    const lines = mascotWide(true);
    expect(lines.length).toBeGreaterThanOrEqual(5);
    expect(lines.length).toBeLessThanOrEqual(9);
    expect(lines.join("\n")).toContain("◇");
    expect(lines.join("\n")).toContain("M");
  });

  it("wide form has an ASCII fallback with no unicode chars", () => {
    // eslint-disable-next-line no-control-regex
    const nonAscii = /[^\x00-\x7f]/;
    for (const line of mascotWide(false)) expect(nonAscii.test(line)).toBe(false);
  });

  it("narrow form is compact (<= 5 rows, <= 6 cols) for tight terminals", () => {
    const lines = mascotNarrow(true);
    expect(lines.length).toBeLessThanOrEqual(5);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(6);
  });

  it("narrow form degrades to ASCII", () => {
    // eslint-disable-next-line no-control-regex
    const nonAscii = /[^\x00-\x7f]/;
    for (const line of mascotNarrow(false)) expect(nonAscii.test(line)).toBe(false);
  });

  it("compact one-line form matches the identity mark used in header/footer", () => {
    expect(mascotCompact(true)).toBe("◇M");
    expect(mascotCompact(false)).toBe("*M");
  });

  it("reports its own wide-form width so callers can decide whether it fits", () => {
    expect(mascotWideWidth(true)).toBe(Math.max(...mascotWide(true).map((l) => l.length)));
  });
});
