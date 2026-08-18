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

/** Matches the contract's narration ceiling. Generous by design — a narration
 * entry IS the assistant's message for that turn, not a label for it. */
const NARRATION_LIMIT = 200_000;

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
    text?: string | null;
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
    text: input.text ?? null,
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

/** Keep chat transcript legible. Low-level reads, listings, and repository
 * probes remain in durable event storage but do not each become a chat row. */
/**
 * Tools that appear as their own transcript step. This is deliberately the
 * whole tool surface, not just the mutating ones: the transcript's job is to
 * show what Morrow actually did, in order, and "read these three files, then
 * searched for this symbol, then wrote that patch" is the part a reader uses
 * to judge whether the work was grounded. Reads were previously hidden as
 * noise, which left write-only transcripts that could not be audited — the
 * evidence for a change was invisible while the change itself was shown.
 *
 * Lifecycle events (task/plan/step/workspace) remain hidden; those are audit
 * records, not things the assistant chose to do.
 */
function isTranscriptTool(toolName: string | null): boolean {
  if (!toolName) return false;
  return /^(?:run_command|propose_patch|create_file|create_directory|load_skill|find_skill|read_file|list_files|read_artifact|search_text|search_files|search_symbols|git_status|git_diff|git_log|browser_[a-z_]+)$/.test(toolName);
}

/** "browser_navigate" -> "browser navigate". The tool's own name, made
 * readable — never a friendlier name it does not actually have. */
function readableToolName(toolName: string): string {
  return toolName.replaceAll("_", " ");
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
    : toolName === "load_skill" ? ["Loading skill", "Used skill"]
    : toolName === "find_skill" ? ["Finding skill", "Found skill"]
    : kind === "command" ? ["Running", "Ran"]
    : kind === "process" ? ["Starting process", "Process finished"]
    // Anything without a hand-written verb — browser actions, artifact reads,
    // future tools — is named after the tool that ran. "Used tool" repeated
    // five times told a reader nothing and, worse, made five distinct actions
    // look like one repeated mistake.
    : toolName ? [`Using ${readableToolName(toolName)}`, `Used ${readableToolName(toolName)}`]
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
    default:
      return { kind: "evidence", summary: "Evidence recorded" };
  }
}

interface TaskProjectionState {
  seenRoute?: { provider: string | null; model: string | null; fallback: boolean } | undefined;
  initialRouteEmitted?: boolean | undefined;
  seenBudget?: {
    provider: string | null;
    model: string | null;
    contextWindowConfidence: string | null;
    contextWindowSource: string | null;
    routeLimitTokens: number | null;
    routeLimitSource: string | null;
    capacity: number | null;
    nearThreshold: boolean;
  } | undefined;
  initialBudgetEmitted?: boolean | undefined;
}

function projectEvent(
  taskId: string,
  event: TaskEvent,
  state?: TaskProjectionState,
): WebConversationActivityEntry | null {
  const payload = event.payload;
  const resultCount = nonnegativeInteger(payload.resultCount ?? payload.evidenceCount ?? payload.count);
  switch (event.type) {
    case "task.created":
    case "task.running":
    case "plan.created":
    case "step.started":
    case "step.completed":
      // Task and plan lifecycle is durable audit data, not chat activity.
      return null;
    case "workspace.inspected":
      return null;
    case "evidence.persisted": {
      const action = identifier(payload.action);
      if (action !== "patched" && action !== "created_directory") return null;
      const presentation = evidencePresentation(action);
      return entry(taskId, event, {
        ...presentation,
        status: "completed",
        target: redactActivityTarget(payload.path),
        resultCount,
      });
    }
    case "assistant.turn_started":
    case "assistant.turn_completed":
      return null;
    case "agent.state_changed": {
      const state = identifier(payload.state);
      const reasoning: Partial<Record<string, string>> = {
        understanding: "Reviewing request",
        planning: "Planning next step",
        proposing_changes: "Preparing changes",
      };
      const detail = state ? reasoning[state] : null;
      return detail ? entry(taskId, event, { kind: "assistant", status: "running", summary: "Thinking", detail }) : null;
    }
    case "approval.requested":
      return entry(taskId, event, {
        kind: "approval",
        status: "blocked",
        summary: "Approval requested",
        detail: identifier(payload.kind) ? `${identifier(payload.kind)} approval` : null,
      });
    case "approval.resolved":
      if (identifier(payload.decision) !== "deny") return null;
      return entry(taskId, event, {
        kind: "approval",
        status: identifier(payload.decision) === "deny" ? "cancelled" : "completed",
        summary: "Approval resolved",
      });
    case "verification.completed":
      return null;
    case "memory.learned": {
      const count = nonnegativeInteger(payload.count) ?? 0;
      return entry(taskId, event, {
        kind: "memory",
        status: "completed",
        summary: "Updated memory",
        detail: `${count} useful detail${count === 1 ? "" : "s"} learned`,
        resultCount: count,
      });
    }
    case "tool.started": {
      const toolName = identifier(payload.toolName);
      if (!isTranscriptTool(toolName)) return null;
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
    case "task.progress_warning": {
      // `task.progress_warning` is now a mixed channel: some reasons are real
      // recovery events, but most are observe-only telemetry that no longer
      // controls anything. Rendering all of them as "Progress warning recorded"
      // filled the Activity feed with alarming, identical, meaningless rows.
      // Each reason is projected as what it actually is.
      const reason = identifier(payload.reason);
      // Pure telemetry with no user-facing meaning.
      if (reason === "execution_policy_observed" || reason === "mission_ledger_write_failed") return null;
      if (reason === "exact_repeat_advisory") {
        return entry(taskId, event, {
          kind: "recovery",
          status: "running",
          summary: "Repeat noted for the model",
          detail: typeof payload.count === "number" && identifier(payload.toolName)
            ? `${identifier(payload.toolName)} repeated ${payload.count} times; the previous result was shown again`
            : "The previous result was shown to the model again",
          toolName: identifier(payload.toolName),
        });
      }
      if (reason === "empty_provider_response") {
        return entry(taskId, event, {
          kind: "provider",
          status: "warning",
          summary: "Provider returned no answer; retrying",
          detail: identifier(payload.providerBoundaryClassification)?.replaceAll("_", " ") ?? null,
        });
      }
      return entry(taskId, event, {
        kind: "recovery",
        status: "warning",
        summary: "Recovery evaluated",
        detail: reason?.replaceAll("_", " ") ?? null,
      });
    }
    case "task.recovery_required":
      return entry(taskId, event, {
        kind: "recovery",
        status: "warning",
        summary: "Recovery required",
        detail: identifier(payload.reason)?.replaceAll("_", " ") ?? null,
      });
    case "task.recovery_requeued":
      return entry(taskId, event, { kind: "recovery", status: "running", summary: "Mission recovered and resumed" });
    case "provider.route_selected": {
      const provider = identifier(payload.providerId);
      const model = identifier(payload.model, 300);
      const fallbackUsed = payload.fallbackUsed === true;
      const prev = state?.seenRoute;
      if (!state?.initialRouteEmitted) {
        if (state) {
          state.initialRouteEmitted = true;
          state.seenRoute = { provider, model, fallback: fallbackUsed };
        }
        return entry(taskId, event, {
          kind: "provider",
          status: "completed",
          summary: fallbackUsed ? "Route selected (fallback)" : "Route selected",
          detail: provider && model
            ? `${provider} / ${model}${payload.pinned === true ? " (pinned)" : ""}`
            : null,
          target: provider,
        });
      }
      if (prev && (prev.provider !== provider || prev.model !== model || prev.fallback !== fallbackUsed)) {
        state.seenRoute = { provider, model, fallback: fallbackUsed };
        return entry(taskId, event, {
          kind: "provider",
          status: fallbackUsed ? "warning" : "completed",
          summary: fallbackUsed ? "Route fallback used" : "Route changed",
          detail: provider && model
            ? `${provider} / ${model}${payload.pinned === true ? " (pinned)" : ""}`
            : null,
          target: provider,
        });
      }
      return null;
    }
    case "provider.reasoning_unavailable": {
      const provider = identifier(payload.provider);
      const model = identifier(payload.model, 300);
      return entry(taskId, event, {
        kind: "provider",
        status: "warning",
        summary: "Requested reasoning not supported; used route default",
        detail: typeof payload.reason === "string" ? clamp(payload.reason, 300) : null,
        target: provider && model ? `${provider} / ${model}` : provider,
      });
    }
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
      return null;
    case "context.budget_calculated": {
      // Emitted once per admitted routing candidate on every turn — a rejected
      // candidate (too large even after compaction) is diagnostic noise here,
      // not something Morrow did, so only the route(s) actually admitted reach
      // the timeline.
      if (payload.admitted !== true) return null;
      const provider = identifier(payload.provider);
      const model = identifier(payload.model, 300);
      const used = nonnegativeInteger(payload.currentModelVisibleTokens ?? payload.currentRequestTokens);
      const usable = nonnegativeInteger(payload.usableInputTokens);
      const confidence = identifier(payload.contextWindowConfidence);
      const source = identifier(payload.contextWindowSource);
      const routeLimitTokens = nonnegativeInteger(payload.routeLimitTokens);
      const routeLimitSource = identifier(payload.routeLimitSource);
      const capacity = nonnegativeInteger(payload.contextWindowTokens ?? payload.effectiveContextWindowTokens);
      const threshold = nonnegativeInteger(payload.compactionThresholdTokens);
      const nearThreshold = Boolean(used !== null && threshold !== null && used >= threshold);

      if (!state?.initialBudgetEmitted) {
        if (state) {
          state.initialBudgetEmitted = true;
          state.seenBudget = {
            provider,
            model,
            contextWindowConfidence: confidence,
            contextWindowSource: source,
            routeLimitTokens,
            routeLimitSource,
            capacity,
            nearThreshold,
          };
        }
        return entry(taskId, event, {
          kind: "context",
          status: "completed",
          summary: "Context budget calculated",
          detail: used !== null && usable !== null
            ? `${used.toLocaleString("en-US")} / ${usable.toLocaleString("en-US")} usable input tokens${confidence ? `, ${confidence}` : ""}`
            : null,
          target: provider && model ? `${provider} / ${model}` : null,
        });
      }

      const prev = state.seenBudget;
      const routeChanged = prev && (prev.provider !== provider || prev.model !== model);
      const capacitySourceChanged = prev && (prev.contextWindowSource !== source || prev.routeLimitSource !== routeLimitSource || prev.routeLimitTokens !== routeLimitTokens);
      const thresholdCrossed = prev && !prev.nearThreshold && nearThreshold;

      if (routeChanged || capacitySourceChanged || thresholdCrossed) {
        state.seenBudget = {
          provider,
          model,
          contextWindowConfidence: confidence,
          contextWindowSource: source,
          routeLimitTokens,
          routeLimitSource,
          capacity,
          nearThreshold,
        };
        if (thresholdCrossed) {
          return entry(taskId, event, {
            kind: "context",
            status: "warning",
            summary: "Context approaching compaction threshold",
            detail: used !== null && threshold !== null
              ? `${used.toLocaleString("en-US")} / ${threshold.toLocaleString("en-US")} tokens (compaction threshold)`
              : null,
            target: provider && model ? `${provider} / ${model}` : null,
          });
        }
        return entry(taskId, event, {
          kind: "context",
          status: "completed",
          summary: "Context window updated",
          detail: used !== null && usable !== null
            ? `${used.toLocaleString("en-US")} / ${usable.toLocaleString("en-US")} usable input tokens${confidence ? `, ${confidence}` : ""}`
            : null,
          target: provider && model ? `${provider} / ${model}` : null,
        });
      }

      // Routine turn recalculation with identical budget params: suppressed from timeline spam
      return null;
    }
    case "context.compaction_started":
      return entry(taskId, event, { kind: "context", status: "running", summary: "Context compaction started" });
    case "context.compaction_completed": {
      const before = nonnegativeInteger(payload.tokensBefore ?? payload.inputTokensBefore);
      const after = nonnegativeInteger(payload.tokensAfter ?? payload.inputTokensAfter);
      return entry(taskId, event, {
        kind: "context",
        status: "completed",
        summary: "Context compacted",
        detail: before !== null && after !== null
          ? `${before.toLocaleString("en-US")} → ${after.toLocaleString("en-US")} tokens`
          : null,
      });
    }
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
    case "process.exited":
      return null;
    default: {
      const terminal = TERMINAL_STATUS[event.type];
      if (terminal && terminal !== "completed") {
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
  const taskStates = new Map<string, TaskProjectionState>();
  // Narration arrives as one `evidence.persisted` event per streamed delta —
  // hundreds of them for a single paragraph. They are folded into ONE entry per
  // assistant turn, anchored at the sequence of that turn's first delta, so the
  // transcript reads as "the model said this, then ran these tools, then said
  // this" instead of a storm of fragments. Keyed by turnId, which agent.ts
  // stamps on every delta, so two turns never merge.
  const narrationByTurn = new Map<string, number>();
  for (const { taskId, event } of orderedEvents) {
    if (updateToolEntry(entries, taskId, event)) continue;

    // Narration is ONLY a pure streamed-text delta. An `evidence.persisted`
    // that carries an `action` is a durable file record, and its payload is
    // projected through the allow-list below — any `deltaText` riding along on
    // one of those is not the assistant narrating and must never be surfaced.
    const deltaText = event.type === "evidence.persisted"
      && event.payload.action === undefined
      && typeof event.payload.deltaText === "string"
      ? redactSecrets(event.payload.deltaText)
      : null;
    if (deltaText !== null) {
      const turnId = identifier(event.payload.turnId) ?? `${taskId}:turn`;
      const key = `${taskId}:${turnId}`;
      const existing = narrationByTurn.get(key);
      if (existing === undefined) {
        if (deltaText.trim().length === 0) continue;
        narrationByTurn.set(key, entries.length);
        entries.push(entry(taskId, event, {
          kind: "narration",
          status: "completed",
          summary: "Assistant message",
          text: clamp(deltaText, NARRATION_LIMIT),
          id: `${taskId}:narration:${turnId}`,
        }));
      } else {
        const current = entries[existing]!;
        entries[existing] = {
          ...current,
          text: clamp((current.text ?? "") + deltaText, NARRATION_LIMIT),
          updatedAt: event.createdAt,
        };
      }
      continue;
    }

    if (!taskStates.has(taskId)) {
      taskStates.set(taskId, {});
    }
    const state = taskStates.get(taskId)!;
    const projected = projectEvent(taskId, event, state);
    if (!projected) continue;

    const previous = entries.at(-1);
    if (projected.kind === "assistant" && previous?.taskId === taskId && previous.kind === "assistant") {
      entries[entries.length - 1] = projected;
      continue;
    }
    entries.push(projected);
  }

  return WebConversationActivitySchema.parse({
    version: 1,
    projectId: input.projectId,
    conversationId: input.conversationId,
    entries,
  });
}
