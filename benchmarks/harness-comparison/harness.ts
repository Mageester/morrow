/**
 * The comparison contract every harness adapter implements.
 *
 * One shape, filled in identically by both sides, so the report is a
 * like-for-like table rather than two differently-shaped stories. Anything a
 * harness cannot report is `null` — never zero, never inferred — because a
 * missing measurement and a measurement of nothing are different claims.
 */
export interface HarnessRunResult {
  harness: string;
  taskId: string;
  category: string;
  model: string;

  /** Ground truth: did the hidden check pass? */
  passed: boolean;
  /** The harness's own verdict: did it report the work as finished? */
  claimedSuccess: boolean;
  failureDetail: string | null;

  durationMs: number;
  /** True when the shared wall-clock ceiling stopped the run. */
  timedOut: boolean;

  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  /**
   * Input tokens billed on the *first* provider request of the run.
   *
   * This is the harness's fixed cost of existing — system prompt, tool
   * schemas, injected context — before any of the conversation the task itself
   * generates. Separating it from `inputTokens` is what makes "harness
   * overhead" a measurement rather than an adjective.
   */
  firstTurnInputTokens: number | null;
  /** Provider-metered cost when the harness reports one; otherwise null. */
  measuredCostUsd: number | null;

  /** Model turns: one per provider request. */
  providerCalls: number | null;
  toolCalls: number | null;

  /** Anything that made the run not a clean measurement of the harness. */
  harnessError: string | null;
}

export interface HarnessAdapter {
  readonly name: string;
  /** Human-readable description of exactly how this harness was invoked. */
  readonly invocation: string;
  run(input: {
    taskId: string;
    category: string;
    prompt: string;
    workspace: string;
    model: string;
    timeoutMs: number;
  }): Promise<Omit<HarnessRunResult, "passed" | "failureDetail">>;
}
