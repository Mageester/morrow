import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { resolveProject } from "../src/commands/common.js";

describe("resolveProject", () => {
  const tempDirs: string[] = [];
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("reuses current workspace when it is already registered", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "morrow-cli-project-"));
    tempDirs.push(cwd);
    process.chdir(cwd);

    const project = { id: "p1", name: "workspace", workspacePath: cwd };
    const api = {
      listProjects: vi.fn().mockResolvedValue([project]),
      createProject: vi.fn(),
    };
    const ctx = {
      flags: {},
      config: { get: () => undefined },
      out: { info: vi.fn() },
    } as any;

    await expect(resolveProject(ctx, api as any, { required: true, autoCreateMissing: true })).resolves.toEqual(project);
    expect(api.createProject).not.toHaveBeenCalled();
  });

  it("auto-registers current workspace for chat-first entry", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "morrow-cli-project-"));
    tempDirs.push(cwd);
    process.chdir(cwd);

    const created = { id: "p2", name: basename(cwd), workspacePath: cwd };
    const api = {
      listProjects: vi.fn().mockResolvedValue([]),
      createProject: vi.fn().mockResolvedValue(created),
    };
    const ctx = {
      flags: {},
      config: { get: () => undefined },
      out: { info: vi.fn() },
    } as any;

    await expect(resolveProject(ctx, api as any, { required: true, autoCreateMissing: true })).resolves.toEqual(created);
    expect(api.createProject).toHaveBeenCalledWith(basename(cwd), cwd);
  });

  it("auto-registers explicit project paths when requested", async () => {
    const repo = mkdtempSync(join(tmpdir(), "morrow-cli-project-"));
    tempDirs.push(repo);
    writeFileSync(join(repo, "package.json"), "{}");

    const created = { id: "p3", name: basename(repo), workspacePath: repo };
    const api = {
      listProjects: vi.fn().mockResolvedValue([]),
      createProject: vi.fn().mockResolvedValue(created),
    };
    const ctx = {
      flags: { project: repo },
      config: { get: () => undefined },
      out: { info: vi.fn() },
    } as any;

    await expect(resolveProject(ctx, api as any, { required: true, autoCreateMissing: true })).resolves.toEqual(created);
    expect(api.createProject).toHaveBeenCalledWith(basename(repo), repo);
  });
});
