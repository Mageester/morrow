import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GitInspectionError, gitDiff, gitLog, gitStatus } from "../src/tools/git.js";

describe("safe git inspection", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "morrow-git-"));
    roots.push(root);
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("init");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Morrow Test");
    writeFileSync(join(root, "src.ts"), "export const value = 1;\n");
    git("add", "src.ts");
    git("commit", "-m", "initial source");
    writeFileSync(join(root, "src.ts"), "export const value = 2;\nconst token = 'should-redact';\n");
    writeFileSync(join(root, ".env"), "TOKEN=hidden\n");
    return root;
  }

  it("returns bounded redacted status, diff, and recent log without secret paths", async () => {
    const root = fixture();

    const status = await gitStatus(root);
    const diff = await gitDiff(root);
    const log = await gitLog(root);

    expect(status.lines.join("\n")).toContain("src.ts");
    expect(status.lines.join("\n")).not.toContain(".env");
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]).toMatchObject({ path: "src.ts" });
    expect(diff.files[0]?.diff).toContain("[REDACTED]");
    expect(log.commits[0]).toMatchObject({ subject: "initial source" });
  }, 15_000);

  it("rejects an already-cancelled inspection", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(gitStatus(fixture(), { signal: controller.signal })).rejects.toBeInstanceOf(GitInspectionError);
  });

  /**
   * Reported live: `git_status` failed at the end of a real `morrow build`
   * run, surfaced to the user as "Needs attention". The target directory was
   * never `git init`-ed — the ordinary state of a fresh build target, since
   * Morrow deliberately does not auto-init (the terminal UI already tells
   * the user "Run git init to enable change tracking" for this exact case).
   * `resolveGitScope` already detected "no repository" gracefully, but the
   * three inspection functions ran the real git command anyway, which exits
   * 128 outside any repository and was thrown as a tool failure. A condition
   * the rest of the product treats as normal should not read to the model,
   * or the user, as something broken.
   */
  describe("a directory that was never git-init-ed", () => {
    function uninitedFixture() {
      const root = mkdtempSync(join(tmpdir(), "morrow-git-no-repo-"));
      roots.push(root);
      writeFileSync(join(root, "index.html"), "<html></html>\n");
      return root;
    }

    it("returns an empty status instead of throwing", async () => {
      const status = await gitStatus(uninitedFixture());
      expect(status).toEqual({ lines: [], truncated: false, timedOut: false, repository: false });
    });

    it("returns an empty diff instead of throwing", async () => {
      const diff = await gitDiff(uninitedFixture());
      expect(diff).toEqual({ files: [], truncated: false, timedOut: false, repository: false });
    });

    it("returns an empty log instead of throwing", async () => {
      const log = await gitLog(uninitedFixture());
      expect(log).toEqual({ commits: [], truncated: false, timedOut: false, repository: false });
    });

    it("still reports repository: true for a real repository with no commits yet", async () => {
      const root = mkdtempSync(join(tmpdir(), "morrow-git-empty-repo-"));
      roots.push(root);
      execFileSync("git", ["-C", root, "init"], { encoding: "utf8" });
      const status = await gitStatus(root);
      expect(status.repository).toBe(true);
    });
  });
});
