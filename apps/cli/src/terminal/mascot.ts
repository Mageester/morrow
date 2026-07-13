/**
 * The Morrow identity mark: a small, original terminal mascot shown once on
 * the startup panel, plus the compact one-line form reused everywhere else
 * (header, footer, avatar) so the two never drift into separate visual
 * vocabularies. Text-only, monochrome-safe, ASCII-degradable — no external
 * assets or image files.
 *
 * Three concepts were drafted and compared (see
 * `terminal-mascot-concepts.test.ts` for all three side by side); the
 * "diamond horizon" concept below is the one used in production. It was
 * chosen over the other two because it reuses the `◇` mark already load-
 * bearing everywhere else in the console (header, footer, avatar) instead of
 * inventing a second symbol vocabulary, stays inside a restrained 6-row/13-
 * column footprint, and reads cleanly in monochrome. The alternatives are
 * kept only as documented, unused concepts:
 *   - "sunrise pyramid": a single ◇ rising over an M-shaped pyramid and
 *     horizon rule — reads well, but the pyramid outline dilutes the M
 *     rather than framing it, and produces a wider footprint for a subtler
 *     result.
 *   - "block M": a five-row typographic M in full block glyphs. The most
 *     literally "pixel mascot"-shaped, but at ~19 columns it drifts toward
 *     decorative art rather than orientation/identity, which the product
 *     brief explicitly warns against.
 */

/** The wide/startup mascot: 6 rows, readable at the startup panel's minimum
 *  inner width. Diamonds either side of the M plus a horizon rule beneath
 *  carry the three named identity elements — M, diamond, horizon. */
export function mascotWide(unicode: boolean): string[] {
  return unicode
    ? ["      ╱◇╲", "     ╱   ╲", "    ◇  M  ◇", "     ╲   ╱", "      ╲◇╱", "    ─────"]
    : ["      /*\\", "     /   \\", "    *  M  *", "     \\   /", "      \\*/", "    -----"];
}

/** The narrow mascot: 3 rows, for terminals too tight for the wide form
 *  (mirrors the same diamond + M + horizon geometry, just condensed). */
export function mascotNarrow(unicode: boolean): string[] {
  return unicode ? ["  ◇", " ╱M╲", "  ◇"] : ["  *", " /M\\", "  *"];
}

/** The compact one-line form used in running states — identical to the
 *  identity mark already used in the header and footer, so the mascot and
 *  the live chrome never present as two different symbols. */
export function mascotCompact(unicode: boolean): string {
  return unicode ? "◇M" : "*M";
}

/** Widest line in the wide mascot, for callers deciding whether it fits. */
export function mascotWideWidth(unicode: boolean): number {
  return Math.max(...mascotWide(unicode).map((l) => l.length));
}
