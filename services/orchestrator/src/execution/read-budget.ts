/**
 * The cumulative raw-bytes-in-context budget for a task's read tools.
 *
 * Every read-shaped tool (read_file, the searches, the git inspectors,
 * read_artifact) charges the bytes it returns against one task-wide ceiling so
 * a model cannot page an unbounded amount of raw workspace text into the
 * provider request.
 *
 * v0.8.0 kept that total in a bare counter that only ever grew. Once a task
 * crossed the ceiling every later read failed — including a 5 KB source file —
 * with a message that read like a complaint about the *current* request:
 * "Raw byte budget ceiling (512 KB) exceeded". A model has no way to narrow a
 * request that was never the problem, so it retried variations of the same call
 * until the task died. Two things fix that:
 *
 *  1. A rejected read is not charged. The old counter added the bytes first and
 *     tested afterwards, so each refusal pushed the total further past the
 *     ceiling and nothing could ever bring it back.
 *  2. The per-segment budget is released at a compaction boundary. It measures
 *     bytes resident in the provider request; once a segment rolls over, those
 *     bytes are gone from context and holding them against the task is wrong.
 *
 * That release, on its own, is escapable: read to the ceiling, force a
 * rollover, read to it again, forever. Two different properties are at stake
 * and v0.8.1 originally traded one for the other by accident. So there are two
 * ceilings. The per-segment one bounds what a single provider request can
 * carry and is released by compaction. The lifetime one bounds what a whole
 * task may ever pull off disk and is never released — it is deliberately much
 * larger, because a long legitimate task does read a lot, but it is finite.
 *
 * The message also had to change. It now states that the budget is cumulative
 * and already spent, and names the ways out, so the failure carries its own
 * recovery instead of inviting a retry.
 */
export class ReadBudgetExceeded extends Error {
  readonly kind = "read_budget_exhausted";
  constructor(
    message: string,
    readonly limitBytes: number,
    readonly consumedBytes: number,
    readonly requestedBytes: number,
  ) {
    super(message);
    this.name = "ReadBudgetExceeded";
  }
}

const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;

/**
 * How many segment-budgets a single task may consume in total. A task that
 * legitimately compacts several times keeps reading; one looping on reads runs
 * out. Eight was chosen to sit well above observed real runs (which rarely pass
 * two rollovers) while still being a bound.
 */
export const LIFETIME_BUDGET_MULTIPLIER = 8;

export class ReadBudget {
  private consumed = 0;
  /** Never reset. Bounds what the whole task may read, across every rollover. */
  private lifetimeConsumed = 0;
  private readonly lifetimeLimitBytes: number;
  /** Rejections since the last successful charge or release. */
  private consecutiveRejections = 0;

  constructor(private readonly limitBytes: number, lifetimeLimitBytes?: number) {
    this.lifetimeLimitBytes = lifetimeLimitBytes ?? limitBytes * LIFETIME_BUDGET_MULTIPLIER;
  }

  get lifetimeConsumedBytes(): number {
    return this.lifetimeConsumed;
  }

  get consumedBytes(): number {
    return this.consumed;
  }

  get remainingBytes(): number {
    return Math.max(0, this.limitBytes - this.consumed);
  }

  get rejections(): number {
    return this.consecutiveRejections;
  }

  /**
   * Charge a completed read. Throws without charging when the read does not
   * fit, so a refused read never makes the next one harder.
   */
  charge(bytes: number, description: string): void {
    if (this.lifetimeConsumed + bytes > this.lifetimeLimitBytes) {
      this.consecutiveRejections += 1;
      throw new ReadBudgetExceeded(
        `Task read limit reached: this task has pulled ${kb(this.lifetimeConsumed)} of raw file and tool output in total, against a ${kb(this.lifetimeLimitBytes)} whole-task ceiling that compaction does not reset. ${description} cannot be served. Do not retry this or any other read — work from what you have already read, or report what remains unknown.`,
        this.lifetimeLimitBytes,
        this.lifetimeConsumed,
        bytes,
      );
    }
    if (this.consumed + bytes <= this.limitBytes) {
      this.consumed += bytes;
      this.lifetimeConsumed += bytes;
      this.consecutiveRejections = 0;
      return;
    }
    this.consecutiveRejections += 1;
    throw new ReadBudgetExceeded(this.message(bytes, description), this.limitBytes, this.consumed, bytes);
  }

  /**
   * Context was compacted, so the raw bytes this budget was tracking are no
   * longer in the provider request.
   */
  releaseForCompaction(): void {
    // Only the per-segment counter. `lifetimeConsumed` deliberately survives,
    // so repeated rollovers cannot be used to page unbounded bytes.
    this.consumed = 0;
    this.consecutiveRejections = 0;
  }

  private message(requestedBytes: number, description: string): string {
    const remaining = this.remainingBytes;
    const head = `Read budget exhausted: this task has already pulled ${kb(this.consumed)} of raw file and tool output into context, against a ${kb(this.limitBytes)} ceiling. ${description} needs ${kb(requestedBytes)} and only ${kb(remaining)} remains.`;
    // The distinction that matters to the model: the ceiling is about
    // everything read so far, not about this request. Retrying it unchanged —
    // or against a different file — fails identically.
    const guidance = remaining === 0
      ? "Retrying this read, or the same read against another path, will fail the same way. Do not repeat it. Work from what you have already read, or narrow to a specific range with the offset argument, or use search_text to locate just the lines you need."
      : `Retrying it unchanged will fail the same way. Request a smaller slice (use offset to read a range under ${kb(remaining)}), or use search_text to find just the lines you need.`;
    return `${head} ${guidance}`;
  }
}
