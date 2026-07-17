import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveProject } from "../src/commands/common.js";
import { resolveConversation } from "../src/commands/chat.js";
import * as prompts from "../src/cli/prompts.js";
import type { Conversation, Project } from "@morrow/contracts";

// Cross-workspace confirmation/refusal (see resolveProject's docstring) is
// driven through ask/select in ../src/cli/prompts.js. Mocking that module
// (rather than commands/common.js, which merely re-exports it) is what makes
// resolveProject's internal calls to select/ask interceptable — same-module
// internal calls survive a vi.mock of their own module untouched.
vi.mock("../src/cli/prompts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli/prompts.js")>();
  return { ...actual, ask: vi.fn(), select: vi.fn() };
});

/**
 * P1-2 regression coverage, hardened after the beta29 advanced consumer
 * proof (PR #53) found that an unregistered cwd could fall back to a stale
 * "last used" project — a leftover PTY test harness workspace in one field
 * case — with only a `warn` line, never blocking. cwd is now authoritative:
 * the only automatic resolution is cwd matching a durable, registered
 * workspace (steps 1-2 below). Anything past that is either an explicit
 * choice a human made, or a refusal — never a silent guess. See
 * `resolveProject`'s own docstring in common.ts for the full precedence.
 */
describe("resolveProject: cwd-first precedence (P1-2)", () => {
  const tempDirs: string[] = [];
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function tempRepo(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    const git = spawnSync("git", ["init"], { cwd: dir, encoding: "utf8", shell: false });
    expect(git.status).toBe(0);
    return dir;
  }

  function project(id: string, workspacePath: string): Project {
    return { version: 1, id, name: id, workspacePath, createdAt: new Date().toISOString() } as Project;
  }

  function fakeCtx(opts: { flags?: Record<string, string | boolean>; defaultProjectId?: string; json?: boolean } = {}) {
    const warnCalls: string[] = [];
    const config = {
      get: (key: string) => (key === "defaults.project" ? opts.defaultProjectId : undefined),
    };
    const out = {
      json: opts.json ?? false,
      quiet: false,
      warn: (msg: string) => void warnCalls.push(msg),
      heading: (_msg: string) => {},
      info: (_msg: string) => {},
      gray: (s: string) => s,
      bold: (s: string) => s,
      cyan: (s: string) => s,
      diag: (_msg: string) => {},
    };
    const ctx = { flags: opts.flags ?? {}, config, out } as any;
    return { ctx, warnCalls };
  }

  function fakeApi(projects: Project[]) {
    return { listProjects: async () => projects } as any;
  }

  /** Runs `fn` with `process.stdin.isTTY` forced true, restoring it after —
   *  the only way `isInteractive()` reports true for a fake ctx that is
   *  otherwise not json/quiet. */
  async function withInteractiveTTY<T>(fn: () => Promise<T>): Promise<T> {
    const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      return await fn();
    } finally {
      if (original) Object.defineProperty(process.stdin, "isTTY", original);
      else delete (process.stdin as any).isTTY;
    }
  }

  it("launching inside project A after previously using project B selects A, not B", async () => {
    const repoA = tempRepo("morrow-projA-");
    const repoB = tempRepo("morrow-projB-");
    const a = project("a", repoA);
    const b = project("b", repoB);
    process.chdir(repoA);

    const { ctx, warnCalls } = fakeCtx({ defaultProjectId: "b" }); // "b" was used last
    const resolved = await resolveProject(ctx, fakeApi([a, b]));

    expect(resolved?.id).toBe("a");
    expect(warnCalls).toEqual([]); // no warning needed — cwd unambiguously maps to a real project
  });

  it("an explicit --project argument always wins, even over a matching cwd", async () => {
    const repoA = tempRepo("morrow-projA-");
    const repoB = tempRepo("morrow-projB-");
    const a = project("a", repoA);
    const b = project("b", repoB);
    process.chdir(repoA);

    const { ctx } = fakeCtx({ flags: { project: "b" } });
    const resolved = await resolveProject(ctx, fakeApi([a, b]));
    expect(resolved?.id).toBe("b");
  });

  it("a nested child workspace resolves to its containing registered project", async () => {
    const repo = tempRepo("morrow-parent-");
    const nested = join(repo, "packages", "app");
    mkdirSync(nested, { recursive: true });
    process.chdir(nested);

    const p = project("p1", repo);
    const { ctx } = fakeCtx({});
    const resolved = await resolveProject(ctx, fakeApi([p]));
    expect(resolved?.id).toBe("p1");
  });

  it("child and parent workspaces registered separately remain distinct — the deepest match wins", async () => {
    const parent = tempRepo("morrow-parent2-");
    const child = join(parent, "apps", "cli");
    mkdirSync(child, { recursive: true });
    process.chdir(child);

    const parentProject = project("parent", parent);
    const childProject = project("child", child);
    const { ctx } = fakeCtx({});
    const resolved = await resolveProject(ctx, fakeApi([parentProject, childProject]));
    expect(resolved?.id).toBe("child");
  });

  it("an unregistered cwd inside a parent Git repository resolves via the git root, not the stale default", async () => {
    const repo = tempRepo("morrow-gitroot-");
    const nested = join(repo, "src");
    mkdirSync(nested, { recursive: true });
    process.chdir(nested);

    const p = project("p1", repo);
    const stale = project("stale", tempRepo("morrow-stale-"));
    const { ctx } = fakeCtx({ defaultProjectId: "stale" });
    const resolved = await resolveProject(ctx, fakeApi([p, stale]));
    expect(resolved?.id).toBe("p1");
  });

  // ── Different workspace refusal ──────────────────────────────────────────
  // A genuinely unregistered cwd (no project, no git-root match) with a
  // configured default elsewhere is precisely "a previous task belongs to
  // another workspace" — this is the exact shape of the PR #53 field finding
  // (a leftover beta28 PTY-harness temp directory silently absorbing a
  // session launched from an unrelated disposable repo). It must never
  // resolve automatically again, in any form.

  it("a non-interactive session refuses outright instead of silently reusing the stale default", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "morrow-unregistered-")); // no git init: no git root either
    tempDirs.push(emptyDir);
    process.chdir(emptyDir);

    const stale = project("stale", tempRepo("morrow-stale2-"));
    const { ctx } = fakeCtx({ defaultProjectId: "stale" });
    let error: any;
    try {
      await resolveProject(ctx, fakeApi([stale]), { required: true });
      expect.unreachable("should have thrown");
    } catch (err) {
      error = err;
    }
    expect(error.message).toMatch(/isn't a registered Morrow project/);
    expect(error.hint).toContain("--project stale");
    expect(vi.mocked(prompts.select)).not.toHaveBeenCalled();
    expect(vi.mocked(prompts.ask)).not.toHaveBeenCalled();
  });

  it("--json mode also refuses (never silently attributes machine output to an unrelated project)", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "morrow-unregistered-json-"));
    tempDirs.push(emptyDir);
    process.chdir(emptyDir);

    const stale = project("stale", tempRepo("morrow-stale3-"));
    const { ctx } = fakeCtx({ defaultProjectId: "stale", json: true });
    await expect(resolveProject(ctx, fakeApi([stale]), { required: true })).rejects.toThrow(
      /isn't a registered Morrow project/
    );
  });

  it("a caller that tolerates no project (required: false) proceeds unscoped instead of the stale default", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "morrow-unregistered-optional-"));
    tempDirs.push(emptyDir);
    process.chdir(emptyDir);

    const stale = project("stale", tempRepo("morrow-stale-optional-"));
    const { ctx } = fakeCtx({ defaultProjectId: "stale" });
    const resolved = await resolveProject(ctx, fakeApi([stale])); // no opts => required defaults to false
    expect(resolved).toBeNull();
    expect(vi.mocked(prompts.select)).not.toHaveBeenCalled();
  });

  // ── Explicit resume override ─────────────────────────────────────────────

  it("--project always wins even when it matches neither cwd nor the stale default", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "morrow-unregistered-override-"));
    tempDirs.push(emptyDir);
    process.chdir(emptyDir);

    const explicit = project("explicit-target", tempRepo("morrow-explicit-"));
    const stale = project("stale", tempRepo("morrow-stale-override-"));
    const { ctx } = fakeCtx({ defaultProjectId: "stale", flags: { project: "explicit-target" } });
    const resolved = await resolveProject(ctx, fakeApi([explicit, stale]), { required: true });
    expect(resolved?.id).toBe("explicit-target");
    expect(vi.mocked(prompts.select)).not.toHaveBeenCalled();
  });

  // ── Interactive confirmation: explicit choices, never automatic ─────────

  it("interactively, choosing to resume the stale default anyway returns it", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "morrow-interactive-resume-"));
    tempDirs.push(emptyDir);
    process.chdir(emptyDir);

    const stale = project("stale", tempRepo("morrow-stale-interactive-"));
    const { ctx } = fakeCtx({ defaultProjectId: "stale" });
    vi.mocked(prompts.select).mockResolvedValueOnce(0); // first choice: "Resume ... anyway"

    const resolved = await withInteractiveTTY(() => resolveProject(ctx, fakeApi([stale]), { required: true }));
    expect(resolved?.id).toBe("stale");
    expect(vi.mocked(prompts.select)).toHaveBeenCalledTimes(1);
  });

  it("interactively, choosing to register this folder creates a fresh project instead of resuming the stale one", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "morrow-interactive-register-"));
    tempDirs.push(emptyDir);
    process.chdir(emptyDir);

    const stale = project("stale", tempRepo("morrow-stale-interactive2-"));
    const created = project("new-here", emptyDir);
    const { ctx } = fakeCtx({ defaultProjectId: "stale" });
    // stale is itself a "safe" project, so it appears as a recent option too.
    // Choices: [Resume anyway(0), Open an existing project(1), Register this folder(2),
    //           Initialize this folder(3), Continue without a project(4), Exit(5)]
    vi.mocked(prompts.select).mockResolvedValueOnce(2); // "Register this folder"
    const api = { listProjects: async () => [stale], createProject: vi.fn().mockResolvedValue(created) } as any;

    const resolved = await withInteractiveTTY(() => resolveProject(ctx, api, { required: true }));
    expect(resolved?.id).toBe("new-here");
    expect(api.createProject).toHaveBeenCalledTimes(1);
    expect(api.createProject.mock.calls[0][1]).toBe(emptyDir);
  });

  it("interactively, cancelling (Exit) refuses rather than defaulting to anything", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "morrow-interactive-cancel-"));
    tempDirs.push(emptyDir);
    process.chdir(emptyDir);

    const stale = project("stale", tempRepo("morrow-stale-interactive3-"));
    const { ctx } = fakeCtx({ defaultProjectId: "stale" });
    // Choices: [Resume anyway(0), Open an existing project(1), Register this folder(2),
    //           Initialize this folder(3), Continue without a project(4), Exit(5)]
    vi.mocked(prompts.select).mockResolvedValueOnce(5);

    await expect(withInteractiveTTY(() => resolveProject(ctx, fakeApi([stale]), { required: true }))).rejects.toThrow(
      /No project selected/
    );
  });

  // ── Nested Git repositories ──────────────────────────────────────────────

  it("an unregistered nested dir with its own unrelated inner .git still resolves to the registered ancestor", async () => {
    const parent = tempRepo("morrow-nested-inner-git-");
    const inner = join(parent, "scratch", "unrelated-clone");
    mkdirSync(inner, { recursive: true });
    const git = spawnSync("git", ["init"], { cwd: inner, encoding: "utf8", shell: false });
    expect(git.status).toBe(0);
    process.chdir(inner);

    const parentProject = project("parent", parent);
    const { ctx } = fakeCtx({});
    const resolved = await resolveProject(ctx, fakeApi([parentProject]), { required: true });
    expect(resolved?.id).toBe("parent");
  });

  it("an unregistered nested dir with no ancestor registration and no default hits refusal, not a silent match", async () => {
    const parent = tempRepo("morrow-nested-unregistered-");
    const inner = join(parent, "packages", "scratch");
    mkdirSync(inner, { recursive: true });
    process.chdir(inner);

    const unrelated = project("unrelated", tempRepo("morrow-unrelated-"));
    const { ctx } = fakeCtx({});
    await expect(resolveProject(ctx, fakeApi([unrelated]), { required: true })).rejects.toThrow(
      /No safe project selected/
    );
  });

  // ── Temporary directories ────────────────────────────────────────────────

  it("a fresh temp directory (the PR #53 field-bug shape) refuses rather than absorbing the stale default", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "morrow-beta28-pty-"));
    tempDirs.push(tempDir);
    process.chdir(tempDir);

    const stalePtyLeftover = project("stale-pty", tempRepo("morrow-stale-pty-"));
    const { ctx } = fakeCtx({ defaultProjectId: "stale-pty" });
    await expect(resolveProject(ctx, fakeApi([stalePtyLeftover]), { required: true })).rejects.toThrow(
      /isn't a registered Morrow project/
    );
  });

  // ── Moved repositories ───────────────────────────────────────────────────

  it("a project whose workspace directory was moved no longer silently matches its old registration", async () => {
    const originalPath = tempRepo("morrow-moved-original-");
    const movedProject = project("moved", originalPath);
    const newPath = join(tmpdir(), `morrow-moved-target-${Date.now()}`);
    renameSync(originalPath, newPath);
    tempDirs.push(newPath); // clean up the new location instead
    process.chdir(newPath);

    const { ctx } = fakeCtx({}); // no configured default: nothing else to fall back to
    await expect(resolveProject(ctx, fakeApi([movedProject]), { required: true })).rejects.toThrow(
      /No safe project selected/
    );
  });

  // ── Deleted repositories ─────────────────────────────────────────────────

  it("a configured default whose directory was deleted still hits the explicit gate, and says so", async () => {
    const deletedPath = tempRepo("morrow-deleted-");
    const deletedProject = project("deleted", deletedPath);
    rmSync(deletedPath, { recursive: true, force: true });
    tempDirs.splice(tempDirs.indexOf(deletedPath), 1); // already gone; don't try to remove it again

    const emptyDir = mkdtempSync(join(tmpdir(), "morrow-unregistered-deleted-"));
    tempDirs.push(emptyDir);
    process.chdir(emptyDir);

    const { ctx } = fakeCtx({ defaultProjectId: "deleted" });
    await expect(resolveProject(ctx, fakeApi([deletedProject]), { required: true })).rejects.toThrow(
      /no longer exists on disk/
    );
  });

  // ── Symlinked repositories ───────────────────────────────────────────────

  it("cwd reached through a symlink to a registered project's real directory still resolves to it", async () => {
    const realDir = tempRepo("morrow-symlink-target-");
    const linkPath = join(tmpdir(), `morrow-symlink-${Date.now()}`);
    try {
      symlinkSync(realDir, linkPath, "junction");
    } catch {
      return; // no privilege to create symlinks/junctions on this machine — skip rather than fail
    }
    tempDirs.push(linkPath);
    process.chdir(linkPath);

    const p = project("p1", realDir);
    const { ctx } = fakeCtx({});
    const resolved = await resolveProject(ctx, fakeApi([p]), { required: true });
    expect(resolved?.id).toBe("p1");
  });

  it("multiple registered projects at the same Git root is ambiguous and refuses rather than guessing", async () => {
    const repo = tempRepo("morrow-ambiguous-");
    const p1 = project("p1", repo);
    const p2 = project("p2", repo);
    process.chdir(repo);

    const { ctx } = fakeCtx({});
    await expect(resolveProject(ctx, fakeApi([p1, p2]))).rejects.toThrow(/Multiple registered projects/);
  });

  it("Windows path casing and separator variants resolve to the same project", async () => {
    if (process.platform !== "win32") return; // case-insensitivity is a win32-specific guarantee here
    const repo = tempRepo("morrow-casing-");
    const p = project("p1", repo.toUpperCase());
    process.chdir(repo.toLowerCase());

    const { ctx } = fakeCtx({});
    const resolved = await resolveProject(ctx, fakeApi([p]));
    expect(resolved?.id).toBe("p1");
  });
});

describe("resolveConversation: /resume must not cross project boundaries (P1-2)", () => {
  function fakeConversation(id: string, projectId: string): Conversation {
    return { version: 1, id, projectId, title: "t", archived: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  }

  function fakeCtx(flags: Record<string, string | boolean>) {
    return { flags, out: { gray: (s: string) => s } } as any;
  }

  it("resuming a conversation id that belongs to a different project is refused, not silently followed", async () => {
    const conv = fakeConversation("conv-1", "project-B");
    const api = { getConversation: async () => conv } as any;
    const ctx = fakeCtx({ resume: "conv-1" });

    await expect(resolveConversation(ctx, api, "project-A")).rejects.toThrow(/belongs to a different project/);
  });

  it("the refusal names the correct --project to resume it explicitly", async () => {
    const conv = fakeConversation("conv-1", "project-B");
    const api = { getConversation: async () => conv } as any;
    const ctx = fakeCtx({ resume: "conv-1" });

    try {
      await resolveConversation(ctx, api, "project-A");
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.hint).toContain("--project project-B");
    }
  });

  it("resuming a conversation id that DOES belong to the resolved project succeeds normally", async () => {
    const conv = fakeConversation("conv-1", "project-A");
    const api = { getConversation: async () => conv } as any;
    const ctx = fakeCtx({ resume: "conv-1" });

    await expect(resolveConversation(ctx, api, "project-A")).resolves.toBe(conv);
  });

  it("a stale/unknown conversation id surfaces a clear not-found error, not a hang or crash", async () => {
    const api = { getConversation: async () => { throw new Error("404"); } } as any;
    const ctx = fakeCtx({ resume: "does-not-exist" });
    await expect(resolveConversation(ctx, api, "project-A")).rejects.toThrow(/Conversation not found/);
  });
});
