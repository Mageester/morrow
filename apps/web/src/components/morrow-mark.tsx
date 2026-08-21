/**
 * The Morrow mark.
 *
 * The shape is the brand pack's mark (`img/01_Master`): two angled panels
 * forming an open book. The geometry here is a cleaned redraw of it, not a
 * copy of the traced master, for two reasons the eye can see at 16px:
 *
 *   Symmetry. The traced paths are not a mirror pair — the left panel's outer
 *   edge drifts a pixel over its length and its inner edge leans, while the
 *   right panel's does not. At rail size that reads as a wobble.
 *
 *   Jitter. The trace carries 1–3px artefacts from the source image (a 3px nub
 *   at the top right, a two-segment bevel at the bottom left) that survive
 *   scaling as fuzz rather than as detail.
 *
 * The redraw keeps the master's real proportions — outer edges at x=118/282,
 * the centre gap, the top and bottom cut angles — and makes them exact and
 * mirrored about x=200. The traced masters in `img/` are untouched, so this is
 * reversible by pointing the paths back at them.
 *
 * The viewBox is cropped to the mark's own bounding box rather than the
 * master's 400×400 canvas, where the mark occupied only ~42% of the width and
 * rendered at two-fifths of whatever size it was given.
 *
 * It paints in `currentColor`, which reaches both of the brand guide's
 * approved presentations from one asset: warm white on the dark ground,
 * near-black on the light one. Inlined rather than linked so it renders in the
 * first paint with no network request — the same reason the type stack is
 * system-only.
 */

export interface MorrowMarkProps {
  size?: number;
  className?: string | undefined;
  /** Set when the mark is the only thing naming the product on screen. */
  title?: string | undefined;
}

/** Left panel, then its mirror about x=200. */
export const MORROW_MARK_PATHS = [
  "M118 108 L118 228 L191 267 L191 176 Z",
  "M282 108 L282 228 L209 267 L209 176 Z",
] as const;

export const MORROW_MARK_VIEWBOX = "116 103.5 168 168";

export function MorrowMark({ size = 20, className, title }: MorrowMarkProps) {
  return (
    <svg
      aria-hidden={title ? undefined : "true"}
      className={className}
      fill="currentColor"
      focusable="false"
      height={size}
      role={title ? "img" : undefined}
      viewBox={MORROW_MARK_VIEWBOX}
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      {title ? <title>{title}</title> : null}
      {MORROW_MARK_PATHS.map((path) => <path d={path} key={path} />)}
    </svg>
  );
}
