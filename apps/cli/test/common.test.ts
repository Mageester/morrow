import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { resolveProject, validateProjectDirectory } from "../src/commands/common.js";

describe("resolveProject", () => {
  const tempDirs: string[] = [];
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("uses the current registered workspace instead of a stale default", async () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-cli-project-"));
    const projectA = join(root, "project-a");
    const projectB = join(root, "project-b");
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    tempDirs.push(root);
    process.chdir(projectB);

    const stale = { id: "p1", name: "project-a", workspacePath: projectA };
    const current = { id: "p2", name: "project-b", workspacePath: projectB };
    const api = {
      listProjects: vi.fn().mockResolvedValue([stale, current]),
      createProject: vi.fn(),
    };
    const ctx = {
      flags: {},
      config: { get: () => "p1" },
      out: { info: vi.fn() },
    } as any;

    await expect(resolveProject(ctx, api as any, { required: true, autoCreateMissing: true })).resolves.toEqual(current);
    expect(api.createProject).not.toHaveBeenCalled();
  });

  it("does not silently auto-register an arbitrary current directory", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "morrow-cli-project-"));
    tempDirs.push(cwd);
    process.chdir(cwd);
    const api = {
      listProjects: vi.fn().mockResolvedValue([]),
      createProject: vi.fn(),
    };
    const ctx = {
      flags: {},
      config: { get: () => undefined },
      out: { info: vi.fn() },
    } as any;

    await expect(resolveProject(ctx, api as any, { required: true, autoCreateMissing: true })).rejects.toThrow("No safe project selected");
    expect(api.createProject).not.toHaveBeenCalled();
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

  it("uses explicit --project even when cwd matches another project", async () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-cli-project-"));
    const projectA = join(root, "project-a");
    const projectB = join(root, "project-b");
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    tempDirs.push(root);
    process.chdir(projectB);

    const explicit = { id: "p1", name: "project-a", workspacePath: projectA };
    const current = { id: "p2", name: "project-b", workspacePath: projectB };
    const api = { listProjects: vi.fn().mockResolvedValue([explicit, current]), createProject: vi.fn() };
    const ctx = { flags: { project: "p1" }, config: { get: () => "p2" }, out: { info: vi.fn() } } as any;

    await expect(resolveProject(ctx, api as any, { required: true })).resolves.toEqual(explicit);
  });

  it("resolves a registered Git root from a nested current directory", async () => {
    const repo = mkdtempSync(join(tmpdir(), "morrow-cli-project-"));
    const nested = join(repo, "src", "feature");
    mkdirSync(join(repo, ".git"));
    mkdirSync(nested, { recursive: true });
    tempDirs.push(repo);
    process.chdir(nested);

    const project = { id: "p1", name: "repo", workspacePath: repo };
    const api = { listProjects: vi.fn().mockResolvedValue([project]), createProject: vi.fn() };
    const ctx = { flags: {}, config: { get: () => undefined }, out: { info: vi.fn() } } as any;

    await expect(resolveProject(ctx, api as any, { required: true })).resolves.toEqual(project);
  });

  it("refuses the real home directory by default", () => {
    expect(() => validateProjectDirectory(homedir())).toThrow("Refusing to use unsafe workspace");
  });
});
