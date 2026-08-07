import { ProviderError } from "../provider/base.js";

/**
 * How long to wait before retrying a provider, and whether to retry at all.
 *
 * Morrow already knew everything it needed here and threw it away. A 429 is
 * parsed into `ProviderError.retryAfterMs`, carried through the fallback
 * aggregate, and written into the `provider.error_classified` event — and then
 * the agent retried *immediately*, twice, and failed the task. `RateGuard`
 * computes a correct cooldown too, but it is advisory and only reorders
 * candidates, so with a single configured provider (the common case) the
 * correct number was calculated and never waited.
 *
 * The consequence is the one that matters: a rate limit is not a defect, it is
 * a queue signal, and Morrow converted it into a hard task failure in under a
 * second. Anyone running one API key hit this the moment the provider throttled
 * them.
 *
 * So retry pacing is stated here, once, as a pure function of the error and what
 * has already been spent. Two things it deliberately does NOT do: it does not
 * retry forever (a wedged provider must still end the task honestly), and it
 * does not pace a context rejection (the remedy there is compaction, and
 * waiting only delays it).
 */

/** Ceiling on any single wait. Kept well under the 5-minute execution lease so
 * a wait can never let the lease lapse and hand the task to another worker. */
export const MAX_SINGLE_BACKOFF_MS = 60_000;

/** Ceiling on everything a single task may spend waiting on transient faults.
 * Past this the provider is not throttling us, it is down, and saying so beats
 * a task that never returns. */
export const MAX_TOTAL_BACKOFF_MS = 300_000;

/** A rate limit is self-clearing and the provider usually tells us when. Worth
 * more patience than a fault we have no stated recovery time for. */
export const RATE_LIMIT_ATTEMPTS = 6;

/** Transport faults: connection resets, timeouts, 502/503. Transient, but with
 * no stated recovery time, so fewer attempts on a blind schedule. */
export const TRANSPORT_ATTEMPTS = 4;

/** Context rejections. Unchanged from the original bound: the remedy is
 * compaction, and a third attempt at the same oversized context is a loop. */
export const CONTEXT_REJECTION_ATTEMPTS = 2;

const RATE_LIMIT_BASE_MS = 2_000;
const TRANSPORT_BASE_MS = 1_000;

export type ProviderFaultClass = "rate_limit" | "transport" | "context_rejection" | "fatal";

export interface ProviderRetryState {
  /** Retries already spent on this fault class for this task. */
  attemptsUsed: number;
  /** Milliseconds this task has already spent waiting on transient faults. */
  totalBackoffMs: number;
}

export interface ProviderRetryDecision {
  retry: boolean;
  /** How long to wait before the retry. Zero for classes that gain nothing
   * from waiting. */
  delayMs: number;
  faultClass: ProviderFaultClass;
  /** Plain-language justification, recorded on the durable event so a paced
   * retry is inspectable rather than looking like a stall. */
  reason: string;
}

/**
 * Classify a provider failure by what would actually make it go away.
 *
 * `isRetryableProviderError` already answers "is this worth retrying"; this
 * answers the different question of *how*, because "wait for the window the
 * provider named" and "recompact and try again" are not the same remedy.
 */
export function classifyProviderFault(error: unknown, isRetryable: boolean, isContextRejection: boolean): ProviderFaultClass {
  if (isContextRejection) return "context_rejection";
  if (!isRetryable) return "fatal";
  if (error instanceof ProviderError && error.kind === "rate_limit") return "rate_limit";
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (/(429|rate.?limit|too many requests|quota)/.test(message)) return "rate_limit";
  return "transport";
}

function attemptBudget(faultClass: ProviderFaultClass): number {
  switch (faultClass) {
    case "rate_limit": return RATE_LIMIT_ATTEMPTS;
    case "transport": return TRANSPORT_ATTEMPTS;
    case "context_rejection": return CONTEXT_REJECTION_ATTEMPTS;
    case "fatal": return 0;
  }
}

/**
 * Decide whether to retry, and how long to wait first.
 *
 * `retryAfterMs` from the provider always wins over a computed schedule: the
 * service telling us when it will serve us again is better information than any
 * guess, and ignoring it is how a client earns a longer ban.
 */
export function decideProviderRetry(input: {
  error: unknown;
  isRetryable: boolean;
  isContextRejection: boolean;
  state: ProviderRetryState;
  /** Cooldown `RateGuard` already computed for this route, if any. Used only
   * when the provider named no explicit window. */
  guardRemainingMs?: number;
}): ProviderRetryDecision {
  const faultClass = classifyProviderFault(input.error, input.isRetryable, input.isContextRejection);
  const budget = attemptBudget(faultClass);

  if (faultClass === "fatal") {
    return { retry: false, delayMs: 0, faultClass, reason: "the provider rejected the request in a way retrying cannot fix" };
  }
  if (input.state.attemptsUsed >= budget) {
    return {
      retry: false,
      delayMs: 0,
      faultClass,
      reason: `exhausted ${budget} ${faultClass.replace("_", " ")} recovery attempt(s)`,
    };
  }
  if (input.state.totalBackoffMs >= MAX_TOTAL_BACKOFF_MS) {
    return {
      retry: false,
      delayMs: 0,
      faultClass,
      reason: `spent the ${Math.round(MAX_TOTAL_BACKOFF_MS / 1000)}s transient-fault budget without the provider recovering`,
    };
  }

  if (faultClass === "context_rejection") {
    return { retry: true, delayMs: 0, faultClass, reason: "recompacting and retrying; waiting would not shrink the request" };
  }

  const retryAfterMs = input.error instanceof ProviderError && typeof input.error.retryAfterMs === "number" && input.error.retryAfterMs > 0
    ? input.error.retryAfterMs
    : undefined;
  const base = faultClass === "rate_limit" ? RATE_LIMIT_BASE_MS : TRANSPORT_BASE_MS;
  const scheduled = Math.min(base * 2 ** input.state.attemptsUsed, MAX_SINGLE_BACKOFF_MS);
  const guard = typeof input.guardRemainingMs === "number" && input.guardRemainingMs > 0 ? input.guardRemainingMs : 0;

  const chosen = retryAfterMs !== undefined
    ? Math.min(retryAfterMs, MAX_SINGLE_BACKOFF_MS)
    : Math.min(Math.max(scheduled, guard), MAX_SINGLE_BACKOFF_MS);

  // Never wait past the total budget: overshooting it would produce one long
  // sleep that ends in failure anyway.
  const delayMs = Math.max(0, Math.min(chosen, MAX_TOTAL_BACKOFF_MS - input.state.totalBackoffMs));

  return {
    retry: true,
    delayMs,
    faultClass,
    reason: retryAfterMs !== undefined
      ? `provider asked for ${Math.round(retryAfterMs / 1000)}s before the next attempt`
      : `backing off ${Math.round(delayMs / 1000)}s before attempt ${input.state.attemptsUsed + 2}`,
  };
}

/**
 * Wait, unless the task is cancelled first. Cancellation must stay responsive
 * during a backoff — a user who asks to stop should not wait out a rate limit
 * they no longer care about.
 */
export function sleepUnlessAborted(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
