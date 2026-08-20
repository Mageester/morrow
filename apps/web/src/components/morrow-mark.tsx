/**
 * The Morrow mark.
 *
 * Geometry is the brand pack's SVG master verbatim (`img/01_Master`), inlined
 * rather than linked so it renders in the first paint with no network request
 * — the same reason the type stack is system-only.
 *
 * It paints in `currentColor`, which is how the brand guide's two approved
 * presentations are reached without shipping two files: warm white on the dark
 * ground, near-black on the light one. The guide's other rules — no stretching,
 * skewing, rotating, shadows, outlines or gradients on the mark — are why this
 * component takes a size and nothing else.
 */

export interface MorrowMarkProps {
  size?: number;
  className?: string | undefined;
  /** Set when the mark is the only thing naming the product on screen. */
  title?: string | undefined;
}

export function MorrowMark({ size = 20, className, title }: MorrowMarkProps) {
  return (
    <svg
      aria-hidden={title ? undefined : "true"}
      className={className}
      fill="currentColor"
      focusable="false"
      height={size}
      role={title ? "img" : undefined}
      viewBox="0 0 400 400"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      {title ? <title>{title}</title> : null}
      <path d="M 282 108 L 279 108 L 210 175 L 211 267 L 218 265 L 275 228 L 281 220 Z" />
      <path d="M 118 108 L 117 216 L 121 224 L 126 229 L 186 267 L 190 267 L 191 176 L 121 108 Z" />
    </svg>
  );
}
