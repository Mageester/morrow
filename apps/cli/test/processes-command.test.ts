import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/service/lifecycle.js", () => ({ ensureRunning: vi.fn() }));

import { Output } from "../src/cli/output.js";
import { processesCommand } from "../src/commands/processes.js";

describe("morrow processes", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports a timeout and signal separately from the compatibility status", async () => {
    const printed: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
      printed.push(String(chunk));
      return true;
    }) as any);
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
      printed.push(String(chunk));
      return true;
    }) as any);

    const api = {
      listProjects: vi.fn(async () => [{
        id: "p1",
        name: "Fixture",
        workspacePath: process.cwd(),
        createdAt: new Date().toISOString(),
      }]),
      listProcesses: vi.fn(async () => []),
      getProcess: vi.fn(async () => ({
        id: "proc-timeout",
        projectId: "p1",
        taskId: "task-1",
        agentId: null,
        command: "node",
        args: ["server.js"],
        cwd: process.cwd(),
        mode: "pipe" as const,
        pid: null,
        status: "failed" as const,
        exitCode: null,
        terminationReason: "timeout" as const,
        signal: "SIGTERM",
        detail: "Process timed out after 100ms.",
        startedAt: "2026-08-25T10:00:00.000Z",
        endedAt: "2026-08-25T10:00:00.100Z",
      })),
    };
    const ctx = {
      flags: { project: "p1" },
      out: new Output({ json: false, quiet: false, color: false }),
      config: { get: () => undefined, merged: {} },
      paths: { defaultDbPath: ":memory:" },
      api: () => api,
    } as any;

    await expect(processesCommand(ctx, "show", ["proc-timeout"])).resolves.toBe(0);

    const output = printed.join("");
    expect(output).toContain("termination");
    expect(output).toContain("timeout");
    expect(output).toContain("signal");
    expect(output).toContain("SIGTERM");
  });
});
