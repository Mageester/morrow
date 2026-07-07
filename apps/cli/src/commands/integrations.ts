import type { Context } from "../cli/context.js";
import type { IntegrationAttempt, MorrowApi, WorktreeRecord } from "../client/api.js";
import { ensureRunning } from "../service/lifecycle.js";
import { resolveProject } from "./common.js";
import { flagString } from "../cli/args.js";
import { usageError, EXIT } from "../cli/errors.js";

/**
 * `morrow integrate` — review and apply clean worktree branches.
 *
 *   morrow integrate                   list recent integration attempts
 *   morrow integrate check <worktree>  dry-run merge analysis (--target <branch>)
 *   morrow integrate show <id>         inspect conflicts/status
 *   morrow integrate apply <id>        apply a clean attempt
 *   morrow integrate cancel <id>       abandon an attempt without deleting work
 */
export async function integrationsCommand(ctx: Context, sub: string, args: string[]): Promise<number> {
  await ensureRunning(ctx);
  const api = ctx.api();
  switch (sub) {
    case undefined:
    case "":
    case "list":
      return list(ctx, api);
    case "check":
      return check(ctx, api, args);
    case "show":
      return show(ctx, api, args);
    case "apply":
      return apply(ctx, api, args);
    case "cancel":
      return cancel(ctx, api, args);
    default:
      throw usageError(`Unknown integrate subcommand: ${sub}`, "Try: list, check, show, apply, cancel");
  }
}

async function projectId(ctx: Context, api: MorrowApi): Promise<string> {
  return (await resolveProject(ctx, api, { required: true, autoCreateMissing: true }))!.id;
}

async function resolveWorktree(ctx: Context, api: MorrowApi, ref: string | undefined): Promise<WorktreeRecord> {
  if (!ref) throw usageError("A worktree id or name is required.", "List them with `morrow worktrees`.");
  const all = await api.listWorktrees(await projectId(ctx, api), "active");
  const matches = all.filter((w) => w.id === ref || w.id.startsWith(ref) || w.branch === ref || w.branch === `morrow/${ref}`);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw usageError(`"${ref}" matches ${matches.length} worktrees — use the id.`);
  throw usageError(`No active worktree matching "${ref}".`, "List them with `morrow worktrees`.");
}

function statusText(ctx: Context, status: IntegrationAttempt["status"]): string {
  switch (status) {
    case "clean": return ctx.out.green("clean");
    case "conflicted": return ctx.out.red("conflicted");
    case "applied": return ctx.out.green("applied");
    case "failed": return ctx.out.red("failed");
    case "cancelled": return ctx.out.gray("cancelled");
    default: return status;
  }
}

function printAttempt(ctx: Context, attempt: IntegrationAttempt): void {
  ctx.out.heading(`Integration ${attempt.id.slice(0, 8)}`);
  ctx.out.keyValue([
    ["status", attempt.status],
    ["source", `${attempt.sourceBranch} ${ctx.out.gray(attempt.sourceCommit.slice(0, 12))}`],
    ["target", `${attempt.targetBranch} ${ctx.out.gray(attempt.targetCommit.slice(0, 12))}`],
    ["worktree", attempt.worktreeId],
    ...(attempt.taskId ? [["task", attempt.taskId] as [string, string]] : []),
    ...(attempt.agentId ? [["agent", attempt.agentId] as [string, string]] : []),
    ["created", attempt.createdAt],
    ...(attempt.appliedCommit ? [["applied commit", attempt.appliedCommit.slice(0, 12)] as [string, string]] : []),
    ...(attempt.errorDetail ? [["detail", attempt.errorDetail] as [string, string]] : []),
  ]);
  for (const file of attempt.conflictedFiles) ctx.out.print(ctx.out.red(`    conflict ${file}`));
}

async function list(ctx: Context, api: MorrowApi): Promise<number> {
  const status = flagString(ctx.flags, "status") as IntegrationAttempt["status"] | undefined;
  const attempts = await api.listIntegrations(await projectId(ctx, api), status);
  if (ctx.out.json) {
    ctx.out.data(attempts);
    return EXIT.OK;
  }
  if (attempts.length === 0) {
    ctx.out.info(status ? `No ${status} integration attempts.` : "No integration attempts. Check one with `morrow integrate check <worktree>`.");
    return EXIT.OK;
  }
  ctx.out.heading(`Integrations (${attempts.length})`);
  ctx.out.table(
    ["id", "status", "source", "target", "updated"],
    attempts.map((a) => [a.id.slice(0, 8), statusText(ctx, a.status), a.sourceBranch, a.targetBranch, a.updatedAt])
  );
  return EXIT.OK;
}

async function check(ctx: Context, api: MorrowApi, args: string[]): Promise<number> {
  const wt = await resolveWorktree(ctx, api, args[0]);
  const targetBranch = flagString(ctx.flags, "target");
  const attempt = await api.checkIntegration(wt.id, targetBranch ? { targetBranch } : {});
  if (ctx.out.json) {
    ctx.out.data(attempt);
    return EXIT.OK;
  }
  printAttempt(ctx, attempt);
  if (attempt.status === "clean") ctx.out.info(`Apply it: morrow integrate apply ${attempt.id.slice(0, 8)}`);
  if (attempt.status === "conflicted") ctx.out.warn("Conflicts were detected in an isolated dry run; the target repository was left untouched.");
  return EXIT.OK;
}

async function show(ctx: Context, api: MorrowApi, args: string[]): Promise<number> {
  const id = args[0];
  if (!id) throw usageError("An integration id is required.", "List them with `morrow integrate`.");
  const attempt = await api.getIntegration(id);
  if (ctx.out.json) ctx.out.data(attempt);
  else printAttempt(ctx, attempt);
  return EXIT.OK;
}

async function apply(ctx: Context, api: MorrowApi, args: string[]): Promise<number> {
  const id = args[0];
  if (!id) throw usageError("An integration id is required.", "Run `morrow integrate check <worktree>` first.");
  const attempt = await api.applyIntegration(id);
  if (ctx.out.json) ctx.out.data(attempt);
  else {
    printAttempt(ctx, attempt);
    if (attempt.status === "applied") ctx.out.success(`Applied ${attempt.sourceBranch} into ${attempt.targetBranch}.`);
  }
  return EXIT.OK;
}

async function cancel(ctx: Context, api: MorrowApi, args: string[]): Promise<number> {
  const id = args[0];
  if (!id) throw usageError("An integration id is required.", "List them with `morrow integrate`.");
  const attempt = await api.cancelIntegration(id);
  if (ctx.out.json) ctx.out.data(attempt);
  else ctx.out.success(`Cancelled integration ${attempt.id.slice(0, 8)}. Source worktree and branch were preserved.`);
  return EXIT.OK;
}
