import {
  WebConversationActivitySchema,
  type TaskEvent,
  type WebActivityKind,
  type WebActivityStatus,
  type WebConversationActivity,
  type WebConversationActivityEntry,
} from "@morrow/contracts";
import { redactSecrets } from "../provider/credentials.js";

export interface ConversationActivityProjectionInput {
  projectId: string;
  conversationId: string;
  tasks: ReadonlyArray<{
    taskId: string;
    events: readonly TaskEvent[];
  }>;
}

const TERMINAL_STATUS: Partial<Record<TaskEvent["type"], WebActivityStatus>> = {
  "task.verified": "completed",
  "task.completed": "completed",
  "task.failed": "failed",
  "task.cancelled": "cancelled",
  "task.interrupted": "warning",
};

const SECRET_ARGUMENT =
  /(--(?:api[-_]?key|token|password|passwd|secret|authorization|auth)(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/gi;
const SECRET_ASSIGNMENT =
  /\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|PASSWORD|PASSWD|SECRET|AUTHORIZATION)[A-Z0-9_]*\s*=\s*)(?:"[^"]*"|'[^']*'|\S+)/gi;
const URL_CREDENTIAL = /(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi;
const SENSITIVE_QUERY = /([?&](?:api[-_]?key|token|password|secret|authorization)=)[^&\s]+/gi;

function clamp(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Redact common credential shapes before any persisted target reaches the
 * browser. Free-form payload fields are never passed through this function:
 * they are omitted entirely by the projection allow-list. */
export function redactActivityTarget(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const redacted = redactSecrets(value.trim())
    .replace(SECRET_ARGUMENT, "$1[redacted]")
    .replace(SECRET_ASSIGNMENT, "$1[redacted]")
    .replace(URL_CREDENTIAL, "$1[redacted]@")
    .replace(SENSITIVE_QUERY, "$1[redacted]");
  return clamp(redacted, 500);
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function integer(value: unknown): number | null {
  const parsed = number(value);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

function nonnegativeInteger(value: unknown): number | null {
  const parsed = integer(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function identifier(value: unknown, max = 120): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9_.:/-]+$/.test(trimmed)) return null;
  return clamp(trimmed, max);
}

function entry(
  taskId: string,
  event: TaskEvent,
  input: {
    kind: WebActivityKind;
    status: WebActivityStatus;
    summary: string;
    detail?: string | null;
    target?: string | null;
    toolName?: string | null;
    durationMs?: number | null;
    exitCode?: number | null;
    resultCount?: number | null;
    id?: string;
  },
): WebConversationActivityEntry {
  return {
    version: 1,
    id: input.id ?? `${taskId}:event:${event.id}`,
    taskId,
    sequence: event.sequence,
    kind: input.kind,
    status: input.status,
    summary: clamp(input.summary, 240),
    detail: input.detail ? clamp(input.detail, 1000) : null,
    target: input.target ?? null,
    toolName: input.toolName ?? null,
    durationMs: input.durationMs ?? null,
    exitCode: input.exitCode ?? null,
    resultCount: input.resultCount ?? null,
    createdAt: event.createdAt,
    updatedAt: event.createdAt,
  };
}

function toolKind(toolName: string | null): WebActivityKind {
  if (toolName === "run_command") return "command";
  if (toolName === "propose_patch") return "diff";
  if (toolName && /^(?:create_file|create_directory|read_file|list_files)$/.test(toolName)) return "file";
  if (toolName && /^(?:search_|git_)/.test(toolName)) return "search";
  if (toolName && /process/.test(toolName)) return "process";
  return "tool";
}

function toolSummary(
  kind: WebActivityKind,
  status: WebActivityStatus,
  toolName: string | null,
  target: string | null,
): string {
  const verb = toolName === "read_file" ? ["Reading", "Read"]
    : toolName === "create_file" ? ["Creating", "Created"]
    : toolName === "create_directory" ? ["Creating directory", "Created directory"]
    : toolName === "list_files" ? ["Listing files", "Listed files"]
    : toolName?.startsWith("search_") ? ["Searching", "Searched"]
    : toolName?.startsWith("git_") ? ["Inspecting Git", "Inspected Git"]
    : toolName === "propose_patch" ? ["Editing", "Edited"]
    : kind === "command" ? ["Running", "Ran"]
    : kind === "process" ? ["Starting process", "Process finished"]
    : ["Using tool", "Used tool"];
  if (status === "failed") return `${verb[1]}${target ? ` ${target}` : ""} — failed`;
  return `${status === "running" ? verb[0] : verb[1]}${target ? ` ${target}` : ""}`;
}

function evidencePresentation(action: string | null): {
  kind: WebActivityKind;
  summary: string;
} {
  switch (action) {
    case "read":
      return { kind: "file", summary: "File read" };
    case "patched":
      return { kind: "file", summary: "File modified" };
    case "created_directory":
      return { kind: "file", summary: "Directory created" };
    case "browser_screenshot":
    case "browser_download":
    case "browser_vision_attached":
    case "browser_vision_reattached":
      return { kind: "evidence", summary: "Browser evidence recorded" };
    default:
      return { kind: "evidence", summary: "Evidence recorded" };
  }
}

function projectEvent(taskId: string, event: TaskEvent): WebConversationActivityEntry | null {
  const payload = event.payload;
  const resultCount = nonnegativeInteger(payload.resultCount ?? payload.evidenceCount ?? payload.count);
  switch (event.type) {
    case "task.created":
      return entry(taskId, event, { kind: "system", status: "pending", summary: "Task queued" });
    case "task.running":
      return entry(taskId, event, { kind: "system", status: "running", summary: "Task started" });
    case "plan.created":
      return entry(taskId, event, {
        kind: "plan",
        status: "completed",
        summary: "Plan created",
        detail: nonnegativeInteger(payload.stepCount) === null
          ? null
          : `${nonnegativeInteger(payload.stepCount)} planned steps`,
        resultCount: nonnegativeInteger(payload.stepCount),
      });
    case "step.started":
      return entry(taskId, event, { kind: "plan", status: "running", summary: "Plan step started" });
    case "step.completed":
      return entry(taskId, event, { kind: "plan", status: "completed", summary: "Plan step completed" });
    case "workspace.inspected": {
      const operation = identifier(payload.kind);
      const kind: WebActivityKind =
        operation?.startsWith("git_diff") ? "diff"
        : operation?.startsWith("search_") || operation?.startsWith("git_") ? "search"
        : operation?.includes("process") ? "process"
        : "search";
      const summary =
        kind === "diff" ? "Diff inspected"
        : kind === "process" ? "Process inspected"
        : operation?.startsWith("search_") ? "Repository search completed"
        : "Workspace inspected";
      return entry(taskId, event, {
        kind,
        status: "completed",
        summary,
        target: redactActivityTarget(payload.path),
        resultCount,
      });
    }
    case "evidence.persisted": {
      const action = identifier(payload.action);
      const presentation = evidencePresentation(action);
      return entry(taskId, event, {
        ...presentation,
        status: "completed",
        target: redactActivityTarget(payload.path),
        resultCount,
      });
    }
    case "assistant.turn_started":
      return entry(taskId, event, { kind: "assistant", status: "running", summary: "Morrow is working" });
    case "assistant.turn_completed":
      return entry(taskId, event, { kind: "assistant", status: "completed", summary: "Morrow finished this response" });
    case "agent.state_changed": {
      const state = identifier(payload.state);
      const presentation: Partial<Record<string, string>> = {
        understanding: "Morrow is reviewing request",
        planning: "Morrow is planning next step",
        executing_tool: "Morrow is preparing tool call",
        observing: "Morrow is reviewing tool result",
        proposing_changes: "Morrow is preparing changes",
        applying_changes: "Morrow is applying changes",
        verifying: "Morrow is verifying work",
      };
      const summary = state ? presentation[state] : null;
      return summary ? entry(taskId, event, { kind: "assistant", status: "running", summary }) : null;
    }
    case "approval.requested":
      return entry(taskId, event, {
        kind: "approval",
        status: "blocked",
        summary: "Approval requested",
        detail: identifier(payload.kind) ? `${identifier(payload.kind)} approval` : null,
      });
    case "approval.resolved":
      return entry(taskId, event, {
        kind: "approval",
        status: identifier(payload.decision) === "deny" ? "cancelled" : "completed",
        summary: "Approval resolved",
      });
    case "verification.completed":
      return entry(taskId, event, {
        kind: "validation",
        status: "completed",
        summary: "Validation completed",
        resultCount,
      });
    case "tool.started": {
      const toolName = identifier(payload.toolName);
      const kind = toolKind(toolName);
      const toolCallId = identifier(payload.id) ?? event.id;
      const cwd = redactActivityTarget(payload.cwd);
      const target = redactActivityTarget(payload.target);
      return entry(taskId, event, {
        id: `${taskId}:tool:${toolCallId}`,
        kind,
        status: "running",
        summary: toolSummary(kind, "running", toolName, target),
        detail: cwd ? `Working directory: ${cwd}` : null,
        target,
        toolName,
      });
    }
    case "tool.arguments_rejected":
      return entry(taskId, event, {
        kind: "recovery",
        status: payload.retryExhausted === true ? "failed" : "warning",
        summary: "Tool arguments rejected",
        detail: nonnegativeInteger(payload.attempts) === null
          ? null
          : `Attempt ${nonnegativeInteger(payload.attempts)}`,
        toolName: identifier(payload.toolName),
      });
    case "tool.strategy_switch":
      return entry(taskId, event, {
        kind: "recovery",
        status: "completed",
        summary: "Recovery strategy changed",
        detail: identifier(payload.to) ? `Switched to ${identifier(payload.to)?.replaceAll("_", " ")}` : null,
        target: redactActivityTarget(payload.path),
        toolName: identifier(payload.tool),
      });
    case "patch.recovery_feedback":
      return entry(taskId, event, {
        kind: "recovery",
        status: payload.retryExhausted === true ? "failed" : "warning",
        summary: "Edit recovery evaluated",
        target: redactActivityTarget(payload.targetFile),
      });
    case "task.progress_warning":
    case "task.recovery_required":
      return entry(taskId, event, {
        kind: "recovery",
        status: "warning",
        summary: event.type === "task.progress_warning" ? "Progress warning recorded" : "Recovery required",
        detail: identifier(payload.reason)?.replaceAll("_", " ") ?? null,
      });
    case "task.recovery_requeued":
      return entry(taskId, event, { kind: "recovery", status: "running", summary: "Mission recovered and resumed" });
    case "provider.fallback":
      return entry(taskId, event, {
        kind: "provider",
        status: "completed",
        summary: "Provider or model changed",
        target: identifier(payload.servedBy ?? payload.toProvider ?? payload.provider),
      });
    case "provider.error_classified":
      return entry(taskId, event, {
        kind: "provider",
        status: "warning",
        summary: "Provider failure classified",
        detail: identifier(payload.kind ?? payload.classification)?.replaceAll("_", " ") ?? null,
      });
    case "provider.rate_limited":
      return entry(taskId, event, { kind: "provider", status: "warning", summary: "Provider rate limit detected" });
    case "provider.tool_syntax_normalized":
      return entry(taskId, event, { kind: "recovery", status: "completed", summary: "Tool syntax normalized" });
    case "context.compaction_started":
      return entry(taskId, event, { kind: "context", status: "running", summary: "Context compaction started" });
    case "context.compaction_completed":
      return entry(taskId, event, {
        kind: "context",
        status: "completed",
        summary: "Context compacted",
        detail: nonnegativeInteger(payload.compactedTokens ?? payload.inputTokensAfter) === null
          ? null
          : `${nonnegativeInteger(payload.compactedTokens ?? payload.inputTokensAfter)?.toLocaleString("en-US")} tokens retained`,
      });
    case "context.compaction_failed":
      return entry(taskId, event, { kind: "context", status: "failed", summary: "Context compaction failed" });
    case "context.history_trimmed":
    case "context.trimmed":
      return entry(taskId, event, { kind: "context", status: "completed", summary: "Older context summarized" });
    case "context.safety_fallback_applied":
      return entry(taskId, event, { kind: "context", status: "warning", summary: "Context safety fallback applied" });
    case "context.minimum_viable_context_exceeded":
      return entry(taskId, event, { kind: "context", status: "blocked", summary: "Context limit blocked this request" });
    case "process.started":
      return entry(taskId, event, {
        kind: "process",
        status: "running",
        summary: "Background process started",
        target: redactActivityTarget(payload.command ?? payload.target),
      });
    case "process.exited":
      return entry(taskId, event, {
        kind: "process",
        status: integer(payload.exitCode) === 0 ? "completed" : "failed",
        summary: integer(payload.exitCode) === 0 ? "Background process exited" : "Background process failed",
        exitCode: integer(payload.exitCode),
      });
    default: {
      const terminal = TERMINAL_STATUS[event.type];
      if (terminal) {
        const summary =
          event.type === "task.verified" ? "Task completed with evidence"
          : event.type === "task.completed" ? "Task completed"
          : event.type === "task.failed" ? "Task failed"
          : event.type === "task.cancelled" ? "Task cancelled"
          : "Task interrupted";
        return entry(taskId, event, { kind: "system", status: terminal, summary });
      }
      // Provider usage, exact token counting, agent-state internals, and other
      // noisy implementation events stay out of the calm browser transcript.
      return null;
    }
  }
}

function updateToolEntry(
  entries: WebConversationActivityEntry[],
  taskId: string,
  event: TaskEvent,
): boolean {
  if (event.type !== "tool.failed" && event.type !== "tool.completed") return false;
  const toolName = identifier(event.payload.toolName);
  const requestedId = identifier(event.payload.id);
  let index = requestedId
    ? entries.findIndex((item) => item.id === `${taskId}:tool:${requestedId}`)
    : -1;
  if (index < 0) {
    for (let cursor = entries.length - 1; cursor >= 0; cursor -= 1) {
      const candidate = entries[cursor]!;
      if (
        candidate.taskId === taskId
        && candidate.status === "running"
        && candidate.toolName === toolName
        && ["tool", "command", "file", "diff", "search", "process"].includes(candidate.kind)
      ) {
        index = cursor;
        break;
      }
    }
  }
  if (index < 0) return false;

  const current = entries[index]!;
  const status: WebActivityStatus =
    event.type === "tool.failed" || event.payload.status === "failed" ? "failed" : "completed";
  entries[index] = {
    ...current,
    status,
    summary: toolSummary(current.kind, status, current.toolName, current.target),
    // Keep the richer started-state detail (e.g. working directory) when one
    // exists; the failed status already conveys the outcome classification.
    detail: current.detail ?? identifier(event.payload.classification)?.replaceAll("_", " ") ?? null,
    durationMs: nonnegativeInteger(event.payload.elapsedMs) ?? current.durationMs,
    exitCode: integer(event.payload.exitCode) ?? current.exitCode,
    updatedAt: event.createdAt,
  };
  return true;
}

export function projectConversationActivity(
  input: ConversationActivityProjectionInput,
): WebConversationActivity {
  const orderedEvents = input.tasks
    .flatMap(({ taskId, events }, taskIndex) =>
      events.map((event) => ({ event, taskId, taskIndex })),
    )
    .sort((left, right) =>
      left.event.createdAt.localeCompare(right.event.createdAt)
      || left.taskIndex - right.taskIndex
      || left.event.sequence - right.event.sequence
      || left.event.id.localeCompare(right.event.id),
    );

  const entries: WebConversationActivityEntry[] = [];
  for (const { taskId, event } of orderedEvents) {
    if (updateToolEntry(entries, taskId, event)) continue;
    const projected = projectEvent(taskId, event);
    if (projected) entries.push(projected);
  }

  return WebConversationActivitySchema.parse({
    version: 1,
    projectId: input.projectId,
    conversationId: input.conversationId,
    entries,
  });
}
