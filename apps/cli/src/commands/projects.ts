import type { Context } from "../cli/context.js";
import type { MorrowApi } from "../client/api.js";
import { ensureRunning } from "../service/lifecycle.js";
import { resolveProject, validateDirectory, ask, select, isInteractive, shortId } from "./common.js";
import { flagString } from "../cli/args.js";
import { usageError, notFound } from "../cli/errors.js";
import { EXIT } from "../cli/errors.js";

export async function projectsCommand(ctx: Context, sub: string, args: string[]): Promise<number> {
  await ensureRunning(ctx);
  const api = ctx.api();
  switch (sub) {
    case undefined:
    case "list":
      return list(ctx, api);
    case "add":
      return add(ctx, api, args);
    case "remove":
      return remove(ctx, api, args);
    case "inspect":
      return inspect(ctx, api);
    case "select":
      return selectProject(ctx, api, args[0]);
    default:
      throw usageError(`Unknown projects subcommand: ${sub}`, "Try: list, add, remove, inspect, select");
  }
}

async function list(ctx: Context, api: MorrowApi): Promise<number> {
  const projects = await api.listProjects();
  const activeDefault = ctx.config.get("defaults.project") as string | undefined;
  if (ctx.out.json) {
    ctx.out.data(projects.map((p) => ({ ...p, isDefault: p.id === activeDefault })));
    return EXIT.OK;
  }
  if (projects.length === 0) {
    ctx.out.info("No projects yet. Add one with `morrow projects add <path>`.");
    return EXIT.OK;
  }
  ctx.out.heading("Projects");
  ctx.out.table(
    ["", "id", "name", "workspace"],
    projects.map((p) => [p.id === activeDefault ? ctx.out.green("●") : " ", ctx.out.cyan(shortId(p.id)), p.name, ctx.out.gray(p.workspacePath)])
  );
  return EXIT.OK;
}

async function add(ctx: Context, api: MorrowApi, args: string[]): Promise<number> {
  let pathArg = args[0] ?? flagString(ctx.flags, "path");
  let name = flagString(ctx.flags, "name");
  if (!pathArg && isInteractive(ctx)) pathArg = await ask("Workspace path: ");
  if (!pathArg) throw usageError("A workspace path is required.", "Usage: morrow projects add <path> [--name <name>]");
  const canonical = validateDirectory(pathArg);
  if (!name) {
    name = flagString(ctx.flags, "name") ?? canonical.split(/[\\/]/).filter(Boolean).pop() ?? "Project";
    if (isInteractive(ctx) && !flagString(ctx.flags, "name")) {
      const entered = await ask(`Project name [${name}]: `);
      if (entered) name = entered;
    }
  }
  const project = await api.createProject(name, canonical);
  ctx.out.success(`Added project "${project.name}" (${shortId(project.id)}).`);
  ctx.out.info(`Workspace: ${project.workspacePath}`);
  if (ctx.out.json) ctx.out.data(project);
  // Offer to set as default when none configured.
  if (!ctx.config.get("defaults.project")) {
    ctx.config.set("defaults.project", project.id, ctx.paths.projectConfigFile ? "project" : "user");
    ctx.out.info("Set as the default project.");
  }
  return EXIT.OK;
}

async function remove(ctx: Context, api: MorrowApi, args: string[]): Promise<number> {
  // Removal is a config-level dissociation: the CLI clears it as the default and
  // forgets it locally. We intentionally do NOT delete server data destructively.
  const ref = args[0] ?? flagString(ctx.flags, "project");
  if (!ref) throw usageError("Specify a project id to remove from local defaults.");
  const projects = await api.listProjects();
  const project = projects.find((p) => p.id === ref || p.name === ref);
  if (!project) throw notFound(`No project matching "${ref}".`);
  if ((ctx.config.get("defaults.project") as string | undefined) === project.id) {
    ctx.config.unset("defaults.project", ctx.paths.projectConfigFile ? "project" : "user");
    ctx.config.unset("defaults.project", "user");
  }
  ctx.out.success(`Removed "${project.name}" from local defaults.`);
  ctx.out.info("Conversations and history remain in the database and can be reattached by adding the project again.");
  return EXIT.OK;
}

async function inspect(ctx: Context, api: MorrowApi): Promise<number> {
  const project = await resolveProject(ctx, api, { required: true });
  if (!project) return EXIT.NOT_FOUND;
  const conversations = await api.listConversations(project.id, true);
  const tasks = await api.audit(project.id, 100);
  if (ctx.out.json) {
    ctx.out.data({ project, conversations: conversations.length, recentTasks: tasks });
    return EXIT.OK;
  }
  ctx.out.heading(`Project: ${project.name}`);
  ctx.out.keyValue([
    ["id", project.id],
    ["workspace", project.workspacePath],
    ["created", project.createdAt],
    ["conversations", String(conversations.length)],
    ["recent tasks", String(tasks.length)],
  ]);
  if (tasks.length > 0) {
    ctx.out.heading("Recent activity");
    ctx.out.table(
      ["task", "kind", "status", "provider", "tools", "evidence"],
      tasks.slice(0, 10).map((t) => [shortId(t.taskId), t.kind, statusColor(ctx, t.status), t.provider ?? "-", String(t.toolCalls), String(t.evidence)])
    );
  }
  return EXIT.OK;
}

async function selectProject(ctx: Context, api: MorrowApi, requested?: string): Promise<number> {
  const projects = await api.listProjects();
  if (projects.length === 0) {
    ctx.out.info("No projects to select. Add one with `morrow projects add <path>`.");
    return EXIT.OK;
  }
  if (!isInteractive(ctx) || requested) {
    const ref = requested ?? flagString(ctx.flags, "project");
    if (!ref) throw usageError("Non-interactive: pass --project <id> to select.");
    const project = projects.find((p) => p.id === ref || p.name === ref);
    if (!project) throw notFound(`No project matching "${ref}".`);
    ctx.config.set("defaults.project", project.id, ctx.paths.projectConfigFile ? "project" : "user");
    ctx.out.success(`Default project set to "${project.name}".`);
    return EXIT.OK;
  }
  const idx = await select(ctx, "Select default project", projects, (p) => `${p.name}  ${ctx.out.gray(p.workspacePath)}`);
  const chosen = projects[idx]!;
  ctx.config.set("defaults.project", chosen.id, ctx.paths.projectConfigFile ? "project" : "user");
  ctx.out.success(`Default project set to "${chosen.name}".`);
  return EXIT.OK;
}

export function statusColor(ctx: Context, status: string): string {
  if (status === "completed" || status === "verified") return ctx.out.green(status);
  if (status === "failed") return ctx.out.red(status);
  if (status === "cancelled" || status === "interrupted") return ctx.out.yellow(status);
  return ctx.out.gray(status);
}

/** `morrow init` — add the current directory as a project. */
export async function initCommand(ctx: Context, args: string[]): Promise<number> {
  await ensureRunning(ctx);
  const api = ctx.api();
  const path = args[0] ?? process.cwd();
  return add(ctx, api, [path]);
}
