import { afterEach, describe, expect, it, vi } from "vitest";
import { MorrowApi } from "../src/client/api.js";
import { SLASH_COMMANDS } from "../src/terminal/commands.js";

describe("MorrowApi processes", () => {
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

  it("hits the process routes with the right shapes", async () => {
    const calls = stubFetch({ ok: true });
    const api = new MorrowApi("http://127.0.0.1:9999");
    await api.startProcess("p1", { command: "node", args: ["-v"], timeoutMs: 5000 });
    await api.listProcesses("p1", "running");
    await api.getProcess("proc-1");
    await api.getProcessOutput("proc-1", { stream: "stderr", offset: 128, limit: 4096 });
    await api.terminateProcess("proc-1", true);

    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}${new URL(c.url).search}`)).toEqual([
      "POST /api/projects/p1/processes",
      "GET /api/projects/p1/processes?status=running",
      "GET /api/processes/proc-1",
      "GET /api/processes/proc-1/output?stream=stderr&offset=128&limit=4096",
      "POST /api/processes/proc-1/terminate",
    ]);
    expect(calls[0]!.body).toEqual({ command: "node", args: ["-v"], timeoutMs: 5000 });
    expect(calls[4]!.body).toEqual({ force: true });
  });

  it("registers /ps as a slash command", () => {
    expect(SLASH_COMMANDS.some((c) => c.name === "ps")).toBe(true);
  });
});
