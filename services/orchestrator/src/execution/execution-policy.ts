/**
 * The single execution-policy boundary for the agent loop.
 *
 * Free execution deliberately treats model-behaviour signals as observations,
 * not stop conditions. Safety and authority boundaries remain explicit: a
 * cancellation, approval/clarification gate, denied permission, ambiguous
 * side effect, configured budget, or unrecoverable provider failure must never
 * be silently converted into permission to continue.
 */

export type ExecutionPolicySignal =
  | "stagnation"
  | "loop_detected"
  | "repeated_inspection"
  | "task_shape_inference"
  | "duplicate_narration"
  | "missing_delivery"
  | "frontend_validation"
  | "cleanup_pending"
  | "verification_incomplete"
  | "malformed_tool_arguments"
  | "recoverable_tool_error"
  | "user_cancelled"
  | "approval_required"
  | "clarification_required"
  | "permission_denied"
  | "destructive_action_denied"
  | "authorization_required"
  | "ambiguous_tool_effect"
  | "explicit_budget_exhausted"
  | "context_preflight_failed"
  | "provider_auth_failure"
  | "provider_failure";

export type ExecutionPolicyDisposition = "observe" | "continue" | "wait" | "interrupt" | "fail";

export interface ExecutionPolicyInput {
  signal: ExecutionPolicySignal;
  details?: Readonly<Record<string, unknown>>;
}

export interface ExecutionPolicyDecision {
  disposition: ExecutionPolicyDisposition;
  /** True means the signal is an authority/safety boundary, not a heuristic. */
  hard: boolean;
  reason: string;
}

export interface ExecutionPolicyObservation extends ExecutionPolicyDecision {
  signal: ExecutionPolicySignal;
  details: Readonly<Record<string, unknown>>;
}

/**
 * The default resource ceiling for an unattended run, expressed in model turns.
 *
 * This is a cost/latency boundary, not a progress heuristic: it never inspects
 * what the model did, only how much provider work has been spent. When it is
 * reached the run checkpoints, reports `turn_budget_exhausted`, and stays
 * resumable with all completed work and evidence intact.
 */
export const DEFAULT_UNATTENDED_TURN_BUDGET = 128;

export interface ExecutionPolicy {
  readonly mode: "free";
  /** Explicit per-segment turn budget; null means no hidden semantic ceiling. */
  readonly turnBudget: number | null;
  /** Explicit unattended segment budget; null means no hidden segment ceiling. */
  readonly segmentBudget: number | null;
  /**
   * Absolute model-turn ceiling for one unattended run. Defaults to
   * {@link DEFAULT_UNATTENDED_TURN_BUDGET}; null only when a caller explicitly
   * opts out of any ceiling.
   */
  readonly unattendedTurnBudget: number | null;
  decide(input: ExecutionPolicyInput): ExecutionPolicyDecision;
  observe(input: ExecutionPolicyInput): ExecutionPolicyObservation;
}

export interface CreateExecutionPolicyOptions {
  /** A caller-supplied turn boundary. Never inferred from task shape. */
  maxTurns?: number | undefined;
  /** A caller-supplied unattended segment cap. */
  maxAutomaticSegments?: number | undefined;
  /**
   * Absolute model-turn ceiling for the whole unattended run. Omit for the
   * default; pass `null` to run without any turn ceiling.
   */
  maxUnattendedTurns?: number | null | undefined;
}

/**
 * Resolves the unattended turn ceiling. Precedence: explicit caller option,
 * then `MORROW_MAX_UNATTENDED_TURNS` (`0`/`unlimited`/`none` disables it), then
 * the built-in default.
 */
function resolveUnattendedTurnBudget(option: number | null | undefined): number | null {
  if (option === null) return null;
  if (option !== undefined) return explicitBudget(option);
  const configured = process.env.MORROW_MAX_UNATTENDED_TURNS?.trim();
  if (configured === undefined || configured === "") return DEFAULT_UNATTENDED_TURN_BUDGET;
  if (configured === "0" || configured === "unlimited" || configured === "none") return null;
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("MORROW_MAX_UNATTENDED_TURNS must be a positive integer, 0, or 'unlimited'");
  }
  return parsed;
}

const SOFT_SIGNALS = new Set<ExecutionPolicySignal>([
  "stagnation",
  "loop_detected",
  "repeated_inspection",
  "task_shape_inference",
  "duplicate_narration",
  "missing_delivery",
  "frontend_validation",
  "cleanup_pending",
  "verification_incomplete",
  "malformed_tool_arguments",
  "recoverable_tool_error",
]);

const HARD_DECISIONS: Readonly<Record<ExecutionPolicySignal, ExecutionPolicyDecision>> = {
  user_cancelled: { disposition: "interrupt", hard: true, reason: "User cancellation is authoritative." },
  approval_required: { disposition: "wait", hard: true, reason: "The action requires an approval boundary." },
  clarification_required: { disposition: "wait", hard: true, reason: "The task requires user clarification." },
  permission_denied: { disposition: "observe", hard: true, reason: "The denied action must remain denied." },
  destructive_action_denied: { disposition: "observe", hard: true, reason: "The destructive action must remain denied." },
  authorization_required: { disposition: "wait", hard: true, reason: "An authorization-style requirement remains unresolved." },
  ambiguous_tool_effect: { disposition: "interrupt", hard: true, reason: "The effect of a potentially mutating action is ambiguous." },
  explicit_budget_exhausted: { disposition: "interrupt", hard: true, reason: "An explicit user-configured execution budget was exhausted." },
  context_preflight_failed: { disposition: "fail", hard: true, reason: "Provider context could not be prepared safely." },
  provider_auth_failure: { disposition: "fail", hard: true, reason: "Provider authentication failed after configured fallback." },
  provider_failure: { disposition: "fail", hard: true, reason: "The provider failed without a safe recovery path." },
  stagnation: { disposition: "observe", hard: false, reason: "Stagnation is an observation; the model still owns the loop." },
  loop_detected: { disposition: "observe", hard: false, reason: "Loop detection is an observation; the model still owns the loop." },
  repeated_inspection: { disposition: "observe", hard: false, reason: "Repeated inspection is an observation; it is not a semantic stop." },
  task_shape_inference: { disposition: "observe", hard: false, reason: "Task-shape inference is advisory only." },
  duplicate_narration: { disposition: "observe", hard: false, reason: "Duplicate narration is an observation; model final output remains authoritative." },
  missing_delivery: { disposition: "observe", hard: false, reason: "Missing delivery evidence is post-execution evidence, not an interruption trigger." },
  frontend_validation: { disposition: "observe", hard: false, reason: "Frontend validation gaps are post-execution evidence, not an interruption trigger." },
  cleanup_pending: { disposition: "observe", hard: false, reason: "Cleanup expectations are advisory and cannot override model completion." },
  verification_incomplete: { disposition: "observe", hard: false, reason: "Verification state is recorded honestly without discarding model output." },
  malformed_tool_arguments: { disposition: "observe", hard: false, reason: "Malformed arguments are returned to the model as a structured tool observation." },
  recoverable_tool_error: { disposition: "observe", hard: false, reason: "Recoverable tool errors are returned to the model as structured observations." },
};

function explicitBudget(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Execution budgets must be positive safe integers");
  }
  return value;
}

export function createExecutionPolicy(options: CreateExecutionPolicyOptions = {}): ExecutionPolicy {
  const turnBudget = explicitBudget(options.maxTurns);
  const segmentBudget = explicitBudget(options.maxAutomaticSegments);

  return {
    mode: "free",
    turnBudget,
    segmentBudget,
    unattendedTurnBudget: resolveUnattendedTurnBudget(options.maxUnattendedTurns),
    decide(input) {
      const decision = HARD_DECISIONS[input.signal];
      if (!decision) throw new Error(`Unknown execution policy signal: ${input.signal}`);
      if (SOFT_SIGNALS.has(input.signal) && decision.hard) {
        throw new Error(`Execution policy signal classification drifted: ${input.signal}`);
      }
      return decision;
    },
    observe(input) {
      return {
        ...this.decide(input),
        signal: input.signal,
        details: input.details ?? {},
      };
    },
  };
}
