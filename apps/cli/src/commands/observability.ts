import type { Context } from "../cli/context.js";
import type { MorrowApi } from "../client/api.js";
import { EXIT, notFound, usageError } from "../cli/errors.js";
import { flagString } from "../cli/args.js";
import { ask, resolveProject, shortId } from "./common.js";
import { ensureRunning } from "../service/lifecycle.js";

export async function toolsCommand(ctx: Context, sub: string | undefined, args: string[]): Promise<number> {
  await ensureRunning(ctx);
  const tools = await ctx.api().listTools();
  if (!sub || sub === "list") {
    if (ctx.out.json) ctx.out.data(tools);
    else {
      ctx.out.heading("Tools");
      ctx.out.table(["name", "access", "enabled", "description"], tools.map((tool) => [tool.name, tool.sideEffect, String(tool.enabled), tool.description]));
    }
    return EXIT.OK;
  }
  if (sub !== "info") throw usageError(`Unknown tools subcommand: ${sub}`, "Try: list, info");
  const name = args[0];
  if (!name) throw usageError("Usage: morrow tools info <tool>");
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw notFound(`Unknown tool: ${name}`);
  if (ctx.out.json) ctx.out.data(tool);
  else {
    ctx.out.heading(tool.title);
    ctx.out.keyValue([["name", tool.name], ["access", tool.sideEffect], ["enabled", String(tool.enabled)], ["description", tool.description]]);
    tool.constraints.forEach((constraint) => ctx.out.bullet(constraint));
  }
  return EXIT.OK;
}

export async function permissionsCommand(ctx: Context, sub: string | undefined): Promise<number> {
  if (sub && sub !== "show") throw usageError(`Unknown permissions subcommand: ${sub}`, "Try: show");
  await ensureRunning(ctx);
  const profile = await ctx.api().permissions();
  if (ctx.out.json) ctx.out.data(profile);
  else {
    ctx.out.heading("Permissions");
    ctx.out.keyValue([["filesystem", profile.filesystemAccess], ["shell", String(profile.shellExecution)], ["network", profile.networkAccess], ["write", String(profile.writeAccess)]]);
    ctx.out.print("Denied paths:");
    profile.deniedPathRules.forEach((rule) => ctx.out.bullet(rule));
  }
  return EXIT.OK;
}

export async function auditCommand(ctx: Context, sub: string | undefined, args: string[]): Promise<number> {
  await ensureRunning(ctx);
  const api = ctx.api();
  if (!sub || sub === "list") {
    const project = await resolveProject(ctx, api);
    const entries = await api.audit(project?.id, Number(flagString(ctx.flags, "limit") ?? 50));
    if (ctx.out.json) ctx.out.data(entries);
    else {
      ctx.out.heading("Audit");
      ctx.out.table(["run", "status", "provider", "tools", "evidence"], entries.map((entry) => [shortId(entry.taskId), entry.status, entry.provider ?? "-", String(entry.toolCalls), String(entry.evidence)]));
    }
    return EXIT.OK;
  }
  if (sub !== "show") throw usageError(`Unknown audit subcommand: ${sub}`, "Try: list, show");
  const run = args[0];
  if (!run) throw usageError("Usage: morrow audit show <run>");
  const task = await api.getTask(run);
  if (ctx.out.json) ctx.out.data(task);
  else {
    ctx.out.heading(`Audit: ${shortId(task.task.id)}`);
    ctx.out.keyValue([["status", task.task.status], ["provider", task.routing?.providerId ?? "-"], ["model", task.routing?.model ?? "-"], ["tools", String(task.toolCalls.length)], ["evidence", String(task.evidence.length)]]);
  }
  return EXIT.OK;
}

export async function memoryCommand(ctx: Context, sub: string | undefined, args: string[]): Promise<number> {
  await ensureRunning(ctx);
  const api = ctx.api();
  const project = await resolveProject(ctx, api, { required: true });
  if (!project) return EXIT.NOT_FOUND;
  if (!sub || sub === "list" || sub === "status") {
    const entries = await api.listProjectMemory(project.id);
    if (ctx.out.json) ctx.out.data(sub === "status" ? { total: entries.length, enabled: entries.filter((entry) => entry.enabled).length } : entries);
    else if (sub === "status") ctx.out.keyValue([["total", String(entries.length)], ["enabled", String(entries.filter((entry) => entry.enabled).length)]]);
    else {
      ctx.out.heading("Memory");
      ctx.out.table(["id", "scope", "enabled", "content"], entries.map((entry) => [shortId(entry.id), entry.scope, String(entry.enabled), entry.content]));
    }
    return EXIT.OK;
  }
  if (sub === "add") {
    let content = args.join(" ") || flagString(ctx.flags, "content");
    if (!content && !ctx.out.json && process.stdin.isTTY) content = await ask("Memory: ");
    if (!content) throw usageError("Usage: morrow memory add <content> [--scope project|conversation]");
    const scope = flagString(ctx.flags, "scope") === "conversation" ? "conversation" : "project";
    const created = await api.addMemory(project.id, scope, content);
    if (ctx.out.json) ctx.out.data(created); else ctx.out.success(`Memory added (${shortId(created.id)}).`);
    return EXIT.OK;
  }
  if (sub === "remove") {
    const id = args[0];
    if (!id) throw usageError("Usage: morrow memory remove <id>");
    await api.deleteMemory(id);
    if (ctx.out.json) ctx.out.data({ removed: id }); else ctx.out.success(`Memory removed (${shortId(id)}).`);
    return EXIT.OK;
  }
  throw usageError(`Unknown memory subcommand: ${sub}`, "Try: list, add, remove, status");
}
