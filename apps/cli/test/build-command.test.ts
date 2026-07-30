import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "@morrow/contracts";
import { classify } from "../../../installer/templates/dispatch.mjs";
import { COMMANDS, resolveInvocation } from "../src/main.js";
import { parseArgs } from "../src/cli/args.js";
import { resolveProject, resolveWorkspaceScope } from "../src/commands/common.js";

/**
 * Regression coverage for the packaged `morrow build` dead-end.
 *
 * Reproduced against packaged 0.1.0-beta.34:
 *
 *   morrow build "Build a task tracker" --in <fresh dir> --provider … --yolo
 *   → ✖ No safe project selected.   (exit 2)
 *
 * Two independent defects produced that: `build` was missing from the CLI
 * command registry, so `resolveInvocation` classified the whole invocation as
 * a chat *prompt*; and `--in` was not a flag anywhere in the CLI, so the
 * target directory was silently discarded and project resolution fell back to
 * the current directory. Both are asserted here at the exact boundary the
 * packaged launcher crosses.
 */
describe("morrow build: packaged command routing", () => {
  it("classifies `build` as a command, not a chat prompt", () => {
    expect(resolveInvocation(["build", "Build a task tracker"])).toEqual({
      kind: "command",
      root: "build",
      sub: "Build a task tracker",
      args: [],
    });
  });

  it("registers build in the command set the launcher parity test iterates", () => {
    expect(COMMANDS.has("build")).toBe(true);
  });

  it("is delegated to the bundled CLI by the packaged Windows launcher", () => {
    const result = classify(["build", "Build a task tracker", "--in", "./app"]);
    expect(result.action).toBe("cli");
    expect(result.command).toBe("build");
    expect(result.args).toEqual(["Build a task tracker", "--in", "./app"]);
  });

  it("keeps the objective intact when it collides with a mission subcommand word", () => {
    // `mission list` is a subcommand; `build list …` is an objective. Build has
    // no subcommands, so the whole tail is the objective.
    const invocation = resolveInvocation(["build", "list", "every", "invoice"]);
    expect(invocation).toEqual({ kind: "command", root: "build", sub: "list", args: ["every", "invoice"] });
  });
});

describe("morrow build: global flag parsing", () => {
  const VALUE_FLAGS = ["project", "in", "provider", "model", "preset", "name"];

  it("parses --in, --name, --provider, --model and --yolo together", () => {
    const parsed = parseArgs(
      ["build", "Build a task tracker", "--in", "C:/tmp/taskflow", "--name", "taskflow", "--provider", "anthropic", "--model", "claude-opus-5", "--yolo"],
      { valueFlags: VALUE_FLAGS },
    );
    expect(parsed.positionals).toEqual(["build", "Build a task tracker"]);
    expect(parsed.flags).toMatchObject({
      in: "C:/tmp/taskflow",
      name: "taskflow",
      provider: "anthropic",
      model: "claude-opus-5",
      yolo: true,
    });
  });

  it("accepts --in=<dir> as well as --in <dir>", () => {
    const parsed = parseArgs(["build", "x", "--in=./taskflow"], { valueFlags: VALUE_FLAGS });
    expect(parsed.flags.in).toBe("./taskflow");
  });

  it("keeps --in a value flag so a following token is never swallowed as a boolean", () => {
    // Without `in` in valueFlags, `--in --json` degrades to `in: true` and the
    // build silently runs against the wrong workspace.
    const parsed = parseArgs(["build", "x", "--in", "--json"], { valueFlags: VALUE_FLAGS });
    expect(parsed.flags.in).toBe("--json");
  });
});

describe("morrow build: --in workspace scoping", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "morrow-build-in-"));
    tempDirs.push(dir);
    return dir;
  }

  function fakeCtx(flags: Record<string, string | boolean> = {}) {
    const messages: string[] = [];
    const out = {
      json: false,
      gray: (value: string) => value,
      diag: (value: string) => void messages.push(value),
      info: (value: string) => void messages.push(value),
      warn: (value: string) => void messages.push(value),
    };
    return { ctx: { flags, out, config: { get: () => undefined } } as any, messages };
  }

  function fakeApi(projects: Project[]) {
    const created: Array<{ name: string; workspacePath: string }> = [];
    const api = {
      listProjects: async () => projects,
      createProject: async (name: string, workspacePath: string) => {
        created.push({ name, workspacePath });
        const project = { version: 1, id: `p-${created.length}`, name, workspacePath, createdAt: new Date().toISOString() } as Project;
        projects.push(project);
        return project;
      },
    } as any;
    return { api, created };
  }

  it("creates a directory that does not exist yet and registers it as the project", async () => {
    const target = join(tempRoot(), "taskflow");
    expect(existsSync(target)).toBe(false);
    const { ctx } = fakeCtx({ in: target });
    const { api, created } = fakeApi([]);

    const project = await resolveWorkspaceScope(ctx, api, target);

    expect(existsSync(target)).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]!.name).toBe("taskflow");
    expect(project.workspacePath.toLowerCase()).toContain("taskflow");
  });

  it("makes a fresh build workspace reviewable: git repository plus starter ignore rules", async () => {
    const target = join(tempRoot(), "taskflow");
    const { ctx } = fakeCtx({ in: target });
    const { api } = fakeApi([]);

    await resolveWorkspaceScope(ctx, api, target);

    // Without a repository, `candidateFiles` reports no changes at all and the
    // Guardian reviews a mission that wrote an application against an empty
    // change set.
    expect(existsSync(join(target, ".git"))).toBe(true);
    const ignore = readFileSync(join(target, ".gitignore"), "utf8");
    // Written before any dependency install, so node_modules never enters the
    // mission's change set in the first place.
    expect(ignore).toContain("node_modules/");
    expect(ignore).toContain("dist/");
    expect(ignore).toContain(".env");
  });

  it("never overwrites an existing .gitignore or re-initializes an existing repository", async () => {
    const root = tempRoot();
    writeFileSync(join(root, ".gitignore"), "# mine\nsecrets.txt\n", "utf8");
    mkdirSync(join(root, ".git"), { recursive: true });
    const { ctx } = fakeCtx({ in: root });
    const { api } = fakeApi([]);

    await resolveWorkspaceScope(ctx, api, root);

    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("# mine\nsecrets.txt\n");
  });

  it("reuses an already-registered project instead of duplicating it", async () => {
    const root = tempRoot();
    const existing = { version: 1, id: "existing", name: "taskflow", workspacePath: root, createdAt: new Date().toISOString() } as Project;
    const { ctx } = fakeCtx({ in: root });
    const { api, created } = fakeApi([existing]);

    const project = await resolveWorkspaceScope(ctx, api, root);

    expect(project.id).toBe("existing");
    expect(created).toHaveLength(0);
  });

  it("routes --in through resolveProject so every mission command honours it", async () => {
    const target = join(tempRoot(), "scoped");
    const { ctx } = fakeCtx({ in: target });
    const { api } = fakeApi([]);

    const project = await resolveProject(ctx, api, { required: true });

    expect(project?.workspacePath.toLowerCase()).toContain("scoped");
  });

  it("refuses --in together with --project rather than silently preferring one", async () => {
    const target = tempRoot();
    const { ctx } = fakeCtx({ in: target, project: "some-id" });
    const { api } = fakeApi([]);

    await expect(resolveProject(ctx, api, { required: true })).rejects.toThrow(/--in and --project/);
  });

  it("still refuses a broad workspace root — creating the directory does not widen scope", async () => {
    const { ctx } = fakeCtx({ in: homedir() });
    const { api } = fakeApi([]);

    await expect(resolveWorkspaceScope(ctx, api, homedir())).rejects.toThrow(/Refusing to use unsafe workspace/);
  });

  it("refuses --in pointing at a file", async () => {
    const file = join(tempRoot(), "notes.txt");
    writeFileSync(file, "hello", "utf8");
    const { ctx } = fakeCtx({ in: file });
    const { api } = fakeApi([]);

    await expect(resolveWorkspaceScope(ctx, api, file)).rejects.toThrow(/must name a directory/);
  });

  it("refuses an empty --in value", async () => {
    const { ctx } = fakeCtx({ in: "" });
    const { api } = fakeApi([]);

    await expect(resolveWorkspaceScope(ctx, api, "   ")).rejects.toThrow(/--in requires a directory path/);
  });
});
