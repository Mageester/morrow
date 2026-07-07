import type { MissionService } from "./service.js";

/**
 * Bridges agent tool execution to the mission failure ledger.
 *
 * Beta.20's acceptance run surfaced the gap this closes: an implementing agent
 * could burn multiple malformed-patch attempts while `/failures` reported
 * nothing, because nothing on the execution path ever called
 * `MissionService.recordFailure`. Agent runs for mission-linked tasks now
 * report through this reporter, which:
 *
 * - filters harmless transient noise (safe-read policy rejections the agent
 *   self-corrects from, and empty/whitespace messages) so the ledger stays
 *   meaningful;
 * - normalizes each failure into the mission's signature buckets, preserving
 *   attempt counts and feeding mission-level loop detection;
 * - marks a failure bucket recovered when a later attempt of the same tool
 *   against the same target succeeds;
 * - never lets ledger bookkeeping break execution (all calls are guarded).
 */

/** Error types the agent loop assigns that are not mission-meaningful. */
const NOISE_ERROR_TYPES = new Set(["safe_read_rejected"]);

/** Extract a stable, human-meaningful target from tool args for the operation string. */
function describeTarget(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  for (const key of ["path", "file", "filePath", "target"]) {
    if (typeof a[key] === "string" && a[key]) return String(a[key]);
  }
  if (typeof a.command === "string" && a.command) return String(a.command).slice(0, 120);
  // propose_patch carries the diff; name the first patched file instead of the body.
  if (typeof a.patch === "string") {
    const m = /^[+-]{3} [ab]\/(\S+)/m.exec(String(a.patch));
    if (m) return m[1]!;
  }
  return "";
}

export interface MissionToolFailureReporter {
  /** Record a meaningful tool failure in the mission ledger. Safe to call unconditionally. */
  reportFailure(toolName: string, args: unknown, message: string, errorType: string | null): void;
  /** Mark the newest unrecovered failure for this tool+target recovered. */
  reportSuccess(toolName: string, args: unknown): void;
}

const NOOP: MissionToolFailureReporter = { reportFailure() {}, reportSuccess() {} };

export function createMissionToolFailureReporter(options: {
  service: MissionService | null;
  missionId: string | null | undefined;
  taskId: string;
  agentId?: string | null;
  log?: (message: string) => void;
}): MissionToolFailureReporter {
  const { service, missionId, taskId, agentId, log } = options;
  if (!service || !missionId) return NOOP;

  // operation bucket (tool + target) → unrecovered failures + latest strategy.
  const openFailures = new Map<string, { failureIds: string[]; strategy: string | null }>();

  const bucket = (toolName: string, args: unknown) => `${toolName} ${describeTarget(args)}`.trim();

  return {
    reportFailure(toolName, args, message, errorType) {
      try {
        if (errorType && NOISE_ERROR_TYPES.has(errorType)) return;
        if (!message || !message.trim()) return;
        const operation = bucket(toolName, args).slice(0, 500);
        const { failure, plan } = service.recordFailure(missionId, operation, message, {
          taskId,
          ...(agentId ? { agentId } : {}),
          escalation: "loop-only",
        });
        const open = openFailures.get(operation) ?? { failureIds: [], strategy: null };
        open.failureIds.push(failure.id);
        open.strategy = plan.strategy;
        openFailures.set(operation, open);
      } catch (err) {
        log?.(`mission failure ledger write failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    reportSuccess(toolName, args) {
      try {
        const operation = bucket(toolName, args).slice(0, 500);
        const open = openFailures.get(operation);
        if (!open) return;
        openFailures.delete(operation);
        for (const failureId of open.failureIds) {
          service.markRecovered(missionId, failureId, open.strategy ?? "subsequent-attempt-succeeded");
        }
      } catch (err) {
        log?.(`mission failure recovery mark failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
