import { ProviderError, type AiProvider, type ChatMessage, type ProviderChunk, type StreamOptions } from "./base.js";
import type { RateGuard } from "./rate-guard.js";

/**
 * Live provider fallback.
 *
 * Static routing already picks a configured provider when the preferred one is
 * unconfigured. This is the *runtime* counterpart: when the chosen provider
 * fails to start streaming (connection refused, timeout, rate limit, 5xx), the
 * turn is retried against the next configured candidate before the task is
 * failed. Fallback only happens at stream *start* — once a provider has begun
 * emitting output, switching would duplicate it, so a mid-stream error is fatal
 * and surfaces to the caller.
 *
 * Fatal request errors (a malformed request, an unsupported tool schema) are
 * NOT retried: falling back would mask a real bug and burn every provider.
 *
 * When a `RateGuard` is supplied, candidates currently cooling down after a
 * rate-limit hit are deprioritized (tried last, soonest-expiring first) rather
 * than skipped — a throttled provider is still better than no provider.
 */

export interface FallbackCandidate {
  id: string;
  provider: AiProvider;
}

export interface OpenStreamResult {
  /** The candidate id that successfully began streaming. */
  servedBy: string;
  /** Candidate ids that failed with a retryable error before this one. */
  fellBackFrom: string[];
  /** Candidate ids tried last because the rate guard had them cooling down. */
  deprioritizedRateLimited: string[];
  stream: AsyncIterable<ProviderChunk>;
}

/** Heuristic: transient/transport failures are retryable; client/request errors are not. */
export function isRetryableProviderError(err: unknown): boolean {
  if (err instanceof ProviderError) {
    if (err.kind === "cancelled") return false;
    if (err.kind === "rate_limit" || err.kind === "timeout" || err.kind === "network") return true;
    if (err.kind === "auth" || err.kind === "invalid_request") return false;
    if (err.kind === "provider") return err.retryable;
    // "unknown": no usable classification — fall through to the message heuristic.
  }
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (!message) return false;
  // Cancellation is never a fallback trigger — the user asked to stop.
  if (/(abort|cancel)/.test(message)) return false;
  if (/(429|rate.?limit|too many requests|quota)/.test(message)) return true;
  if (/(econnrefused|econnreset|enotfound|etimedout|eai_again|timeout|timed out|socket hang up|network|fetch failed|unavailable|overloaded|\b50[0234]\b)/.test(message)) {
    return true;
  }
  return false;
}

/** Is this start error a rate-limit signal the guard should learn from? */
function isRateLimitError(err: unknown): boolean {
  if (err instanceof ProviderError) return err.kind === "rate_limit";
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /(429|rate.?limit|too many requests|quota)/.test(message);
}

async function* prepend(first: IteratorResult<ProviderChunk>, rest: AsyncIterator<ProviderChunk>): AsyncIterable<ProviderChunk> {
  if (!first.done) yield first.value;
  while (true) {
    const next = await rest.next();
    if (next.done) return;
    yield next.value;
  }
}

/** Order candidates so rate-limited ones are tried last (soonest recovery first). */
function orderByRateGuard(
  candidates: FallbackCandidate[],
  guard: RateGuard | undefined
): { ordered: FallbackCandidate[]; deprioritized: string[] } {
  if (!guard) return { ordered: candidates, deprioritized: [] };
  const ready: FallbackCandidate[] = [];
  const limited: FallbackCandidate[] = [];
  for (const candidate of candidates) {
    (guard.isLimited(candidate.id) ? limited : ready).push(candidate);
  }
  limited.sort((a, b) => guard.remainingMs(a.id) - guard.remainingMs(b.id));
  return { ordered: [...ready, ...limited], deprioritized: limited.map((c) => c.id) };
}

/**
 * Open a stream against the first candidate that can begin emitting; fall back to
 * the next on a retryable start error. The returned `stream` re-yields the first
 * chunk that was pulled to probe the candidate, so no output is lost.
 */
export async function openStreamWithFallback(
  candidates: FallbackCandidate[],
  messages: ChatMessage[],
  options: StreamOptions,
  rateGuard?: RateGuard
): Promise<OpenStreamResult> {
  if (candidates.length === 0) throw new Error("No providers available to stream");
  const { ordered, deprioritized } = orderByRateGuard(candidates, rateGuard);
  const fellBackFrom: string[] = [];
  let lastError: unknown;

  for (const candidate of ordered) {
    if (options.abortSignal?.aborted) throw new Error("AbortError");
    try {
      const iterator = candidate.provider.streamChat(messages, options)[Symbol.asyncIterator]();
      const first = await iterator.next();
      // An error chunk at the very start counts as a start failure. Preserve the
      // normalized classification so retry/rate-guard decisions stay precise.
      if (!first.done && first.value.type === "error") {
        const payload = first.value.error;
        throw new ProviderError(payload?.type ?? "provider_error", payload?.message || "Model provider error", {
          kind: payload?.kind ?? "unknown",
          retryable: payload?.retryable ?? false,
          ...(payload?.status !== undefined ? { status: payload.status } : {}),
          ...(payload?.retryAfterMs !== undefined ? { retryAfterMs: payload.retryAfterMs } : {}),
        });
      }
      rateGuard?.reportSuccess(candidate.id);
      return { servedBy: candidate.id, fellBackFrom, deprioritizedRateLimited: deprioritized, stream: prepend(first, iterator) };
    } catch (err) {
      if (options.abortSignal?.aborted) throw err;
      if (isRateLimitError(err)) {
        rateGuard?.reportRateLimit(candidate.id, err instanceof ProviderError ? err.retryAfterMs : undefined);
      }
      if (!isRetryableProviderError(err)) throw err;
      lastError = err;
      fellBackFrom.push(candidate.id);
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error");
  throw new Error(`All ${candidates.length} provider(s) failed; last error: ${detail}`);
}
