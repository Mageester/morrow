/**
 * Morrow Harness Benchmark v1 — metric projection.
 *
 * Every metric here is derived from durable evidence a run already produces
 * (task events plus recorded tool calls). Nothing in this module influences
 * execution; it only reads what happened.
 */
import type { ToolCallRecord } from "../src/repositories/conversations.js";

export interface BenchmarkEvent {
  type: string;
  payload: Record<string, unknown>;
  createdAt?: string;
}

export interface BenchmarkMetrics {
  /** Provider stream attempts (one per real request, including retries). */
  modelRequests: number;
  toolCalls: number;
  failedToolCalls: number;
  rejectedToolArguments: number;
  providerRetries: number;
  compactions: number;
  /** Advisory "you already did this" style observations. Never a stop. */
  repeatAdvisories: number;
  interruptions: number;
  filesRead: number;
  filesChanged: number;
  redundantUnchangedFileReads: number;
  redundantEquivalentWrites: number;
  /** ms from run start to the first successful mutating tool call. */
  timeToFirstMutationMs: number | null;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number | null;
  /** Largest observed request size against the route's window, when known. */
  peakContextTokens: number | null;
  contextWindowTokens: number | null;
}

const READ_TOOLS = new Set(["read_file", "inspect_workspace", "list_files", "search_text", "search_files", "search_symbols", "git_diff", "git_status", "git_log", "read_artifact"]);
const WRITE_TOOLS = new Set(["create_file", "append_file", "propose_patch", "create_directory"]);

function parseArgs(record: ToolCallRecord): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(record.argsJson);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function pathOf(args: Record<string, unknown>): string | null {
  const value = args.path ?? args.file ?? args.filePath;
  return typeof value === "string" ? value : null;
}

function numberAt(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function projectBenchmarkMetrics(input: {
  events: ReadonlyArray<BenchmarkEvent>;
  toolCalls: ReadonlyArray<ToolCallRecord>;
  startedAtMs: number;
}): BenchmarkMetrics {
  const { events, toolCalls } = input;

  const readPaths = new Set<string>();
  const changedPaths = new Set<string>();
  let redundantUnchangedFileReads = 0;
  let redundantEquivalentWrites = 0;
  let timeToFirstMutationMs: number | null = null;
  // A read is redundant when the same path is read again with no intervening
  // write to it; a write is redundant when the identical payload is written to
  // the same path twice. Both are efficiency observations only.
  const readSinceWrite = new Set<string>();
  const lastWritePayload = new Map<string, string>();

  for (const record of toolCalls) {
    const args = parseArgs(record);
    const path = pathOf(args);
    if (READ_TOOLS.has(record.toolName) && path) {
      readPaths.add(path);
      if (readSinceWrite.has(path)) redundantUnchangedFileReads++;
      readSinceWrite.add(path);
    }
    if (WRITE_TOOLS.has(record.toolName) && path && record.status === "completed") {
      changedPaths.add(path);
      readSinceWrite.delete(path);
      const payload = JSON.stringify([record.toolName, args]);
      if (lastWritePayload.get(path) === payload) redundantEquivalentWrites++;
      lastWritePayload.set(path, payload);
      if (timeToFirstMutationMs === null) {
        const at = record.completedAt ?? record.startedAt ?? record.createdAt;
        const parsed = Date.parse(at);
        if (Number.isFinite(parsed)) timeToFirstMutationMs = Math.max(0, parsed - input.startedAtMs);
      }
    }
  }

  const usageEvents = events.filter((event) => event.type === "provider.usage");
  const promptTokens = usageEvents.reduce((total, event) => total + (numberAt(event.payload, "totalInputTokens") ?? 0), 0);
  const completionTokens = usageEvents.reduce((total, event) => total + (numberAt(event.payload, "outputTokens") ?? 0), 0);
  const cachedSamples = usageEvents.map((event) => numberAt(event.payload, "cachedInputTokens")).filter((value): value is number => value !== null);

  const budgetEvents = events.filter((event) => event.type === "context.budget_calculated");
  const peakContextTokens = budgetEvents
    .map((event) => numberAt(event.payload, "totalRequestTokens") ?? numberAt(event.payload, "inputTokens"))
    .filter((value): value is number => value !== null)
    .reduce<number | null>((peak, value) => (peak === null ? value : Math.max(peak, value)), null);
  const contextWindowTokens = budgetEvents
    .map((event) => numberAt(event.payload, "contextWindow") ?? numberAt(event.payload, "windowTokens"))
    .find((value): value is number => value !== null) ?? null;

  const requestStarts = events.filter((event) => event.type === "provider.request_started").length;

  return {
    modelRequests: requestStarts > 0 ? requestStarts : usageEvents.length,
    toolCalls: toolCalls.length,
    failedToolCalls: toolCalls.filter((record) => record.status === "failed").length,
    rejectedToolArguments: events.filter((event) => event.type === "tool.arguments_rejected").length,
    providerRetries: events.filter((event) => event.type === "provider.fallback" || event.type === "provider.rate_limited").length,
    compactions: events.filter((event) => event.type === "context.compaction_completed").length,
    repeatAdvisories: events.filter((event) => event.type === "workspace.inspected" && event.payload.duplicate === true).length,
    // Any durable interruption of the run, including budget exhaustion.
    interruptions: events.filter((event) => event.type === "task.interrupted" || (event.type === "task.progress_warning" && event.payload.disposition === "interrupt")).length,
    filesRead: readPaths.size,
    filesChanged: changedPaths.size,
    redundantUnchangedFileReads,
    redundantEquivalentWrites,
    timeToFirstMutationMs,
    promptTokens,
    completionTokens,
    cachedPromptTokens: cachedSamples.length > 0 ? cachedSamples.reduce((total, value) => total + value, 0) : null,
    peakContextTokens,
    contextWindowTokens,
  };
}
