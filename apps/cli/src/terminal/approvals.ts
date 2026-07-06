/**
 * Pure approval-key semantics.
 *
 * The single safety-critical rule of a permission prompt: only an *explicit,
 * affirmative* keystroke may approve. Enter/Return, Space, Tab, arrows, and any
 * stray character must resolve to `null` (no decision), so a queued Enter left
 * over from streaming can never silently approve a command or patch.
 *
 * Keeping this mapping pure and separate from the session lets the guarantee be
 * unit-tested directly, with no TTY.
 */

export type ApprovalDecision = "allow_once" | "trust_session" | "trust_project" | "deny";

export interface ApprovalKey {
  str?: string | undefined;
  name?: string | undefined;
  ctrl?: boolean | undefined;
}

/**
 * Map a keypress to an approval decision, or `null` when the key is not an
 * explicit choice. Only y/s/p/n (case-insensitive) and Ctrl+C (deny) decide;
 * everything else — critically including Enter/Return and Space — is a no-op.
 */
export function approvalDecisionForKey(key: ApprovalKey): ApprovalDecision | null {
  // Ctrl+C is an explicit, unambiguous "deny" (and does not exit while pending).
  if (key.ctrl && key.name === "c") return "deny";
  // Never let a control/navigation key stand in for a letter choice.
  if (key.ctrl) return null;
  if (key.name === "return" || key.name === "enter" || key.name === "space" || key.name === "tab") return null;
  const ch = (key.str ?? "").toLowerCase();
  switch (ch) {
    case "y":
      return "allow_once";
    case "s":
      return "trust_session";
    case "p":
      return "trust_project";
    case "n":
      return "deny";
    default:
      return null;
  }
}

/** Human summary of a resolved decision for the activity/notice log. */
export function approvalDecisionLabel(decision: ApprovalDecision): string {
  switch (decision) {
    case "deny":
      return "denied";
    case "trust_project":
      return "trusted (project)";
    case "trust_session":
      return "trusted (session)";
    case "allow_once":
      return "approved";
  }
}

/** The compact, always-visible action row for an approval prompt. */
export function approvalActionsLine(verb: "approve" | "apply"): string {
  return `  [y] ${verb} once   [s] trust session   [p] trust project   [n] deny`;
}
