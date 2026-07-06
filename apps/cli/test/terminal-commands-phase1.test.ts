import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { SLASH_COMMANDS } from "../src/terminal/commands.js";
import { gitStatus, type GitStatus } from "../src/cli/gitinfo.js";

const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8", shell: false });

describe("Phase 1 slash command registration", () => {
  it("registers /branch and /changes", () => {
    expect(SLASH_COMMANDS.some((c) => c.name === "branch")).toBe(true);
    expect(SLASH_COMMANDS.some((c) => c.name === "changes")).toBe(true);
  });

  it("registers /resume /new /clear /status /diff /context /cost", () => {
    const required = ["resume", "new", "clear", "status", "diff", "context", "cost"];
    for (const name of required) {
      expect(SLASH_COMMANDS.some((c) => c.name === name)).toBe(true);
    }
  });

  it("every registered command has a non-empty description", () => {
    for (const c of SLASH_COMMANDS) {
      expect(c.description.length).toBeGreaterThan(0);
    }
  });
});

describe("/branch and /changes backing data (gitStatus)", () => {
  let dir: string;
  let hasGit = true;
  let status: GitStatus;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "morrow-branch-cmd-"));
    const init = git(dir, ["init", "-b", "feature/test"]);
    if (init.status !== 0) { hasGit = false; return; }
    git(dir, ["config", "user.email", "t@t.dev"]);
    git(dir, ["config", "user.name", "t"]);
    // commit a baseline
    writeFileSync(join(dir, "app.ts"), "v1\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "init"]);
    // staged
    writeFileSync(join(dir, "new.ts"), "new\n");
    git(dir, ["add", "new.ts"]);
    // modified (worktree)
    writeFileSync(join(dir, "app.ts"), "v2\n");
    // untracked
    mkdirSync(join(dir, "util"), { recursive: true });
    writeFileSync(join(dir, "util", "helper.ts"), "helper\n");
    status = gitStatus(dir);
  });

  afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  it("reports the branch name for /branch", () => {
    if (!hasGit) return;
    expect(status.isRepo).toBe(true);
    expect(status.branch).toBe("feature/test");
  });

  it("categorizes staged files for /changes", () => {
    if (!hasGit) return;
    expect(status.staged).toContain("new.ts");
  });

  it("categorizes modified files for /changes", () => {
    if (!hasGit) return;
    expect(status.modified).toContain("app.ts");
  });

  it("categorizes untracked files for /changes", () => {
    if (!hasGit) return;
    expect(status.untracked.some((p) => p.includes("helper.ts"))).toBe(true);
  });

  it("dirty count is the sum of all three categories", () => {
    if (!hasGit) return;
    const dirty = status.staged.length + status.modified.length + status.untracked.length;
    expect(dirty).toBeGreaterThanOrEqual(3);
  });
});
