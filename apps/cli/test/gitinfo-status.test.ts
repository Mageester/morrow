import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { gitStatus } from "../src/cli/gitinfo.js";

const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8", shell: false });

describe("gitStatus (read-only categorized status)", () => {
  let dir: string;
  let hasGit = true;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "morrow-git-"));
    const init = git(dir, ["init", "-b", "main"]);
    if (init.status !== 0) { hasGit = false; return; }
    git(dir, ["config", "user.email", "t@t.dev"]);
    git(dir, ["config", "user.name", "t"]);
    writeFileSync(join(dir, "committed.txt"), "v1\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "init"]);
    // A staged new file, a modified tracked file, and an untracked file.
    writeFileSync(join(dir, "committed.txt"), "v2\n"); // modified (worktree)
    writeFileSync(join(dir, "staged.txt"), "new\n");
    git(dir, ["add", "staged.txt"]);
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "sub", "untracked.txt"), "u\n");
  });

  afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  it("reports branch and categorized files", () => {
    if (!hasGit) return; // skip where git is unavailable
    const s = gitStatus(dir);
    expect(s.isRepo).toBe(true);
    expect(s.branch).toBe("main");
    expect(s.staged).toContain("staged.txt");
    expect(s.modified).toContain("committed.txt");
    expect(s.untracked.some((p) => p.includes("untracked.txt"))).toBe(true);
  });

  it("returns isRepo false outside a work tree", () => {
    const outside = mkdtempSync(join(tmpdir(), "morrow-nogit-"));
    try {
      const s = gitStatus(outside);
      expect(s.isRepo).toBe(false);
      expect(s.branch).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
