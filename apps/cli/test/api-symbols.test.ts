import { afterEach, describe, expect, it, vi } from "vitest";
import { MorrowApi } from "../src/client/api.js";

describe("MorrowApi symbols", () => {
  afterEach(() => vi.restoreAllMocks());

  function stubFetch(payload: unknown) {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: any) => {
        calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : null });
        return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
      })
    );
    return calls;
  }

  it("hits the symbol-index routes with the right shapes", async () => {
    const calls = stubFetch({ ok: true });
    const api = new MorrowApi("http://127.0.0.1:9999");

    await api.rebuildSymbols("p1");
    await api.refreshSymbols("p1");
    await api.symbolStatus("p1");
    await api.searchSymbols("p1", "add value", { limit: 10 });
    await api.symbolDefinition("p1", "Calculator.total");
    await api.fileSymbols("p1", "src/math.ts");

    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}${new URL(c.url).search}`)).toEqual([
      "POST /api/projects/p1/symbols/rebuild",
      "POST /api/projects/p1/symbols/refresh",
      "GET /api/projects/p1/symbols/status",
      "GET /api/projects/p1/symbols/search?q=add+value&limit=10",
      "GET /api/projects/p1/symbols/definition?name=Calculator.total",
      "GET /api/projects/p1/symbols/file?path=src%2Fmath.ts",
    ]);
  });
});
