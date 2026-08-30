import type { CompletionBlocker, CompletionBlockerCode } from "./completion-contract.js";

/**
 * Why an agent turn is allowed to end, or what must happen before it can.
 *
 * The completion contract already knows, at the moment the model stops calling
 * tools, whether the user's goal is actually satisfied. Before v0.8.1 that
 * knowledge was only *recorded* — a run that had just watched five of its own
 * tests fail was allowed to hand the terminal back to the user with the failure
 * filed as evidence. That is the "so are you done" bug: the agent knew the next
 * step and yielded anyway.
 *
 * This module turns that recorded knowledge into an execution decision. It is
 * deliberately a pure classifier over blocker codes plus two counters: no
 * workflow engine, no plan graph, no extra model turn to ask "are you done".
 */

export type ContinuationAction =
  /** Nothing remains: the contract is satisfied. */
  | { action: "finish" }
  /** Actionable work remains and no user input is needed. Keep going. */
  | { action: "continue"; directive: string; blockers: CompletionBlockerCode[] }
  /** Execution must end even though the contract is unsatisfied. */
  | { action: "stop"; reason: ContinuationStopReason; blockers: CompletionBlockerCode[] };

export type ContinuationStopReason =
  /** Only blockers that no further autonomous work can clear remain. */
  | "blocked"
  /** The remaining blockers need something only the user can supply. */
  | "waiting_for_user"
  /** The continuation budget is spent; stopping beats looping. */
  | "exhausted";

/**
 * Blockers a further autonomous turn can plausibly clear. Each of these names a
 * concrete next action the agent can take on its own: fix the failing check,
 * write the missing file, run the missing verification, close the process.
 */
const ACTIONABLE: ReadonlySet<CompletionBlockerCode> = new Set<CompletionBlockerCode>([
  "failed_final_verification",
  "missing_independent_verification",
  "missing_durable_artifact",
  "artifact_not_independently_observed",
  "artifact_not_durable",
  "missing_read_only_observation",
  "requirements_unresolved",
  "requirement_failed",
  "requirement_unevaluated",
  "frontend_route_missing",
  "frontend_snapshot_missing",
  "frontend_console_unclean",
  "frontend_interaction_missing",
  "frontend_viewports_incomplete",
  "background_process_running",
  // A screenshot that was never attached can simply be taken again. Treating
  // it as terminal stopped the agent one action short of the evidence it was
  // being judged on.
  "frontend_vision_missing",
]);

/**
 * Blockers that need the user, not another turn. `requirement_unavailable`
 * means the evidence a requirement demands cannot be produced in this
 * environment; retrying it just burns turns and tokens.
 */
const NEEDS_USER: ReadonlySet<CompletionBlockerCode> = new Set<CompletionBlockerCode>([
  "requirement_unavailable",
]);

/**
 * Blockers about the *shape of the final message* rather than the work. These
 * have their own recovery paths earlier in the loop (the empty-response retry,
 * the narration-duplication gate); continuing here would only re-run a turn
 * that already produced its text, so they never drive continuation.
 */
const NOT_CONTINUABLE: ReadonlySet<CompletionBlockerCode> = new Set<CompletionBlockerCode>([
  "missing_canonical_final_answer",
  "duplicate_canonical_narration",
  "unknown_task_shape",
]);

/** Bounded so a model that cannot converge stops instead of spinning. */
export const MAX_COMPLETION_CONTINUATIONS = 3;

export interface ContinuationInput {
  /** Blockers from the completion evaluation at the model's stop point. */
  blockers: readonly CompletionBlocker[];
  /** How many continuations this task has already been granted. */
  attempts: number;
  /** Overrides the default budget; tests and presets use this. */
  maxAttempts?: number;
  /**
   * Whether the model did any tool work since the last continuation directive.
   * A continuation that produced only prose and left the same blockers standing
   * is not converging, so the next one is refused.
   */
  actedSinceLastContinuation?: boolean;
}

const describe = (blockers: readonly CompletionBlocker[]): string =>
  blockers.map((item) => `- ${item.message}`).join("\n");

/**
 * The directive is written to be unambiguous about the one thing the model got
 * wrong: it treated "I have described the remaining work" as "the work is
 * done". It names the outstanding evidence and forbids a summary-only reply.
 */
function buildDirective(
  actionable: readonly CompletionBlocker[],
  needsUser: readonly CompletionBlocker[],
): string {
  const lines = [
    "Your goal is not finished. The following acceptance evidence is still outstanding:",
    describe(actionable),
    "",
  ];
  // Claiming "no user input is required" while a genuinely unavailable
  // requirement is also outstanding is a lie the model cannot act on, and it
  // invites autonomous retries of something that cannot succeed. Name the
  // split instead.
  if (needsUser.length > 0) {
    lines.push(
      "These separately need something only the user can supply, so do not retry them:",
      describe(needsUser),
      "",
      "Do the work above that you can do unaided. Do not summarise what is left and stop — do it now:",
    );
  } else {
    lines.push("No permission, clarification, or user input is required. Do not summarise what is left and stop — do it now:");
  }
  lines.push(
    "act on the next concrete step, re-run the verification that failed, and only then return a final answer.",
    "If you have already identified the fixes, apply them in this turn rather than restating them.",
  );
  return lines.join("\n");
}

export function decideContinuation(input: ContinuationInput): ContinuationAction {
  const codes = input.blockers.map((item) => item.code);
  if (input.blockers.length === 0) return { action: "finish" };

  let actionable = input.blockers.filter((item) => ACTIONABLE.has(item.code));
  // Evidence has an order. You cannot verify a route, capture a DOM snapshot or
  // check a console for a thing that has not been built, so listing those
  // alongside "nothing was delivered" does not describe parallel work — it
  // describes work that cannot start yet, and it misdirects.
  //
  // Observed live: a mission whose workspace held only .gitignore was told its
  // outstanding evidence included frontend_route_missing, and spent both of its
  // continuations calling browser_open against an empty directory instead of
  // writing the module it had been asked for. When delivery is outstanding, the
  // directive names delivery and nothing else.
  const deliveryOutstanding = actionable.some((item) =>
    item.code === "missing_durable_artifact"
    || item.code === "artifact_not_independently_observed"
    || item.code === "artifact_not_durable");
  if (deliveryOutstanding) {
    actionable = actionable.filter((item) => !item.code.startsWith("frontend_")
      && item.code !== "missing_independent_verification");
  }
  if (actionable.length === 0) {
    const reason: ContinuationStopReason = input.blockers.some((item) => NEEDS_USER.has(item.code))
      ? "waiting_for_user"
      : "blocked";
    return { action: "stop", reason, blockers: codes };
  }

  const maxAttempts = input.maxAttempts ?? MAX_COMPLETION_CONTINUATIONS;
  if (input.attempts >= maxAttempts) return { action: "stop", reason: "exhausted", blockers: codes };
  // A granted continuation that produced no tool call did not attempt the work,
  // and replaying prose forever is the loop this budget exists to stop — so
  // normally one such turn ends it.
  //
  // The exception is a task that has produced nothing at all. Observed live: a
  // mission answered its first directive with prose, was cut off four seconds
  // after being told to keep going, and finished with one changed file —
  // .gitignore. Stopping is defensible when there is work to stop on; stopping
  // with an empty workspace and budget still in hand never is. So when the
  // outstanding evidence says nothing was delivered, the first prose-only turn
  // is forgiven and the second is not.
  const deliveredNothing = codes.includes("missing_durable_artifact")
    || codes.includes("missing_read_only_observation");
  const proseOnlyLimit = deliveredNothing ? 2 : 1;
  if (input.attempts >= proseOnlyLimit && input.actedSinceLastContinuation === false) {
    return { action: "stop", reason: "exhausted", blockers: codes };
  }

  return {
    action: "continue",
    directive: buildDirective(actionable, input.blockers.filter((item) => NEEDS_USER.has(item.code))),
    blockers: actionable.map((item) => item.code),
  };
}

/**
 * Every blocker code must be classified exactly once. Left implicit, a code
 * added later would silently default to "stop", which is the failure this
 * module exists to prevent — so the classification is asserted rather than
 * assumed, and a new unclassified code fails loudly in tests.
 */
export function classifyBlocker(code: CompletionBlockerCode): "actionable" | "needs_user" | "not_continuable" {
  if (ACTIONABLE.has(code)) return "actionable";
  if (NEEDS_USER.has(code)) return "needs_user";
  if (NOT_CONTINUABLE.has(code)) return "not_continuable";
  throw new Error(`Unclassified completion blocker: ${code}`);
}

/** Exported for tests and for the completion evidence written to the ledger. */
export const continuationClassification = {
  actionable: ACTIONABLE,
  needsUser: NEEDS_USER,
  notContinuable: NOT_CONTINUABLE,
} as const;
