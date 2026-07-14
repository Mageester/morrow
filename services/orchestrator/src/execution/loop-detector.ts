/**
 * Loop detection for the agent runtime.
 *
 * A stalled model often repeats the *same action* — the same tool with the same
 * arguments — making no observable progress. The adaptive budget eventually
 * stops this, but only after several whole turns. Loop detection is an earlier,
 * tighter signal: it watches a sliding window of recent tool-call signatures and
 * flags when one signature recurs past a threshold.
 *
 * Signatures are computed from a *stable* serialization of the arguments, so two
 * calls that are semantically identical but differ only in JSON key order are
 * treated as the same action. The detector is pure and deterministic — no clocks,
 * no randomness — which makes the agent's stop behavior fully testable.
 */

/** Stable JSON: object keys sorted recursively so key order never matters. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

/**
 * A canonical signature for a tool call. `args` may be an already-parsed object
 * or the raw JSON string the provider returned; raw strings are parsed when
 * possible so argument key order does not change the signature.
 */
export function toolCallSignature(toolName: string, args: unknown): string {
  let normalized = args;
  if (typeof args === "string") {
    try {
      normalized = JSON.parse(args);
    } catch {
      /* not JSON — keep the raw string */
    }
  }
  return `${toolName}:${stableStringify(normalized)}`;
}

export interface LoopDetectorOptions {
  /** How many recent signatures to keep in view. Default 6. */
  windowSize?: number;
  /** Occurrences of one signature within the window that count as a loop. Default 3. */
  repeatThreshold?: number;
}

export interface LoopRecord {
  looping: boolean;
  /** Occurrences of this signature currently in the window. */
  count: number;
  signature: string;
}

export interface LoopDetector {
  record(signature: string): LoopRecord;
  reset(): void;
  readonly size: number;
}

/**
 * True when `candidate` is, after whitespace normalization, exactly the same
 * text as one of the task's earlier turns. A stalled model that re-emits the
 * same scene-setting narration turn after turn must never have that repeated
 * text mistaken for a genuine, novel conclusion — this is a deterministic,
 * content-based check independent of the loop/stall detectors above, which
 * only look at tool-call signatures.
 */
export function duplicatesPriorNarration(candidate: string, priorTexts: string[]): boolean {
  const normalize = (text: string) => text.trim().replace(/\s+/g, " ");
  const normalizedCandidate = normalize(candidate);
  if (!normalizedCandidate) return false;
  return priorTexts.some((text) => normalize(text) === normalizedCandidate);
}

export function createLoopDetector(options: LoopDetectorOptions = {}): LoopDetector {
  const windowSize = Math.max(2, options.windowSize ?? 6);
  const repeatThreshold = Math.max(2, options.repeatThreshold ?? 3);
  let window: string[] = [];
  return {
    record(signature: string): LoopRecord {
      window.push(signature);
      if (window.length > windowSize) window = window.slice(window.length - windowSize);
      const count = window.reduce((n, s) => (s === signature ? n + 1 : n), 0);
      return { looping: count >= repeatThreshold, count, signature };
    },
    reset() {
      window = [];
    },
    get size() {
      return window.length;
    },
  };
}
