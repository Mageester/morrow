import type { Context } from "../cli/context.js";
import { EXIT, usageError } from "../cli/errors.js";
import { ensureRunning } from "../service/lifecycle.js";
import { resolveProject, shortId } from "./common.js";

/**
 * Cron schedules for unattended, isolated task runs. The orchestrator's
 * scheduler ticker fires due schedules; this command manages them over the API.
 */
export async function scheduleCommand(ctx: Context, sub: string | undefined, args: string[]): Promise<number> {
  await ensureRunning(ctx);
  const api = ctx.api();
  const project = await resolveProject(ctx, api, { required: true });
  if (!project) return EXIT.NOT_FOUND;
  const verb = sub ?? "list";

  if (verb === "list") {
    const schedules = await api.listSchedules(project.id);
    if (ctx.out.json) ctx.out.data(schedules);
    else if (!schedules.length) ctx.out.info("No schedules. Add one: morrow schedule add \"0 9 * * 1-5\"");
    else ctx.out.table(["id", "cron", "kind", "enabled", "next run"], schedules.map((s) => [shortId(s.id), s.cron, s.taskKind, String(s.enabled), s.nextRunAt]));
    return EXIT.OK;
  }

  if (verb === "add") {
    // Accept either a single quoted cron or five separate fields.
    const cron = args.filter((a) => !a.startsWith("-")).join(" ").trim();
    if (!cron) throw usageError('Usage: morrow schedule add "<cron>"  (e.g. "0 9 * * 1-5")');
    const created = await api.createSchedule(project.id, cron);
    if (ctx.out.json) ctx.out.data(created);
    else ctx.out.success(`Scheduled ${created.taskKind} (${shortId(created.id)}); next run ${created.nextRunAt}.`);
    return EXIT.OK;
  }

  if (verb === "remove") {
    const id = args[0];
    if (!id) throw usageError("Usage: morrow schedule remove <id>");
    await api.deleteSchedule(id);
    if (ctx.out.json) ctx.out.data({ removed: id }); else ctx.out.success(`Removed schedule ${shortId(id)}.`);
    return EXIT.OK;
  }

  if (verb === "run") {
    const id = args[0];
    if (!id) throw usageError("Usage: morrow schedule run <id>");
    const result = await api.runSchedule(id);
    if (ctx.out.json) ctx.out.data(result); else ctx.out.success(`Started run ${shortId(result.taskId)} for schedule ${shortId(id)}.`);
    return EXIT.OK;
  }

  throw usageError(`Unknown schedule subcommand: ${verb}`, "Try: list, add, remove, run");
}
