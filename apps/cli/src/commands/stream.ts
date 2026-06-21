import type { RoutingDecision } from "@morrow/contracts";
import type { Context } from "../cli/context.js";
import type { MorrowApi, TaskAggregate } from "../client/api.js";
import { streamTaskEvents } from "../client/sse.js";
import { EXIT } from "../cli/errors.js";
import { ask } from "./common.js";

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
        case "approval.requested": {
          if (wroteText) {
            out.write("\n");
            wroteText = false;
          }
          const payload = event.payload as any;
          const approvalId = payload.approvalId;
          const kind = payload.kind;

          try {
            const approval = await api.getApproval(approvalId);

            if (kind === "command") {
              const details = approval.details as any;
              out.print();
              out.heading("Command Approval Request");
              out.keyValue([
                ["Command", `${details.executable} ${details.args.join(" ")}`],
                ["Cwd", details.cwd || "(workspace root)"],
                ["Purpose", details.purpose || "(not specified)"],
                ["Risk", details.risk],
              ]);
              out.print();

              let decision: string | null = null;
              while (!decision) {
                const answer = (await ask("Approve command? [y]es / [n]o / [t]rust pattern: ")).trim().toLowerCase();
                if (answer === "y" || answer === "yes") {
                  decision = "allow_once";
                } else if (answer === "n" || answer === "no") {
                  decision = "deny";
                } else if (answer === "t" || answer === "trust") {
                  decision = "trust_project";
                }
              }

              const trustPattern = decision === "trust_project" ? details.pattern : undefined;

              await api.resolveApproval(approvalId, {
                projectId: approval.projectId,
                decision: decision as any,
                trustPattern,
              });

              if (decision === "deny") {
                out.error("Command denied.");
              } else {
                out.success(`Command approved (${decision}). Resuming task…`);
              }
            } else if (kind === "change_set") {
              const details = approval.details as any;
              // The exact proposed diff lives in the approval details; the
              // /diff endpoint only reports *applied* change sets, so we render
              // straight from the pending approval here.
              const proposedDiff: string | undefined = typeof details.diff === "string" ? details.diff : undefined;
              out.print();
              out.heading("Patch Proposal Approval Request");
              out.print(`${out.bold("Explanation:")} ${details.explanation}`);
              out.print(`${out.bold("Files to change:")} ${details.files.join(", ")}`);
              out.print();
              out.print(out.bold("Unified Diff:"));
              if (proposedDiff) {
                const diffLines = proposedDiff.split("\n");
                for (const line of diffLines) {
                  if (line.startsWith("+") && !line.startsWith("+++")) {
                    out.print(out.green(line));
                  } else if (line.startsWith("-") && !line.startsWith("---")) {
                    out.print(out.red(line));
                  } else {
                    out.print(line);
                  }
                }
              } else {
                out.print("(no diff returned)");
              }
              out.print();

              let decision: string | null = null;
              while (!decision) {
                const answer = (await ask("Apply this patch? [y]es / [n]o: ")).trim().toLowerCase();
                if (answer === "y" || answer === "yes") {
                  decision = "allow_once";
                } else if (answer === "n" || answer === "no") {
                  decision = "deny";
                }
              }

              await api.resolveApproval(approvalId, {
                projectId: approval.projectId,
                decision: decision as any,
              });

              if (decision === "deny") {
                out.error("Patch denied.");
              } else {
                out.success("Patch approved. Applying changes and resuming task…");
              }
            }
          } catch (err: any) {
            out.error(`Error resolving approval: ${err.message || err}`);
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
