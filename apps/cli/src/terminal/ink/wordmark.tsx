import { Text } from "ink";
import { theme } from "./theme.js";

/**
 * Morrow's one signature visual moment: a warm gradient wordmark, spent
 * exactly once — the true first impression, before onboarding begins.
 *
 * Nowhere else in the shell repeats this treatment. `theme.ts` already spends
 * copper on exactly two things (the assistant's mark, the active state) and
 * warns that colouring every line makes a terminal unscannable; a gradient
 * wordmark used twice stops being a signature and starts being a mannerism.
 * Every hex here comes from the existing copper family in theme.ts — this is
 * a new arrangement of Morrow's colours, not a new palette.
 */

/** Linear interpolation between two hex colours, `t` in [0, 1]. */
function mixHex(from: string, to: string, t: number): string {
  const a = Number.parseInt(from.slice(1), 16);
  const b = Number.parseInt(to.slice(1), 16);
  const lerp = (shift: number) => {
    const av = (a >> shift) & 0xff;
    const bv = (b >> shift) & 0xff;
    return Math.round(av + (bv - av) * t);
  };
  const r = lerp(16);
  const g = lerp(8);
  const bch = lerp(0);
  return `#${((r << 16) | (g << 8) | bch).toString(16).padStart(6, "0")}`;
}

/** deep copper -> bright bone-warm copper, left to right. */
const GRADIENT_FROM = theme.diffRemoved; // rust — the warm end
const GRADIENT_TO = theme.accent; // copper — the mark's own colour

export function Wordmark({ text = "MORROW" }: { text?: string }) {
  const chars = [...text];
  return (
    <Text bold>
      {chars.map((char, index) => (
        <Text key={index} color={mixHex(GRADIENT_TO, GRADIENT_FROM, chars.length <= 1 ? 0 : index / (chars.length - 1))}>
          {char}
        </Text>
      ))}
    </Text>
  );
}
