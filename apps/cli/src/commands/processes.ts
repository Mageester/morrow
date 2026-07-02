import type { Context } from "../cli/context.js";
import type { MorrowApi, ProcessRecord } from "../client/api.js";
import { ensureRunning } from "../service/lifecycle.js";
import { resolveProject } from "./common.js";
import { flagBool, flagString } from "../cli/args.js";
import { usageError, EXIT } from "../cli/errors.js";

/**
 * `morrow processes` (alias `ps`) — the background-process registry.
 *
 *   morrow processes                    list processes for the project
 *   morrow processes start -- <cmd> …   start a background command
 *   morrow processes show <id>          inspect one process
 *   morrow processes logs <id>          print captured output (--stream stderr, --follow)
 *   morrow processes kill <id>          terminate (--force for immediate tree kill)
 */
export async function processesCommand(ctx: Context, sub: string, args: string[]): Promise<number> {
  await ensureRunning(ctx);
  const api = ctx.api();
  switch (sub) {
    case undefined:
    case "":
    case "list":
      return list(ctx, api);
    case "start":
      return start(ctx, api, args);
    case "show":
      return show(ctx, api, args);
    case "logs":
      return logs(ctx, api, args);
    case "kill":
      return kill(ctx, api, args);
    default:
      throw usageError(`Unknown processes subcommand: ${sub}`, "Try: list, start, show, logs, kill");
  }
}

function statusMark(ctx: Context, status: string): string {
  switch (status) {
    case "running": return ctx.out.green("● running");
    case "exited": return ctx.out.gray("○ exited");
    case "failed": return ctx.out.red("✗ failed");
    case "cancelled": return ctx.out.yellow("■ cancelled");
    case "lost": return ctx.out.red("? lost");
    default: return status;
  }
}

async function list(ctx: Context, api: MorrowApi): Promise<number> {
  const projectId = (await resolveProject(ctx, api, { required: true, autoCreateMissing: true }))!.id;
  const status = flagString(ctx.flags, "status") as any;
  const processes = await api.listProcesses(projectId, status);
  if (ctx.out.json) {
    ctx.out.data(processes);
    return EXIT.OK;
  }
  if (processes.length === 0) {
    ctx.out.info("No background processes. Start one with `morrow processes start -- <command> …`.");
    return EXIT.OK;
  }
  ctx.out.heading(`Processes (${processes.length})`);
  ctx.out.table(
    ["id", "status", "command", "pid", "started", "exit"],
    processes.map((p) => [
      p.id.slice(0, 8),
      statusMark(ctx, p.status),
      [p.command, ...p.args].join(" ").slice(0, 48),
      p.pid !== null ? String(p.pid) : "-",
      p.startedAt,
      p.exitCode !== null ? String(p.exitCode) : "-",
    ])
  );
  ctx.out.diag("");
  ctx.out.diag(ctx.out.gray("Full ids via --json · logs: morrow processes logs <id>"));
  return EXIT.OK;
}

async function start(ctx: Context, api: MorrowApi, args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (!command) {
    throw usageError("Usage: morrow processes start -- <command> [args …]", "Everything after -- is passed through verbatim.");
  }
  const projectId = (await resolveProject(ctx, api, { required: true, autoCreateMissing: true }))!.id;
  const input: { command: string; args: string[]; cwd?: string; timeoutMs?: number } = { command, args: rest };
  const cwd = flagString(ctx.flags, "cwd");
  if (cwd) input.cwd = cwd;
  const timeout = flagString(ctx.flags, "timeout");
  if (timeout) input.timeoutMs = Number(timeout) * 1000;
  const record = await api.startProcess(projectId, input);
  if (ctx.out.json) {
    ctx.out.data(record);
    return EXIT.OK;
  }
  ctx.out.success(`Started ${record.command} (process ${record.id.slice(0, 8)}, pid ${record.pid ?? "?"}).`);
  ctx.out.info(`Watch it: morrow processes logs ${record.id.slice(0, 8)} --follow`);
  return EXIT.OK;
}

/** Accept a full id or an unambiguous short prefix. */
async function resolveProcess(ctx: Context, api: MorrowApi, idArg: string | undefined): Promise<ProcessRecord> {
  if (!idArg) throw usageError("A process id is required.", "List them with `morrow processes`.");
  const projectId = (await resolveProject(ctx, api, { required: true, autoCreateMissing: true }))!.id;
  const all = await api.listProcesses(projectId);
  const matches = all.filter((p) => p.id === idArg || p.id.startsWith(idArg));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw usageError(`"${idArg}" matches ${matches.length} processes — use more characters.`);
  // Fall back to a direct id fetch (process may belong to another project).
  return api.getProcess(idArg);
}

async function show(ctx: Context, api: MorrowApi, args: string[]): Promise<number> {
  const record = await resolveProcess(ctx, api, args[0]);
  if (ctx.out.json) {
    ctx.out.data(record);
    return EXIT.OK;
  }
  ctx.out.heading(`Process ${record.id.slice(0, 8)}`);
  ctx.out.keyValue([
    ["status", record.status],
    ["command", [record.command, ...record.args].join(" ")],
    ["pid", record.pid !== null ? String(record.pid) : "-"],
    ["cwd", record.cwd],
    ["mode", record.mode],
    ["started", record.startedAt],
    ["ended", record.endedAt ?? "-"],
    ["exit code", record.exitCode !== null ? String(record.exitCode) : "-"],
    ...(record.taskId ? [["task", record.taskId] as [string, string]] : []),
    ...(record.detail ? [["detail", record.detail] as [string, string]] : []),
  ]);
  return EXIT.OK;
}

async function logs(ctx: Context, api: MorrowApi, args: string[]): Promise<number> {
  const record = await resolveProcess(ctx, api, args[0]);
  const stream = flagString(ctx.flags, "stream") === "stderr" ? "stderr" : "stdout";
  const follow = flagBool(ctx.flags, "follow");

  let offset = 0;
  for (;;) {
    const slice = await api.getProcessOutput(record.id, { stream, offset });
    if (slice.data) {
      if (ctx.out.json) ctx.out.data({ processId: record.id, stream, data: slice.data, nextOffset: slice.nextOffset, truncated: slice.truncated });
      else process.stdout.write(slice.data);
    }
    offset = slice.nextOffset;
    if (slice.eof || !follow) {
      if (!ctx.out.json && slice.truncated) ctx.out.warn("\n[output truncated at the capture limit]");
      return EXIT.OK;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function kill(ctx: Context, api: MorrowApi, args: string[]): Promise<number> {
  const record = await resolveProcess(ctx, api, args[0]);
  const force = flagBool(ctx.flags, "force");
  const result = await api.terminateProcess(record.id, force);
  if (ctx.out.json) {
    ctx.out.data(result);
    return EXIT.OK;
  }
  ctx.out.success(`Terminating ${record.id.slice(0, 8)}${force ? " (forced)" : ""}. Check it with \`morrow processes show ${record.id.slice(0, 8)}\`.`);
  return EXIT.OK;
}
