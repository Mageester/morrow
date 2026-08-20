import type Database from "better-sqlite3";
import { WebToolEvidenceSchema, type WebToolEvidence } from "@morrow/contracts";
import { conversationsRepository } from "../repositories/conversations.js";
import { redactActivityTarget } from "./activity-projection.js";

/**
 * One step's recorded output, for the evidence card behind a transcript row.
 *
 * Deliberately narrower than the operator task aggregate at `/api/tasks/:id`.
 * Tool *arguments* are excluded outright — they carry prompt text and
 * model-authored content, and a reader opening a step is asking what it
 * produced, not what it was told. What comes back is the result the tool
 * recorded, already secret-redacted at the repository seam, bounded here, and
 * honest about having been cut.
 */

/**
 * Enough to read a failing test run or a directory listing without turning the
 * conversation into a log viewer. Anything longer is still complete in durable
 * storage and reachable from the operator surfaces.
 */
const MAX_BODY_BYTES = 32_000;

/** Result shapes the tools actually produce, in the order worth showing. */
const OUTPUT_FIELDS = ["stdout", "output", "content", "text", "result", "error", "stderr"] as const;

/**
 * Renders a stored tool result as something a person can read.
 *
 * A tool result is JSON, but almost every tool puts the part a human wants
 * into one string field. Showing that field alone beats pretty-printing an
 * envelope whose other keys are bookkeeping — and when there is no such field,
 * the formatted JSON is the honest answer rather than a guess.
 */
export function renderEvidenceBody(resultJson: string | null | undefined): {
  bodyKind: WebToolEvidence["bodyKind"];
  body: string;
  truncated: boolean;
  bytes: number;
} {
  if (resultJson === null || resultJson === undefined || resultJson.trim() === "") {
    return { bodyKind: "none", body: "", truncated: false, bytes: 0 };
  }
  const bytes = Buffer.byteLength(resultJson, "utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson);
  } catch {
    return { bodyKind: "text", ...clampBody(resultJson), bytes };
  }

  if (typeof parsed === "string") return { bodyKind: "text", ...clampBody(parsed), bytes };
  if (parsed !== null && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    const chosen = OUTPUT_FIELDS.find((field) => typeof record[field] === "string" && (record[field] as string).length > 0);
    if (chosen) return { bodyKind: "text", ...clampBody(record[chosen] as string), bytes };
  }
  return { bodyKind: "json", ...clampBody(JSON.stringify(parsed, null, 2)), bytes };
}

function clampBody(value: string): { body: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= MAX_BODY_BYTES) return { body: value, truncated: false };
  // Slice on characters after a byte-budget estimate: a hard byte cut can land
  // mid-codepoint, and a card that renders a replacement character reads as a
  // corrupted recording rather than a clipped one.
  return { body: `${value.slice(0, MAX_BODY_BYTES)}`, truncated: true };
}

export interface ToolEvidenceInput {
  db: Database.Database;
  taskId: string;
  toolCallId: string;
}

/**
 * Returns the evidence, or null when this tool call does not belong to this
 * task. The caller turns that into a 404 — an evidence id from another task is
 * a scope violation, not an empty result.
 */
export function projectToolEvidence(input: ToolEvidenceInput): WebToolEvidence | null {
  const call = conversationsRepository(input.db).getToolCall(input.toolCallId);
  if (!call || call.taskId !== input.taskId) return null;

  const durationMs = call.startedAt && call.completedAt
    ? Math.max(0, Date.parse(call.completedAt) - Date.parse(call.startedAt))
    : null;

  const exitCode = readExitCode(call.resultJson);
  const target = readTarget(call.argsJson);

  return WebToolEvidenceSchema.parse({
    version: 1,
    taskId: call.taskId,
    toolCallId: call.id,
    toolName: call.toolName,
    status: call.status,
    target,
    exitCode,
    durationMs: Number.isFinite(durationMs) ? durationMs : null,
    ...renderEvidenceBody(call.resultJson ?? (call.errorMessage ? JSON.stringify({ error: call.errorMessage }) : null)),
  });
}

function readExitCode(resultJson: string | null | undefined): number | null {
  if (!resultJson) return null;
  try {
    const parsed = JSON.parse(resultJson) as { exitCode?: unknown };
    return typeof parsed.exitCode === "number" && Number.isInteger(parsed.exitCode) ? parsed.exitCode : null;
  } catch {
    return null;
  }
}

/**
 * The one field of the arguments that is safe and useful to echo: what the step
 * acted on. Routed through the same defensive redaction the activity
 * projection uses for targets, so this cannot become a side channel for the
 * rest of the arguments.
 */
function readTarget(argsJson: string): string | null {
  try {
    const parsed = JSON.parse(argsJson) as Record<string, unknown>;
    for (const field of ["path", "file", "target", "command", "url", "query", "pattern"]) {
      const value = parsed[field];
      const redacted = redactActivityTarget(typeof value === "string" ? value : undefined);
      if (redacted) return redacted;
    }
    return null;
  } catch {
    return null;
  }
}
