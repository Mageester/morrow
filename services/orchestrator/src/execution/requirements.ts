import { createHash } from "node:crypto";
import { redactSecrets } from "../provider/credentials.js";

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
  /** A waiver is terminal only when its authority, reason, and evidence are durable. */
  waiver?: RequirementWaiver;
}

export interface RequirementWaiver {
  authorizedBy: "user" | "mission_ledger";
  reason: string;
  evidenceRefs: string[];
}

export type RequirementPathType = "file" | "directory" | "unknown";

export interface RequirementPathObservation {
  path: string;
  type: RequirementPathType;
}

export interface RequirementToolCall {
  toolName: string;
  args: Record<string, unknown>;
}

export interface RequirementObservation {
  type: "changed_paths" | "command" | "verification";
  paths?: string[];
  pathTypes?: RequirementPathObservation[];
  /** Tool-declared path types are hints only; final stat evidence opts in explicitly. */
  pathTypesAuthoritative?: boolean;
  /** A complete filesystem observation can prove the absence of a conflict. */
  measured?: boolean;
  authoritative?: boolean;
  completed?: boolean;
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
  observedFileType?: RequirementPathType;
}

export interface RequirementEvaluationOptions {
  platform?: NodeJS.Platform;
}

export interface RequirementEnforcementOptions {
  platform?: NodeJS.Platform;
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
const COMMAND_EXECUTABLES = new Set(["npm", "pnpm", "yarn", "bun", "node", "deno", "npx"]);
const DEPENDENCY_MANIFESTS = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
]);

export function canonicalRequirementPath(value: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/").replace(/\/$/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function normalizePath(value: string, platform: NodeJS.Platform = process.platform): string {
  return canonicalRequirementPath(value, platform);
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

function redactStructured(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[REDACTED]";
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.slice(0, 256).map((item) => redactStructured(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 256).map(([key, item]) => [key, redactStructured(item, depth + 1)]));
  }
  return value;
}

export function sanitizeExecutionRequirement(requirement: ExecutionRequirement): ExecutionRequirement {
  return {
    ...requirement,
    sourceExcerpt: redactSecrets(requirement.sourceExcerpt),
    parameters: redactStructured(requirement.parameters) as Record<string, unknown>,
    ...(requirement.waiver
      ? {
          waiver: {
            authorizedBy: requirement.waiver.authorizedBy,
            reason: redactSecrets(requirement.waiver.reason),
            evidenceRefs: requirement.waiver.evidenceRefs.map(redactSecrets),
          },
        }
      : {}),
  };
}

export function sanitizeRequirementEvaluation(evaluation: RequirementEvaluation): RequirementEvaluation {
  return {
    ...evaluation,
    evidence: evaluation.evidence.map((item) => redactSecrets(item)),
  };
}

function validRequirementWaiver(requirement: ExecutionRequirement): requirement is ExecutionRequirement & { waiver: RequirementWaiver } {
  return requirement.status === "waived"
    && requirement.waiver !== undefined
    && (requirement.waiver.authorizedBy === "user" || requirement.waiver.authorizedBy === "mission_ledger")
    && requirement.waiver.reason.trim().length > 0
    && requirement.waiver.evidenceRefs.length > 0
    && requirement.waiver.evidenceRefs.every((ref) => ref.trim().length > 0);
}

/** Restore only a mission-ledger waiver that is authoritative and auditable. */
export function restoreMissionRequirementWaivers<T extends {
  sourcePromptExcerpt?: string | null;
  statement?: string | null;
  authoritative?: boolean;
  status?: string;
  lastFailure?: string | null;
  evidenceRefs?: string[];
}>(requirements: ExecutionRequirement[], nodes: T[]): ExecutionRequirement[] {
  return requirements.map((requirement) => {
    const node = nodes.find((candidate) =>
      candidate.authoritative === true
      && candidate.status === "waived"
      && (candidate.sourcePromptExcerpt === requirement.sourceExcerpt || candidate.statement === requirement.sourceExcerpt)
      && typeof candidate.lastFailure === "string"
      && candidate.lastFailure.trim().length > 0
      && Array.isArray(candidate.evidenceRefs)
      && candidate.evidenceRefs.length > 0
      && candidate.evidenceRefs.every((ref) => typeof ref === "string" && ref.trim().length > 0));
    if (!node) return requirement;
    return {
      ...requirement,
      status: "waived",
      waiver: {
        authorizedBy: "mission_ledger",
        reason: node.lastFailure!.trim(),
        evidenceRefs: [...node.evidenceRefs!],
      },
    };
  });
}

/** Restore a standalone checkpoint waiver only when its durable record proves user authority. */
export function restoreExecutionRequirementWaivers(
  requirements: ExecutionRequirement[],
  persistedRequirements: ExecutionRequirement[],
): ExecutionRequirement[] {
  return requirements.map((requirement) => {
    const persisted = persistedRequirements.find((candidate) =>
      candidate.id === requirement.id
      || (candidate.kind === requirement.kind && candidate.sourceExcerpt === requirement.sourceExcerpt));
    if (!persisted || !validRequirementWaiver(persisted)) return requirement;
    return { ...requirement, status: "waived", waiver: { ...persisted.waiver } };
  });
}

function normalizedCommand(command: string): { executable: string; args: string[] } | null {
  const tokens = command
    .trim()
    .replace(/[“”"']/g, "")
    .split(/\s+/)
    .map((token) => token.replace(/[.,;:!?]+$/, ""))
    .filter(Boolean);
  if (tokens.length === 0) return null;
  const executable = executableName(tokens[0]!);
  if (!COMMAND_EXECUTABLES.has(executable)) return null;
  const args = tokens.slice(1).filter((token) => !/^(?:passes|pass|succeeds|successfully|successfully\.)$/i.test(token));
  return { executable, args };
}

function commandEqual(left: { executable: string; args: string[] }, right: { executable: string; args: string[] }): boolean {
  const normalizeExecutable = executableName;
  return normalizeExecutable(left.executable) === normalizeExecutable(right.executable)
    && left.args.length === right.args.length
    && left.args.every((arg, index) => arg === right.args[index]);
}

function executableName(value: string): string {
  const basename = value.replace(/\\/g, "/").split("/").at(-1) ?? value;
  return basename.replace(/\.cmd$|\.exe$|\.bat$/i, "").toLowerCase();
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
    const pathTypes: RequirementPathObservation[] = paths.map((path) => ({
      path,
      type: call.toolName === "create_directory" ? "directory" : call.toolName === "create_file" ? "file" : "unknown",
    }));
    observations.push({
      type: "changed_paths",
      paths,
      pathTypes,
      pathTypesAuthoritative: false,
      authoritative: false,
      measured: false,
      completed: true,
      dependencyChange: contentAddsDependencies(call) || paths.some((path) => isDependencyLockfile(path)),
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
      completed: status === "completed",
      evidence: `${command.executable} command was recorded`,
    });
  }
  return observations;
}

export function observeRequirementChangedPaths(
  paths: string[],
  evidence = "final workspace changed paths observed",
  options: { pathTypes?: RequirementPathObservation[]; pathTypesAuthoritative?: boolean; measured?: boolean; authoritative?: boolean } = {},
): RequirementObservation {
  const normalized = paths.map(displayPath).filter(Boolean);
  return {
    type: "changed_paths",
    paths: [...new Set(normalized)],
    ...(options.pathTypes ? { pathTypes: options.pathTypes.map((entry) => ({ path: displayPath(entry.path), type: entry.type })) } : {}),
    ...(options.pathTypes
      ? { pathTypesAuthoritative: options.pathTypesAuthoritative ?? options.authoritative === true }
      : {}),
    ...(options.measured !== undefined ? { measured: options.measured } : {}),
    ...(options.authoritative !== undefined ? { authoritative: options.authoritative } : {}),
    evidence,
  };
}

function commandFromCall(call: RequirementToolCall): { executable: string; args: string[] } | null {
  if (call.toolName !== "run_command") return null;
  const executable = typeof call.args.executable === "string" ? call.args.executable : null;
  const args = Array.isArray(call.args.args) ? call.args.args.filter((value): value is string => typeof value === "string") : [];
  if (!executable) return null;
  return { executable: executableName(executable), args };
}

function isFrontendPath(path: string, platform: NodeJS.Platform = process.platform): boolean {
  const normalized = normalizePath(path, platform);
  return /(?:^|\/)(?:frontend|ui|components|public)(?:\/|$)/.test(normalized)
    || /\.(?:html?|css|scss|sass|less|jsx|tsx|vue|svelte|astro)$/.test(normalized);
}

function isDatabasePath(path: string, platform: NodeJS.Platform = process.platform): boolean {
  const normalized = normalizePath(path, platform);
  return /(?:^|\/)(?:database|databases|db|migrations?)(?:\/|$)/.test(normalized)
    || /\.(?:sql|sqlite|sqlite3|db)$/.test(normalized)
    || /(?:^|\/)(?:schema|prisma)\.(?:sql|prisma)$/.test(normalized);
}

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const DEPENDENCY_MUTATING_VERBS = new Set(["install", "i", "ci", "add", "update", "up", "remove", "rm", "uninstall", "prune", "dedupe", "link"]);
const PACKAGE_MANAGER_OPTIONS_WITH_VALUE = new Set(["--dir", "--prefix", "--cwd", "--filter", "--workspace", "--workspace-root", "-c", "-C"]);
const PACKAGE_MANAGER_WRAPPER_OPTIONS_WITH_VALUE = new Set(["--package", "-p", "--cache", "--prefix", "--registry"]);
const SHELL_EXECUTABLES = new Set(["sh", "bash", "dash", "zsh", "fish", "cmd", "powershell", "pwsh"]);

function shellScriptTokens(script: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s]+)/g;
  for (const match of script.matchAll(pattern)) tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  return tokens.filter(Boolean);
}

function stripWrapperOptions(args: string[], optionsWithValue: Set<string>): string[] {
  const remaining = [...args];
  while (remaining.length > 0) {
    const flag = remaining[0]!.toLowerCase();
    if (flag === "--") {
      remaining.shift();
      break;
    }
    if (optionsWithValue.has(flag)) {
      remaining.splice(0, Math.min(2, remaining.length));
      continue;
    }
    if ([...optionsWithValue].some((option) => flag.startsWith(`${option}=`))) {
      remaining.shift();
      continue;
    }
    if (flag.startsWith("-")) {
      remaining.shift();
      continue;
    }
    break;
  }
  return remaining;
}

function unwrapPackageManagerCommand(command: { executable: string; args: string[] }): { executable: string; args: string[] } | null {
  let executable = executableName(command.executable);
  let args = [...command.args];
  for (let depth = 0; depth < 4; depth++) {
    if (PACKAGE_MANAGERS.has(executable)) {
      args = stripWrapperOptions(args, PACKAGE_MANAGER_OPTIONS_WITH_VALUE);
      if ((args[0]?.toLowerCase() === "exec" || args[0]?.toLowerCase() === "dlx") && args[1]) {
        args = args.slice(1);
        args = stripWrapperOptions(args, new Set(["exec", "dlx"]));
        if (!args[0]) return null;
        executable = executableName(args[0]!);
        args = args.slice(1);
        continue;
      }
      return { executable, args };
    }
    if (executable === "npx") {
      args = stripWrapperOptions(args, PACKAGE_MANAGER_WRAPPER_OPTIONS_WITH_VALUE);
      if (!args[0]) return null;
      executable = executableName(args[0]!);
      args = args.slice(1);
      continue;
    }
    if (executable === "corepack") {
      const managerIndex = args.findIndex((value) => PACKAGE_MANAGERS.has(executableName(value)));
      if (managerIndex < 0) return null;
      executable = executableName(args[managerIndex]!);
      args = args.slice(managerIndex + 1);
      continue;
    }
    if (SHELL_EXECUTABLES.has(executable)) {
      const scriptIndex = args.findIndex((value) => ["-c", "/c", "-command", "--command"].includes(value.toLowerCase()));
      if (scriptIndex < 0 || !args[scriptIndex + 1]) return null;
      const nested = shellScriptTokens(args[scriptIndex + 1]!);
      if (nested.length === 0) return null;
      executable = executableName(nested[0]!);
      args = nested.slice(1);
      continue;
    }
    return null;
  }
  return null;
}

function isDependencyInstall(command: { executable: string; args: string[] }): boolean {
  const canonical = unwrapPackageManagerCommand(command);
  if (!canonical) return false;
  return DEPENDENCY_MUTATING_VERBS.has(canonical.args[0]?.toLowerCase() ?? "");
}

function isDependencyManifest(path: string, platform: NodeJS.Platform = process.platform): boolean {
  const basename = normalizePath(path, platform).split("/").at(-1) ?? "";
  return DEPENDENCY_MANIFESTS.has(basename);
}

function isDependencyLockfile(path: string, platform: NodeJS.Platform = process.platform): boolean {
  const basename = normalizePath(path, platform).split("/").at(-1) ?? "";
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
    let manifestPath: string | null = null;
    let dependencyBlockDepth: number | null = null;
    for (const line of patch.split(/\r?\n/)) {
      const header = /^(?:\+\+\+|---)\s+(?:[ab]\/)?([^\r\n]+)$/.exec(line);
      if (header) {
        manifestPath = displayPath(header[1]!);
        dependencyBlockDepth = null;
        continue;
      }
      if (!manifestPath || !isDependencyManifest(manifestPath)) continue;
      const text = line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") ? line.slice(1) : line;
      const dependencyHeader = /["'](?:dependencies|devDependencies|peerDependencies|optionalDependencies)["']\s*:\s*\{/i.test(text);
      if (dependencyHeader) {
        if (line.startsWith("+")) return true;
        dependencyBlockDepth = Math.max(1, (text.match(/\{/g) ?? []).length - (text.match(/\}/g) ?? []).length);
        continue;
      }
      if (dependencyBlockDepth !== null && line.startsWith("+") && /^\+\s*["'][^"']+["']\s*:/.test(line)) return true;
      if (dependencyBlockDepth !== null) {
        dependencyBlockDepth += (text.match(/\{/g) ?? []).length - (text.match(/\}/g) ?? []).length;
        if (dependencyBlockDepth <= 0) dependencyBlockDepth = null;
      }
    }
    return false;
  }
  return false;
}

function matchesRequiredVerification(call: RequirementToolCall, requirement: ExecutionRequirement): boolean {
  const required = requirement.parameters.command;
  const actual = commandFromCall(call);
  return Boolean(actual && required && typeof required === "object" && commandEqual(actual, required as { executable: string; args: string[] }));
}

function requirementViolation(requirement: ExecutionRequirement, call: RequirementToolCall, platform: NodeJS.Platform): string | null {
  if (!requirement.authoritative || (requirement.status === "waived" && validRequirementWaiver(requirement)) || !requirement.kind) return null;
  const paths = affectedPaths(call);
  switch (requirement.kind) {
    case "no_frontend":
      return paths.find((path) => isFrontendPath(path, platform)) ? "the action targets a frontend deliverable" : null;
    case "no_database":
      return paths.find((path) => isDatabasePath(path, platform)) ? "the action targets a database deliverable" : null;
    case "no_new_dependencies": {
      const command = commandFromCall(call);
      if (command && isDependencyInstall(command)) return "the command installs or adds a dependency";
      if (contentAddsDependencies(call)) return "the file content adds dependency declarations";
      return null;
    }
    case "allowed_files": {
      const allowed = new Set((Array.isArray(requirement.parameters.paths) ? requirement.parameters.paths : []).map((path) => canonicalRequirementPath(String(path), platform)));
      return paths.find((path) => !allowed.has(canonicalRequirementPath(path, platform))) ? "the action targets a file outside the user's allowed-file boundary" : null;
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

  addPattern("no_frontend", /\bbackend\s+only\b|\b(?:no|without|never use|do not|don't|must not|mustn't)(?:\s+(?:build|create|add|include|use))?\s+(?:a\s+)?front[- ]?end\b(?!\s+(?:tests?|testing|test[- ]?suite|specs?)\b)/gi);
  addPattern("no_database", /\b(?:no|without|never use|do not|don't|must not|mustn't)(?:\s+(?:build|create|add|include|use|require))?\s+(?:a\s+)?(?:database|db)(?:\s+server)?\b(?!\s+(?:tests?|testing|test[- ]?suite|queries?|migrations?)\b)/gi);
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
  addPattern("required_verification", /\brequired\s+verification\s*:\s*(?:pnpm|npm|yarn|bun|node|deno|npx)\b(?:(?!\s+(?:passes|pass|succeeds|successfully)\b)[^\n])*(?:\s+(?:passes|pass|succeeds|successfully)\b[.!?]?)?/gi, (match) => {
    const commandText = match[0].split(":").slice(1).join(":").replace(/\b(?:passes|pass|succeeds|successfully)\b.*$/i, "").trim();
    return { command: normalizedCommand(commandText) };
  });
  addPattern("required_verification", /\b(?:must|should)\s+(?:run|execute|verify with)\s+(?:pnpm|npm|yarn|bun|node|deno|npx)\b(?:(?!\s+(?:passes|pass|succeeds|successfully)\b)[^\n])*(?:\s+(?:passes|pass|succeeds|successfully)\b[.!?]?)?/gi, (match) => {
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
  const clauses: Array<{ value: string; start: number }> = [];
  for (const match of prompt.matchAll(/[^.!?;\n]+[.!?;]?/g)) {
    const value = match[0]?.replace(/;\s*$/, "").trim() ?? "";
    if (value.length > 0) clauses.push({ value, start: match.index ?? 0 });
  }
  for (const clause of clauses) {
    // Generic words such as "only", "no", "without", and "must" also
    // occur in ordinary task framing ("no changes needed", "finish without
    // asking"). Keep unknown constraints blocking only when the wording itself
    // makes a contractual boundary unmistakable; supported kinds above already
    // capture high-confidence no/only/required forms.
    const explicitMarker = /^(?:\s*)(?:must(?:n't| not)?|should(?:n't| not)?|don't|do not|never|no|without|required|strictly|approved|as specified|use|follow|preserve|only\s+(?:modify|change|edit|touch))\b/i.test(clause.value);
    const unsupportedSignal = /\b(?:exactly|protocol|format|schema|process|standard|contract|tests?|testing|test[- ]?suite|specification|policy|convention|interface|api|migrations?|backend\s+files?|frontend\s+files?)\b/i.test(clause.value);
    if (!explicitMarker || !unsupportedSignal) continue;
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

function observationPathTypes(observation: RequirementObservation): RequirementPathObservation[] {
  return (observation.pathTypes ?? []).map((entry) => ({ path: displayPath(entry.path), type: entry.type }));
}

function authoritativeObservationPathTypes(observation: RequirementObservation): RequirementPathObservation[] {
  return observation.pathTypesAuthoritative === false ? [] : observationPathTypes(observation);
}

function observationCommand(observation: RequirementObservation): { executable: string; args: string[] } | null {
  return observation.command ?? null;
}

function evidenceFor(observation: RequirementObservation, fallback: string): string {
  return redactSecrets(observation.evidence?.trim() || fallback);
}

/** Evaluate the final changed-path/command ledger without trusting narration. */
export function evaluateRequirementObservations(
  requirements: ExecutionRequirement[],
  observations: RequirementObservation[],
  options: RequirementEvaluationOptions = {},
): RequirementEvaluation[] {
  const platform = options.platform ?? process.platform;
  const pathKey = (path: string): string => canonicalRequirementPath(path, platform);
  return requirements.map((requirement) => {
    if (!requirement.authoritative) {
      return { requirementId: requirement.id, kind: requirement.kind, status: "unevaluated", evidence: ["requirement is not authoritative"] };
    }
    if (requirement.status === "waived") {
      if (!validRequirementWaiver(requirement)) {
        return { requirementId: requirement.id, kind: requirement.kind, status: "unevaluated", evidence: ["waiver lacks explicit user authority, reason, or durable evidence"] };
      }
      return {
        requirementId: requirement.id,
        kind: requirement.kind,
        status: "waived",
        evidence: [
          `explicit waiver authorized by ${requirement.waiver.authorizedBy}`,
          `waiver reason: ${redactSecrets(requirement.waiver.reason)}`,
          `waiver evidence: ${requirement.waiver.evidenceRefs.map(redactSecrets).join(", ")}`,
        ],
      };
    }
    if (!requirement.kind) {
      return { requirementId: requirement.id, kind: null, status: "unevaluated", evidence: ["explicit constraint was not mapped to a deterministic evaluator"] };
    }
    const paths = observations.flatMap(observationPaths);
    const changedPathObservations = observations.filter((observation) => observation.type === "changed_paths");
    const commandObservations = observations.filter((observation) => observation.type === "command" || observation.type === "verification");
    const hasCompleteWorkspaceObservation = changedPathObservations.some((observation) => observation.measured === true && observation.authoritative !== false);
    const hasUsablePathEvidence = paths.length > 0 || hasCompleteWorkspaceObservation;
    let status: RequirementStatus = "unevaluated";
    const evidence: string[] = [];
    let observedFileType: RequirementPathType | undefined;
    switch (requirement.kind) {
      case "no_frontend": {
        const conflict = paths.find((path) => isFrontendPath(path, platform));
        const canProveAbsence = changedPathObservations.length > 0
          && hasUsablePathEvidence
          && changedPathObservations.every((observation) => observation.authoritative !== false);
        if (conflict || canProveAbsence) {
          status = conflict ? "failed" : "verified";
          evidence.push(conflict ? `frontend path changed: ${conflict}` : "final changed paths contain no frontend deliverable");
        }
        break;
      }
      case "no_database": {
        const conflict = paths.find((path) => isDatabasePath(path, platform));
        const canProveAbsence = changedPathObservations.length > 0
          && hasUsablePathEvidence
          && changedPathObservations.every((observation) => observation.authoritative !== false);
        if (conflict || canProveAbsence) {
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
          || (isDependencyManifest(path) && observations.some((observation) => observation.dependencyChange === true && observationPaths(observation).some((candidate) => pathKey(candidate) === pathKey(path)))));
        const manifestPath = paths.find((path) => isDependencyManifest(path));
        const explicitDependencyChange = observations.find((observation) => observation.dependencyChange === true);
        if (commandObservations.length > 0 || changedPathObservations.some((observation) => observation.measured === true) || paths.length > 0) {
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
        const allowed = new Set((Array.isArray(requirement.parameters.paths) ? requirement.parameters.paths : []).map((path) => pathKey(String(path))));
        const outside = paths.find((path) => !allowed.has(pathKey(path)));
        if (changedPathObservations.length > 0
          && hasUsablePathEvidence
          && changedPathObservations.every((observation) => observation.authoritative !== false)) {
          status = outside ? "failed" : "verified";
          evidence.push(outside ? `path outside allowlist: ${outside}` : "all final changed paths are allowed");
        }
        break;
      }
      case "required_file": {
        const requiredPath = typeof requirement.parameters.path === "string" ? pathKey(requirement.parameters.path) : "";
        const matchingTypes = changedPathObservations
          .flatMap(authoritativeObservationPathTypes)
          .filter((entry) => pathKey(entry.path) === requiredPath);
        const matchingPath = paths.some((path) => pathKey(path) === requiredPath);
        const type = matchingTypes.at(-1)?.type;
        if (type) {
          observedFileType = type;
          if (type === "file") {
            status = "verified";
            evidence.push(`required file delivered as file: ${requiredPath}`);
          } else if (type === "directory") {
            status = "failed";
            evidence.push(`required path is a directory, not a file: ${requiredPath}`);
          } else {
            status = "unevaluated";
            evidence.push(`required path type is unknown: ${requiredPath}`);
          }
        } else if (hasCompleteWorkspaceObservation) {
          status = "failed";
          evidence.push(`required file absent from authoritative workspace observation: ${requiredPath}`);
        } else if (matchingPath) {
          status = "unevaluated";
          evidence.push(`required path was observed without stat.isFile evidence: ${requiredPath}`);
        } else if (paths.length > 0) {
          status = "failed";
          evidence.push(`required file absent from final changed paths: ${requiredPath}`);
        }
        break;
      }
      case "required_verification": {
        const required = requirement.parameters.command;
        const matching = commandObservations.filter((observation) => {
          const actual = observationCommand(observation);
          return Boolean(actual && required && typeof required === "object" && commandEqual(actual, required as { executable: string; args: string[] }));
        });
        const failed = matching.find((observation) => observation.passed === false || (typeof observation.exitCode === "number" && observation.exitCode !== 0));
        const inconsistent = matching.find((observation) => observation.passed === true && observation.exitCode !== undefined && observation.exitCode !== 0);
        const passed = matching.find((observation) =>
          observation.passed !== false
          && observation.exitCode === 0
          && observation.completed !== false,
        );
        if (failed || inconsistent) {
          status = "failed";
          evidence.push(evidenceFor(failed ?? inconsistent!, "required verification failed"));
        } else if (passed) {
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
    return { requirementId: requirement.id, kind: requirement.kind, status, evidence, ...(observedFileType ? { observedFileType } : {}) };
  });
}

/** Full completion is possible only after every authoritative requirement is terminal and verified/waived. */
export function canCompleteWithRequirements(requirements: ExecutionRequirement[], evaluations: RequirementEvaluation[]): boolean {
  const byId = new Map(evaluations.map((evaluation) => [evaluation.requirementId, evaluation]));
  return requirements
    .filter((requirement) => requirement.authoritative)
    .every((requirement) => {
      const evaluation = byId.get(requirement.id);
      return evaluation?.status === "verified" || (evaluation?.status === "waived" && validRequirementWaiver(requirement));
    });
}

/** Return a structured failure payload for a tool call that would violate policy. */
export function enforceToolRequirement(
  call: RequirementToolCall,
  requirements: ExecutionRequirement[],
  options: RequirementEnforcementOptions = {},
): RequirementEnforcementResult {
  const platform = options.platform ?? process.platform;
  for (const requirement of requirements) {
    if (requirement.kind && !EXECUTION_REQUIREMENT_REGISTRY[requirement.kind].preAction) continue;
    const reason = requirementViolation(requirement, call, platform);
    if (!reason || !requirement.kind) continue;
    return {
      allowed: false,
      resultJson: JSON.stringify({
        errorType: "requirement_violation",
        requirementId: requirement.id,
        requirementKind: requirement.kind,
        sourceExcerpt: redactSecrets(requirement.sourceExcerpt),
        reason: redactSecrets(reason),
        instruction: redactSecrets(correctionInstruction(requirement.kind)),
        toolName: redactSecrets(call.toolName),
        targetPaths: affectedPaths(call).slice(0, 32).map(redactSecrets),
      }),
    };
  }
  return { allowed: true };
}
