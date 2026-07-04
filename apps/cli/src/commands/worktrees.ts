import type { Context } from "../cli/context.js";
import type { MorrowApi, WorktreeRecord } from "../client/api.js";
import { ensureRunning } from "../service/lifecycle.js";
import { resolveProject } from "./common.js";
import { flagBool, flagString } from "../cli/args.js";
import { usageError, EXIT } from "../cli/errors.js";

/**
 * `morrow worktrees` — isolated git checkouts for agent work.
 *
 *   morrow worktrees                 list worktrees for the project
 *   morrow worktrees create [name]   create one (--base <ref>, --task <id>, --agent <id>)
 *   morrow worktrees show <id|name>  live status (dirty files, commits ahead)
 *   morrow worktrees diff <id|name>  diff against the pinned base
 *   morrow worktrees remove <id|name> [--preserve]
 */
export async function worktreesCommand(ctx: Context, sub: string, args: string[]): Promise<number> {
  await ensureRunning(ctx);
  const api = ctx.api();
  switch (sub) {
    case undefined:
    case "":
    case "list":
      return list(ctx, api);
    case "create":
      return create(ctx, api, args);
    case "show":
      return show(ctx, api, args);
    case "diff":
      return diff(ctx, api, args);
    case "remove":
      return remove(ctx, api, args);
    default:
      throw usageError(`Unknown worktrees subcommand: ${sub}`, "Try: list, create, show, diff, remove");
  }
}

async function projectId(ctx: Context, api: MorrowApi): Promise<string> {
  return (await resolveProject(ctx, api, { required: true, autoCreateMissing: true }))!.id;
}

async function resolveWorktree(ctx: Context, api: MorrowApi, ref: string | undefined): Promise<WorktreeRecord> {
  if (!ref) throw usageError("A worktree id or name is required.", "List them with `morrow worktrees`.");
  const all = await api.listWorktrees(await projectId(ctx, api));
  const matches = all.filter((w) => w.id === ref || w.id.startsWith(ref) || w.branch === ref || w.branch === `morrow/${ref}`);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw usageError(`"${ref}" matches ${matches.length} worktrees — use the id.`);
  throw usageError(`No worktree matching "${ref}".`, "List them with `morrow worktrees`.");
}

async function list(ctx: Context, api: MorrowApi): Promise<number> {
  const status = flagString(ctx.flags, "status") as WorktreeRecord["status"] | undefined;
  const worktrees = await api.listWorktrees(await projectId(ctx, api), status);
  if (ctx.out.json) {
    ctx.out.data(worktrees);
    return EXIT.OK;
  }
  if (worktrees.length === 0) {
    ctx.out.info(status ? `No ${status} worktrees.` : "No worktrees. Create one with `morrow worktrees create <name>`.");
    return EXIT.OK;
  }
  ctx.out.heading(`Worktrees (${worktrees.length})`);
  ctx.out.table(
    ["id", "branch", "status", "task", "agent", "created", "detail"],
    worktrees.map((w) => [
      w.id.slice(0, 8),
      w.branch,
      w.status,
      w.taskId ? w.taskId.slice(0, 8) : "-",
      w.agentId ? w.agentId.slice(0, 8) : "-",
      w.createdAt,
      ctx.out.gray(w.detail ?? ""),
    ])
  );
  ctx.out.diag("");
  ctx.out.diag(ctx.out.gray("Inspect: morrow worktrees show <id>  ·  remove clean worktrees with: morrow worktrees remove <id>"));
  return EXIT.OK;
}

async function create(ctx: Context, api: MorrowApi, args: string[]): Promise<number> {
  const input: { name?: string; baseRef?: string; taskId?: string; agentId?: string } = {};
  if (args[0]) input.name = args[0];
  const base = flagString(ctx.flags, "base");
  if (base) input.baseRef = base;
  const taskId = flagString(ctx.flags, "task");
  if (taskId) input.taskId = taskId;
  const agentId = flagString(ctx.flags, "agent");
  if (agentId) input.agentId = agentId;
  const record = await api.createWorktree(await projectId(ctx, api), input);
  if (ctx.out.json) {
    ctx.out.data(record);
    return EXIT.OK;
  }
  ctx.out.success(`Created worktree ${record.branch} at ${record.path}`);
  ctx.out.info(`Pin agent work to it: morrow chat --worktree ${record.id.slice(0, 8)} (or /worktree in a session).`);
  return EXIT.OK;
}

async function show(ctx: Context, api: MorrowApi, args: string[]): Promise<number> {
  const record = await resolveWorktree(ctx, api, args[0]);
  const status = await api.getWorktree(record.id);
  if (ctx.out.json) {
    ctx.out.data(status);
    return EXIT.OK;
  }
  ctx.out.heading(`Worktree ${status.branch}`);
  ctx.out.keyValue([
    ["status", status.status],
    ["path", status.path],
    ["exists", String(status.exists)],
    ["base", status.baseRef.slice(0, 12)],
    ["task", status.taskId ?? "-"],
    ["agent", status.agentId ?? "-"],
    ["created", status.createdAt],
    ["removed", status.removedAt ?? "-"],
    ["dirty", status.dirty ? `yes (${status.dirtyFiles.length} file${status.dirtyFiles.length === 1 ? "" : "s"})` : "no"],
    ["commits ahead", String(status.aheadCommits.length)],
    ...(status.detail ? [["detail", status.detail] as [string, string]] : []),
  ]);
  for (const f of status.dirtyFiles.slice(0, 20)) ctx.out.print(ctx.out.yellow(`    M ${f}`));
  for (const c of status.aheadCommits.slice(0, 20)) ctx.out.print(ctx.out.gray(`    ${c.hash.slice(0, 8)} ${c.subject}`));
  return EXIT.OK;
}

async function diff(ctx: Context, api: MorrowApi, args: string[]): Promise<number> {
  const record = await resolveWorktree(ctx, api, args[0]);
  const result = await api.getWorktreeDiff(record.id);
  if (ctx.out.json) {
    ctx.out.data(result);
    return EXIT.OK;
  }
  if (!result.diff.trim()) {
    ctx.out.info("No committed differences against the base yet.");
    return EXIT.OK;
  }
  for (const line of result.diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) ctx.out.print(ctx.out.green(line));
    else if (line.startsWith("-") && !line.startsWith("---")) ctx.out.print(ctx.out.red(line));
    else ctx.out.print(line);
  }
  if (result.truncated) ctx.out.warn("[diff truncated]");
  return EXIT.OK;
}

async function remove(ctx: Context, api: MorrowApi, args: string[]): Promise<number> {
  const record = await resolveWorktree(ctx, api, args[0]);
  const preserve = flagBool(ctx.flags, "preserve");
  const result = await api.removeWorktree(record.id, preserve);
  if (ctx.out.json) {
    ctx.out.data(result);
    return EXIT.OK;
  }
  ctx.out.success(`Removed worktree ${record.branch} (branch retained).`);
  if (result.preservedCommit) {
    ctx.out.info(`Uncommitted work preserved as ${result.preservedCommit.slice(0, 12)} on ${record.branch}.`);
  }
  return EXIT.OK;
}
