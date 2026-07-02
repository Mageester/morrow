import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/service/lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, ensureRunning: vi.fn() };
});

import { Output } from "../src/cli/output.js";
import { integrationsCommand } from "../src/commands/integrations.js";

describe("morrow integrate command", () => {
  let printed: string[];

  beforeEach(() => {
    printed = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: any) => {
      printed.push(String(chunk));
      return true;
    }) as any);
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: any) => {
      printed.push(String(chunk));
      return true;
    }) as any);
  });

  afterEach(() => vi.restoreAllMocks());

  function ctx(api: Record<string, unknown>, flags: Record<string, string | boolean> = {}) {
    return {
      flags: { project: "p1", ...flags },
      out: new Output({ json: false, quiet: false, color: false }),
      config: { get: () => undefined },
      api: () => api,
    } as any;
  }

  it("checks a named worktree and prints the apply action for a clean attempt", async () => {
    const attempt = {
      id: "integration-123456",
      projectId: "p1",
      taskId: "task-1",
      agentId: null,
      worktreeId: "wt-1",
      sourceBranch: "morrow/feature-x",
      targetBranch: "main",
      sourceCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      targetCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      status: "clean",
      conflictedFiles: [],
      errorDetail: null,
      appliedCommit: null,
      createdAt: "2026-07-02T12:00:00.000Z",
      updatedAt: "2026-07-02T12:00:00.000Z",
      appliedAt: null,
      cancelledAt: null,
    };
    const api = {
      listProjects: vi.fn(async () => [{ id: "p1", name: "P1", workspacePath: "C:/repo" }]),
      listWorktrees: vi.fn(async () => [{ id: "wt-1", branch: "morrow/feature-x", status: "active" }]),
      checkIntegration: vi.fn(async () => attempt),
    };

    await expect(integrationsCommand(ctx(api, { target: "main" }), "check", ["feature-x"])).resolves.toBe(0);

    expect(api.checkIntegration).toHaveBeenCalledWith("wt-1", { targetBranch: "main" });
    const output = printed.join("");
    expect(output).toContain("Integration integrat");
    expect(output).toContain("morrow/feature-x");
    expect(output).toContain("morrow integrate apply integrat");
  });
});
