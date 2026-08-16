/** Canonical exact-call identity and task-local repeat counts.
 *
 * Repetition is advisory context only. The executor still runs every validated
 * call and applies its ordinary permission, containment, cancellation, replay,
 * provider, and budget boundaries.
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

export interface LoopRecord {
  /** Kept as a compatibility-shaped field; repetition never controls execution. */
  looping: false;
  /** Successful occurrences of this signature in this task-local detector. */
  count: number;
  signature: string;
}

export interface LoopDetector {
  record(signature: string): LoopRecord;
  reset(): void;
  readonly size: number;
}

/** Reminder points are intentionally small and deterministic. */
export function isRepeatAdvisoryPoint(count: number): boolean {
  return count === 3 || count === 4 || (count > 4 && count % 4 === 0);
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

export function createLoopDetector(): LoopDetector {
  const counts = new Map<string, number>();
  return {
    record(signature: string): LoopRecord {
      const count = (counts.get(signature) ?? 0) + 1;
      counts.set(signature, count);
      return { looping: false, count, signature };
    },
    reset() {
      counts.clear();
    },
    get size() {
      return counts.size;
    },
  };
}
