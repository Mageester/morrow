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

/**
 * Repeated *failures* of the same call with the same deterministic error.
 *
 * The exact-repeat advisory above is telemetry: it tells an operator that a
 * signature recurred, but the model never hears about it. That is how a run can
 * issue the same oversized read a dozen times — each attempt is answered with
 * the identical error, and nothing in the conversation marks it as *identical*.
 *
 * This tracker keys on (call signature, error identity) so only a genuinely
 * deterministic repeat counts: the same arguments producing the same failure.
 * A different path, a different error, or a transient network message resets
 * nothing and accumulates separately.
 */
export interface RepeatedFailureTracker {
  /** Returns how many times this exact call has now failed this exact way. */
  record(signature: string, errorIdentity: string): number;
}

/**
 * Error text often carries volatile detail (byte counts, durations, ids). Two
 * failures are "substantially the same" when their text matches after those are
 * normalized away, so a size-limit message that quotes a different figure each
 * time is still recognised as the same wall.
 */
export function errorIdentity(errorType: string | null | undefined, message: string): string {
  // Exit codes are extracted before masking, because they are the one number
  // in an error that changes its meaning rather than its magnitude. Masking
  // every digit made "exited with status 1" and "exited with status 2" the
  // same identity, so the advisory could tell a model that two materially
  // different failures were identical.
  const exitCodes = [...message.matchAll(/\b(?:exit(?:ed)?(?:\s+(?:code|status|with\s+status))?|status)\s+(\d{1,3})\b/gi)]
    .map((match) => match[1])
    .join(",");
  const normalized = message
    .toLowerCase()
    // Everything else numeric is a magnitude — byte counts, durations,
    // offsets, ids. The same wall quotes a different figure each time, and
    // that must not read as a different wall.
    .replace(/\d+(?:\.\d+)?/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return `${errorType ?? "unknown"}|${exitCodes}|${normalized}`;
}

export function createRepeatedFailureTracker(): RepeatedFailureTracker {
  const counts = new Map<string, number>();
  return {
    record(signature: string, identity: string): number {
      const key = `${signature}::${identity}`;
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return count;
    },
  };
}

/**
 * The note appended to a repeated failure's tool result. It fires on the second
 * identical failure — the first repeat is already one too many — and says the
 * only thing the model needs: this wall does not move, change approach.
 */
export function repeatedFailureAdvice(count: number, toolName: string): string | null {
  if (count < 2) return null;
  return `This is failure ${count} of the identical ${toolName} call with the same error. Retrying it unchanged will produce this same error again. Do not repeat it — narrow the request, target a specific file or line range, use a different tool, or continue with what you already have.`;
}
