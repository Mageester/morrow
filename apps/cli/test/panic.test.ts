import { describe, expect, it, vi } from "vitest";
import { cancelActiveTasks } from "../src/commands/panic.js";

describe("panic stop", () => {
  it("cancels only queued and running tasks across projects", async () => {
    const api = {
      listProjects: vi.fn().mockResolvedValue([{ id: "p1" }, { id: "p2" }]),
      listTasks: vi.fn().mockImplementation(async (projectId: string) => projectId === "p1"
        ? [{ id: "run", status: "running" }, { id: "done", status: "completed" }]
        : [{ id: "queued", status: "queued" }, { id: "failed", status: "failed" }]),
      cancelTask: vi.fn().mockResolvedValue(undefined),
    };
    await expect(cancelActiveTasks(api as any)).resolves.toEqual(["run", "queued"]);
    expect(api.cancelTask).toHaveBeenCalledTimes(2);
  });
});
