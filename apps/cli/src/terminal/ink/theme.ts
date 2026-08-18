/**
 * Morrow's terminal palette.
 *
 * The same identity as the web app — near-black ground, warm off-white text,
 * one copper accent — expressed in the colours a terminal actually has. Copper
 * is spent on exactly two things: the assistant's mark and the active state.
 * Everything else is a shade of the foreground, because a terminal that colours
 * every category is a terminal nobody can scan.
 *
 * Two layers, deliberately. `vars` are the raw values; `theme` maps them to
 * roles. Nothing outside this file names a hex code, so a second theme is a new
 * mapping rather than an edit to every component — and a role like `codeBlock`
 * can be retuned once instead of in the six places that draw code.
 *
 * The role set was widened after comparing the shell against its peers: what
 * read as "bland" was largely structural, not chromatic. There were no fills,
 * no borders, and no markdown roles at all, so every line arrived at the same
 * visual weight and long answers had no shape.
 */

/** Raw values. Referenced only through `theme` below. */
const vars = {
  copper: "#d48562",
  copperDim: "#8a5540",
  bone: "#f2eee6",
  ash: "#a39f96",
  smoke: "#74776e",
  slate: "#4a4c47",
  ink: "#1a1b18",
  sage: "#82aa88",
  amber: "#c8a06a",
  rust: "#dc7972",
} as const;

export const theme = {
  /** The assistant's mark and anything genuinely active. */
  accent: vars.copper,
  /** Body text. */
  copy: vars.bone,
  /** Secondary text: metadata, durations, counts. */
  soft: vars.ash,
  /** Tertiary: hints, separators, things present but not being read. */
  faint: vars.smoke,
  success: vars.sage,
  warning: vars.amber,
  danger: vars.rust,

  /** Fills. A terminal with no backgrounds gives every line equal weight; one
   *  that fills everything is a mess. These are spent on exactly three things:
   *  what you said, what is selected, and a tool that failed. */
  userBg: vars.ink,
  selectedBg: vars.slate,
  errorBg: "#2e1f1d",

  /** Rules and frames. */
  border: vars.slate,
  borderAccent: vars.copperDim,

  /** Markdown. Headings carry weight through the accent rather than a second
   *  hue; code is the one place a distinct colour earns its keep, because
   *  mistaking prose for code is a real error. */
  mdHeading: vars.copper,
  mdCode: vars.sage,
  mdCodeBlock: vars.bone,
  mdCodeFence: vars.slate,
  mdQuote: vars.ash,
  mdBullet: vars.copper,
  mdLink: vars.copper,
  mdRule: vars.slate,

  /** Diffs, shown wherever a patch is summarised. */
  diffAdded: vars.sage,
  diffRemoved: vars.rust,
  diffContext: vars.smoke,
} as const;

/** Status glyphs, with ASCII fallbacks for terminals without wide coverage. */
export function glyphs(unicode: boolean) {
  return unicode
    ? { done: "✓", fail: "✕", run: "◇", pending: "·", mark: "✦", chevron: "›", bullet: "•", rule: "─", quote: "│" }
    : { done: "+", fail: "x", run: "*", pending: ".", mark: "*", chevron: ">", bullet: "*", rule: "-", quote: "|" };
}
