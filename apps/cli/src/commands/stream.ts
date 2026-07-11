import type { RoutingDecision } from "@morrow/contracts";
import type { Context } from "../cli/context.js";
import type { MorrowApi, TaskAggregate } from "../client/api.js";
import { streamTaskEvents } from "../client/sse.js";
import { EXIT } from "../cli/errors.js";
import { ask } from "./common.js";
import { LineRenderer } from "../terminal/line-renderer.js";
import { mapTaskEvent } from "../terminal/task-event-adapter.js";
import { resolveUnicodeFlag } from "../terminal/capabilities.js";
import { selectCanonicalFinalAnswer } from "../terminal/output-report.js";
import { changeSetApprovalView, commandApprovalView } from "../terminal/approval-view-model.js";

export interface StreamResult {
  status: string;
  content: string;
  aggregate: TaskAggregate;
}

/**
 * Stream a chat task to completion through the terminal runtime.
 *
 * The SSE task-event stream is normalized into TerminalEvents and rendered by
 * the (non-interactive) LineRenderer, which owns visible output: the assistant
 * answer streams to stdout, activity/tool/patch diagnostics to stderr. The only
 * thing handled outside the renderer is `approval.requested`, which is an *input*
 * event — it prompts the user, then resolves the approval so the agent resumes.
 *
 * Honors Ctrl+C: first press cancels the task gracefully, a second force-exits.
 */
export async function streamChatTask(
  ctx: Context,
  api: MorrowApi,
  taskId: string,
  routing: RoutingDecision,
  opts: { showActivity: boolean } = { showActivity: true }
): Promise<StreamResult> {
  const out = ctx.out;
  const unicode = resolveUnicodeFlag(ctx.config.get("ui.unicode") as boolean | undefined, process.env);
  // The completion card is part of the product surface now: any run that shows
  // activity also gets the concise "did it succeed / what changed" card.
  const renderer = new LineRenderer(out, { unicode, showActivity: opts.showActivity, showSummary: opts.showActivity });

  if (opts.showActivity) {
    renderer.apply({
      type: "routing",
      provider: routing.providerId,
      model: routing.model,
      preset: routing.presetId,
      fallback: routing.fallbackUsed,
      overridden: routing.overridden,
      privacy: routing.privacy,
    });
  }

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
      if (event.type === "approval.requested") {
        await handleApproval(api, out, renderer, event);
        continue;
      }
      for (const te of mapTaskEvent(event)) renderer.apply(te);
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
  }

  // `renderer.end()` is the raw text streamed to stdout — every turn's
  // narration, concatenated, which is correct for a human/log-following
  // reader but not for a single machine-readable "content" field (that was
  // the exact shape of the real duplication bug in exported reports). Prefer
  // the canonical final turn from the persisted event log; only fall back to
  // the raw stream for legacy tasks with no turn markers.
  const streamed = renderer.end();
  const aggregate = await api.getTask(taskId);
  const canonical = selectCanonicalFinalAnswer(aggregate, streamed);
  const content = canonical.kind === "final" ? canonical.text : "";
  return { status: aggregate.task.status, content, aggregate };
}

/**
 * Interactive approval. This is deliberately outside the renderer: it reads from
 * the user and writes a decision back to the orchestrator, which then resumes the
 * blocked tool. In YOLO sessions the orchestrator never emits approval.requested,
 * so this path is skipped entirely.
 */
async function handleApproval(
  api: MorrowApi,
  out: Context["out"],
  renderer: LineRenderer,
  event: { payload: Record<string, unknown> }
): Promise<void> {
  renderer.flush();
  const payload = event.payload as any;
  const approvalId = payload.approvalId as string;
  const kind = payload.kind as string;

  try {
    const approval = await api.getApproval(approvalId);

    if (kind === "command") {
      const details = commandApprovalView(approval.details as Record<string, unknown>);
      out.print();
      out.heading("Command Approval Request");
      out.keyValue([
        ["Command", details.commandLine],
        ["Cwd", details.cwd],
        ["Purpose", details.purpose],
        ["Risk", details.risk],
      ]);
      out.print();

      let decision: string | null = null;
      while (!decision) {
        const answer = (await ask("Approve command? [y]es / [n]o / [t]rust pattern: ")).trim().toLowerCase();
        if (answer === "y" || answer === "yes") decision = "allow_once";
        else if (answer === "n" || answer === "no") decision = "deny";
        else if (answer === "t" || answer === "trust") decision = "trust_project";
      }

      const approvalDecision = decision as "allow_once" | "trust_project" | "deny";
      const payload: Parameters<typeof api.resolveApproval>[1] = { projectId: approval.projectId, decision: approvalDecision };
      if (approvalDecision === "trust_project") payload.trustPattern = details.pattern;
      await api.resolveApproval(approvalId, payload);
      if (decision === "deny") out.error("Command denied.");
      else out.success(`Command approved (${decision}). Resuming task…`);
    } else if (kind === "change_set") {
      const details = changeSetApprovalView(approval.details as Record<string, unknown>);
      const proposedDiff = details.diffPreview;
      out.print();
      out.heading("Patch Proposal Approval Request");
      out.print(`${out.bold("Explanation:")} ${details.explanation}`);
      out.print(`${out.bold("Files to change:")} ${details.filesLabel}`);
      out.print();
      out.print(out.bold("Unified Diff:"));
      if (proposedDiff) {
        for (const line of proposedDiff.split("\n")) {
          if (line.startsWith("+") && !line.startsWith("+++")) out.print(out.green(line));
          else if (line.startsWith("-") && !line.startsWith("---")) out.print(out.red(line));
          else out.print(line);
        }
      } else {
        out.print("(no diff returned)");
      }
      out.print();

      let decision: string | null = null;
      while (!decision) {
        const answer = (await ask("Apply this patch? [y]es / [n]o: ")).trim().toLowerCase();
        if (answer === "y" || answer === "yes") decision = "allow_once";
        else if (answer === "n" || answer === "no") decision = "deny";
      }

      await api.resolveApproval(approvalId, { projectId: approval.projectId, decision: decision as any });
      if (decision === "deny") out.error("Patch denied.");
      else out.success("Patch approved. Applying changes and resuming task…");
    }
  } catch (err: any) {
    out.error(`Error resolving approval: ${err.message || err}`);
  }
}
