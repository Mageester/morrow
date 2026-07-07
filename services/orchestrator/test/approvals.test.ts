import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/database.js";
import { approvalsRepository } from "../src/repositories/approvals.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { canonicalCommandTrustKey } from "../src/tools/command-policy.js";
import { clampApprovalSummary, MAX_APPROVAL_SUMMARY } from "../src/repositories/approvals.js";

describe("approvals", () => {
  const createdAt = "2026-06-21T00:00:00.000Z";

  function seed(db: Database.Database) {
    projectRepository(db).createProject({ id: "project", name: "Project", workspacePath: "C:/workspace", createdAt });
    taskRepository(db).createTask({ id: "task", projectId: "project", kind: "agent_chat", status: "queued", createdAt });
  }

  it("clamps an over-long summary instead of crashing schema validation", () => {
    const db = openDatabase(":memory:");
    seed(db);
    const approvals = approvalsRepository(db);
    // A long command line (e.g. a big `npm install …` argv) exceeds the 240-char
    // schema cap; before the clamp this threw ZodError and crashed the whole run.
    const longSummary = "Run command: npm " + "install some-really-long-package-name ".repeat(20);
    expect(longSummary.length).toBeGreaterThan(MAX_APPROVAL_SUMMARY);
    let created!: ReturnType<typeof approvals.create>;
    expect(() => {
      created = approvals.create({
        id: "long-approval",
        taskId: "task",
        projectId: "project",
        kind: "command",
        summary: longSummary,
        details: {},
        createdAt,
      });
    }).not.toThrow();
    expect(created.summary.length).toBeLessThanOrEqual(MAX_APPROVAL_SUMMARY);
    expect(created.summary.endsWith("…")).toBe(true);
    // The persisted row also round-trips back through schema validation.
    expect(approvals.get("long-approval")!.summary).toBe(created.summary);
    db.close();
  });

  it("clampApprovalSummary leaves short summaries untouched", () => {
    expect(clampApprovalSummary("pnpm test")).toBe("pnpm test");
    expect(clampApprovalSummary("x".repeat(MAX_APPROVAL_SUMMARY))).toHaveLength(MAX_APPROVAL_SUMMARY);
    expect(clampApprovalSummary("x".repeat(MAX_APPROVAL_SUMMARY + 50))).toHaveLength(MAX_APPROVAL_SUMMARY);
  });

  it("persists one-time approval decisions and revocable project trust", () => {
    const db = openDatabase(":memory:");
    seed(db);
    const approvals = approvalsRepository(db);
    const pending = approvals.create({
      id: "approval",
      taskId: "task",
      projectId: "project",
      kind: "command",
      summary: "pnpm test",
      details: { command: "pnpm test", risk: "test" },
      createdAt,
    });

    expect(pending.status).toBe("pending");
    expect(approvals.listByTask("task")).toEqual([pending]);
    expect(approvals.resolve("approval", { decision: "allow_once", resolvedAt: createdAt })?.status).toBe("approved");
    expect(approvals.grantCommandTrust({ projectId: "project", pattern: "pnpm test", createdAt })).toMatchObject({ projectId: "project", pattern: "pnpm test" });
    expect(approvals.listCommandTrusts("project")).toHaveLength(1);
    expect(approvals.revokeCommandTrust("project", "pnpm test")).toBe(true);
    expect(approvals.listCommandTrusts("project")).toHaveLength(0);

    db.close();
  });

  describe("approval API", () => {
    let db: Database.Database;
    let app: ReturnType<typeof buildServer>;

    beforeEach(async () => {
      db = openDatabase(":memory:");
      seed(db);
      app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
      await app.ready();
    });

    afterEach(async () => {
      await app.close();
      db.close();
    });

    it("resolves approvals only for their project and records exact, server-derived project trust", async () => {
      projectRepository(db).createProject({ id: "other", name: "Other", workspacePath: "C:/other", createdAt });
      approvalsRepository(db).create({
        id: "approval",
        taskId: "task",
        projectId: "project",
        kind: "command",
        summary: "pnpm test",
        details: { executable: "pnpm", args: ["test"], cwd: "", risk: "approval_required", pattern: "pnpm test" },
        createdAt,
      });

      // The trust binding is derived from the persisted approval, not the
      // client-supplied pattern, and is bound to the exact (exe, argv, cwd).
      const exactKey = canonicalCommandTrustKey("pnpm", ["test"], "");

      expect((await app.inject({ method: "GET", url: "/api/projects/project/approvals" })).json()).toHaveLength(1);
      const denied = await app.inject({ method: "POST", url: "/api/approvals/approval/resolve", payload: { projectId: "other", decision: "deny" } });
      expect(denied.statusCode).toBe(404);

      const resolved = await app.inject({
        method: "POST",
        url: "/api/approvals/approval/resolve",
        payload: { projectId: "project", decision: "trust_project", trustPattern: "pnpm test" },
      });
      expect(resolved.statusCode).toBe(200);
      expect(resolved.json()).toMatchObject({ status: "approved", decision: "trust_project" });
      // Stored trust is the exact canonical key, NOT the broad "pnpm test".
      expect((await app.inject({ method: "GET", url: "/api/projects/project/command-trusts" })).json()).toMatchObject([{ pattern: exactKey }]);
      expect((await app.inject({ method: "GET", url: "/api/tasks/task" })).json().approvals).toMatchObject([{ id: "approval", status: "approved" }]);
      expect(taskRecordsRepository(db).listEvents("task").at(-1)).toMatchObject({ type: "approval.resolved", payload: { approvalId: "approval", decision: "trust_project" } });
      expect((await app.inject({ method: "DELETE", url: "/api/projects/project/command-trusts", payload: { pattern: exactKey } })).statusCode).toBe(204);
      expect((await app.inject({ method: "GET", url: "/api/projects/project/command-trusts" })).json()).toEqual([]);
    });

    it("refuses to trust a non-command approval", async () => {
      approvalsRepository(db).create({
        id: "patch-approval",
        taskId: "task",
        projectId: "project",
        kind: "change_set",
        summary: "apply patch",
        details: { diffHash: "abc", files: ["a.ts"] },
        createdAt,
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/approvals/patch-approval/resolve",
        payload: { projectId: "project", decision: "trust_project", trustPattern: "anything" },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
