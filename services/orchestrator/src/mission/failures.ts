import type { MissionFailureCategory } from "@morrow/contracts";

/**
 * Failure intelligence: classify errors, produce stable signatures for loop
 * detection, and choose an escalating recovery strategy so the same failed
 * operation is never repeated forever. Pure and fully unit-testable.
 */

/** Classify a raw error message/operation into a mission failure category. */
export function categorizeFailure(operation: string, message: string): MissionFailureCategory {
  const m = `${operation}\n${message}`.toLowerCase();
  if (/hunk|patch context|context mismatch|expected .* at line|patch conflict|line count mismatch/.test(m)) return "patch_context_mismatch";
  if (/loop detected|no measurable progress|repeated identical/.test(m)) return "loop_detected";
  if (/\btest(s)? (failed|failing)|assertion|expect\(|✗|✖/.test(m)) return "test_failure";
  if (/build failed|compilation|tsc error|cannot find module|type error|ts\d{3,}/.test(m)) return "build_failure";
  if (/rate limit|quota|provider error|model provider|upstream|502|503|429/.test(m)) return "provider_failure";
  if (/permission denied|not permitted|approval denied|forbidden|eacces/.test(m)) return "permission_denied";
  if (/timeout|timed out|deadline exceeded|etimedout/.test(m)) return "timeout";
  if (/invalid (json|output|response)|could not parse|malformed/.test(m)) return "invalid_output";
  if (/tool .* (failed|error)|enoent|no such file/.test(m)) return "tool_error";
  return "unknown";
}

/**
 * Normalize an operation into a stable signature so semantically-identical
 * retries collapse to one bucket. Strips volatile detail (line numbers, hashes,
 * quoted paths, byte counts) that would otherwise defeat repeat detection.
 */
export function normalizeSignature(category: MissionFailureCategory, operation: string): string {
  const normalized = operation
    .toLowerCase()
    .replace(/["'`].*?["'`]/g, "<str>")       // quoted literals
    .replace(/\b[0-9a-f]{7,40}\b/g, "<hash>")  // hashes / shas
    .replace(/@@[^@]*@@/g, "<hunk>")           // diff hunk headers
    .replace(/\d+/g, "<n>")                    // line/byte numbers
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return `${category}:${normalized}`;
}

export interface RecoveryPlan {
  /** Short label surfaced in the activity stream. */
  strategy: string;
  /** Whether safe automated recovery options are exhausted (→ escalate/blocked). */
  exhausted: boolean;
  /** Human-readable steps for the activity stream. */
  steps: string[];
}

/**
 * Choose a recovery strategy given how many times this exact signature has
 * already failed (1-based attempt count including the current failure).
 * Escalation is category-aware; patch-context failures follow the documented
 * ladder: reread → reduce scope → targeted rewrite → give up.
 */
export function planRecovery(category: MissionFailureCategory, attempt: number, maxAttempts = 4): RecoveryPlan {
  if (attempt >= maxAttempts) {
    return { strategy: "escalate", exhausted: true, steps: ["Safe automated recovery options exhausted", "Escalate mission to blocked for human input"] };
  }
  switch (category) {
    case "patch_context_mismatch":
      if (attempt === 1) return { strategy: "reread-target", exhausted: false, steps: ["Reread the target file region to refresh exact context"] };
      if (attempt === 2) return { strategy: "reduce-patch-scope", exhausted: false, steps: ["Reduce the patch to a single minimal hunk"] };
      return { strategy: "targeted-rewrite", exhausted: false, steps: ["Switch to a targeted full-region rewrite instead of a contextual patch"] };
    case "test_failure":
      if (attempt === 1) return { strategy: "inspect-failure", exhausted: false, steps: ["Read the failing test and the code under test"] };
      return { strategy: "narrow-fix", exhausted: false, steps: ["Apply a narrower fix addressing the specific assertion"] };
    case "build_failure":
      return { strategy: "resolve-build-error", exhausted: false, steps: ["Read the compiler error location", "Fix the specific type/import error"] };
    case "provider_failure":
      return { strategy: "provider-fallback", exhausted: false, steps: ["Fall back to an alternate provider/model and retry"] };
    case "timeout":
      return { strategy: "reduce-scope-retry", exhausted: false, steps: ["Reduce operation scope and retry once"] };
    case "permission_denied":
      // Permission failures are not safely auto-recoverable — surface immediately.
      return { strategy: "request-approval", exhausted: true, steps: ["Operation requires explicit approval; cannot auto-recover"] };
    case "invalid_output":
      return { strategy: "reprompt-structured", exhausted: false, steps: ["Re-request the output in the required structured form"] };
    default:
      if (attempt === 1) return { strategy: "retry-once", exhausted: false, steps: ["Retry the operation once"] };
      return { strategy: "alternate-approach", exhausted: false, steps: ["Try a different safe approach"] };
  }
}

/**
 * In-memory loop detector. Tracks normalized signatures and read/think cycles
 * within a mission run to catch unproductive repetition that persistence-based
 * counts might miss inside a single execution.
 */
export class LoopDetector {
  private readonly signatureCounts = new Map<string, number>();
  private readonly progressWindow: string[] = [];

  constructor(
    private readonly repeatThreshold = 3,
    private readonly noProgressWindow = 6,
  ) {}

  /** Record a failure signature; returns the new count and whether it's looping. */
  recordFailure(signature: string): { count: number; looping: boolean } {
    const count = (this.signatureCounts.get(signature) ?? 0) + 1;
    this.signatureCounts.set(signature, count);
    return { count, looping: count >= this.repeatThreshold };
  }

  /**
   * Record a progress fingerprint (e.g. a hash of the current diff / verified
   * criteria count). If the last `noProgressWindow` fingerprints are identical,
   * the run is making no measurable progress.
   */
  recordProgress(fingerprint: string): { stalled: boolean } {
    this.progressWindow.push(fingerprint);
    if (this.progressWindow.length > this.noProgressWindow) this.progressWindow.shift();
    const stalled = this.progressWindow.length >= this.noProgressWindow
      && this.progressWindow.every((f) => f === this.progressWindow[0]);
    return { stalled };
  }

  countFor(signature: string): number {
    return this.signatureCounts.get(signature) ?? 0;
  }
}
