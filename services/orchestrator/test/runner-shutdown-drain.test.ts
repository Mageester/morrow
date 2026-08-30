import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";

function seedTask(db: any, workspacePath: string, id: string) {
  const iso = new Date().toISOString();
  if (!projectRepository(db).getProjectById?.("p")) {
    try { projectRepository(db).createProject({ id: "p", name: "P", workspacePath, createdAt: iso }); } catch { /* already seeded */ }
  }
  taskRepository(db).createTask({ id, projectId: "p", kind: "agent_chat", status: "queued", createdAt: iso });
  taskRecordsRepository(db).transitionAgentState(id, { id: `s-${id}`, state: "idle", details: {}, createdAt: iso });
}

describe("TaskRunner shutdown drain", () => {
  let db: any;
  let ws: string;
  beforeEach(() => { ws = realpathSync(mkdtempSync(join(tmpdir(), "morrow-drain-"))); db = openDatabase(":memory:"); });
  afterEach(() => { try { db.close(); } catch {} rmSync(ws, { recursive: true, force: true }); });

  it("returns immediately when nothing is running", async () => {
    const runner = new TaskRunner(db, async () => {});
    await expect(runner.shutdown()).resolves.toEqual({ active: 0, drained: true });
  });

  it("aborts an in-flight turn and waits for it to settle", async () => {
    seedTask(db, ws, "t1");
    let sawAbort = false;
    let finished = false;
    const runner = new TaskRunner(db, async ({ abortSignal }) => {
      taskRecordsRepository(db).transitionTask("t1", "running", {
        id: "e-running", createdAt: new Date().toISOString(), payload: {},
      });
      await new Promise<void>((resolve) => {
        abortSignal?.addEventListener("abort", () => { sawAbort = true; resolve(); }, { once: true });
      });
      // The window a turn uses to persist its own interruption. The drain must
      // still be waiting here — this is the write that v0.8.0 could lose.
      await new Promise((resolve) => setTimeout(resolve, 20));
      taskRecordsRepository(db).transitionTask("t1", "interrupted", {
        id: "e-interrupt", createdAt: new Date().toISOString(), payload: { reason: "shutdown" },
      });
      finished = true;
    });
    runner.run("t1");
    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = await runner.shutdown();

    expect(sawAbort).toBe(true);
    expect(finished).toBe(true);
    expect(result).toEqual({ active: 1, drained: true });
    // The interruption is durable, so a restart can reconcile it.
    expect(taskRepository(db).getTaskById("t1")?.status).toBe("interrupted");
  });

  it("gives up on a non-responsive turn instead of hanging the process", async () => {
    seedTask(db, ws, "t1");
    let released: (() => void) | undefined;
    const runner = new TaskRunner(db, async () => {
      await new Promise<void>((resolve) => { released = resolve; });
    });
    runner.run("t1");
    await new Promise((resolve) => setTimeout(resolve, 10));

    const started = Date.now();
    const result = await runner.shutdown({ timeoutMs: 50 });
    const elapsed = Date.now() - started;

    expect(result).toEqual({ active: 1, drained: false });
    // Bounded: the caller continues to the remaining shutdown stages.
    expect(elapsed).toBeLessThan(1_000);
    released?.();
  });

  it("refuses new work once the drain has begun", async () => {
    seedTask(db, ws, "t1");
    seedTask(db, ws, "t2");
    let ran = 0;
    const runner = new TaskRunner(db, async () => { ran++; });
    await runner.shutdown();

    runner.run("t2");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(ran).toBe(0);
    // The task keeps its queued status so startup reconciliation reclaims it,
    // rather than being dispatched into a database that is about to close.
    expect(taskRepository(db).getTaskById("t2")?.status).toBe("queued");
  });

  it("drains several concurrent turns before returning", async () => {
    const ids = ["t1", "t2", "t3"];
    for (const id of ids) seedTask(db, ws, id);
    const settled: string[] = [];
    const runner = new TaskRunner(db, async ({ taskId, abortSignal }) => {
      await new Promise<void>((resolve) => {
        abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      settled.push(taskId);
    });
    for (const id of ids) runner.run(id);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = await runner.shutdown();

    expect(result).toEqual({ active: 3, drained: true });
    expect(settled.sort()).toEqual(ids);
  });
});
