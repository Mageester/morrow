import { describe, expect, it } from "vitest";
import { ProviderError } from "../src/provider/base.js";
import {
  CONTEXT_REJECTION_ATTEMPTS,
  MAX_SINGLE_BACKOFF_MS,
  MAX_TOTAL_BACKOFF_MS,
  RATE_LIMIT_ATTEMPTS,
  TRANSPORT_ATTEMPTS,
  classifyProviderFault,
  decideProviderRetry,
  sleepUnlessAborted,
} from "../src/execution/provider-backoff.js";

/**
 * Retry pacing.
 *
 * The defect these cover: Morrow parsed `Retry-After` off a 429, carried it
 * through the error, wrote it into the durable event — and then retried
 * immediately, twice, and failed the task. A rate limit is a queue signal, not
 * a defect, and it was ending runs in under a second for anyone using a single
 * API key.
 */

const rateLimit = (retryAfterMs?: number) =>
  new ProviderError("rate_limit", "Too Many Requests", {
    kind: "rate_limit",
    retryable: true,
    status: 429,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });

const fresh = { attemptsUsed: 0, totalBackoffMs: 0 };

describe("classifying what would actually fix a provider failure", () => {
  it("separates a rate limit from a transport fault", () => {
    expect(classifyProviderFault(rateLimit(), true, false)).toBe("rate_limit");
    expect(classifyProviderFault(new ProviderError("network", "connection reset", { kind: "network", retryable: true }), true, false)).toBe("transport");
  });

  it("recognises a rate limit that only says so in its message", () => {
    // Compatible gateways tunnel upstream 429s through their own envelopes.
    expect(classifyProviderFault(new Error("upstream returned 429 rate limit exceeded"), true, false)).toBe("rate_limit");
  });

  it("keeps a context rejection distinct from a transient fault", () => {
    expect(classifyProviderFault(new Error("context too large"), true, true)).toBe("context_rejection");
  });

  it("never retries something retrying cannot fix", () => {
    const authError = new ProviderError("auth_error", "Unauthorized", { kind: "auth", retryable: false, status: 401 });
    expect(classifyProviderFault(authError, false, false)).toBe("fatal");
    expect(decideProviderRetry({ error: authError, isRetryable: false, isContextRejection: false, state: fresh }).retry).toBe(false);
  });
});

describe("a rate limit is paced, not spun", () => {
  it("waits exactly as long as the provider asked", () => {
    const decision = decideProviderRetry({
      error: rateLimit(30_000),
      isRetryable: true,
      isContextRejection: false,
      state: fresh,
    });
    expect(decision.retry).toBe(true);
    expect(decision.delayMs).toBe(30_000);
    expect(decision.reason).toContain("30s");
  });

  it("prefers the provider's stated window over its own schedule", () => {
    // Retry-After is better information than any guess, and ignoring it is how
    // a client earns a longer ban.
    const decision = decideProviderRetry({
      error: rateLimit(45_000),
      isRetryable: true,
      isContextRejection: false,
      state: { attemptsUsed: 0, totalBackoffMs: 0 },
      guardRemainingMs: 2_000,
    });
    expect(decision.delayMs).toBe(45_000);
  });

  it("backs off on a rising schedule when no window is stated", () => {
    const delays = [0, 1, 2, 3].map((attemptsUsed) =>
      decideProviderRetry({
        error: rateLimit(),
        isRetryable: true,
        isContextRejection: false,
        state: { attemptsUsed, totalBackoffMs: 0 },
      }).delayMs);
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000]);
  });

  it("never waits longer than a single-wait ceiling", () => {
    // A wait must stay well under the 5-minute execution lease, or a paced
    // retry would look like an abandoned worker and be taken over.
    const decision = decideProviderRetry({
      error: rateLimit(3_600_000),
      isRetryable: true,
      isContextRejection: false,
      state: fresh,
    });
    expect(decision.delayMs).toBe(MAX_SINGLE_BACKOFF_MS);
  });

  it("is more patient with a rate limit than with a blind transport fault", () => {
    // A 429 is self-clearing and usually timed; a reset is neither.
    expect(RATE_LIMIT_ATTEMPTS).toBeGreaterThan(TRANSPORT_ATTEMPTS);
    const exhausted = decideProviderRetry({
      error: rateLimit(),
      isRetryable: true,
      isContextRejection: false,
      state: { attemptsUsed: RATE_LIMIT_ATTEMPTS, totalBackoffMs: 0 },
    });
    expect(exhausted.retry).toBe(false);
    expect(exhausted.reason).toContain("rate limit");
  });
});

describe("bounded, so a wedged provider still ends the task", () => {
  it("stops once the transient-fault time budget is spent", () => {
    const decision = decideProviderRetry({
      error: rateLimit(),
      isRetryable: true,
      isContextRejection: false,
      state: { attemptsUsed: 1, totalBackoffMs: MAX_TOTAL_BACKOFF_MS },
    });
    expect(decision.retry).toBe(false);
    expect(decision.reason).toContain("without the provider recovering");
  });

  it("never overshoots the remaining budget with one long sleep", () => {
    const decision = decideProviderRetry({
      error: rateLimit(60_000),
      isRetryable: true,
      isContextRejection: false,
      state: { attemptsUsed: 0, totalBackoffMs: MAX_TOTAL_BACKOFF_MS - 5_000 },
    });
    expect(decision.delayMs).toBe(5_000);
  });

  it("gives up on a transport fault after its own bounded attempts", () => {
    const decision = decideProviderRetry({
      error: new ProviderError("network", "reset", { kind: "network", retryable: true }),
      isRetryable: true,
      isContextRejection: false,
      state: { attemptsUsed: TRANSPORT_ATTEMPTS, totalBackoffMs: 0 },
    });
    expect(decision.retry).toBe(false);
  });
});

describe("a context rejection is recompacted, not waited out", () => {
  it("retries immediately, because waiting does not shrink the request", () => {
    const decision = decideProviderRetry({
      error: new Error("context too large"),
      isRetryable: true,
      isContextRejection: true,
      state: fresh,
    });
    expect(decision.retry).toBe(true);
    expect(decision.delayMs).toBe(0);
  });

  it("keeps its original bound, so a third identical attempt is not a loop", () => {
    const decision = decideProviderRetry({
      error: new Error("context too large"),
      isRetryable: true,
      isContextRejection: true,
      state: { attemptsUsed: CONTEXT_REJECTION_ATTEMPTS, totalBackoffMs: 0 },
    });
    expect(decision.retry).toBe(false);
  });
});

describe("waiting stays cancellable", () => {
  it("returns immediately when the task is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    await sleepUnlessAborted(30_000, controller.signal);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("stops waiting the moment the task is cancelled", async () => {
    // Someone who asks to stop should not sit through a rate limit they no
    // longer care about.
    const controller = new AbortController();
    const started = Date.now();
    const waiting = sleepUnlessAborted(30_000, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await waiting;
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
