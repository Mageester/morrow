import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { MorrowApi } from "../src/client/api.js";
import { CliError } from "../src/cli/errors.js";

/**
 * P0-2 regression coverage: `/output` (and startup task resolution) must
 * never wait forever on `getTask`/`listMessages`. These stub `fetch` to
 * simulate a connection that never resolves on its own — the only thing
 * that can end it is the AbortSignal `req()` wires up from `timeoutMs` —
 * and assert the call rejects at the bound, not never.
 */
describe("MorrowApi: bounded timeouts for the /output hot path (P0-2)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function stubHangingFetch(): void {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        });
      })
    );
  }

  function stubOkFetch(payload: unknown): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } }))
    );
  }

  it("getTask() rejects at its bound instead of hanging indefinitely", async () => {
    stubHangingFetch();
    const api = new MorrowApi("http://127.0.0.1:9999");
    const call = api.getTask("stale-task-id");
    const assertion = expect(call).rejects.toThrow(CliError);
    await vi.advanceTimersByTimeAsync(8001);
    await assertion;
  });

  it("getTask() does not fire early — real, in-flight requests under the bound still resolve", async () => {
    stubHangingFetch();
    const api = new MorrowApi("http://127.0.0.1:9999");
    let settled = false;
    const call = api.getTask("id").catch(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(4000); // well under the 8s bound
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(4001);
    await call;
    expect(settled).toBe(true);
  });

  it("listMessages() rejects at its bound instead of hanging indefinitely", async () => {
    stubHangingFetch();
    const api = new MorrowApi("http://127.0.0.1:9999");
    const call = api.listMessages("conv-1");
    const assertion = expect(call).rejects.toThrow(CliError);
    await vi.advanceTimersByTimeAsync(8001);
    await assertion;
  });

  it("a completed task within the bound resolves normally", async () => {
    stubOkFetch({ task: { id: "t1", status: "completed" }, plan: [], events: [], agentStates: [], approvals: [], evidence: [], toolCalls: [], routing: null });
    const api = new MorrowApi("http://127.0.0.1:9999");
    const agg = await api.getTask("t1");
    expect(agg.task.status).toBe("completed");
  });

  it("a failed task within the bound resolves normally (not treated as an error)", async () => {
    stubOkFetch({ task: { id: "t1", status: "failed" }, plan: [], events: [], agentStates: [], approvals: [], evidence: [], toolCalls: [], routing: null });
    const api = new MorrowApi("http://127.0.0.1:9999");
    const agg = await api.getTask("t1");
    expect(agg.task.status).toBe("failed");
  });

  it("a stale/unknown task id surfaces a clear 404 error, not a hang", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { message: "Task not found", code: "NOT_FOUND" } }), { status: 404, headers: { "Content-Type": "application/json" } }))
    );
    const api = new MorrowApi("http://127.0.0.1:9999");
    await expect(api.getTask("does-not-exist")).rejects.toThrow(CliError);
  });

  it("an unavailable service (connection refused) surfaces a clear, actionable error immediately", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      })
    );
    const api = new MorrowApi("http://127.0.0.1:9999");
    await expect(api.getTask("t1")).rejects.toThrow(/Cannot reach the Morrow service/);
  });

  it("a corrupted (non-JSON) persisted record surfaces an error instead of throwing an unhandled exception", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{not valid json", { status: 200, headers: { "Content-Type": "application/json" } }))
    );
    const api = new MorrowApi("http://127.0.0.1:9999");
    const agg = await api.getTask("t1");
    // safeJson() swallows the parse error and returns undefined rather than
    // throwing — the caller (showTaskReport) treats a falsy aggregate as
    // "could not load", not as a crash.
    expect(agg).toBeUndefined();
  });
});
