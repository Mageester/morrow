import type { Context } from "../cli/context.js";
import { EXIT } from "../cli/errors.js";
import type { MorrowApi } from "../client/api.js";
import { ensureRunning } from "../service/lifecycle.js";

/** Cancel active work without erasing its task, approval, or audit evidence. */
export async function cancelActiveTasks(api: Pick<MorrowApi, "listProjects" | "listTasks" | "cancelTask">): Promise<string[]> {
  const projects = await api.listProjects();
  const active = (await Promise.all(projects.map(async (project) =>
    (await api.listTasks(project.id)).filter((task) => task.status === "queued" || task.status === "running")))).flat();
  await Promise.all(active.map((task) => api.cancelTask(task.id)));
  return active.map((task) => task.id);
}

export async function panicCommand(ctx: Context): Promise<number> {
  await ensureRunning(ctx);
  const cancelled = await cancelActiveTasks(ctx.api());
  if (ctx.out.json) ctx.out.data({ panic: true, cancelledTaskIds: cancelled });
  else ctx.out.warn(cancelled.length ? `Panic stop cancelled ${cancelled.length} active task${cancelled.length === 1 ? "" : "s"}.` : "Panic stop: no active tasks.");
  return EXIT.OK;
}
