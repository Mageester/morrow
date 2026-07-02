import { describe, expect, it } from "vitest";

import type { ChatMessage, ProviderChunk, StreamOptions } from "../src/provider/base.js";
import { openStreamWithFallback, type FallbackCandidate } from "../src/provider/fallback.js";
import { RateGuard, parseRetryAfter } from "../src/provider/rate-guard.js";

function makeClock(startMs = 0) {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("RateGuard", () => {
  it("is not limited until a rate-limit report arrives, and clears on success", () => {
    const clock = makeClock();
    const guard = new RateGuard(clock.now);
    expect(guard.isLimited("openai")).toBe(false);

    guard.reportRateLimit("openai");
    expect(guard.isLimited("openai")).toBe(true);
    expect(guard.remainingMs("openai")).toBe(2000);

    guard.reportSuccess("openai");
    expect(guard.isLimited("openai")).toBe(false);
    expect(guard.snapshot()).toEqual([]);
  });

  it("honors Retry-After over the exponential backoff", () => {
    const clock = makeClock();
    const guard = new RateGuard(clock.now);
    guard.reportRateLimit("anthropic", 45_000);
    expect(guard.remainingMs("anthropic")).toBe(45_000);
  });

  it("backs off exponentially on consecutive hits and caps at five minutes", () => {
    const clock = makeClock();
    const guard = new RateGuard(clock.now);
    guard.reportRateLimit("gemini"); // 2s
    expect(guard.remainingMs("gemini")).toBe(2_000);
    guard.reportRateLimit("gemini"); // 4s
    expect(guard.remainingMs("gemini")).toBe(4_000);
    for (let i = 0; i < 12; i++) guard.reportRateLimit("gemini");
    expect(guard.remainingMs("gemini")).toBe(300_000);
  });

  it("expires the cooldown as time passes", () => {
    const clock = makeClock();
    const guard = new RateGuard(clock.now);
    guard.reportRateLimit("openai", 10_000);
    clock.advance(9_999);
    expect(guard.isLimited("openai")).toBe(true);
    clock.advance(1);
    expect(guard.isLimited("openai")).toBe(false);
  });

  it("reports a snapshot per provider for observability", () => {
    const clock = makeClock();
    const guard = new RateGuard(clock.now);
    guard.reportRateLimit("a", 5_000);
    guard.reportRateLimit("b");
    guard.reportRateLimit("b");
    const snap = guard.snapshot().sort((x, y) => x.providerId.localeCompare(y.providerId));
    expect(snap).toEqual([
      { providerId: "a", limited: true, remainingMs: 5_000, consecutive: 1 },
      { providerId: "b", limited: true, remainingMs: 4_000, consecutive: 2 },
    ]);
  });
});

describe("parseRetryAfter", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfter("30")).toBe(30_000);
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("parses HTTP-date relative to now", () => {
    const now = Date.parse("2026-07-02T12:00:00Z");
    expect(parseRetryAfter("Thu, 02 Jul 2026 12:00:30 GMT", now)).toBe(30_000);
  });

  it("returns undefined for garbage, negatives, and past dates", () => {
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
    const now = Date.parse("2026-07-02T12:00:00Z");
    expect(parseRetryAfter("Thu, 02 Jul 2026 11:00:00 GMT", now)).toBeUndefined();
  });
});

// --- fallback integration ---------------------------------------------------

function textProvider(text: string) {
  return {
    async *streamChat(_m: ChatMessage[], _o: StreamOptions): AsyncIterable<ProviderChunk> {
      yield { type: "text", text };
      yield { type: "done" };
    },
  };
}

function rateLimitedProvider(retryAfterMs?: number) {
  return {
    async *streamChat(): AsyncIterable<ProviderChunk> {
      yield {
        type: "error",
        error: {
          type: "rate_limit",
          kind: "rate_limit" as const,
          message: "429 Too Many Requests",
          retryable: true,
          status: 429,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        },
      };
    },
  };
}

async function collectText(stream: AsyncIterable<ProviderChunk>): Promise<string> {
  let out = "";
  for await (const chunk of stream) {
    if (chunk.type === "text" && chunk.text) out += chunk.text;
  }
  return out;
}

describe("openStreamWithFallback + RateGuard", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "hi" }];

  it("records a rate-limit hit (with Retry-After) and falls back to the next candidate", async () => {
    const clock = makeClock();
    const guard = new RateGuard(clock.now);
    const candidates: FallbackCandidate[] = [
      { id: "primary", provider: rateLimitedProvider(45_000) },
      { id: "secondary", provider: textProvider("ok") },
    ];

    const res = await openStreamWithFallback(candidates, messages, {}, guard);
    expect(res.servedBy).toBe("secondary");
    expect(res.fellBackFrom).toEqual(["primary"]);
    expect(await collectText(res.stream)).toBe("ok");
    expect(guard.isLimited("primary")).toBe(true);
    expect(guard.remainingMs("primary")).toBe(45_000);
    expect(guard.isLimited("secondary")).toBe(false);
  });

  it("deprioritizes a cooling-down provider on the next turn", async () => {
    const clock = makeClock();
    const guard = new RateGuard(clock.now);
    guard.reportRateLimit("primary", 60_000);

    const order: string[] = [];
    const tracking = (id: string, inner: { streamChat: (...a: any[]) => AsyncIterable<ProviderChunk> }) => ({
      streamChat(m: ChatMessage[], o: StreamOptions) {
        order.push(id);
        return inner.streamChat(m, o);
      },
    });

    const candidates: FallbackCandidate[] = [
      { id: "primary", provider: tracking("primary", textProvider("from primary")) },
      { id: "secondary", provider: tracking("secondary", textProvider("from secondary")) },
    ];

    const res = await openStreamWithFallback(candidates, messages, {}, guard);
    expect(order).toEqual(["secondary"]);
    expect(res.servedBy).toBe("secondary");
    expect(res.deprioritizedRateLimited).toEqual(["primary"]);
  });

  it("still tries a rate-limited provider when it is the only candidate", async () => {
    const clock = makeClock();
    const guard = new RateGuard(clock.now);
    guard.reportRateLimit("only", 60_000);

    const candidates: FallbackCandidate[] = [{ id: "only", provider: textProvider("served anyway") }];
    const res = await openStreamWithFallback(candidates, messages, {}, guard);
    expect(res.servedBy).toBe("only");
    expect(res.deprioritizedRateLimited).toEqual(["only"]);
    expect(await collectText(res.stream)).toBe("served anyway");
    // A successful open clears the cooldown.
    expect(guard.isLimited("only")).toBe(false);
  });

  it("does not treat auth failures as rate limits", async () => {
    const clock = makeClock();
    const guard = new RateGuard(clock.now);
    const authFailing = {
      async *streamChat(): AsyncIterable<ProviderChunk> {
        yield {
          type: "error" as const,
          error: { type: "auth_error", kind: "auth" as const, message: "invalid api key", retryable: false, status: 401 },
        };
      },
    };
    await expect(
      openStreamWithFallback([{ id: "p", provider: authFailing }], messages, {}, guard)
    ).rejects.toMatchObject({ kind: "auth" });
    expect(guard.isLimited("p")).toBe(false);
  });

  it("summarizes the last error when every candidate is rate-limited", async () => {
    const clock = makeClock();
    const guard = new RateGuard(clock.now);
    await expect(
      openStreamWithFallback([{ id: "p", provider: rateLimitedProvider(1_000) }], messages, {}, guard)
    ).rejects.toThrow(/All 1 provider\(s\) failed.*429/);
    // The guard learned about the hit even though the turn failed.
    expect(guard.isLimited("p")).toBe(true);
    expect(guard.remainingMs("p")).toBe(1_000);
  });
});
