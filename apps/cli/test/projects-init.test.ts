import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

vi.mock("../src/service/lifecycle.js", () => ({ ensureRunning: vi.fn() }));

import { initCommand } from "../src/commands/projects.js";

describe("morrow init", () => {
  const tempDirs: string[] = [];
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("registers the current Git repository root and activates it", async () => {
    const repo = mkdtempSync(join(tmpdir(), "morrow-init-project-"));
    tempDirs.push(repo);
    const git = spawnSync("git", ["init"], { cwd: repo, encoding: "utf8", shell: false });
    expect(git.status).toBe(0);
    const nested = join(repo, "src", "feature");
    mkdirSync(nested, { recursive: true });
    process.chdir(nested);

    const project = { id: "repo-id", name: repo.split(/[\\/]/).pop()!, workspacePath: repo, createdAt: new Date().toISOString() };
    const api = { createProject: vi.fn().mockResolvedValue(project) };
    const config = { set: vi.fn() };
    const out = { success: vi.fn(), info: vi.fn(), json: false, data: vi.fn() };
    const ctx = { api: () => api, flags: {}, config, paths: { projectConfigFile: null }, out } as any;

    await expect(initCommand(ctx, [])).resolves.toBe(0);

    expect(api.createProject).toHaveBeenCalledWith(project.name, repo);
    expect(config.set).toHaveBeenCalledWith("defaults.project", "repo-id", "user");
    expect(out.info).toHaveBeenCalledWith(`Workspace: ${repo}`);
    expect(out.info).toHaveBeenCalledWith(expect.stringMatching(/^Git: (?!—)/));
  });
});
