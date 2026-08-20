import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import type Database from "better-sqlite3";
import { filterEnv } from "../tools/command-executor.js";
import { stableStringify } from "../execution/loop-detector.js";

export type ActionAttemptStatus = "running" | "succeeded" | "failed" | "suppressed";

export interface ActionAttempt {
  id: string;
  taskId: string;
  missionId: string | null;
  toolCallId: string;
  actionKind: string;
  normalizedSignature: string;
  command: { executable: string; args: string[] } | null;
  cwd: string | null;
  environmentFingerprint: string;
  attemptNumber: number;
  strategy: string;
  status: ActionAttemptStatus;
  exitStatus: number | null;
  terminationReason: string | null;
  failureCategory: string | null;
  failureFingerprint: string | null;
  progressFingerprint: string | null;
  createdAt: string;
  completedAt: string | null;
}

type StartActionAttempt = Pick<
  ActionAttempt,
  | "id"
  | "taskId"
  | "missionId"
  | "toolCallId"
  | "actionKind"
  | "normalizedSignature"
  | "command"
  | "cwd"
  | "environmentFingerprint"
  | "strategy"
  | "createdAt"
>;

type FinishActionAttempt = Pick<
  ActionAttempt,
  | "status"
  | "exitStatus"
  | "terminationReason"
  | "failureCategory"
  | "failureFingerprint"
  | "progressFingerprint"
  | "completedAt"
>;

const SECRET_ARGUMENT = /(?:api[-_]?key|token|secret|password|authorization|bearer)/i;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function executableName(executable: string): string {
  const file = basename(executable.trim()).toLowerCase();
  const extension = extname(file);
  return [".cmd", ".exe", ".bat"].includes(extension) ? file.slice(0, -extension.length) : file;
}

function normalizedCwd(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim().replaceAll("\\", "/").replace(/\/+/g, "/").replace(/\/$/, "");
  return normalized === "." ? "" : normalized.toLowerCase();
}

function normalizedCommandArgs(executable: string, value: unknown): string[] {
  const args = Array.isArray(value)
    ? value.filter((argument): argument is string => typeof argument === "string").map((argument) => argument.trim())
    : [];
  if (["npm", "pnpm", "yarn"].includes(executable) && args[0]?.toLowerCase() === "run") return args.slice(1);
  return args;
}

/**
 * Stable, secret-safe identity for retry decisions. The durable value contains
 * only action kind plus a digest; raw tool payloads never enter retry memory.
 */
export function normalizeActionSignature(actionKind: string, args: unknown): string {
  const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const canonical = actionKind === "run_command"
    ? {
        executable: executableName(typeof input.executable === "string" ? input.executable : ""),
        args: normalizedCommandArgs(
          executableName(typeof input.executable === "string" ? input.executable : ""),
          input.args,
        ),
        cwd: normalizedCwd(input.cwd),
        background: input.background === true,
      }
    : input;
  return `${actionKind}:${sha256(stableStringify(canonical))}`;
}

/** Hash only command-executor allowlisted environment values, never secrets. */
export function actionEnvironmentFingerprint(env: NodeJS.ProcessEnv): string {
  return sha256(stableStringify(filterEnv(env)));
}

function redactCommand(command: StartActionAttempt["command"]): StartActionAttempt["command"] {
  if (!command) return null;
  return {
    executable: command.executable,
    args: command.args.map((argument, index, args) => {
      if (SECRET_ARGUMENT.test(argument)) return "<redacted>";
      if (index > 0 && SECRET_ARGUMENT.test(args[index - 1] ?? "")) return "<redacted>";
      return argument;
    }),
  };
}

function map(row: any): ActionAttempt {
  return {
    id: row.id,
    taskId: row.task_id,
    missionId: row.mission_id ?? null,
    toolCallId: row.tool_call_id,
    actionKind: row.action_kind,
    normalizedSignature: row.normalized_signature,
    command: row.command_json ? JSON.parse(row.command_json) : null,
    cwd: row.cwd ?? null,
    environmentFingerprint: row.environment_fingerprint,
    attemptNumber: row.attempt_number,
    strategy: row.strategy,
    status: row.status,
    exitStatus: row.exit_status ?? null,
    terminationReason: row.termination_reason ?? null,
    failureCategory: row.failure_category ?? null,
    failureFingerprint: row.failure_fingerprint ?? null,
    progressFingerprint: row.progress_fingerprint ?? null,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? null,
  };
}

export function actionAttemptsRepository(db: Database.Database) {
  const scopeClause = (missionId: string | null) => missionId
    ? { sql: "mission_id=?", value: missionId }
    : { sql: "task_id=?", value: null as string | null };

  const scopedAttempts = (taskId: string, missionId: string | null, signature?: string): ActionAttempt[] => {
    const scope = scopeClause(missionId);
    const scopeValue = missionId ?? taskId;
    const rows = db.prepare(`SELECT * FROM action_attempts
      WHERE ${scope.sql}${signature ? " AND normalized_signature=?" : ""}
      ORDER BY created_at ASC,rowid ASC`)
      .all(...(signature ? [scopeValue, signature] : [scopeValue]));
    return rows.map(map);
  };

  return {
    start(input: StartActionAttempt): ActionAttempt {
      const prior = scopedAttempts(input.taskId, input.missionId, input.normalizedSignature);
      const attemptNumber = prior.length + 1;
      db.prepare(`INSERT INTO action_attempts
        (id,task_id,mission_id,tool_call_id,action_kind,normalized_signature,command_json,cwd,
         environment_fingerprint,attempt_number,strategy,status,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          input.id,
          input.taskId,
          input.missionId,
          input.toolCallId,
          input.actionKind,
          input.normalizedSignature,
          input.command ? JSON.stringify(redactCommand(input.command)) : null,
          input.cwd || null,
          input.environmentFingerprint,
          attemptNumber,
          input.strategy,
          "running",
          input.createdAt,
        );
      return map(db.prepare("SELECT * FROM action_attempts WHERE id=?").get(input.id));
    },

    finish(id: string, outcome: FinishActionAttempt): ActionAttempt {
      db.prepare(`UPDATE action_attempts SET
        status=?,exit_status=?,termination_reason=?,failure_category=?,failure_fingerprint=?,
        progress_fingerprint=?,completed_at=? WHERE id=?`)
        .run(
          outcome.status,
          outcome.exitStatus,
          outcome.terminationReason,
          outcome.failureCategory,
          outcome.failureFingerprint,
          outcome.progressFingerprint,
          outcome.completedAt,
          id,
        );
      const row = db.prepare("SELECT * FROM action_attempts WHERE id=?").get(id);
      if (!row) throw new Error(`Unknown action attempt ${id}`);
      return map(row);
    },

    listForTask(taskId: string): ActionAttempt[] {
      return (db.prepare("SELECT * FROM action_attempts WHERE task_id=? ORDER BY created_at,id").all(taskId) as any[]).map(map);
    },

    shouldSuppress(
      taskId: string,
      missionId: string | null,
      signature: string,
      currentProgressFingerprint: string | null = null,
    ): { suppress: boolean; failedAttempts: number; reason: string } {
      const attempts = scopedAttempts(taskId, missionId, signature);
      const latest = attempts.at(-1);
      if (!latest || latest.status === "succeeded") {
        return { suppress: false, failedAttempts: 0, reason: "No unresolved failed attempt exists." };
      }
      const unresolved: ActionAttempt[] = [];
      for (let index = attempts.length - 1; index >= 0; index--) {
        const attempt = attempts[index]!;
        if (attempt.status === "succeeded") break;
        if (attempt.status === "failed" || attempt.status === "suppressed") unresolved.unshift(attempt);
      }
      const progressChanged = currentProgressFingerprint !== null
        && unresolved.some((attempt) =>
          attempt.progressFingerprint !== null
          && attempt.progressFingerprint !== currentProgressFingerprint);
      if (progressChanged) {
        return {
          suppress: false,
          failedAttempts: unresolved.length,
          reason: "Workspace progress changed after the prior failure.",
        };
      }
      return {
        suppress: unresolved.length >= 2,
        failedAttempts: unresolved.length,
        reason: unresolved.length >= 2
          ? "Identical failed action already repeated without meaningful change; select a different strategy."
          : "One bounded retry remains after the first failed attempt.",
      };
    },

    detectOscillation(taskId: string, missionId: string | null): {
      oscillating: boolean;
      signatures: string[];
    } {
      const recent = scopedAttempts(taskId, missionId)
        .filter((attempt) => attempt.status === "failed" || attempt.status === "suppressed")
        .slice(-4);
      if (
        recent.length === 4
        && recent[0]!.normalizedSignature === recent[2]!.normalizedSignature
        && recent[1]!.normalizedSignature === recent[3]!.normalizedSignature
        && recent[0]!.normalizedSignature !== recent[1]!.normalizedSignature
      ) {
        return {
          oscillating: true,
          signatures: [recent[0]!.normalizedSignature, recent[1]!.normalizedSignature],
        };
      }
      return { oscillating: false, signatures: [] };
    },
  };
}
