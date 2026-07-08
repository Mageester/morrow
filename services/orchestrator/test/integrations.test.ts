import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { worktreesRepository } from "../src/repositories/worktrees.js";
import { WorktreeManager } from "../src/workspace/worktrees.js";

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@localhost", ...args], {
    shell: false,
    encoding: "utf8",
    windowsHide: true,
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "morrow-integrate-repo-"));
  git(dir, "init", "-b", "main");
  writeFileSync(join(dir, "app.ts"), "export const value = 1;\n", "utf8");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "initial");
  return dir;
}

// Each test here spawns ~10 real `git` subprocesses (init, add, commit,
// `git worktree add`, an isolated merge check, and a real apply/merge) plus a
// real Fastify server. That is inherently slow on Windows and OneDrive-backed
// temp dirs, and under the parallel `pnpm test` load (turbo runs the CLI suite
// and the real-provider mission benchmarks concurrently) the heaviest case
// exceeds vitest's 5s default even though it finishes in ~1s uncontended. This
// is real filesystem/Git integration work with bounded cleanup (afterEach
// removes every temp dir), not a production hang — every git call is status-
// checked and the server injects are bounded — so a generous ceiling is
// correct. 20s is well under any real deadlock, which would still fail promptly.
const INTEGRATION_TEST_TIMEOUT_MS = 20_000;

describe("integration attempts (real git)", () => {
  let db: any;
  let app: any;
  let ws: string;
  let home: string;
  let prevHome: string | undefined;
  let prevGitEnv: Record<string, string | undefined>;
  const cleanups: string[] = [];

  beforeEach(() => {
    // Simulate a machine with no git identity (like CI runners): without this,
    // a developer's global user.name/user.email masks merges that would fail
    // in CI with "Committer identity unknown" (exit 128).
    const noConfig = mkdtempSync(join(tmpdir(), "morrow-integrate-gitcfg-"));
    cleanups.push(noConfig);
    const emptyConfig = join(noConfig, "empty.gitconfig");
    writeFileSync(emptyConfig, "", "utf8");
    prevGitEnv = {
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
      EMAIL: process.env.EMAIL,
    };
    process.env.GIT_CONFIG_GLOBAL = emptyConfig;
    process.env.GIT_CONFIG_SYSTEM = emptyConfig;
    delete process.env.GIT_AUTHOR_NAME;
    delete process.env.GIT_AUTHOR_EMAIL;
    delete process.env.GIT_COMMITTER_NAME;
    delete process.env.GIT_COMMITTER_EMAIL;
    delete process.env.EMAIL;

    ws = makeRepo();
    home = mkdtempSync(join(tmpdir(), "morrow-integrate-home-"));
    cleanups.push(ws, home);
    prevHome = process.env.MORROW_HOME;
    process.env.MORROW_HOME = home;
    db = openDatabase(":memory:");
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: ws, createdAt: new Date().toISOString() });
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(prevGitEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (prevHome === undefined) delete process.env.MORROW_HOME; else process.env.MORROW_HOME = prevHome;
    app.close();
    db.close();
    cleanups.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  });

  function createWorktree(name: string) {
    return new WorktreeManager(worktreesRepository(db), join(home, "worktrees")).create({
      projectId: "p1",
      workspacePath: ws,
      name,
    });
  }

  it("checks and applies a clean worktree integration without deleting the source worktree", { timeout: INTEGRATION_TEST_TIMEOUT_MS }, async () => {
    const wt = createWorktree("clean-feature");
    writeFileSync(join(wt.path, "feature.ts"), "export const feature = true;\n", "utf8");
    git(wt.path, "add", "-A");
    git(wt.path, "commit", "-m", "add feature");

    const check = await app.inject({ method: "POST", url: `/api/worktrees/${wt.id}/integrations/check`, payload: { targetBranch: "main" } });
    expect(check.statusCode).toBe(201);
    expect(check.json()).toMatchObject({ status: "clean", worktreeId: wt.id, sourceBranch: "morrow/clean-feature", targetBranch: "main" });
    expect(check.json().conflictedFiles).toEqual([]);

    const apply = await app.inject({ method: "POST", url: `/api/integrations/${check.json().id}/apply` });
    expect(apply.statusCode).toBe(200);
    expect(apply.json().status).toBe("applied");
    expect(readFileSync(join(ws, "feature.ts"), "utf8")).toContain("feature = true");
    expect(existsSync(wt.path)).toBe(true);
  });

  it("surfaces task-associated integration attempts in task inspection", { timeout: INTEGRATION_TEST_TIMEOUT_MS }, async () => {
    const task = taskRepository(db).createTask({
      id: "task-1",
      projectId: "p1",
      kind: "agent_chat",
      status: "queued",
      createdAt: new Date().toISOString(),
    });
    const wt = new WorktreeManager(worktreesRepository(db), join(home, "worktrees")).create({
      projectId: "p1",
      workspacePath: ws,
      name: "task-feature",
      taskId: task.id,
    });
    writeFileSync(join(wt.path, "feature.ts"), "export const feature = true;\n", "utf8");
    git(wt.path, "add", "-A");
    git(wt.path, "commit", "-m", "add feature");

    const check = await app.inject({ method: "POST", url: `/api/worktrees/${wt.id}/integrations/check`, payload: { targetBranch: "main" } });
    expect(check.statusCode).toBe(201);
    const aggregate = await app.inject({ method: "GET", url: `/api/tasks/${task.id}` });
    expect(aggregate.json().integrations.map((x: any) => x.id)).toContain(check.json().id);
  });

  it("detects conflicts in an isolated dry run and leaves the target repository clean", { timeout: INTEGRATION_TEST_TIMEOUT_MS }, async () => {
    const wt = createWorktree("conflict-feature");
    writeFileSync(join(wt.path, "app.ts"), "export const value = 2;\n", "utf8");
    git(wt.path, "add", "-A");
    git(wt.path, "commit", "-m", "source edit");

    writeFileSync(join(ws, "app.ts"), "export const value = 3;\n", "utf8");
    git(ws, "add", "-A");
    git(ws, "commit", "-m", "target edit");

    const check = await app.inject({ method: "POST", url: `/api/worktrees/${wt.id}/integrations/check`, payload: { targetBranch: "main" } });
    expect(check.statusCode).toBe(201);
    expect(check.json()).toMatchObject({ status: "conflicted", worktreeId: wt.id });
    expect(check.json().conflictedFiles).toContain("app.ts");
    expect(git(ws, "status", "--porcelain")).toBe("");
    expect(existsSync(join(ws, ".git", "MERGE_HEAD"))).toBe(false);
  });

  it("records a failed check instead of integrating into a dirty target tree", { timeout: INTEGRATION_TEST_TIMEOUT_MS }, async () => {
    const wt = createWorktree("dirty-target");
    writeFileSync(join(wt.path, "feature.ts"), "export const feature = true;\n", "utf8");
    git(wt.path, "add", "-A");
    git(wt.path, "commit", "-m", "add feature");
    writeFileSync(join(ws, "uncommitted.txt"), "do not merge over me\n", "utf8");

    const check = await app.inject({ method: "POST", url: `/api/worktrees/${wt.id}/integrations/check`, payload: { targetBranch: "main" } });
    expect(check.statusCode).toBe(201);
    expect(check.json().status).toBe("failed");
    expect(check.json().errorDetail).toMatch(/target repository has uncommitted changes/i);
    expect(existsSync(join(ws, "feature.ts"))).toBe(false);
  });
});
