import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveProject } from "../src/commands/common.js";
import { resolveConversation } from "../src/commands/chat.js";
import type { Conversation, Project } from "@morrow/contracts";

/**
 * P1-2 regression coverage: launching Morrow inside a registered workspace
 * must select that exact workspace, never a stale "last used" project just
 * because it happens to be the configured default. See `resolveProject`'s
 * own docstring in common.ts for the precedence this enforces.
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
    const out = { json: opts.json ?? false, warn: (msg: string) => void warnCalls.push(msg) };
    const ctx = { flags: opts.flags ?? {}, config, out } as any;
    return { ctx, warnCalls };
  }

  function fakeApi(projects: Project[]) {
    return { listProjects: async () => projects } as any;
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

  it("a genuinely unregistered cwd (no project, no git-root match) falls back to the default — but WARNS, never silently", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "morrow-unregistered-")); // no git init: no git root either
    tempDirs.push(emptyDir);
    process.chdir(emptyDir);

    const stale = project("stale", tempRepo("morrow-stale2-"));
    const { ctx, warnCalls } = fakeCtx({ defaultProjectId: "stale" });
    const resolved = await resolveProject(ctx, fakeApi([stale]));

    expect(resolved?.id).toBe("stale");
    expect(warnCalls.length).toBe(1);
    expect(warnCalls[0]).toContain("isn't a registered Morrow project");
    expect(warnCalls[0]).toContain("stale");
  });

  it("the fallback warning is suppressed in --json mode (never pollutes machine output)", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "morrow-unregistered-json-"));
    tempDirs.push(emptyDir);
    process.chdir(emptyDir);

    const stale = project("stale", tempRepo("morrow-stale3-"));
    const { ctx, warnCalls } = fakeCtx({ defaultProjectId: "stale", json: true });
    await resolveProject(ctx, fakeApi([stale]));
    expect(warnCalls).toEqual([]);
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
