import type { RoutingDecision } from "@morrow/contracts";
import type { Context } from "../cli/context.js";
import type { MorrowApi, TaskAggregate } from "../client/api.js";
import { streamTaskEvents } from "../client/sse.js";
import { EXIT } from "../cli/errors.js";

export interface StreamResult {
  status: string;
  content: string;
  aggregate: TaskAggregate;
}

/**
 * Stream a chat task to completion. The assistant's answer text streams to
 * stdout; plan/tool/evidence activity streams to stderr (so stdout stays a clean
 * answer for piping). Honors Ctrl+C: first press cancels the task gracefully, a
 * second press force-exits.
 */
export async function streamChatTask(
  ctx: Context,
  api: MorrowApi,
  taskId: string,
  routing: RoutingDecision,
  opts: { showActivity: boolean } = { showActivity: true }
): Promise<StreamResult> {
  const out = ctx.out;
  if (opts.showActivity) {
    out.diag(
      out.gray(
        `↳ ${routing.providerId} · ${routing.model} · preset ${routing.presetId}` +
          (routing.fallbackUsed ? " · fallback" : "") +
          (routing.overridden ? " · override" : "") +
          ` · ${routing.privacy}`
      )
    );
  }

  const planTitles = new Map<string, string>();
  let content = "";
  let wroteText = false;
  let cancelRequested = false;

  const abort = new AbortController();
  const onSigint = () => {
    if (!cancelRequested) {
      cancelRequested = true;
      out.diag("");
      out.warn("Cancelling… (press Ctrl+C again to force quit)");
      void api.cancelTask(taskId).catch(() => {});
    } else {
      process.exit(EXIT.CANCELLED);
    }
  };
  process.on("SIGINT", onSigint);

  try {
    for await (const event of streamTaskEvents(api.baseUrl, taskId, { signal: abort.signal })) {
      switch (event.type) {
        case "plan.created": {
          // Fetch plan titles once for nicer step labels.
          try {
            const agg = await api.getTask(taskId);
            for (const step of agg.plan) planTitles.set(step.id, step.title);
          } catch {
            /* best effort */
          }
          break;
        }
        case "step.started": {
          if (opts.showActivity) {
            const id = (event.payload as any).stepId as string | undefined;
            const title = id ? planTitles.get(id) : undefined;
            if (title) out.diag(out.gray(`  ▸ ${title}`));
          }
          break;
        }
        case "workspace.inspected": {
          if (opts.showActivity) {
            const count = (event.payload as any).resultCount;
            const path = (event.payload as any).path;
            out.diag(out.gray(`  ◦ inspected ${path ? `${path} ` : "workspace "}(${count} entries)`));
          }
          break;
        }
        case "evidence.persisted": {
          const payload = event.payload as any;
          if (typeof payload.deltaText === "string") {
            content += payload.deltaText;
            out.write(payload.deltaText);
            wroteText = true;
          } else if (typeof payload.path === "string") {
            if (opts.showActivity) {
              if (wroteText) {
                out.write("\n");
                wroteText = false;
              }
              out.diag(out.gray(`  ◦ read ${payload.path} (${payload.size ?? "?"} bytes) — evidence`));
            }
          }
          break;
        }
        case "task.failed": {
          if (wroteText) out.write("\n");
          out.error(`Task failed: ${(event.payload as any).message ?? "unknown error"}`);
          break;
        }
        case "task.cancelled": {
          if (wroteText) out.write("\n");
          out.warn("Response cancelled.");
          break;
        }
        case "task.interrupted": {
          if (wroteText) out.write("\n");
          out.warn("Response interrupted.");
          break;
        }
        default:
          break;
      }
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
  }

  if (wroteText) out.write("\n");

  const aggregate = await api.getTask(taskId);
  return { status: aggregate.task.status, content, aggregate };
}
