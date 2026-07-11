import type { Task } from "@morrow/contracts";
import type { ReportKind } from "./output-report.js";

export type TaskReferenceResolution =
  | { status: "resolved"; id: string }
  | { status: "invalid"; ref: string }
  | { status: "not-found"; ref: string }
  | { status: "ambiguous"; ref: string; count: number; candidates: string[] };

export function parseTaskReportArgs(input: string): { kind: ReportKind; ref?: string } {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  const first = tokens[0];
  const kind: ReportKind = first === "full" || first === "failures" ? first : "summary";
  const ref = kind === "summary" ? first : tokens[1];
  return { kind, ...(ref ? { ref } : {}) };
}

/** Resolve only within tasks already scoped to the active project. */
export function resolveTaskReference(tasks: readonly Task[], input: string): TaskReferenceResolution {
  const ref = input.trim();
  if (!ref || !/^[A-Za-z0-9_-]+$/.test(ref)) return { status: "invalid", ref: input };
  const matches = tasks.filter((task) => task.id === ref || task.id.startsWith(ref));
  if (matches.length === 1) return { status: "resolved", id: matches[0]!.id };
  if (matches.length === 0) return { status: "not-found", ref };
  return { status: "ambiguous", ref, count: matches.length, candidates: matches.slice(0, 5).map((task) => task.id) };
}
