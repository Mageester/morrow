import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWorkspaceRepository } from "../src/commands/common.js";
import { Output } from "../src/cli/output.js";

const ctx = { out: new Output({ json: false, quiet: true, color: false }), flags: {} } as any;
const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

/**
 * Morrow adopts the current directory as a workspace and initializes a Git
 * repository so change tracking, checkpoints and rollback work. The freshness
 * check used to be `existsSync(".git")`, which only recognises a repository
 * ROOT — so any subdirectory of an existing checkout looked brand new and got
 * its own nested repository plus a starter .gitignore. A nested repository
 * shadows the real one for every Git command beneath it, which destroys the
 * change tracking this setup exists to provide.
 */
describe("adopting a directory inside an existing repository", () => {
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "morrow-nesting-"));
    git(root, "init");
    git(root, "config", "user.email", "t@example.com");
    git(root, "config", "user.name", "T");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("never creates a nested repository in a subdirectory of a checkout", () => {
    const nested = join(root, "packages", "cli");
    mkdirSync(nested, { recursive: true });

    ensureWorkspaceRepository(ctx, nested);

    expect(existsSync(join(nested, ".git")), "created a nested repository").toBe(false);
    expect(existsSync(join(nested, ".gitignore")), "wrote into an existing repository").toBe(false);
    expect(git(nested, "rev-parse", "--show-toplevel").stdout.trim()).toBe(git(root, "rev-parse", "--show-toplevel").stdout.trim());
  });

  it("leaves the repository root itself untouched", () => {
    ensureWorkspaceRepository(ctx, root);
    expect(existsSync(join(root, ".gitignore"))).toBe(false);
  });

  it("still initializes a genuinely fresh directory outside any repository", () => {
    const fresh = mkdtempSync(join(tmpdir(), "morrow-fresh-"));
    try {
      ensureWorkspaceRepository(ctx, fresh);
      expect(existsSync(join(fresh, ".git")), "did not initialize a fresh workspace").toBe(true);
      expect(existsSync(join(fresh, ".gitignore"))).toBe(true);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});
