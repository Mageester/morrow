/**
 * Bracketed-paste decoder.
 *
 * The session enables bracketed paste (`ESC[?2004h`) so the terminal wraps
 * pasted content between `ESC[200~` and `ESC[201~`. Without decoding those
 * markers, a multi-line paste arrives as a stream of keypresses whose embedded
 * newlines look exactly like Enter — silently submitting each line. This decoder
 * sits in front of the key handler: normal keystrokes pass through untouched, so
 * typed input is byte-for-byte unchanged; only the span between the paste markers
 * is buffered and emitted once as a single `paste` event with newlines intact.
 *
 * Pure and synchronous — no timers, no I/O — so it is fully unit-testable.
 */

export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

export interface DecoderKey {
  name?: string | undefined;
  sequence?: string | undefined;
  code?: string | undefined;
}

export type PasteResult =
  | { kind: "key"; str: string | undefined } // pass this keypress through unchanged
  | { kind: "buffering" } // consumed as part of an in-flight paste
  | { kind: "paste"; text: string }; // a completed paste, newlines preserved

/** Hard cap so a missed end-marker can never buffer unbounded input. */
const MAX_PASTE = 200_000;

function marker(str: string | undefined, key: DecoderKey, needle: string, seq: string): boolean {
  if (key.sequence === seq || str === seq) return true;
  const hay = key.sequence ?? key.code ?? str ?? "";
  return hay.includes(needle);
}

export class PasteDecoder {
  private pasting = false;
  private buf = "";

  /** True while a paste is in progress (for callers that want to suppress paint). */
  get active(): boolean {
    return this.pasting;
  }

  /**
   * Feed one keypress. Returns whether to pass it through, swallow it (mid-paste),
   * or flush a completed paste. `str` is the printable string readline reported;
   * `key` carries the sequence/code used to spot the paste markers.
   */
  feed(str: string | undefined, key: DecoderKey): PasteResult {
    const isStart = marker(str, key, "200~", PASTE_START);
    const isEnd = marker(str, key, "201~", PASTE_END);

    if (!this.pasting) {
      if (isStart) {
        this.pasting = true;
        this.buf = "";
        return { kind: "buffering" };
      }
      return { kind: "key", str };
    }

    // Mid-paste: the end marker flushes; everything else accumulates literally.
    if (isEnd) {
      const text = this.buf;
      this.pasting = false;
      this.buf = "";
      return { kind: "paste", text };
    }
    if (isStart) return { kind: "buffering" }; // ignore a nested start
    // Reconstruct the raw bytes: sequence preserves \r/\n/\t; fall back to str.
    const chunk = key.sequence ?? str ?? "";
    this.buf += chunk;
    if (this.buf.length > MAX_PASTE) {
      // Safety valve: flush what we have rather than buffer forever.
      const text = this.buf;
      this.pasting = false;
      this.buf = "";
      return { kind: "paste", text };
    }
    return { kind: "buffering" };
  }
}

/**
 * Normalize pasted text for insertion into the single editor buffer: collapse
 * CRLF/CR to LF and drop other control characters, but keep newlines and tabs so
 * multi-line pastes survive intact.
 */
export function normalizePaste(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}
