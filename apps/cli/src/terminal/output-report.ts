import type { ConversationMessage } from "@morrow/contracts";
import type { TaskAggregate } from "../client/api.js";

export type ReportKind = "summary" | "full" | "failures";

export interface TaskReportOptions {
  kind: ReportKind;
  finalAnswer?: string;
  maxToolOutputLines?: number;
}

const DEFAULT_OUTPUT_LINES = 120;

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

export function buildTaskReport(aggregate: TaskAggregate, opts: TaskReportOptions): string {
  const lines: string[] = [];
  const usage = usageFromEvents(aggregate);
  const tools = aggregate.toolCalls ?? [];
  const failed = tools.filter((tool) => tool.status === "failed");

  lines.push("# Morrow Task Report", "");
  lines.push(`Task: ${aggregate.task.id}`);
  lines.push(`Status: ${aggregate.task.status}`);
  if (aggregate.routing) lines.push(`Model: ${aggregate.routing.providerId}/${aggregate.routing.model}`);
  else if (aggregate.disclosure?.provider) lines.push(`Model: ${aggregate.disclosure.provider}/unknown`);
  lines.push(`Workspace: ${aggregate.disclosure?.workspaceScope ?? "unknown"}`);
  lines.push(`Cost: ${aggregate.disclosure?.estimatedCostUsd ?? "unknown"}`);
  if (usage) lines.push(`Tokens: ${formatNumber(usage.input)} in / ${formatNumber(usage.output)} out${usage.cached > 0 ? ` / ${formatNumber(usage.cached)} cached` : ""}`);
  else lines.push("Tokens: unknown");
  if (aggregate.context) {
    const known = aggregate.context.contextWindowSource !== "fallback" && aggregate.context.contextWindowTokens > 0;
    const used = aggregate.context.inputTokensAfter ?? aggregate.context.inputTokensBefore;
    lines.push(`Context: ${used !== null && used !== undefined ? formatCompact(used) : "unknown"} / ${known ? formatCompact(aggregate.context.contextWindowTokens) : "unknown"}`);
  } else {
    lines.push("Context: unknown");
  }
  lines.push(`Tools: ${tools.length} calls / ${failed.length} failed`, "");

  if (opts.finalAnswer?.trim()) {
    lines.push("## Final Answer", "", sanitizeReportText(opts.finalAnswer.trim()), "");
  }

  if (opts.kind === "summary") {
    lines.push("## Tool Summary");
    for (const tool of tools) lines.push(toolSummaryLine(tool));
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
    if (output) {
      lines.push("", "Output:");
      lines.push(...boundedBlock(output, opts.maxToolOutputLines ?? DEFAULT_OUTPUT_LINES));
    }
    if (tool.errorMessage) lines.push(`Error: ${sanitizeReportText(tool.errorMessage)}`);
    lines.push("");
  }

  addFailures(lines, aggregate);
  return finish(lines);
}

function addFailures(lines: string[], aggregate: TaskAggregate): void {
  lines.push("## Failures And Recovery");
  const failures = aggregate.toolCalls.filter((tool) => tool.status === "failed" || tool.errorMessage);
  const recoveryEvents = aggregate.events.filter((event) => /recovery|strategy|failed/i.test(event.type));
  if (failures.length === 0 && recoveryEvents.length === 0) {
    lines.push("No tool failures or recovery attempts were recorded.", "");
    return;
  }
  for (const tool of failures) lines.push(`- ${sanitizeReportText(tool.toolName)}: ${sanitizeReportText(tool.errorMessage ?? tool.errorType ?? "failed")}`);
  for (const event of recoveryEvents) {
    const payload = JSON.stringify(event.payload);
    lines.push(`- ${event.type}: ${boundedInline(payload, 240)}`);
  }
  lines.push("");
}

function toolSummaryLine(tool: TaskAggregate["toolCalls"][number]): string {
  const status = tool.status === "completed" ? "completed" : tool.status === "failed" ? "failed" : tool.status;
  const detail = tool.errorMessage ? ` - ${sanitizeReportText(tool.errorMessage)}` : "";
  return `- ${sanitizeReportText(tool.toolName)}: ${status}${detail}`;
}

function usageFromEvents(aggregate: TaskAggregate): { input: number; output: number; cached: number } | null {
  let input = 0;
  let output = 0;
  let cached = 0;
  let found = false;
  for (const event of aggregate.events) {
    if (event.type !== "provider.usage") continue;
    const p = event.payload as Record<string, unknown>;
    if (typeof p.inputTokens === "number" && typeof p.outputTokens === "number") {
      input += p.inputTokens;
      output += p.outputTokens;
      if (typeof p.cachedInputTokens === "number") cached += p.cachedInputTokens;
      found = true;
    }
  }
  return found ? { input, output, cached } : null;
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
  return shown.map((line) => `    ${line}`);
}

function finish(lines: string[]): string {
  return sanitizeReportText(lines.join("\n").replace(/\n{4,}/g, "\n\n\n")).trimEnd() + "\n";
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
