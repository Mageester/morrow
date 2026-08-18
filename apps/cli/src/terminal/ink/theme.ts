/**
 * Morrow's terminal palette.
 *
 * The same identity as the web app — near-black ground, warm off-white text,
 * one copper accent — expressed in the colours a terminal actually has. Copper
 * is spent on exactly two things: the assistant's mark and the active state.
 * Everything else is a shade of the foreground, because a terminal that colours
 * every category is a terminal nobody can scan.
 */
export const theme = {
  /** The assistant's mark and anything genuinely active. */
  accent: "#d48562",
  /** Body text. */
  copy: "#f2eee6",
  /** Secondary text: metadata, durations, counts. */
  soft: "#a39f96",
  /** Tertiary: hints, separators, things present but not being read. */
  faint: "#74776e",
  success: "#82aa88",
  warning: "#c8a06a",
  danger: "#dc7972",
} as const;

/** Status glyphs, with ASCII fallbacks for terminals without wide coverage. */
export function glyphs(unicode: boolean) {
  return unicode
    ? { done: "✓", fail: "✕", run: "◇", pending: "·", mark: "✦", chevron: "›" }
    : { done: "+", fail: "x", run: "*", pending: ".", mark: "*", chevron: ">" };
}
