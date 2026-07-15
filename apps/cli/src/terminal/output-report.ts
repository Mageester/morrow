import type { ConversationMessage, ReasoningConfiguration } from "@morrow/contracts";
import { ReasoningConfigurationSchema } from "@morrow/contracts";
import type { TaskAggregate } from "../client/api.js";
import { dedupeRawEvents } from "./event-ledger.js";
import { reasoningStatusText } from "./reasoning.js";

export type ReportKind = "summary" | "full" | "failures";

export interface TaskReportOptions {
  kind: ReportKind;
  /**
   * Used ONLY when the task's persisted event log has no `assistant.turn_completed`
   * events at all — a task that predates turn-boundary tracking, or one whose
   * events haven't landed yet. Ignored whenever turn events are present, so
   * every report source (/output, /output full, /export, the live overlay)
   * agrees on the same canonical answer. See `selectCanonicalFinalAnswer`.
   */
  legacyFinalAnswerFallback?: string;
  maxToolOutputLines?: number;
}

const DEFAULT_OUTPUT_LINES = 120;
const MAX_INTERMEDIATE_TURNS_SHOWN = 20;
const MAX_INTERMEDIATE_TURN_LINES = 20;

interface TurnCompletedPayload {
  turnId: string;
  text: string;
  final: boolean;
  hasToolCalls: boolean;
  aborted?: boolean;
  sequence: number;
}

function readTurnPayload(payload: Record<string, unknown>, sequence: number): TurnCompletedPayload | null {
  if (typeof payload.turnId !== "string" || typeof payload.text !== "string") return null;
  return {
    turnId: payload.turnId,
    text: payload.text,
    final: payload.final === true,
    hasToolCalls: payload.hasToolCalls === true,
    ...(payload.aborted === true ? { aborted: true } : {}),
    sequence,
  };
}

/**
 * Every report path folds `aggregate.events` through this instead of its own
 * identity logic — `dedupeRawEvents` (`event-ledger.ts`) is the single
 * ownership boundary for "same source event," shared with the live session's
 * ingestion path so history and replay can never disagree about identity.
 */
function uniqueEvents(aggregate: TaskAggregate): TaskAggregate["events"] {
  return dedupeRawEvents(aggregate.events);
}

function completedTurns(aggregate: TaskAggregate): TurnCompletedPayload[] {
  const byTurnId = new Map<string, TurnCompletedPayload>();
  for (const event of uniqueEvents(aggregate)) {
    if (event.type !== "assistant.turn_completed") continue;
    const turn = readTurnPayload(event.payload as Record<string, unknown>, event.sequence);
    if (!turn) continue;
    const current = byTurnId.get(turn.turnId);
    if (!current || turn.sequence >= current.sequence) byTurnId.set(turn.turnId, turn);
  }
  return [...byTurnId.values()].sort((a, b) => a.sequence - b.sequence);
}

export type FinalAnswerResult =
  | { kind: "final"; text: string; source: "turn_event" | "legacy_message"; turnId?: string }
  | { kind: "none"; reason: string };

/**
 * The single source of truth for "what is the final answer" — every report
 * path calls this instead of independently concatenating or guessing, so
 * /output, /output full, /export, and the live overlay can never disagree.
 *
 * Structured `assistant.turn_completed` events (one per model turn, emitted
 * by the orchestrator) are always preferred over the legacy fallback. A task
 * with turn events but no turn ever marked `final` (cancelled or aborted
 * mid-turn) intentionally reports "no final answer" rather than picking
 * arbitrary intermediate narration.
 */
export function selectCanonicalFinalAnswer(
  aggregate: TaskAggregate,
  legacyFallback?: string | null
): FinalAnswerResult {
  const turns = completedTurns(aggregate);

  if (turns.length > 0) {
    const finalTurn = [...turns].reverse().find((t) => t.final);
    if (finalTurn && finalTurn.text.trim()) {
      return { kind: "final", text: finalTurn.text, source: "turn_event", turnId: finalTurn.turnId };
    }
    return { kind: "none", reason: "the task ended without producing a final, tool-free response (cancelled, aborted, or still in progress)" };
  }

  const legacy = legacyFallback?.trim();
  if (legacy) return { kind: "final", text: legacy, source: "legacy_message" };
  return { kind: "none", reason: "no assistant response was recorded for this task" };
}

function intermediateTurns(aggregate: TaskAggregate, finalTurnId: string | null): TurnCompletedPayload[] {
  return completedTurns(aggregate).filter((turn) => turn.turnId !== finalTurnId && !turn.final);
}

export function sanitizeReportText(input: string): string {
  return input
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\b([A-Z0-9_-]+)\s*[:=]\s*["']?[^"'\s]+/gi, (match, key: string) => {
      return isSecretKeyName(key) ? `${key}=[REDACTED]` : match;
    })
    .replace(/\b(?:sk|sk-proj|sk-ant|ghp|github_pat)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\bpassword\s*[:=]\s*["']?[^"'\s]+/gi, "password=[REDACTED]");
}

function isSecretKeyName(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized === "token" ||
    normalized.endsWith("_token") ||
    normalized.endsWith("-token") ||
    normalized.includes("api_key") ||
    normalized.includes("apikey") ||
    normalized.includes("api-key") ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.includes("credential")
  );
}

export function findLatestTaskId(messages: ConversationMessage[]): string | null {
  return [...messages]
    .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))
    .reverse()
    .find((message) => Boolean(message.taskId))?.taskId ?? null;
}

export function defaultReportFilename(taskId: string, date = new Date()): string {
  const safeTask = taskId.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "task";
  const stamp = date.toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "");
  return `morrow-task-${safeTask}-${stamp}.md`;
}

/** Files this task changed, from persisted evidence (action: patched). */
export function changedFiles(aggregate: TaskAggregate): string[] {
  const files = new Set<string>();
  for (const item of aggregate.evidence ?? []) {
    if (item.metadata && (item.metadata as Record<string, unknown>).action === "patched") files.add(item.path);
  }
  return [...files].sort();
}

/** Human duration between the task's created and last-updated timestamps. */
function taskDuration(aggregate: TaskAggregate): string | null {
  const start = Date.parse(aggregate.task.createdAt);
  const end = Date.parse(aggregate.task.updatedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}m${String(totalSeconds % 60).padStart(2, "0")}s`;
}

export function buildTaskReport(aggregate: TaskAggregate, opts: TaskReportOptions): string {
  const lines: string[] = [];
  const usage = usageFromEvents(aggregate);
  const tools = aggregate.toolCalls ?? [];
  const failed = tools.filter(isFailedTool);
  const shortId = aggregate.task.id.slice(0, 8);
  const duration = taskDuration(aggregate);

  lines.push("# Morrow Task Report", "");
  lines.push(`Task: ${shortId} (${aggregate.task.id})`);
  lines.push(`Report: ${opts.kind}`);
  lines.push(`Status: ${aggregate.task.status}`);
  lines.push(`Started: ${aggregate.task.createdAt}${duration ? ` (took ${duration})` : ""}`);
  if (aggregate.routing) lines.push(`Model: ${aggregate.routing.providerId}/${aggregate.routing.model}`);
  else if (aggregate.disclosure?.provider) lines.push(`Model: ${aggregate.disclosure.provider}/unknown`);
  lines.push(`Workspace: ${aggregate.disclosure?.workspaceScope ?? "unknown"}`);
  lines.push(`Tools: ${tools.length} calls / ${failed.length} failed`);
  const files = changedFiles(aggregate);
  if (files.length > 0) lines.push(`Files changed: ${files.join(", ")}`);
  if (aggregate.verification) lines.push(`Verification: ${aggregate.verification.status} — ${aggregate.verification.summary}`);
  // Full reports carry the metering metadata; the summary stays scannable.
  if (opts.kind === "full") {
    lines.push(`Cost: ${aggregate.disclosure?.estimatedCostUsd ?? "unknown"}`);
    lines.push(`Reasoning: ${reasoningStatusText(effectiveReasoning(aggregate))}`);
    if (usage) {
      const cachedSuffix = usage.cached !== null && usage.cached > 0
        ? usage.cacheBreakdownComplete
          ? ` / ${formatNumber(usage.cached)} cached`
          : ` / cache breakdown incomplete (known cached: at least ${formatNumber(usage.cached)})`
        : "";
      lines.push(`Tokens: ${formatNumber(usage.input)} in / ${formatNumber(usage.output)} out${cachedSuffix}`);
    } else lines.push("Tokens: unknown");
    if (aggregate.context) {
      const known = aggregate.context.contextWindowSource !== "fallback" && aggregate.context.contextWindowTokens > 0;
      const used = aggregate.context.inputTokensAfter ?? aggregate.context.inputTokensBefore;
      lines.push(`Context: ${used !== null && used !== undefined ? formatCompact(used) : "unknown"} / ${known ? formatCompact(aggregate.context.contextWindowTokens) : "unknown"}`);
    } else {
      lines.push("Context: unknown");
    }
  }
  lines.push("");

  const finalAnswer = selectCanonicalFinalAnswer(aggregate, opts.legacyFinalAnswerFallback);
  const finalTurnId = finalAnswer.kind === "final" ? finalAnswer.turnId ?? null : null;

  lines.push("## Final Answer", "");
  if (finalAnswer.kind === "final") {
    if (finalAnswer.source === "legacy_message") {
      lines.push("_Reconstructed from a task record with no turn boundaries (predates turn tracking); may read as a single unseparated block._", "");
    }
    lines.push(sanitizeReportText(finalAnswer.text.trim()), "");
  } else {
    lines.push(`_No final answer: ${finalAnswer.reason}._`, "");
  }

  if (opts.kind === "summary") {
    lines.push("## Tool Summary");
    for (const tool of tools) lines.push(toolSummaryLine(tool));
    lines.push("");
    addFailures(lines, aggregate);
    return finish(lines);
  }

  if (opts.kind === "failures") {
    addFailures(lines, aggregate);
    return finish(lines);
  }

  lines.push("## Plan");
  if (aggregate.plan.length === 0) lines.push("- No plan was recorded.");
  for (const step of aggregate.plan) lines.push(`- [${step.status}] ${sanitizeReportText(step.title)}`);
  lines.push("");

  lines.push("## Tool Activity");
  for (const tool of tools) {
    lines.push(`### ${sanitizeReportText(tool.toolName)} (${tool.status})`);
    lines.push(`Id: ${sanitizeReportText(tool.id)}`);
    lines.push(`Args: ${boundedInline(tool.argsJson, 500)}`);
    const output = toolOutputText(tool);
    if (output && !isFailedTool(tool)) {
      lines.push("", "Output:");
      lines.push(...boundedBlock(output, opts.maxToolOutputLines ?? DEFAULT_OUTPUT_LINES));
    }
    if (tool.errorMessage && !isFailedTool(tool)) lines.push(`Diagnostic: ${sanitizeReportText(tool.errorMessage)}`);
    lines.push("");
  }

  addIntermediateActivity(lines, aggregate, finalTurnId);
  addFailures(lines, aggregate);
  return finish(lines);
}

function addIntermediateActivity(lines: string[], aggregate: TaskAggregate, finalTurnId: string | null): void {
  const turns = intermediateTurns(aggregate, finalTurnId);
  if (turns.length === 0) return;
  lines.push("## Intermediate Activity");
  const shown = turns.slice(0, MAX_INTERMEDIATE_TURNS_SHOWN);
  for (const turn of shown) {
    const state = turn.aborted ? " · aborted" : turn.hasToolCalls ? " · before tool execution" : "";
    lines.push(`### ${sanitizeReportText(turn.turnId)}${state}`);
    lines.push(...boundedBlock(turn.text, MAX_INTERMEDIATE_TURN_LINES), "");
  }
  if (turns.length > shown.length) lines.push(`- [${turns.length - shown.length} more intermediate turns omitted]`);
  lines.push("");
}

function addFailures(lines: string[], aggregate: TaskAggregate): void {
  lines.push("## Recovery Summary");
  const events = uniqueEvents(aggregate);
  const failureEvents = events.filter((event) => event.type === "tool.failed");
  const strategyEvents = events.filter((event) => event.type === "tool.strategy_switch" || event.type === "patch.recovery_feedback");
  const fallbackFailures = failureEvents.length === 0
    ? aggregate.toolCalls.filter(isFailedTool)
    : [];
  if (failureEvents.length === 0 && fallbackFailures.length === 0 && strategyEvents.length === 0) {
    lines.push("No tool failures or recovery attempts were recorded.", "");
    return;
  }

  const groupedFailures = new Map<string, { tool: string; message: string; count: number }>();
  for (const event of failureEvents) {
    const payload = event.payload as Record<string, unknown>;
    const tool = stringFact(payload.toolName) ?? "tool";
    const message = stringFact(payload.message) ?? "failed";
    const key = `${tool}\u0000${message}`;
    const group = groupedFailures.get(key);
    if (group) group.count += 1;
    else groupedFailures.set(key, { tool, message, count: 1 });
  }
  for (const tool of fallbackFailures) {
    const name = tool.toolName;
    const message = tool.errorMessage ?? tool.errorType ?? "failed";
    const key = `${name}\u0000${message}`;
    const group = groupedFailures.get(key);
    if (group) group.count += 1;
    else groupedFailures.set(key, { tool: name, message, count: 1 });
  }
  for (const failure of groupedFailures.values()) {
    const count = failure.count > 1 ? ` (${failure.count} occurrences)` : "";
    lines.push(`- What failed: ${sanitizeReportText(failure.tool)} — ${boundedInline(failure.message, 200)}${count}`);
  }

  const groupedStrategies = new Map<string, { line: string; count: number }>();
  for (const event of strategyEvents) {
    const payload = event.payload as Record<string, unknown>;
    if (event.type === "tool.strategy_switch") {
      const tool = stringFact(payload.tool) ?? "tool";
      const from = stringFact(payload.from) ?? "previous approach";
      const to = stringFact(payload.to) ?? "new approach";
      const path = stringFact(payload.path);
      const reason = stringFact(payload.reason);
      const line = `${sanitizeReportText(tool)} switched from ${sanitizeReportText(from)} to ${sanitizeReportText(to)}${path ? ` for ${sanitizeReportText(path)}` : ""}${reason ? ` (${boundedInline(reason, 120)})` : ""}`;
      const group = groupedStrategies.get(line);
      if (group) group.count += 1;
      else groupedStrategies.set(line, { line, count: 1 });
      continue;
    }
    const strategy = stringFact(payload.strategy);
    if (!strategy) continue;
    const target = stringFact(payload.targetFile) ?? stringFact(payload.path);
    const detail = stringFact(payload.detail);
    const line = `${sanitizeReportText(strategy)}${target ? ` for ${sanitizeReportText(target)}` : ""}${detail ? ` — ${boundedInline(detail, 160)}` : ""}`;
    const group = groupedStrategies.get(line);
    if (group) group.count += 1;
    else groupedStrategies.set(line, { line, count: 1 });
  }
  for (const strategy of groupedStrategies.values()) {
    const count = strategy.count > 1 ? ` (${strategy.count} occurrences)` : "";
    lines.push(`- Recovery strategy: ${strategy.line}${count}.`);
  }
  const failedCount = aggregate.toolCalls.filter(isFailedTool).length;
  const total = aggregate.toolCalls.length;
  const status = aggregate.task.status.charAt(0).toUpperCase() + aggregate.task.status.slice(1);
  lines.push(`- Final outcome: Task ${status.toLowerCase()}; ${failedCount} of ${total} tool calls failed.`);
  lines.push("");
}

function stringFact(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toolSummaryLine(tool: TaskAggregate["toolCalls"][number]): string {
  const status = tool.status === "completed" ? "completed" : tool.status === "failed" ? "failed" : tool.status;
  const detail = tool.errorMessage && !isFailedTool(tool) ? ` - ${sanitizeReportText(tool.errorMessage)}` : "";
  return `- ${sanitizeReportText(tool.toolName)}: ${status}${detail}`;
}

function isFailedTool(tool: TaskAggregate["toolCalls"][number]): boolean {
  return tool.status === "failed";
}

function usageFromEvents(aggregate: TaskAggregate): { input: number; output: number; cached: number | null; cacheBreakdownComplete: boolean } | null {
  let input = 0;
  let output = 0;
  // Sums only the responses that reported a cached-token count. This is the
  // exact cumulative cached total ONLY while cacheBreakdownComplete stays
  // true; a report must never print an unqualified "N cached" once one
  // response didn't report a breakdown — that reads as an exact fact when
  // it is really a partial lower bound. It must also never print "0 cached"
  // for a task whose provider(s) simply never reported cache usage at all.
  let cached: number | null = null;
  let cacheBreakdownComplete = true;
  let found = false;
  for (const event of uniqueEvents(aggregate)) {
    if (event.type !== "provider.usage") continue;
    const p = event.payload as Record<string, unknown>;
    if (typeof p.inputTokens === "number" && typeof p.outputTokens === "number") {
      input += p.inputTokens;
      output += p.outputTokens;
      if (typeof p.cachedInputTokens === "number") cached = (cached ?? 0) + p.cachedInputTokens;
      else cacheBreakdownComplete = false;
      found = true;
    }
  }
  return found ? { input, output, cached, cacheBreakdownComplete } : null;
}

/**
 * The reasoning actually attached to the request that produced the most
 * recent response — the last `provider.usage` event's `reasoning` field, the
 * same per-response ground truth agent.ts records (see execution/agent.ts).
 * Falls back to the send-time requested value (`aggregate.routing.reasoning`)
 * only when no usage event has landed yet (task still running, or failed
 * before any response) — the two agree on every completed, successful task.
 */
function effectiveReasoning(aggregate: TaskAggregate): ReasoningConfiguration | undefined {
  const events = uniqueEvents(aggregate);
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type !== "provider.usage") continue;
    const parsed = ReasoningConfigurationSchema.safeParse((event.payload as Record<string, unknown>).reasoning);
    if (parsed.success) return parsed.data;
    break; // most recent usage event exists but carried no reasoning — Auto, not "unknown"
  }
  return aggregate.routing?.reasoning;
}

function toolOutputText(tool: TaskAggregate["toolCalls"][number]): string {
  const raw = tool.resultJson ?? tool.errorMessage ?? "";
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as { stdout?: string; stderr?: string; error?: string; exitCode?: number | null; content?: string };
    return [
      parsed.exitCode !== undefined ? `exit ${parsed.exitCode ?? "unknown"}` : "",
      parsed.stdout ?? "",
      parsed.stderr ?? "",
      parsed.error ?? "",
      parsed.content ?? "",
    ].filter(Boolean).join("\n");
  } catch {
    return raw;
  }
}

function boundedInline(value: string, max: number): string {
  const clean = sanitizeReportText(value).replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)} [truncated ${clean.length - max} chars]` : clean;
}

function boundedBlock(value: string, maxLines: number): string[] {
  const cleanLines = sanitizeReportText(value).split(/\r?\n/);
  const shown = cleanLines.slice(0, maxLines);
  if (cleanLines.length > shown.length) {
    const hidden = cleanLines.slice(shown.length);
    const redactedHidden = hidden.some((line) => line.includes("[REDACTED]"));
    shown.push(`[truncated ${hidden.length} lines${redactedHidden ? "; hidden content sanitized: [REDACTED]" : ""}]`);
  }
  return shown.map((line) => line ? `    ${line}` : "");
}

function finish(lines: string[]): string {
  const markdown = lines.map((line) => line.trimEnd()).join("\n").replace(/\n{4,}/g, "\n\n\n");
  return sanitizeReportText(markdown).trimEnd() + "\n";
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatCompact(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(value);
}
