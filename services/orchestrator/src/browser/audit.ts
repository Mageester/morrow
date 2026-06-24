import { sanitizeForModel } from "./injection-guard.js";
import type { AuditEntryInput } from "../audit/log.js";
import type { BrowserAuditSink } from "./types.js";

export interface BrowserAuditLog {
  append(entry: AuditEntryInput): unknown;
}

export interface BrowserAuditContext {
  projectId: string | null;
  taskId: string | null;
  now?: () => string;
}

const SENSITIVE_KEY = /password|secret|token|cookie|authorization|credential/i;

function sanitizeAuditValue(value: unknown, key = ""): unknown {
  if (SENSITIVE_KEY.test(key)) return "[redacted]";
  if (typeof value === "string") return sanitizeForModel(value).text.slice(0, 512);
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => sanitizeAuditValue(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 50).map(([entryKey, entryValue]) => [entryKey, sanitizeAuditValue(entryValue, entryKey)]));
  }
  return value;
}

/** Turns controller events into append-only, task-scoped audit records. */
export function browserAuditSink(log: BrowserAuditLog, context: BrowserAuditContext): BrowserAuditSink {
  return (entry) => {
    log.append({
      projectId: context.projectId,
      taskId: context.taskId,
      kind: entry.action,
      detail: sanitizeAuditValue(entry.detail) as Record<string, unknown>,
      createdAt: (context.now ?? (() => new Date().toISOString()))(),
    });
  };
}
