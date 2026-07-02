import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/service/lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, ensureRunning: vi.fn() };
});

import { Output } from "../src/cli/output.js";
import { worktreesCommand } from "../src/commands/worktrees.js";

describe("morrow worktrees command", () => {
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

  it("lists worktrees with operational association fields", async () => {
    const api = {
      listProjects: vi.fn(async () => [{ id: "p1", name: "P1", workspacePath: "C:/repo" }]),
      listWorktrees: vi.fn(async () => [
        {
          id: "worktree-123456",
          projectId: "p1",
          taskId: "task-abcdef",
          agentId: "agent-xyz987",
          branch: "morrow/feature-x",
          path: "C:/repo/.morrow/worktrees/feature-x",
          baseRef: "abc",
          status: "active",
          detail: null,
          createdAt: "2026-07-02T12:00:00.000Z",
          removedAt: null,
        },
      ]),
    };

    await expect(worktreesCommand(ctx(api, { status: "active" }), "list", [])).resolves.toBe(0);

    expect(api.listWorktrees).toHaveBeenCalledWith("p1", "active");
    const output = printed.join("");
    expect(output).toContain("morrow/feature-x");
    expect(output).toContain("task-ab");
    expect(output).toContain("agent-x");
  });
});
