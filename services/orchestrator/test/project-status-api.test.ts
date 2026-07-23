import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";

describe("GET /api/projects/:projectId/status", () => {
  let db: any;
  let runner: TaskRunner;
  let app: any;
  let tempDir: string;
  const roots: string[] = [];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "morrow-status-api-"));
    db = openDatabase(join(tempDir, "morrow.db"));
    runner = new TaskRunner(db);
    app = buildServer({ db, runner });
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function createProject(workspacePath: string, name = "Test"): Promise<string> {
    const res = await app.inject({ method: "POST", url: "/api/projects", payload: { name, workspacePath } });
    expect(res.statusCode).toBe(200);
    return res.json().id as string;
  }

  it("reports an accessible non-Git workspace honestly, not a hard-coded default", async () => {
    const ws = mkdtempSync(join(tmpdir(), "morrow-status-plain-"));
    roots.push(ws);
    const projectId = await createProject(ws, "Plain folder");

    const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/status` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accessible: true, gitDetected: false, branch: null });
  });

  it("detects the real current branch of an arbitrary Git repository", async () => {
    const ws = mkdtempSync(join(tmpdir(), "morrow-status-git-"));
    roots.push(ws);
    const git = (...args: string[]) => execFileSync("git", ["-C", ws, ...args], { encoding: "utf8" });
    git("init", "-b", "feature/workspace-status");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Morrow Test");
    writeFileSync(join(ws, "file.txt"), "hello\n");
    git("add", "file.txt");
    git("commit", "-m", "initial");
    const projectId = await createProject(ws, "Git repo");

    const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/status` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      accessible: true,
      gitDetected: true,
      branch: "feature/workspace-status",
    });
  }, 15_000);

  it("reports a project whose folder has since disappeared as inaccessible instead of silently falling back", async () => {
    const ws = mkdtempSync(join(tmpdir(), "morrow-status-gone-"));
    const projectId = await createProject(ws, "Vanished folder");
    rmSync(ws, { recursive: true, force: true });

    const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/status` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accessible: false, gitDetected: false, branch: null });
  });

  it("404s for an unknown project instead of guessing a workspace", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects/unknown-project/status" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });
});
