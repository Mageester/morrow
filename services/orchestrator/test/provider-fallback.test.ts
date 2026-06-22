import { describe, it, expect } from "vitest";
import { openStreamWithFallback, isRetryableProviderError, type FallbackCandidate } from "../src/provider/fallback.js";
import type { AiProvider, ProviderChunk } from "../src/provider/base.js";

/** A provider that streams the given chunks, or throws at stream start. */
function fakeProvider(behavior: { chunks?: ProviderChunk[]; throwAtStart?: Error; errorChunk?: string }): AiProvider {
  return {
    async *streamChat(): AsyncIterable<ProviderChunk> {
      if (behavior.throwAtStart) throw behavior.throwAtStart;
      if (behavior.errorChunk) {
        yield { type: "error", error: { message: behavior.errorChunk } } as ProviderChunk;
        return;
      }
      for (const c of behavior.chunks ?? []) yield c;
    },
  } as unknown as AiProvider;
}

async function collect(stream: AsyncIterable<ProviderChunk>): Promise<ProviderChunk[]> {
  const out: ProviderChunk[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

describe("isRetryableProviderError", () => {
  it("treats transport, timeout, rate-limit, and 5xx as retryable", () => {
    for (const m of ["ECONNREFUSED", "request timed out", "429 Too Many Requests", "503 Service Unavailable", "fetch failed", "model overloaded"]) {
      expect(isRetryableProviderError(new Error(m))).toBe(true);
    }
  });
  it("treats client/request errors and cancellation as fatal", () => {
    for (const m of ["400 Bad Request", "invalid tool schema", "AbortError", "operation cancelled", "401 Unauthorized"]) {
      expect(isRetryableProviderError(new Error(m))).toBe(false);
    }
  });
});

describe("openStreamWithFallback", () => {
  const text = (t: string): ProviderChunk => ({ type: "text", text: t }) as ProviderChunk;

  it("falls back to the next candidate when the first throws a retryable error", async () => {
    const candidates: FallbackCandidate[] = [
      { id: "primary", provider: fakeProvider({ throwAtStart: new Error("ECONNREFUSED") }) },
      { id: "secondary", provider: fakeProvider({ chunks: [text("hi"), { type: "done" } as ProviderChunk] }) },
    ];
    const res = await openStreamWithFallback(candidates, [], {});
    expect(res.servedBy).toBe("secondary");
    expect(res.fellBackFrom).toEqual(["primary"]);
    const chunks = await collect(res.stream);
    expect(chunks[0]).toMatchObject({ type: "text", text: "hi" });
  });

  it("does not lose the probed first chunk", async () => {
    const candidates: FallbackCandidate[] = [
      { id: "p", provider: fakeProvider({ chunks: [text("a"), text("b"), { type: "done" } as ProviderChunk] }) },
    ];
    const res = await openStreamWithFallback(candidates, [], {});
    expect(res.servedBy).toBe("p");
    expect(res.fellBackFrom).toEqual([]);
    const chunks = await collect(res.stream);
    expect(chunks.filter((c) => c.type === "text").map((c: any) => c.text)).toEqual(["a", "b"]);
  });

  it("falls back when the first candidate yields an error chunk at the start", async () => {
    const candidates: FallbackCandidate[] = [
      { id: "primary", provider: fakeProvider({ errorChunk: "503 unavailable" }) },
      { id: "secondary", provider: fakeProvider({ chunks: [text("ok"), { type: "done" } as ProviderChunk] }) },
    ];
    const res = await openStreamWithFallback(candidates, [], {});
    expect(res.servedBy).toBe("secondary");
  });

  it("does not fall back on a fatal (non-retryable) error", async () => {
    const candidates: FallbackCandidate[] = [
      { id: "primary", provider: fakeProvider({ throwAtStart: new Error("400 Bad Request") }) },
      { id: "secondary", provider: fakeProvider({ chunks: [text("unused")] }) },
    ];
    await expect(openStreamWithFallback(candidates, [], {})).rejects.toThrow(/bad request/i);
  });

  it("throws an aggregated error when every candidate fails", async () => {
    const candidates: FallbackCandidate[] = [
      { id: "a", provider: fakeProvider({ throwAtStart: new Error("timeout") }) },
      { id: "b", provider: fakeProvider({ throwAtStart: new Error("ECONNRESET") }) },
    ];
    await expect(openStreamWithFallback(candidates, [], {})).rejects.toThrow(/provider\(s\) failed/i);
  });

  it("respects a pre-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const candidates: FallbackCandidate[] = [{ id: "a", provider: fakeProvider({ chunks: [text("x")] }) }];
    await expect(openStreamWithFallback(candidates, [], { abortSignal: controller.signal })).rejects.toThrow(/abort/i);
  });
});
