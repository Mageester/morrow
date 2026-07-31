import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../src/config/config.js";
import { Context } from "../src/cli/context.js";
import { Output } from "../src/cli/output.js";
import { EXIT } from "../src/cli/errors.js";

vi.mock("../src/service/lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, ensureRunning: vi.fn(), isRunning: vi.fn().mockResolvedValue(true) };
});

vi.mock("../src/commands/mission.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, runMission: vi.fn().mockResolvedValue(0) };
});

import { runMission } from "../src/commands/mission.js";
import { buildCommand, directoryHasContents, slugForProject } from "../src/commands/build.js";

describe("morrow build", () => {
  const tempRoots: string[] = [];
  let ctx: Context;
  let workdir: string;
  let createProject: any;
  let baseHome: string;

  /** Build a Context with the given flags; Context.flags is readonly. */
  const withFlags = (flags: Record<string, unknown>): Context => {
    const config = ConfigStore.load({ MORROW_HOME: baseHome }, baseHome);
    const c = new Context({ out: new Output({ json: false, quiet: false, color: false }), config, paths: config.paths, flags: flags as any });
    c.api = () => ({ createProject }) as any;
    return c;
  };

  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const home = mkdtempSync(join(tmpdir(), "morrow-build-home-"));
    baseHome = home;
    workdir = mkdtempSync(join(tmpdir(), "morrow-build-cwd-"));
    tempRoots.push(home, workdir);
    vi.spyOn(process, "cwd").mockReturnValue(workdir);

    const config = ConfigStore.load({ MORROW_HOME: home }, home);
    ctx = new Context({ out: new Output({ json: false, quiet: false, color: false }), config, paths: config.paths, flags: {} });

    // resetAllMocks() in afterEach clears implementations, so the shared
    // mission mock is re-armed for every test rather than only the first.
    vi.mocked(runMission).mockResolvedValue(0);
    createProject = vi.fn(async (name: string, path: string) => ({ id: "new-project", name, workspacePath: path }));
    ctx.api = () => ({ createProject }) as any;
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  describe("naming", () => {
    it("derives a short, safe directory name from the description", () => {
      expect(slugForProject("a CLI todo app in TypeScript with tests")).toBe("a-cli-todo-app-in");
      expect(slugForProject("Invoice Generator!!!")).toBe("invoice-generator");
    });

    it("never produces a name that could escape the parent directory", () => {
      for (const input of ["../../etc/passwd", "..", "/absolute/path", "a/b\\c"]) {
        const slug = slugForProject(input);
        expect(slug).not.toContain("/");
        expect(slug).not.toContain("\\");
        expect(slug).not.toContain("..");
        expect(slug.length).toBeGreaterThan(0);
      }
    });

    it("falls back to a default when a description has no usable characters", () => {
      expect(slugForProject("!!!")).toBe("morrow-project");
    });
  });

  describe("directory safety", () => {
    it("detects existing contents", () => {
      const empty = join(workdir, "empty");
      mkdirSync(empty);
      expect(directoryHasContents(empty)).toBe(false);
      expect(directoryHasContents(join(workdir, "missing"))).toBe(false);
      writeFileSync(join(empty, "file.txt"), "x");
      expect(directoryHasContents(empty)).toBe(true);
    });

    /**
     * An autonomous build must never be aimed at a directory that already holds
     * work it could overwrite. This is the guard that makes autonomy-by-default
     * defensible for this command.
     */
    it("refuses to build into a directory that already has contents", async () => {
      const occupied = join(workdir, "occupied");
      mkdirSync(occupied);
      writeFileSync(join(occupied, "important.ts"), "export const keepMe = 1;");

      await expect(buildCommand(withFlags({ in: occupied }), ["a todo app"])).rejects.toThrow(/already has contents/);
      expect(createProject).not.toHaveBeenCalled();
      expect(runMission).not.toHaveBeenCalled();
      // The pre-existing file is untouched.
      expect(existsSync(join(occupied, "important.ts"))).toBe(true);
    });

    it("allows an occupied directory only with an explicit --force", async () => {
      const occupied = join(workdir, "occupied2");
      mkdirSync(occupied);
      writeFileSync(join(occupied, "file.txt"), "x");

      const code = await buildCommand(withFlags({ in: occupied, force: true }), ["a todo app"]);
      expect(code).toBe(EXIT.OK);
      expect(createProject).toHaveBeenCalled();
    });

    it("refuses a workspace root that is too broad to scope autonomy to", async () => {
      await expect(buildCommand(withFlags({ in: homedir() }), ["a todo app"])).rejects.toThrow(/Refusing to build/);
      expect(createProject).not.toHaveBeenCalled();
    });
  });

  describe("project creation", () => {
    it("creates the directory, registers it, and runs the mission there", async () => {
      const code = await buildCommand(ctx, ["a CLI todo app"]);

      expect(code).toBe(EXIT.OK);
      const expected = join(workdir, "a-cli-todo-app");
      expect(existsSync(expected)).toBe(true);
      expect(createProject).toHaveBeenCalledWith("a-cli-todo-app", expected);
      expect(runMission).toHaveBeenCalledTimes(1);
      // The objective handed to the engine is the user's own description.
      expect(vi.mocked(runMission).mock.calls[0]![2]).toBe("a CLI todo app");
    });

    it("scopes the mission to the new project rather than a saved default", async () => {
      ctx.config.set("defaults.project", "some-old-project", "user");
      await buildCommand(ctx, ["a todo app"]);

      const missionCtx = vi.mocked(runMission).mock.calls[0]![0] as Context;
      expect(missionCtx.flags.project).toBe("new-project");
    });

    it("builds autonomously by default, and steps back on --no-yolo", async () => {
      await buildCommand(ctx, ["a todo app"]);
      expect((vi.mocked(runMission).mock.calls[0]![0] as Context).flags.yolo).toBe(true);

      vi.mocked(runMission).mockClear();
      await buildCommand(withFlags({ "no-yolo": true }), ["another app"]);
      expect((vi.mocked(runMission).mock.calls[0]![0] as Context).flags.yolo).toBeUndefined();
    });

    it("honours an explicit --name and --in", async () => {
      const where = join(workdir, "custom-location");
      await buildCommand(withFlags({ name: "invoicer", in: where }), ["an invoice generator"]);
      expect(createProject).toHaveBeenCalledWith("invoicer", where);
    });

    it("shows usage instead of guessing when given no description", async () => {
      const code = await buildCommand(ctx, []);
      expect(code).toBe(EXIT.USAGE);
      expect(createProject).not.toHaveBeenCalled();
    });
  });
});
