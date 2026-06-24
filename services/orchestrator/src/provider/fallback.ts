import type { AiProvider, ChatMessage, ProviderChunk, StreamOptions } from "./base.js";

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
  stream: AsyncIterable<ProviderChunk>;
}

/** Heuristic: transient/transport failures are retryable; client/request errors are not. */
export function isRetryableProviderError(err: unknown): boolean {
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

async function* prepend(first: IteratorResult<ProviderChunk>, rest: AsyncIterator<ProviderChunk>): AsyncIterable<ProviderChunk> {
  if (!first.done) yield first.value;
  while (true) {
    const next = await rest.next();
    if (next.done) return;
    yield next.value;
  }
}

/**
 * Open a stream against the first candidate that can begin emitting; fall back to
 * the next on a retryable start error. The returned `stream` re-yields the first
 * chunk that was pulled to probe the candidate, so no output is lost.
 */
export async function openStreamWithFallback(
  candidates: FallbackCandidate[],
  messages: ChatMessage[],
  options: StreamOptions
): Promise<OpenStreamResult> {
  if (candidates.length === 0) throw new Error("No providers available to stream");
  const fellBackFrom: string[] = [];
  let lastError: unknown;

  for (const candidate of candidates) {
    if (options.abortSignal?.aborted) throw new Error("AbortError");
    try {
      const iterator = candidate.provider.streamChat(messages, options)[Symbol.asyncIterator]();
      const first = await iterator.next();
      // An error chunk at the very start counts as a start failure.
      if (!first.done && first.value.type === "error") {
        throw new Error(first.value.error?.message || "Model provider error");
      }
      return { servedBy: candidate.id, fellBackFrom, stream: prepend(first, iterator) };
    } catch (err) {
      if (options.abortSignal?.aborted) throw err;
      if (!isRetryableProviderError(err)) throw err;
      lastError = err;
      fellBackFrom.push(candidate.id);
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error");
  throw new Error(`All ${candidates.length} provider(s) failed; last error: ${detail}`);
}
