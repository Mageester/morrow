/**
 * Human-friendly error interpretation.
 *
 * Raw provider and tool errors arrive as terse strings ("authentication_error:
 * Invalid API key", "429 Too Many Requests", "Command timed out"). Users should
 * never see a raw stack trace by default — this module maps known error
 * patterns to clear, actionable messages.
 *
 * Pure: pattern-matching only, no I/O. Snapshot-testable.
 */

export interface InterpretedError {
  /** Short heading shown to the user, e.g. "Provider authentication failed". */
  title: string;
  /** One or two lines of explanation. */
  body: string;
  /** Optional actionable hint, e.g. "Run /provider to update it." */
  hint?: string;
}

/** Match a raw error string to a human-friendly interpretation. */
export function interpretError(raw: string): InterpretedError {
  const lower = raw.toLowerCase();

  // ── Provider authentication ──────────────────────────────────────────────
  if (/auth|invalid.*key|unauthorized|401|api.?key.*invalid|incorrect.*api.?key/.test(lower)) {
    return {
      title: "Provider authentication failed.",
      body: "The configured API key was rejected by the provider.",
      hint: "Run /provider to update it, or morrow auth login to reconfigure.",
    };
  }

  // ── Rate limiting ────────────────────────────────────────────────────────
  if (/rate.?limit|429|too many requests|quota|throttl/.test(lower)) {
    return {
      title: "Rate limit reached.",
      body: "The provider is throttling requests. Wait a moment and try again.",
      hint: "If this persists, consider switching models with /model.",
    };
  }

  // ── Timeout ─────────────────────────────────────────────────────────────
  if (/timeout|timed.?out|deadline.?exceeded/.test(lower)) {
    return {
      title: "Provider timeout.",
      body: "The model provider took too long to respond.",
      hint: "Check your network, or try a different model with /model.",
    };
  }

  // ── Service stopped ─────────────────────────────────────────────────────
  if (/econnreset|socket.*closed|server.*not.*running/.test(lower)) {
    return {
      title: "Service connection lost.",
      body: "The Morrow service stopped responding.",
      hint: "Run morrow start to restart it, or morrow doctor to diagnose.",
    };
  }

  // ── Provider offline / unreachable ───────────────────────────────────────
  if (/econnrefused|fetch.*failed|network|unreachable|dns|socket hang up|err_connection|cannot connect|empty stream/.test(lower)) {
    return {
      title: "Provider unreachable.",
      body: "Morrow could not reach the model provider endpoint.",
      hint: "Check your network and provider status, or run morrow doctor.",
    };
  }

  // ── Unsupported model ────────────────────────────────────────────────────
  if (/model.*not.*found|not.*supported|unknown.*model|invalid.*model/.test(lower)) {
    return {
      title: "Unsupported model.",
      body: "The selected model is not available on this provider.",
      hint: "Run /model to choose a supported model.",
    };
  }

  // ── Patch failure ───────────────────────────────────────────────────────
  if (/patch.*fail|failed.*apply|conflict|hunk.*fail/.test(lower)) {
    return {
      title: "Patch failed.",
      body: "Morrow could not apply the proposed file change.",
      hint: "The file may have changed. Run /changes to inspect, then ask again.",
    };
  }

  // ── Test failure ────────────────────────────────────────────────────────
  if (/test.*fail|assertion|tests? failed|exit.*1/.test(lower)) {
    return {
      title: "Tests failed.",
      body: "The verification step ran tests but they did not pass.",
      hint: "Run /activity for details, or /diff to see what changed.",
    };
  }

  // ── Permission denial ────────────────────────────────────────────────────
  if (/permission.*denied|denied.*by.*policy|operation.*not.*permitted|forbidden|403/.test(lower)) {
    return {
      title: "Permission denied.",
      body: "Morrow's safety policy blocked this operation.",
      hint: "If this is intentional, review /permissions or adjust the mode with /mode.",
    };
  }

  // ── Malformed review JSON ───────────────────────────────────────────────
  if (/json.*parse|unexpected.*token|malformed.*json|invalid.*json|review.*json/.test(lower)) {
    return {
      title: "Review parsing failed.",
      body: "The model returned a review response that could not be parsed as structured JSON.",
      hint: "Morrow will attempt one structured repair. If it persists, the model may not support JSON mode.",
    };
  }

  // ── Database migration ──────────────────────────────────────────────────
  if (/migration|database.*version|schema.*mismatch|sqlite|better-sqlite/.test(lower)) {
    return {
      title: "Database issue.",
      body: "The local database needs migration or is in an inconsistent state.",
      hint: "Run morrow doctor to diagnose, or morrow start --reset-db if data loss is acceptable.",
    };
  }

  // ── Git repository ──────────────────────────────────────────────────────
  if (/not.*a.*git.*repo|fatal.*not.*a.*git|repository.*not.*found/.test(lower)) {
    return {
      title: "Not a Git repository.",
      body: "This operation requires a Git repository.",
      hint: "Run git init, or /branch to check the current state.",
    };
  }

  // ── Fallback ────────────────────────────────────────────────────────────
  return {
    title: "Something went wrong.",
    body: raw.slice(0, 200),
    hint: "Run /details for technical output, or morrow doctor to diagnose.",
  };
}

/** Format an InterpretedError for the notice area (compact, multi-line). */
export function formatInterpretedError(err: InterpretedError): string {
  const lines = [err.title, "", err.body];
  if (err.hint) lines.push("", err.hint);
  return lines.join("\n");
}
