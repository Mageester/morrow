import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { worktreesRepository } from "../src/repositories/worktrees.js";
import { WorktreeManager, WorktreeError, isGitRepo } from "../src/workspace/worktrees.js";

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@localhost", ...args], {
    shell: false, encoding: "utf8", windowsHide: true,
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "morrow-wt-repo-"));
  git(dir, "init", "-b", "main");
  writeFileSync(join(dir, "app.ts"), "export const v = 1;\n", "utf8");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "initial");
  return dir;
}

describe("WorktreeManager (real git)", () => {
  let db: any;
  let repo: ReturnType<typeof worktreesRepository>;
  let manager: WorktreeManager;
  let ws: string;
  let root: string;
  const cleanups: string[] = [];

  beforeEach(() => {
    ws = makeRepo();
    root = mkdtempSync(join(tmpdir(), "morrow-wt-root-"));
    cleanups.push(ws, root);
    db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: ws, createdAt: new Date().toISOString() });
    repo = worktreesRepository(db);
    manager = new WorktreeManager(repo, root);
  });

  afterEach(() => {
    db.close();
    cleanups.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  });

  it("creates an isolated worktree on a fresh morrow/<name> branch", () => {
    const record = manager.create({ projectId: "p1", workspacePath: ws, name: "feature-x" });
    expect(record.branch).toBe("morrow/feature-x");
    expect(record.status).toBe("active");
    expect(existsSync(join(record.path, "app.ts"))).toBe(true);
    expect(isGitRepo(record.path)).toBe(true);
    // Base ref is pinned to a concrete commit.
    expect(record.baseRef).toMatch(/^[0-9a-f]{40}$/);

    // Same name again → conflict, both in the registry and against git.
    expect(() => manager.create({ projectId: "p1", workspacePath: ws, name: "feature-x" })).toThrow(WorktreeError);
  });

  it("rejects hostile names and non-repo workspaces", () => {
    expect(() => manager.create({ projectId: "p1", workspacePath: ws, name: "../escape" })).toThrow(/names may use/);
    const notRepo = mkdtempSync(join(tmpdir(), "morrow-wt-plain-"));
    cleanups.push(notRepo);
    expect(() => manager.create({ projectId: "p1", workspacePath: notRepo, name: "x" })).toThrow(/not a git repository/);
  });

  it("reports dirtiness and commits ahead of the pinned base", () => {
    const record = manager.create({ projectId: "p1", workspacePath: ws, name: "wt-status" });
    let report = manager.status(record.id);
    expect(report).toMatchObject({ exists: true, dirty: false, aheadCommits: [] });

    writeFileSync(join(record.path, "new.ts"), "export const n = 2;\n", "utf8");
    report = manager.status(record.id);
    expect(report.dirty).toBe(true);
    expect(report.dirtyFiles).toContain("new.ts");

    git(record.path, "add", "-A");
    git(record.path, "commit", "-m", "add new.ts");
    report = manager.status(record.id);
    expect(report.dirty).toBe(false);
    expect(report.aheadCommits).toHaveLength(1);
    expect(report.aheadCommits[0]!.subject).toBe("add new.ts");

    const { diff } = manager.diff(record.id);
    expect(diff).toContain("new.ts");
    expect(diff).toContain("+export const n = 2;");
  });

  it("refuses to remove a dirty worktree without preservation, preserves with it", () => {
    const record = manager.create({ projectId: "p1", workspacePath: ws, name: "wt-dirty" });
    writeFileSync(join(record.path, "wip.ts"), "// half-finished\n", "utf8");

    expect(() => manager.remove(record.id)).toThrow(/uncommitted changes/);
    expect(repo.get(record.id)!.status).toBe("active");
    expect(existsSync(record.path)).toBe(true);

    const { record: removed, preservedCommit } = manager.remove(record.id, { preserve: true });
    expect(removed.status).toBe("removed");
    expect(preservedCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(record.path)).toBe(false);

    // The branch retains the preserved work in the main repository.
    const show = git(ws, "show", "--stat", "morrow/wt-dirty");
    expect(show).toContain("wip.ts");
    expect(show).toContain("preserve uncommitted work");
  });

  it("removes a clean worktree and keeps the branch", () => {
    const record = manager.create({ projectId: "p1", workspacePath: ws, name: "wt-clean" });
    const { preservedCommit } = manager.remove(record.id);
    expect(preservedCommit).toBeNull();
    expect(repo.get(record.id)!.status).toBe("removed");
    expect(git(ws, "branch", "--list", "morrow/wt-clean").trim()).toContain("morrow/wt-clean");
  });

  it("reconciles a vanished worktree directory as abandoned", () => {
    const record = manager.create({ projectId: "p1", workspacePath: ws, name: "wt-gone" });
    rmSync(record.path, { recursive: true, force: true });
    const { abandoned } = manager.reconcile(() => ws);
    expect(abandoned).toBe(1);
    const row = repo.get(record.id)!;
    expect(row.status).toBe("abandoned");
    expect(row.detail).toMatch(/branch morrow\/wt-gone may still hold the work/);
  });
});

describe("worktree API + task assignment", () => {
  let db: any;
  let app: any;
  let ws: string;
  let root: string;
  let prevMock: string | undefined;
  let prevHome: string | undefined;
  const cleanups: string[] = [];

  beforeEach(() => {
    ws = makeRepo();
    root = mkdtempSync(join(tmpdir(), "morrow-wtapi-home-"));
    cleanups.push(ws, root);
    prevMock = process.env.MOCK_PROVIDER;
    prevHome = process.env.MORROW_HOME;
    process.env.MOCK_PROVIDER = "true";
    process.env.MORROW_HOME = root; // worktrees + process logs land in the temp home
    db = openDatabase(":memory:");
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: ws, createdAt: new Date().toISOString() });
  });

  afterEach(() => {
    if (prevMock === undefined) delete process.env.MOCK_PROVIDER; else process.env.MOCK_PROVIDER = prevMock;
    if (prevHome === undefined) delete process.env.MORROW_HOME; else process.env.MORROW_HOME = prevHome;
    app.close();
    db.close();
    cleanups.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  });

  it("full journey: create, inspect, diff, delete with preservation", async () => {
    const create = await app.inject({ method: "POST", url: "/api/projects/p1/worktrees", payload: { name: "api-wt" } });
    expect(create.statusCode).toBe(201);
    const wt = create.json();
    expect(wt.branch).toBe("morrow/api-wt");

    const dup = await app.inject({ method: "POST", url: "/api/projects/p1/worktrees", payload: { name: "api-wt" } });
    expect(dup.statusCode).toBe(409);

    writeFileSync(join(wt.path, "change.ts"), "export const c = 3;\n", "utf8");
    const status = await app.inject({ method: "GET", url: `/api/worktrees/${wt.id}` });
    expect(status.json()).toMatchObject({ exists: true, dirty: true });
    expect(status.json().dirtyFiles).toContain("change.ts");

    const del = await app.inject({ method: "DELETE", url: `/api/worktrees/${wt.id}` });
    expect(del.statusCode).toBe(409); // dirty without preserve

    const preserved = await app.inject({ method: "DELETE", url: `/api/worktrees/${wt.id}?preserve=true` });
    expect(preserved.statusCode).toBe(200);
    expect(preserved.json().preservedCommit).toMatch(/^[0-9a-f]{40}$/);

    const list = await app.inject({ method: "GET", url: "/api/projects/p1/worktrees?status=removed" });
    expect(list.json().map((w: any) => w.id)).toContain(wt.id);
  });

  it("agent-chat sends can be pinned to an active worktree; stale ones are refused", async () => {
    const conv = await app.inject({ method: "POST", url: "/api/projects/p1/conversations", payload: { title: "T" } });
    const conversationId = conv.json().id;

    const wt = (await app.inject({ method: "POST", url: "/api/projects/p1/worktrees", payload: { name: "task-wt" } })).json();
    const send = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages`,
      payload: { content: "work in the worktree", worktreeId: wt.id },
    });
    expect(send.statusCode).toBe(202);
    const taskId = send.json().task.id;
    expect((taskRepository(db).getTaskById(taskId) as any).worktreeId).toBe(wt.id);
    const aggregate = await app.inject({ method: "GET", url: `/api/tasks/${taskId}` });
    expect(aggregate.json().task.worktreeId).toBe(wt.id);

    // Unknown and removed worktrees are refused up front.
    const missing = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages`,
      payload: { content: "x", worktreeId: "nope" },
    });
    expect(missing.statusCode).toBe(404);

    await app.inject({ method: "DELETE", url: `/api/worktrees/${wt.id}?preserve=true` });
    const stale = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages`,
      payload: { content: "x", worktreeId: wt.id },
    });
    expect(stale.statusCode).toBe(409);
  });

  it("refuses to associate a worktree with a task from another project", async () => {
    const other = makeRepo();
    cleanups.push(other);
    projectRepository(db).createProject({ id: "p2", name: "P2", workspacePath: other, createdAt: new Date().toISOString() });
    const task = taskRepository(db).createTask({
      id: "other-task",
      projectId: "p2",
      kind: "agent_chat",
      status: "queued",
      createdAt: new Date().toISOString(),
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/projects/p1/worktrees",
      payload: { name: "wrong-project", taskId: task.id },
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.stringify(res.json())).toMatch(/Task not found in this project/);
  });
});
