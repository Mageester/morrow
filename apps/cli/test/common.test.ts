import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { resolveProject, validateProjectDirectory, matchProjectByIdPrefix } from "../src/commands/common.js";

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

  it("uses the configured child workspace instead of an ancestor project when launched from the ancestor", async () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-cli-project-"));
    const ancestor = join(root, "ancestor");
    const child = join(ancestor, "Tests", "Invoice-Generator");
    mkdirSync(join(ancestor, ".git"), { recursive: true });
    mkdirSync(child, { recursive: true });
    tempDirs.push(root);
    process.chdir(ancestor);

    const parentProject = { id: "parent", name: "Morrow", workspacePath: ancestor };
    const childProject = { id: "child", name: "Invoice", workspacePath: child };
    const api = {
      listProjects: vi.fn().mockResolvedValue([parentProject, childProject]),
      createProject: vi.fn(),
    };
    const ctx = {
      flags: {},
      config: { get: (key: string) => key === "defaults.project" ? "child" : undefined },
      out: { info: vi.fn() },
    } as any;

    await expect(resolveProject(ctx, api as any, { required: true })).resolves.toEqual(childProject);
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

describe("matchProjectByIdPrefix", () => {
  const projects = [
    { id: "560fbc91-1111-4aaa-bbbb-cccccccccccc", name: "game", workspacePath: "/a" },
    { id: "f820e474-2222-4aaa-bbbb-cccccccccccc", name: "chat", workspacePath: "/b" },
    { id: "560fdd00-3333-4aaa-bbbb-cccccccccccc", name: "other", workspacePath: "/c" },
  ] as any;

  it("resolves the 8-char short id shown by `projects list`", () => {
    expect(matchProjectByIdPrefix(projects, "f820e474").project?.name).toBe("chat");
  });

  it("resolves a shorter unambiguous prefix", () => {
    expect(matchProjectByIdPrefix(projects, "f820").project?.name).toBe("chat");
  });

  it("reports ambiguity when a prefix matches several projects", () => {
    const r = matchProjectByIdPrefix(projects, "560f");
    expect(r.project).toBeUndefined();
    expect(r.ambiguous.map((p: any) => p.name).sort()).toEqual(["game", "other"]);
  });

  it("ignores non-id-looking refs so names never prefix-match ids", () => {
    expect(matchProjectByIdPrefix(projects, "ga").ambiguous).toEqual([]);
    expect(matchProjectByIdPrefix(projects, "game").project).toBeUndefined();
  });
});
