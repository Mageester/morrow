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
  if (/context (window|limit|budget).*(exceed|exhaust|full)|maximum context|too many tokens/.test(m)) return "context_exhaustion";
  if (/model .*not (available|found|supported)|unknown model|model access denied/.test(m)) return "model_unavailable";
  if (/rate limit|quota|\b429\b/.test(m)) return "rate_limit";
  if (/econnreset|enotfound|dns|network (error|unreachable)|socket hang up/.test(m)) return "network_failure";
  if (/invalid (tool )?(argument|parameter)|tool arguments.*(malformed|schema)/.test(m)) return "invalid_tool_arguments";
  if (/verification (failed|failure)|criterion.*not verified/.test(m)) return "verification_failure";
  if (/approval (required|pending)|requires explicit approval/.test(m)) return "approval_required";
  if (/loop detected|no measurable progress|repeated identical|same strategy/.test(m)) return "repeated_strategy";
  if (/may have executed|unknown side effect|effect.*ambiguous/.test(m)) return "unknown_effect";
  if (/process (crashed|interrupted|terminated)|orchestrator restart/.test(m)) return "process_interruption";
  if (/\btest(s)? (failed|failing)|assertion|expect\(|✗|✖/.test(m)) return "test_failure";
  if (/build failed|compilation|tsc error|cannot find module|type error|ts\d{3,}/.test(m)) return "build_failure";
  if (/provider error|model provider|upstream|\b502\b|\b503\b/.test(m)) return "provider_failure";
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
      if (attempt === 1) return { strategy: "provider-fallback", exhausted: false, steps: ["Fall back to an alternate configured provider and retry"] };
      if (attempt === 2) return { strategy: "switch-model", exhausted: false, steps: ["Select a different available model on the fallback provider"] };
      return { strategy: "reduce-request-retry", exhausted: false, steps: ["Reduce request scope and retry on the healthiest available route"] };
    case "model_unavailable":
      return attempt === 1
        ? { strategy: "switch-model", exhausted: false, steps: ["Select a model confirmed available for this account"] }
        : { strategy: "provider-fallback", exhausted: false, steps: ["Switch to a configured provider with an available model"] };
    case "rate_limit":
      if (attempt === 1) return { strategy: "bounded-backoff", exhausted: false, steps: ["Wait for the provider retry window"] };
      if (attempt === 2) return { strategy: "provider-fallback", exhausted: false, steps: ["Switch to an alternate configured provider"] };
      return { strategy: "switch-model", exhausted: false, steps: ["Use a separately limited available model"] };
    case "network_failure":
      return attempt === 1
        ? { strategy: "connectivity-diagnosis", exhausted: false, steps: ["Check DNS and provider endpoint reachability"] }
        : { strategy: "provider-fallback", exhausted: false, steps: ["Use a reachable alternate provider"] };
    case "context_exhaustion":
      return attempt === 1
        ? { strategy: "checkpoint-and-compact", exhausted: false, steps: ["Persist a checkpoint and compact durable context"] }
        : { strategy: "reproject-minimum-context", exhausted: false, steps: ["Reproject only hard requirements, evidence, decisions, and pending work"] };
    case "invalid_tool_arguments":
      return { strategy: "repair-tool-arguments", exhausted: false, steps: ["Validate arguments against the tool schema and repair only invalid fields"] };
    case "verification_failure":
      return attempt === 1
        ? { strategy: "focused-diagnosis", exhausted: false, steps: ["Diagnose the failing criterion from direct evidence"] }
        : { strategy: "replan-from-evidence", exhausted: false, steps: ["Replace the disproven approach with an evidence-backed plan"] };
    case "approval_required":
      return { strategy: "request-approval", exhausted: true, steps: ["Record the exact approval and effect required before resuming"] };
    case "unknown_effect":
      return { strategy: "verify-effect", exhausted: false, steps: ["Inspect durable evidence before deciding whether replay is safe"] };
    case "process_interruption":
      return { strategy: "restore-checkpoint", exhausted: false, steps: ["Reclaim the durable checkpoint and reconcile completed operations"] };
    case "repeated_strategy":
      return attempt === 1
        ? { strategy: "focused-diagnosis", exhausted: false, steps: ["Diagnose why the current strategy cannot progress"] }
        : { strategy: "alternate-approach", exhausted: false, steps: ["Select a strategy with a distinct fingerprint"] };
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
