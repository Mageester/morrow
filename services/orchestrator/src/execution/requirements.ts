import { createHash } from "node:crypto";

/** The closed set of execution requirements understood by deterministic policy. */
export const REQUIREMENT_KINDS = [
  "no_frontend",
  "no_database",
  "no_new_dependencies",
  "allowed_files",
  "required_file",
  "required_verification",
] as const;

export type RequirementKind = typeof REQUIREMENT_KINDS[number];

export type RequirementStatus = "unevaluated" | "verified" | "failed" | "waived";

export interface RequirementRegistryEntry {
  preAction: boolean;
  observation: "changed_paths" | "command" | "final_workspace";
}

/**
 * One declaration per supported kind. The conformance test intentionally
 * compares its table keys with this record so a new kind cannot silently skip
 * an enforcement or evaluation rule.
 */
export const EXECUTION_REQUIREMENT_REGISTRY: Record<RequirementKind, RequirementRegistryEntry> = {
  no_frontend: { preAction: true, observation: "changed_paths" },
  no_database: { preAction: true, observation: "changed_paths" },
  no_new_dependencies: { preAction: true, observation: "command" },
  allowed_files: { preAction: true, observation: "changed_paths" },
  required_file: { preAction: false, observation: "final_workspace" },
  required_verification: { preAction: false, observation: "command" },
};

// Descriptive alias for callers that use the shorter registry name.
export const REQUIREMENT_REGISTRY = EXECUTION_REQUIREMENT_REGISTRY;

export interface ExecutionRequirement {
  /** Stable across a retry/resume of the same prompt and source excerpt. */
  id: string;
  /** null means the user stated a constraint we deliberately could not map. */
  kind: RequirementKind | null;
  /** Exact text copied from the prompt; never a model paraphrase. */
  sourceExcerpt: string;
  /** Normalized, non-authoritative interpretation used only by policy. */
  parameters: Record<string, unknown>;
  authoritative: boolean;
  status: RequirementStatus;
}

export interface RequirementToolCall {
  toolName: string;
  args: Record<string, unknown>;
}

export interface RequirementObservation {
  type: "changed_paths" | "command" | "verification";
  paths?: string[];
  command?: { executable: string; args: string[] };
  exitCode?: number | null;
  passed?: boolean;
  /** Signals that a manifest/lockfile observation actually changed dependencies. */
  dependencyChange?: boolean;
  evidence?: string;
}

export interface RequirementEvaluation {
  requirementId: string;
  kind: RequirementKind | null;
  status: RequirementStatus;
  evidence: string[];
}

export type RequirementEnforcementResult =
  | { allowed: true }
  | { allowed: false; resultJson: string };

type Match = {
  kind: RequirementKind;
  start: number;
  end: number;
  excerpt: string;
  parameters: Record<string, unknown>;
};

const PATH_PATTERN = /[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)*/g;
const COMMAND_EXECUTABLES = new Set(["npm", "pnpm", "yarn", "bun", "node"]);
const DEPENDENCY_MANIFESTS = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
]);

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/").replace(/\/$/, "").toLowerCase();
}

function displayPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/").replace(/\/$/, "");
}

function stableId(kind: RequirementKind | null, sourceExcerpt: string, parameters: Record<string, unknown>, index: number): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ kind, sourceExcerpt, parameters, index }), "utf8")
    .digest("hex")
    .slice(0, 20);
  return `execution-requirement-${digest}`;
}

function normalizedCommand(command: string): { executable: string; args: string[] } | null {
  const tokens = command
    .trim()
    .replace(/[“”"']/g, "")
    .split(/\s+/)
    .map((token) => token.replace(/[.,;:!?]+$/, ""))
    .filter(Boolean);
  if (tokens.length === 0) return null;
  const executable = tokens[0]!.replace(/\.cmd$|\.exe$|\.bat$/i, "").toLowerCase();
  if (!COMMAND_EXECUTABLES.has(executable)) return null;
  const args = tokens.slice(1).filter((token) => !/^(?:passes|pass|succeeds|successfully|successfully\.)$/i.test(token));
  return { executable, args };
}

function commandEqual(left: { executable: string; args: string[] }, right: { executable: string; args: string[] }): boolean {
  const normalizeExecutable = (value: string) => value.replace(/\.cmd$|\.exe$|\.bat$/i, "").toLowerCase();
  return normalizeExecutable(left.executable) === normalizeExecutable(right.executable)
    && left.args.length === right.args.length
    && left.args.every((arg, index) => arg === right.args[index]);
}

function affectedPaths(call: RequirementToolCall): string[] {
  const args = call.args;
  if (call.toolName === "create_file" || call.toolName === "create_directory") {
    return typeof args.path === "string" ? [displayPath(args.path)] : [];
  }
  if (call.toolName === "propose_patch") {
    const patch = typeof args.patch === "string" ? args.patch : "";
    const paths = [...patch.matchAll(/^(?:---|\+\+\+)\s+(?:[ab]\/)?([^\r\n]+)$/gm)]
      .map((match) => displayPath(match[1]!))
      .filter((path) => path !== "/dev/null");
    return [...new Set(paths)];
  }
  return [];
}

/** Derive bounded observations from a durable tool row, without copying raw payloads. */
export function observeRequirementToolCall(
  call: RequirementToolCall,
  resultJson: string | null | undefined,
  status: "completed" | "failed" | "requested" = "completed",
): RequirementObservation[] {
  const observations: RequirementObservation[] = [];
  const paths = affectedPaths(call);
  if (paths.length > 0 && status === "completed") {
    observations.push({
      type: "changed_paths",
      paths,
      dependencyChange: contentAddsDependencies(call) || paths.some(isDependencyLockfile),
      evidence: `${call.toolName} completed for ${paths.length} workspace path${paths.length === 1 ? "" : "s"}`,
    });
  }
  const command = commandFromCall(call);
  if (command && status !== "requested") {
    let exitCode: number | null = null;
    try {
      const parsed = JSON.parse(resultJson ?? "{}") as { exitCode?: unknown };
      exitCode = typeof parsed.exitCode === "number" ? parsed.exitCode : null;
    } catch {
      // A failed/non-JSON command is still an observed command; its missing
      // exit code keeps a required verification unevaluated or failed rather
      // than fabricating a pass.
    }
    observations.push({
      type: "command",
      command,
      exitCode,
      passed: status === "completed" && exitCode === 0,
      evidence: `${command.executable} command was recorded`,
    });
  }
  return observations;
}

export function observeRequirementChangedPaths(paths: string[], evidence = "final workspace changed paths observed"): RequirementObservation {
  const normalized = paths.map(displayPath).filter(Boolean);
  return { type: "changed_paths", paths: [...new Set(normalized)], evidence };
}

function commandFromCall(call: RequirementToolCall): { executable: string; args: string[] } | null {
  if (call.toolName !== "run_command") return null;
  const executable = typeof call.args.executable === "string" ? call.args.executable : null;
  const args = Array.isArray(call.args.args) ? call.args.args.filter((value): value is string => typeof value === "string") : [];
  if (!executable) return null;
  return { executable, args };
}

function isFrontendPath(path: string): boolean {
  const normalized = normalizePath(path);
  return /(?:^|\/)(?:frontend|ui|components|public)(?:\/|$)/.test(normalized)
    || /\.(?:html?|css|scss|sass|less|jsx|tsx|vue|svelte|astro)$/.test(normalized);
}

function isDatabasePath(path: string): boolean {
  const normalized = normalizePath(path);
  return /(?:^|\/)(?:database|databases|db|migrations?)(?:\/|$)/.test(normalized)
    || /\.(?:sql|sqlite|sqlite3|db)$/.test(normalized)
    || /(?:^|\/)(?:schema|prisma)\.(?:sql|prisma)$/.test(normalized);
}

function isDependencyInstall(command: { executable: string; args: string[] }): boolean {
  const executable = command.executable.replace(/\.cmd$|\.exe$|\.bat$/i, "").toLowerCase();
  if (!new Set(["npm", "pnpm", "yarn", "bun"]).has(executable)) return false;
  const first = command.args[0]?.toLowerCase();
  return first === "install" || first === "add" || first === "i";
}

function isDependencyManifest(path: string): boolean {
  const basename = normalizePath(path).split("/").at(-1) ?? "";
  return DEPENDENCY_MANIFESTS.has(basename);
}

function isDependencyLockfile(path: string): boolean {
  const basename = normalizePath(path).split("/").at(-1) ?? "";
  return basename === "package-lock.json"
    || basename === "pnpm-lock.yaml"
    || basename === "yarn.lock"
    || basename === "bun.lock"
    || basename === "bun.lockb";
}

function contentAddsDependencies(call: RequirementToolCall): boolean {
  if (call.toolName === "create_file") {
    const content = typeof call.args.content === "string" ? call.args.content : "";
    return /["'](?:dependencies|devDependencies|peerDependencies|optionalDependencies)["']\s*:/i.test(content);
  }
  if (call.toolName === "propose_patch") {
    const patch = typeof call.args.patch === "string" ? call.args.patch : "";
    return /\+\s*["'](?:dependencies|devDependencies|peerDependencies|optionalDependencies)["']\s*:/i.test(patch)
      || /^\+[^+].*(?:express|react|vite|lodash|fastify|axios|typescript)/im.test(patch);
  }
  return false;
}

function matchesRequiredVerification(call: RequirementToolCall, requirement: ExecutionRequirement): boolean {
  const required = requirement.parameters.command;
  const actual = commandFromCall(call);
  return Boolean(actual && required && typeof required === "object" && commandEqual(actual, required as { executable: string; args: string[] }));
}

function requirementViolation(requirement: ExecutionRequirement, call: RequirementToolCall): string | null {
  if (!requirement.authoritative || requirement.status === "waived" || !requirement.kind) return null;
  const paths = affectedPaths(call);
  switch (requirement.kind) {
    case "no_frontend":
      return paths.find(isFrontendPath) ? "the action targets a frontend deliverable" : null;
    case "no_database":
      return paths.find(isDatabasePath) ? "the action targets a database deliverable" : null;
    case "no_new_dependencies": {
      const command = commandFromCall(call);
      if (command && isDependencyInstall(command)) return "the command installs or adds a dependency";
      if (contentAddsDependencies(call)) return "the file content adds dependency declarations";
      return null;
    }
    case "allowed_files": {
      const allowed = new Set((Array.isArray(requirement.parameters.paths) ? requirement.parameters.paths : []).map((path) => normalizePath(String(path))));
      return paths.find((path) => !allowed.has(normalizePath(path))) ? "the action targets a file outside the user's allowed-file boundary" : null;
    }
    case "required_file":
      return null;
    case "required_verification":
      // A required verification is a post-action obligation, not a blanket
      // prohibition on useful preparatory commands. The final evaluator owns
      // whether the exact command ran and passed.
      return null;
  }
}

function correctionInstruction(kind: RequirementKind): string {
  switch (kind) {
    case "no_frontend": return "Keep the implementation backend-only and use a non-frontend source path.";
    case "no_database": return "Keep persistence in the permitted backend boundary and do not create database or migration files.";
    case "no_new_dependencies": return "Use the existing dependencies or standard library; do not run an install/add command or add dependency declarations.";
    case "allowed_files": return "Use only the files named in the user's allowed-file requirement.";
    case "required_file": return "Deliver the required file before claiming completion.";
    case "required_verification": return "Run the exact required verification command and report its real result.";
  }
}

/**
 * Deterministically extract only explicit, high-confidence constraints. The
 * model is never asked to classify prose and unrecognized explicit clauses
 * stay as a null-kind authoritative blocker.
 */
export function extractExecutionRequirements(prompt: string): ExecutionRequirement[] {
  const matches: Match[] = [];
  const add = (match: Match): void => { matches.push(match); };
  const addPattern = (kind: RequirementKind, pattern: RegExp, parameters: (match: RegExpExecArray) => Record<string, unknown> = () => ({})): void => {
    const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    let match: RegExpExecArray | null;
    while ((match = global.exec(prompt)) !== null) {
      add({ kind, start: match.index, end: match.index + match[0].length, excerpt: match[0], parameters: parameters(match) });
      if (match[0].length === 0) global.lastIndex++;
    }
  };

  addPattern("no_frontend", /\bbackend\s+only\b|\b(?:no|without|never use|do not (?:build|create|add|include|use)|must not (?:build|create|add|include|use))\s+(?:a\s+)?front[- ]?end\b/gi);
  addPattern("no_database", /\b(?:no|without|never use|do not (?:build|create|add|include|use|require)|must not (?:build|create|add|include|use|require))\s+(?:a\s+)?(?:database|db)(?:\s+server)?\b/gi);
  addPattern("no_new_dependencies", /\bno\s+(?:new\s+)?dependencies\b|\b(?:without|do not|don't|must not)\s+(?:adding\s+)?(?:any\s+)?(?:new\s+)?dependencies\b/gi);
  addPattern("allowed_files", /\b(?:modify|change|edit|touch)\s+only\s+(?:these\s+)?files?\s*:\s*[^!?\n]+/gi, (match) => {
    const afterColon = match[0].split(":").slice(1).join(":");
    const paths = [...afterColon.matchAll(PATH_PATTERN)]
      .map((item) => displayPath(item[0].replace(/[.,;]+$/, "")))
      .filter((path) => path.includes("/") || /\.[A-Za-z0-9_-]+$/.test(path));
    return { paths: [...new Set(paths)] };
  });
  addPattern("required_file", /\brequired\s+file\s*:\s*[A-Za-z0-9_.\\/-]+/gi, (match) => {
    const path = match[0].split(":").slice(1).join(":").trim().replace(/[.,;]+$/, "");
    return { path: displayPath(path) };
  });
  addPattern("required_verification", /\brequired\s+verification\s*:\s*(?:pnpm|npm|yarn|node)\b(?:(?!\s+(?:passes|pass|succeeds|successfully)\b)[^\n])*/gi, (match) => {
    const commandText = match[0].split(":").slice(1).join(":").replace(/\b(?:passes|pass|succeeds|successfully)\b.*$/i, "").trim();
    return { command: normalizedCommand(commandText) };
  });
  addPattern("required_verification", /\b(?:must|should)\s+(?:run|execute|verify with)\s+(?:pnpm|npm|yarn|node)\b(?:(?!\s+(?:passes|pass|succeeds|successfully)\b)[^\n])*/gi, (match) => {
    const commandText = match[0].replace(/^.*?\b(?:run|execute|verify with)\s+/i, "").replace(/\b(?:passes|pass|succeeds|successfully)\b.*$/i, "").trim();
    return { command: normalizedCommand(commandText) };
  });

  const recognized = matches
    .filter((match) => match.kind !== "required_verification" || match.parameters.command !== null)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const selected: Match[] = [];
  const seen = new Set<string>();
  for (const match of recognized) {
    const key = `${match.kind}:${JSON.stringify(match.parameters)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(match);
  }

  // Keep explicit clauses that use a clear constraint marker but do not map to
  // one of the closed kinds. "Approved protocol exactly" is intentionally
  // visible and blocks completion instead of being guessed into a category.
  const clauses = prompt.split(/(?<=[.!?])\s+|\n+/).map((value) => {
    const start = prompt.indexOf(value);
    return { value: value.trim(), start: start < 0 ? 0 : start };
  }).filter((clause) => clause.value.length > 0);
  for (const clause of clauses) {
    // Generic words such as "only", "no", "without", and "must" also
    // occur in ordinary task framing ("no changes needed", "finish without
    // asking"). Keep unknown constraints blocking only when the wording itself
    // makes a contractual boundary unmistakable; supported kinds above already
    // capture high-confidence no/only/required forms.
    if (!/\b(?:strictly|approved)\b|\bas specified\b[\s\S]*\b(?:protocol|format|schema|process|standard|contract)\b/i.test(clause.value)) continue;
    const clauseEnd = clause.start + clause.value.length;
    if (selected.some((match) => match.start < clauseEnd && match.end > clause.start)) continue;
    selected.push({ kind: null as never, start: clause.start, end: clauseEnd, excerpt: clause.value, parameters: { statement: clause.value } });
  }

  selected.sort((left, right) => left.start - right.start || left.end - right.end);
  return selected.map((match, index) => ({
    id: stableId(match.kind, match.excerpt, match.parameters, index),
    kind: match.kind,
    sourceExcerpt: match.excerpt,
    parameters: match.parameters,
    authoritative: true,
    status: "unevaluated",
  }));
}

function observationPaths(observation: RequirementObservation): string[] {
  return (observation.paths ?? []).map(displayPath);
}

function observationCommand(observation: RequirementObservation): { executable: string; args: string[] } | null {
  return observation.command ?? null;
}

function evidenceFor(observation: RequirementObservation, fallback: string): string {
  return observation.evidence?.trim() || fallback;
}

/** Evaluate the final changed-path/command ledger without trusting narration. */
export function evaluateRequirementObservations(
  requirements: ExecutionRequirement[],
  observations: RequirementObservation[],
): RequirementEvaluation[] {
  return requirements.map((requirement) => {
    if (!requirement.authoritative || requirement.status === "waived") {
      return { requirementId: requirement.id, kind: requirement.kind, status: "waived", evidence: ["requirement is not authoritative or was explicitly waived"] };
    }
    if (!requirement.kind) {
      return { requirementId: requirement.id, kind: null, status: "unevaluated", evidence: ["explicit constraint was not mapped to a deterministic evaluator"] };
    }
    const paths = observations.flatMap(observationPaths);
    const changedPathObservations = observations.filter((observation) => observation.type === "changed_paths");
    const commandObservations = observations.filter((observation) => observation.type === "command" || observation.type === "verification");
    let status: RequirementStatus = "unevaluated";
    const evidence: string[] = [];
    switch (requirement.kind) {
      case "no_frontend": {
        const conflict = paths.find(isFrontendPath);
        if (changedPathObservations.length > 0) {
          status = conflict ? "failed" : "verified";
          evidence.push(conflict ? `frontend path changed: ${conflict}` : "final changed paths contain no frontend deliverable");
        }
        break;
      }
      case "no_database": {
        const conflict = paths.find(isDatabasePath);
        if (changedPathObservations.length > 0) {
          status = conflict ? "failed" : "verified";
          evidence.push(conflict ? `database path changed: ${conflict}` : "final changed paths contain no database deliverable");
        }
        break;
      }
      case "no_new_dependencies": {
        const dependencyCommand = commandObservations.find((observation) => {
          const command = observationCommand(observation);
          return Boolean(command && isDependencyInstall(command));
        });
        const dependencyPath = paths.find((path) => isDependencyLockfile(path)
          || (isDependencyManifest(path) && observations.some((observation) => observation.dependencyChange === true && observationPaths(observation).some((candidate) => normalizePath(candidate) === normalizePath(path)))));
        const manifestPath = paths.find((path) => isDependencyManifest(path));
        const explicitDependencyChange = observations.find((observation) => observation.dependencyChange === true);
        if (observations.length > 0) {
          if (dependencyCommand) {
            status = "failed";
            evidence.push(`dependency-install command recorded: ${dependencyCommand.command?.executable ?? "unknown"}`);
          } else if (explicitDependencyChange) {
            status = "failed";
            evidence.push("dependency manifest observation reports a dependency change");
          } else if (dependencyPath) {
            status = "failed";
            evidence.push(`dependency lockfile changed: ${dependencyPath}`);
          } else if (manifestPath) {
            status = "unevaluated";
            evidence.push(`dependency manifest changed but its dependency delta was not observed: ${manifestPath}`);
          } else {
            status = "verified";
            evidence.push("observations contain no dependency installation or dependency change");
          }
        }
        break;
      }
      case "allowed_files": {
        const allowed = new Set((Array.isArray(requirement.parameters.paths) ? requirement.parameters.paths : []).map((path) => normalizePath(String(path))));
        const outside = paths.find((path) => !allowed.has(normalizePath(path)));
        if (changedPathObservations.length > 0) {
          status = outside ? "failed" : "verified";
          evidence.push(outside ? `path outside allowlist: ${outside}` : "all final changed paths are allowed");
        }
        break;
      }
      case "required_file": {
        const requiredPath = typeof requirement.parameters.path === "string" ? normalizePath(requirement.parameters.path) : "";
        if (changedPathObservations.length > 0) {
          const present = paths.some((path) => normalizePath(path) === requiredPath);
          status = present ? "verified" : "failed";
          evidence.push(present ? `required file delivered: ${requiredPath}` : `required file absent from final changed paths: ${requiredPath}`);
        }
        break;
      }
      case "required_verification": {
        const required = requirement.parameters.command;
        const matching = commandObservations.filter((observation) => {
          const actual = observationCommand(observation);
          return Boolean(actual && required && typeof required === "object" && commandEqual(actual, required as { executable: string; args: string[] }));
        });
        const passed = matching.find((observation) => observation.passed === true || observation.exitCode === 0);
        const failed = matching.find((observation) => observation.passed === false || (typeof observation.exitCode === "number" && observation.exitCode !== 0));
        if (passed) {
          status = "verified";
          evidence.push(evidenceFor(passed, "required verification passed"));
        } else if (failed) {
          status = "failed";
          evidence.push(evidenceFor(failed, "required verification failed"));
        } else if (commandObservations.length > 0) {
          status = "failed";
          evidence.push("required verification command was not recorded");
        }
        break;
      }
    }
    return { requirementId: requirement.id, kind: requirement.kind, status, evidence };
  });
}

/** Full completion is possible only after every authoritative requirement is terminal and verified/waived. */
export function canCompleteWithRequirements(requirements: ExecutionRequirement[], evaluations: RequirementEvaluation[]): boolean {
  const byId = new Map(evaluations.map((evaluation) => [evaluation.requirementId, evaluation]));
  return requirements
    .filter((requirement) => requirement.authoritative)
    .every((requirement) => {
      const evaluation = byId.get(requirement.id);
      return evaluation?.status === "verified" || evaluation?.status === "waived";
    });
}

/** Return a structured failure payload for a tool call that would violate policy. */
export function enforceToolRequirement(call: RequirementToolCall, requirements: ExecutionRequirement[]): RequirementEnforcementResult {
  for (const requirement of requirements) {
    if (requirement.kind && !EXECUTION_REQUIREMENT_REGISTRY[requirement.kind].preAction) continue;
    const reason = requirementViolation(requirement, call);
    if (!reason || !requirement.kind) continue;
    return {
      allowed: false,
      resultJson: JSON.stringify({
        errorType: "requirement_violation",
        requirementId: requirement.id,
        requirementKind: requirement.kind,
        sourceExcerpt: requirement.sourceExcerpt,
        reason,
        instruction: correctionInstruction(requirement.kind),
        toolName: call.toolName,
        targetPaths: affectedPaths(call).slice(0, 32),
      }),
    };
  }
  return { allowed: true };
}
