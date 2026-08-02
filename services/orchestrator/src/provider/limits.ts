/**
 * The one place a wire request's limits are made mutually consistent.
 *
 * Every limit on a provider request looks independent and is not. Morrow has
 * now shipped the same defect twice, in two unrelated adapters, because the
 * coupling lived in whichever adapter happened to remember it:
 *
 *  1. Anthropic extended thinking constrains `temperature` and `max_tokens`.
 *     The API rejects the request outright if a sampling temperature is sent
 *     alongside thinking, or if `max_tokens` does not leave room for the
 *     visible answer *on top of* the thinking budget. The preset that supplies
 *     temperature and the output budget cannot see the reasoning mode, so
 *     every reasoning selection 400'd until the adapter reconciled them.
 *
 *  2. The output budget and the request deadline. A reasoning model bills its
 *     hidden chain-of-thought against the same output allowance as its visible
 *     answer, so the empty-response recovery raises the ceiling on retry —
 *     and raising the ceiling alone converted an "empty response" failure into
 *     a "provider stream timed out" failure without ever letting the turn
 *     finish. Measured live: 18,900 completion tokens took 146s, so a 4x
 *     allowance under a fixed deadline cannot complete by construction.
 *
 * Both are instances of one class: a limit that is only valid relative to
 * another limit. This module owns that relation. Adapters state what the
 * protocol requires (does thinking exclude temperature? how many tokens are
 * reserved before the first visible one?) and get back a reconciled set; they
 * do not each re-derive the arithmetic.
 *
 * Reconciliation is deliberately corrective rather than fatal. Every rule here
 * has a single safe direction — give the request more room — and failing a
 * request that could have succeeded is a worse outcome than quietly widening
 * a ceiling. Every change is recorded in `adjustments` so the decision is
 * inspectable rather than invisible.
 */

/** Floor on wall-clock time per output token the deadline must allow for.
 *
 * Measured against opencode-zen/deepseek-v4-flash-free: 18,900 completion
 * tokens in 146s, i.e. ~7.7ms/token on a slow free-tier reasoning route. The
 * floor is set well below that — it is not a throughput estimate, it is the
 * point past which a deadline is arithmetically incapable of admitting the
 * allowance it was paired with. Morrow's own presets sit at 22-29ms/token, so
 * this rule never fires on a coherent configuration; it fires exactly when one
 * of the two limits was moved without the other. */
export const MIN_MS_PER_OUTPUT_TOKEN = 4;

/** Room preserved for a visible answer on top of a reasoning budget when the
 * caller does not state its own. Matches the default output allowance an
 * adapter falls back to when no budget was requested. */
export const DEFAULT_VISIBLE_ANSWER_FLOOR_TOKENS = 4096;

export interface WireRequestLimits {
  /** The ceiling every output token bills against — hidden reasoning included. */
  maxOutputTokens?: number | null | undefined;
  /** Wall-clock deadline for the whole stream, in milliseconds. */
  timeoutMs?: number | undefined;
  temperature?: number | null | undefined;
  /** Tokens the protocol reserves for hidden reasoning before it can emit a
   * single visible one (Anthropic `thinking.budget_tokens`). Absent or 0 means
   * the protocol does not carve reasoning out of the same allowance. */
  reasoningBudgetTokens?: number | undefined;
  /** True when the protocol rejects a sampling temperature alongside reasoning. */
  reasoningExcludesTemperature?: boolean | undefined;
  /** Visible-answer room to preserve on top of `reasoningBudgetTokens`.
   * Defaults to DEFAULT_VISIBLE_ANSWER_FLOOR_TOKENS. */
  visibleAnswerFloorTokens?: number | undefined;
}

export interface ReconciledWireLimits {
  maxOutputTokens: number | null;
  timeoutMs: number | undefined;
  temperature: number | null;
  /** Every limit this reconciliation changed, in the order it changed them.
   * Empty when the caller's limits were already mutually consistent. */
  adjustments: string[];
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Reconcile a request's limits against each other. Pure, total, and safe to
 * call on every request — an already-consistent set comes back unchanged with
 * no adjustments.
 */
export function reconcileWireLimits(limits: WireRequestLimits): ReconciledWireLimits {
  const adjustments: string[] = [];

  let maxOutputTokens: number | null = isPositiveNumber(limits.maxOutputTokens) ? limits.maxOutputTokens : null;
  let timeoutMs: number | undefined = isPositiveNumber(limits.timeoutMs) ? limits.timeoutMs : undefined;
  let temperature: number | null = typeof limits.temperature === "number" ? limits.temperature : null;

  const reasoningBudget = isPositiveNumber(limits.reasoningBudgetTokens) ? limits.reasoningBudgetTokens : 0;

  // Rule 1 — reasoning excludes temperature. Dropping the sampling knob is the
  // only resolution available: the caller asked for reasoning explicitly and
  // inherited the temperature from a preset that could not see that choice.
  if (reasoningBudget > 0 && limits.reasoningExcludesTemperature && temperature !== null) {
    adjustments.push(`dropped temperature ${temperature}: the protocol rejects sampling temperature alongside reasoning`);
    temperature = null;
  }

  // Rule 2 — the output ceiling must leave room for a visible answer *above*
  // the reasoning budget. A ceiling at or below the budget guarantees the
  // model spends the whole allowance thinking and returns nothing.
  if (reasoningBudget > 0) {
    const floor = isPositiveNumber(limits.visibleAnswerFloorTokens)
      ? limits.visibleAnswerFloorTokens
      : DEFAULT_VISIBLE_ANSWER_FLOOR_TOKENS;
    const required = reasoningBudget + floor;
    if (maxOutputTokens === null) {
      maxOutputTokens = required;
      adjustments.push(`set maxOutputTokens to ${required}: a ${reasoningBudget}-token reasoning budget needs ${floor} tokens of visible-answer room above it`);
    } else if (maxOutputTokens <= reasoningBudget) {
      adjustments.push(`raised maxOutputTokens ${maxOutputTokens} -> ${required}: it did not exceed the ${reasoningBudget}-token reasoning budget, so no visible answer could be emitted`);
      maxOutputTokens = required;
    }
  }

  // Rule 3 — the deadline must be able to admit the allowance. Raising the
  // ceiling without raising the deadline just relabels the failure.
  if (maxOutputTokens !== null && timeoutMs !== undefined) {
    const required = maxOutputTokens * MIN_MS_PER_OUTPUT_TOKEN;
    if (timeoutMs < required) {
      adjustments.push(`raised timeoutMs ${timeoutMs} -> ${required}: a ${maxOutputTokens}-token allowance cannot be emitted within ${timeoutMs}ms`);
      timeoutMs = required;
    }
  }

  return { maxOutputTokens, timeoutMs, temperature, adjustments };
}
