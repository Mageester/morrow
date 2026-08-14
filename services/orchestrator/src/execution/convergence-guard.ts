import { createHash } from "node:crypto";
import { posix } from "node:path";

export interface ConvergenceCall {
  toolName: string;
  args: unknown;
  outcome?: "success" | "failure";
  /** True only when the operation changed durable state. */
  changed?: boolean;
  /** True when this call delivered a previously absent required artifact. */
  newArtifact?: boolean;
}

export interface ConvergenceProgress {
  newArtifact?: boolean;
  requirementChanged?: boolean;
  verificationPassed?: boolean;
  diagnosticChanged?: boolean;
  appMilestone?: boolean;
}

export interface ConvergenceObservation {
  calls: ConvergenceCall[];
  progress?: ConvergenceProgress;
}

export interface ConvergenceTargetSnapshot {
  key: string;
  callCount: number;
  uniqueArgumentCount: number;
  changedCallCount: number;
  noOpCallCount: number;
}

export interface ConvergenceSnapshot {
  version: 1;
  nonProgressCycles: number;
  exactCounts: Array<{ signature: string; count: number }>;
  targets: ConvergenceTargetSnapshot[];
}

export interface ConvergenceDecision {
  exactRepeat: { signature: string; count: number } | null;
  churn: {
    identity: ReturnType<typeof canonicalOperationIdentity>;
    callCount: number;
    uniqueArgumentCount: number;
  } | null;
  nonProgressCycles: number;
  stalled: boolean;
  reason?: "same_target_write_churn" | "repeated_write";
  advisory?: string;
}

export interface ConvergenceGuard {
  observeTurn(observation: ConvergenceObservation): ConvergenceDecision;
  snapshot(): ConvergenceSnapshot;
  restore(snapshot: ConvergenceSnapshot | null | undefined): void;
}

const WRITE_TOOLS = new Set(["create_file", "append_file", "propose_patch", "create_directory"]);

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

function argumentHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function normalizeTargetPath(value: string): string {
  const replaced = value.replace(/\\/g, "/").trim();
  const normalized = posix.normalize(replaced || ".").replace(/^\.\//, "");
  return normalized === "." ? "." : normalized;
}

function targetFor(toolName: string, args: unknown): string {
  const record = args && typeof args === "object" && !Array.isArray(args)
    ? args as Record<string, unknown>
    : {};
  if (typeof record.path === "string" && record.path.trim()) return normalizeTargetPath(record.path);
  if (Array.isArray(record.files)) {
    const files = record.files.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
      .map(normalizeTargetPath)
      .sort();
    if (files.length > 0) return files.join(",");
  }
  if (typeof record.patch === "string") {
    const paths = [...record.patch.matchAll(/^\+\+\+\s+(?:b\/)?([^\s]+)$/gm)]
      .map((match) => match[1])
      .filter((path): path is string => Boolean(path))
      .map(normalizeTargetPath);
    if (paths.length > 0) return [...new Set(paths)].sort().join(",");
  }
  if (toolName === "run_command") {
    const executable = typeof record.executable === "string" ? record.executable : "?";
    const cwd = typeof record.cwd === "string" && record.cwd.trim() ? normalizeTargetPath(record.cwd) : ".";
    return `${cwd}:${executable}`;
  }
  return "workspace";
}

function toolFamily(toolName: string): string {
  if (WRITE_TOOLS.has(toolName)) return "workspace-write";
  if (toolName.startsWith("browser_")) return "browser";
  if (["read_file", "list_files", "search_files", "search_text", "inspect_workspace", "search_symbols"].includes(toolName)) return "workspace-read";
  return "execution";
}

function operationClass(toolName: string): string {
  if (toolName === "create_file") return "overwrite";
  if (toolName === "append_file") return "append";
  if (toolName === "propose_patch") return "patch";
  if (toolName === "create_directory") return "mkdir";
  if (toolName === "run_command") return "command";
  if (toolName.startsWith("browser_")) return "browser-observation";
  return "observation";
}

export function canonicalOperationIdentity(toolName: string, args: unknown): {
  toolFamily: string;
  targetPath: string;
  operationClass: string;
  key: string;
} {
  const identity = {
    toolFamily: toolFamily(toolName),
    targetPath: targetFor(toolName, args),
    operationClass: operationClass(toolName),
  };
  return { ...identity, key: `${identity.toolFamily}|${identity.targetPath}|${identity.operationClass}` };
}

export function canonicalCallSignature(toolName: string, args: unknown): string {
  return `${toolName}:${argumentHash(args)}`;
}

function hasMeaningfulProgress(progress: ConvergenceProgress | undefined, calls: ConvergenceCall[]): boolean {
  return Boolean(
    progress?.newArtifact
      || progress?.requirementChanged
      || progress?.verificationPassed
      || progress?.diagnosticChanged
      || progress?.appMilestone
      || calls.some((call) => call.newArtifact),
  );
}

export function createConvergenceGuard(options: {
  exactRepeatThreshold?: number;
  stallThreshold?: number;
} = {}): ConvergenceGuard {
  const exactRepeatThreshold = Math.max(2, Math.floor(options.exactRepeatThreshold ?? 3));
  const stallThreshold = Math.max(2, Math.floor(options.stallThreshold ?? 3));
  const exactCounts = new Map<string, number>();
  const targets = new Map<string, {
    identity: ReturnType<typeof canonicalOperationIdentity>;
    callCount: number;
    argumentHashes: Set<string>;
    changedCallCount: number;
    noOpCallCount: number;
  }>();
  let nonProgressCycles = 0;

  const snapshot = (): ConvergenceSnapshot => ({
    version: 1,
    nonProgressCycles,
    exactCounts: [...exactCounts.entries()].map(([signature, count]) => ({ signature, count })),
    targets: [...targets.values()].map((target) => ({
      key: target.identity.key,
      callCount: target.callCount,
      uniqueArgumentCount: target.argumentHashes.size,
      changedCallCount: target.changedCallCount,
      noOpCallCount: target.noOpCallCount,
    })),
  });

  return {
    observeTurn(observation) {
      const exactRepeats: Array<{ signature: string; count: number }> = [];
      const churnCandidates: Array<{
        identity: ReturnType<typeof canonicalOperationIdentity>;
        callCount: number;
        uniqueArgumentCount: number;
      }> = [];

      for (const call of observation.calls) {
        const signature = canonicalCallSignature(call.toolName, call.args);
        const count = (exactCounts.get(signature) ?? 0) + 1;
        exactCounts.set(signature, count);
        if (count >= exactRepeatThreshold) exactRepeats.push({ signature, count });

        // Failed schema/permission calls have a separate bounded recovery
        // policy. They do not establish a target/content operation and must
        // not pre-empt a legitimate argument repair on the next turn.
        if (!WRITE_TOOLS.has(call.toolName) || call.outcome !== "success") continue;
        const identity = canonicalOperationIdentity(call.toolName, call.args);
        const current = targets.get(identity.key) ?? {
          identity,
          callCount: 0,
          argumentHashes: new Set<string>(),
          changedCallCount: 0,
          noOpCallCount: 0,
        };
        current.callCount += 1;
        current.argumentHashes.add(argumentHash(call.args));
        if (call.changed === true) current.changedCallCount += 1;
        if (call.changed !== true) current.noOpCallCount += 1;
        targets.set(identity.key, current);
        if (current.callCount >= 2) {
          churnCandidates.push({
            identity,
            callCount: current.callCount,
            uniqueArgumentCount: current.argumentHashes.size,
          });
        }
      }

      const meaningfulProgress = hasMeaningfulProgress(observation.progress, observation.calls);
      if (meaningfulProgress) nonProgressCycles = 0;
      else if (observation.calls.length > 0) nonProgressCycles += 1;

      const exactRepeat = exactRepeats.sort((left, right) => right.count - left.count)[0] ?? null;
      const churn = churnCandidates.sort((left, right) => right.callCount - left.callCount)[0] ?? null;
      const writeChurn = churn !== null && nonProgressCycles >= stallThreshold;
      const repeatedWrite = exactRepeat !== null
        && nonProgressCycles >= stallThreshold
        && churn !== null;
      const stalled = writeChurn || repeatedWrite;
      const advisory = churn
        ? `Repeated writes target the same target (${churn.identity.targetPath}) without a new requirement, verification, diagnostic, or application milestone. Change strategy or verify the current result.`
        : exactRepeat
          ? `The exact tool call has repeated ${exactRepeat.count} times. Produce new work, gather evidence, or finish.`
          : undefined;

      return {
        exactRepeat,
        churn,
        nonProgressCycles,
        stalled,
        ...(stalled ? { reason: writeChurn ? "same_target_write_churn" as const : "repeated_write" as const } : {}),
        ...(advisory ? { advisory } : {}),
      };
    },
    snapshot,
    restore(value) {
      exactCounts.clear();
      targets.clear();
      nonProgressCycles = 0;
      if (!value || value.version !== 1) return;
      nonProgressCycles = Number.isSafeInteger(value.nonProgressCycles) && value.nonProgressCycles >= 0 ? value.nonProgressCycles : 0;
      for (const item of value.exactCounts ?? []) {
        if (typeof item?.signature === "string" && Number.isSafeInteger(item.count) && item.count > 0) exactCounts.set(item.signature, item.count);
      }
      for (const item of value.targets ?? []) {
        if (!item || typeof item.key !== "string") continue;
        const parts = item.key.split("|");
        if (parts.length < 3) continue;
        const uniqueCount = Number.isSafeInteger(item.uniqueArgumentCount) && item.uniqueArgumentCount > 0 ? item.uniqueArgumentCount : 1;
        const argumentHashes = new Set(Array.from({ length: uniqueCount }, (_, index) => `restored:${item.key}:${index}`));
        targets.set(item.key, {
          identity: { toolFamily: parts[0]!, targetPath: parts.slice(1, -1).join("|"), operationClass: parts.at(-1)!, key: item.key },
          callCount: Number.isSafeInteger(item.callCount) && item.callCount > 0 ? item.callCount : 0,
          argumentHashes,
          changedCallCount: Number.isSafeInteger(item.changedCallCount) && item.changedCallCount >= 0 ? item.changedCallCount : 0,
          noOpCallCount: Number.isSafeInteger(item.noOpCallCount) && item.noOpCallCount >= 0 ? item.noOpCallCount : 0,
        });
      }
    },
  };
}
