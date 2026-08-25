import { afterEach, describe, expect, it, vi } from "vitest";
import { MorrowApi } from "../src/client/api.js";
import { BUILTIN_COMMANDS } from "../src/terminal/commands/index.js";

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
    expect(BUILTIN_COMMANDS.some((c: { name: string }) => c.name === "ps")).toBe(true);
  });
});

describe("/ps surfaces where a job is listening and what it printed", () => {
  const command = BUILTIN_COMMANDS.find((entry) => entry.name === "ps")!;

  const job = {
    id: "proc-abcdef123456",
    projectId: "p1",
    taskId: null,
    agentId: null,
    command: "pnpm",
    args: ["dev"],
    cwd: "/w",
    mode: "pipe" as const,
    pid: 4242,
    status: "running" as const,
    exitCode: null,
    detail: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    endpoints: [
      { url: "http://192.168.1.9:5173", host: "192.168.1.9", port: 5173, rewritten: false },
      { url: "http://localhost:5173", host: "localhost", port: 5173, rewritten: false },
    ],
  };

  function ctx(over: Record<string, unknown> = {}) {
    return { backend: { listProcesses: async () => [job], ...over } } as never;
  }

  it("prints the address that actually reaches the job", async () => {
    const result = await command.run({ sub: undefined, rest: "" } as never, ctx());
    const table = result.report!.blocks.find((block: any) => block.kind === "table") as any;
    // Loopback over the LAN address: a table row cannot ask the reader to know
    // which of their machine's IPs is the reachable one.
    expect(table.rows[0]).toContain("localhost:5173");
    expect(table.head).toContain("Address");
  });

  it("says nothing rather than guessing before a server announces itself", async () => {
    const quiet = { ...job, endpoints: [] };
    const result = await command.run({ sub: undefined, rest: "" } as never, ctx({ listProcesses: async () => [quiet] }));
    const table = result.report!.blocks.find((block: any) => block.kind === "table") as any;
    expect(table.rows[0]).toContain("—");
  });

  it("reads a job's output from the short id shown in the table", async () => {
    const reads: Array<{ id: string; stream?: string }> = [];
    const result = await command.run(
      { sub: "logs", rest: "proc-abc" } as never,
      ctx({
        readProcessOutput: async (id: string, opts: any) => {
          reads.push({ id, stream: opts?.stream });
          return { data: "VITE ready\nLocal: http://localhost:5173/\n", nextOffset: 41, eof: false, truncated: false };
        },
      }),
    );
    // The table truncates ids on purpose, so the prefix someone can actually
    // read off the screen has to be the thing that works.
    expect(reads).toEqual([{ id: "proc-abcdef123456", stream: "stdout" }]);
    expect(JSON.stringify(result.report!.blocks)).toContain("VITE ready");
  });

  it("reads stderr when asked, which is where plenty of servers report failure", async () => {
    const reads: string[] = [];
    await command.run(
      { sub: "logs", rest: "proc-abc stderr" } as never,
      ctx({
        readProcessOutput: async (_id: string, opts: any) => {
          reads.push(opts.stream);
          return { data: "EADDRINUSE :5173", nextOffset: 16, eof: true, truncated: false };
        },
      }),
    );
    expect(reads).toEqual(["stderr"]);
  });

  it("refuses an id that matches nothing instead of reading someone else's job", async () => {
    const result = await command.run(
      { sub: "logs", rest: "nope" } as never,
      ctx({ readProcessOutput: async () => { throw new Error("must not be called"); } }),
    );
    expect(result.notice).toMatchObject({ level: "warn" });
  });
});
