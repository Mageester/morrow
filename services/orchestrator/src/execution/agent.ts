import { randomUUID, createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync, renameSync, cpSync } from "node:fs";
import { resolve, relative, join, isAbsolute, dirname } from "node:path";
import { inspectWorkspace, type WorkspaceEntry } from "../workspace/inspector.js";
import { readWorkspaceFile, SafeReadError } from "../workspace/safe-reader.js";
import { createGitignoreMatcher, isBuiltInIgnoredName } from "../workspace/ignore.js";
import { searchFiles, searchText, WorkspaceSearchError } from "../workspace/search.js";
import { gitDiff, gitLog, gitStatus, GitInspectionError } from "../tools/git.js";
import { projectRepository } from "../repositories/projects.js";
import { taskRepository } from "../repositories/tasks.js";
import { taskRecordsRepository } from "../repositories/task-records.js";
import { conversationsRepository, type ToolCallRecord } from "../repositories/conversations.js";
import { taskRoutingRepository } from "../repositories/task-routing.js";
import { memoryRepository } from "../repositories/memory.js";
import { approvalsRepository } from "../repositories/approvals.js";
import { changeSetsRepository } from "../repositories/change-sets.js";
import { taskContinuationsRepository } from "../repositories/task-continuations.js";
import { contextSummariesRepository } from "../repositories/context-summaries.js";
import { createExecutionLeaseOwnerId, ExecutionLeaseFenceError, executionContinuityRepository, type ExecutionCheckpointSnapshot } from "../repositories/execution-continuity.js";
import { symbolIndexRepository } from "../repositories/symbols.js";
import { ApprovalContinuationRegistry } from "./continuation.js";
import { classifyCommand, canonicalCommandTrustKey, longRunningCommandTimeoutMs } from "../tools/command-policy.js";
import { PERMISSION_PROFILE } from "../tools/catalog.js";
import { runProcessSafe } from "../tools/command-executor.js";
import { parseUnifiedDiff, validatePatchPaths, applyUnifiedPatch, hashString, assertContainedRealPath, buildCreationDiff, buildReplacementDiff, PatchApplicationError, type PatchFile } from "../tools/diff-applier.js";
import { repairAndParseToolArguments, validateToolArguments, describeToolSchema, type ToolArgFailureReason } from "../tools/tool-argument-repair.js";
import { resolveMorrowHome } from "../home.js";
import { missionsRepository } from "../repositories/missions.js";
import { MissionService } from "../mission/service.js";
import { createMissionToolFailureReporter } from "../mission/tool-failure-reporter.js";
import { AiProvider, ChatMessage, ToolDefinition, ProviderChunk, ProviderError } from "../provider/base.js";
import { createProvider, getProviderDefaultModel, providerCapabilities } from "../provider/registry.js";
import { isRetryableProviderError, openStreamWithFallback, type FallbackCandidate } from "../provider/fallback.js";
import { globalRateGuard } from "../provider/rate-guard.js";
import { getPreset, DEFAULT_PRESET_ID } from "../routing/presets.js";
import { calculateUsageCost, resolveModelMetadata } from "../routing/models.js";
import { MockProvider } from "../provider/mock.js";
import { adaptiveTurnCeiling, toolProgressFingerprint, turnMadeProgress } from "./adaptive-budget.js";
import { createLoopDetector, toolCallSignature } from "./loop-detector.js";
import { measureProviderRequest, prepareContextForProvider, resolveContextBudget } from "./context-budget.js";
import { buildProviderProjection, projectProviderRequest, type DurableProviderTurn } from "./provider-projection.js";
import { providerRouteFingerprint, resolveEffectiveContext } from "../routing/effective-context.js";
import type { AgentExecutionState, AgentMode, ProviderId, ToolProfile } from "@morrow/contracts";

/**
 * Best-effort human-readable target for a tool call, included in the
 * `tool.started` event so the terminal can render "Editing verify.js" instead
 * of a bare tool name. Never throws: mid-stream arguments may be malformed,
 * in which case no target is reported.
 */
function displayTarget(toolName: string, argsJson: string): { target?: string; verification?: boolean } {
  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>;
    const pick = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    let target: string | undefined;
    if (toolName === "run_command") {
      const executable = pick(args.executable);
      const rest = Array.isArray(args.args) ? args.args.filter((a): a is string => typeof a === "string").join(" ") : "";
      target = executable ? `${executable}${rest ? " " + rest : ""}` : undefined;
    } else {
      target = pick(args.path) ?? pick(args.query) ?? pick(args.pattern) ?? (Array.isArray(args.files) ? args.files.filter((f): f is string => typeof f === "string").join(", ") : undefined);
    }
    const purpose = pick(args.purpose);
    const verification = toolName === "run_command" && purpose !== undefined && /\b(?:verify|verification|test|check|lint|typecheck|build)\b/i.test(purpose);
    return {
      ...(target ? { target: target.length > 80 ? target.slice(0, 79) + "…" : target } : {}),
      ...(verification ? { verification: true } : {}),
    };
  } catch {
    return {};
  }
}

function isProviderContextRejection(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false;
  if (error.status !== 400 && error.status !== 413 && error.status !== 422) return false;
  return /(?:context|token|request).*(?:large|long|limit|maximum|max)|(?:large|long|limit|maximum|max).*(?:context|token|request)/i.test(error.message);
}

const MAX_AUTOMATIC_EXECUTION_SEGMENTS = 64;

/**
 * Find installed skills relevant to a prompt by scoring each skill's
 * id/name/description against the prompt's keywords. Scans the same directories
 * the find_skill tool uses (workspace, MORROW_HOME, bundled MORROW_SKILLS_DIR)
 * and handles both metadata formats (# heading + body, or YAML frontmatter).
 * Used to deterministically surface skills into the agent prompt so skill use
 * doesn't depend on the model choosing to call find_skill.
 */
function discoverRelevantSkills(prompt: string, workspacePath: string, env: NodeJS.ProcessEnv): { id: string; name: string; description: string }[] {
  const dirs = [join(workspacePath, "skills")];
  const home = resolveMorrowHome(env);
  if (home) dirs.push(join(home, "skills"));
  if (env.MORROW_SKILLS_DIR) dirs.push(env.MORROW_SKILLS_DIR);
  const promptTokens = new Set((prompt.toLowerCase().match(/[a-z][a-z-]{2,}/g) ?? []));
  if (promptTokens.size === 0) return [];
  const seen = new Set<string>();
  const scored: { id: string; name: string; description: string; score: number }[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      const sd = join(dir, entry);
      const mdPath = join(sd, "SKILL.md");
      if (seen.has(entry)) continue;
      try { if (!statSync(sd).isDirectory() || !existsSync(mdPath)) continue; } catch { continue; }
      seen.add(entry);
      const md = readFileSync(mdPath, "utf8");
      let name = entry, desc = "";
      if (md.startsWith("---") && md.indexOf("\n---", 3) !== -1) {
        const fm = md.slice(3, md.indexOf("\n---", 3));
        name = (fm.match(/^name:\s*(.*)$/m)?.[1] ?? entry).trim().replace(/^["']|["']$/g, "");
        desc = (fm.match(/^description:\s*(.*)$/m)?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
      } else {
        const lines = md.split("\n").filter((l) => l.trim());
        name = lines[0]?.replace(/^#\s*/, "").trim() || entry;
        desc = lines.slice(1).find((l) => l.trim() && !l.startsWith("#"))?.trim() || "";
      }
      const hayTokens = `${entry} ${name} ${desc}`.toLowerCase().match(/[a-z][a-z-]{2,}/g) ?? [];
      let score = 0;
      for (const t of new Set(hayTokens)) if (promptTokens.has(t)) score++;
      if (score > 0) scored.push({ id: entry, name, description: desc, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 5).map(({ id, name, description }) => ({ id, name, description }));
}

const TOOL_RESULT_BYTE_LIMIT = 24 * 1024;
const TOP_LEVEL_ENTRY_LIMIT = 80;

async function buildWorkspaceDiscovery(
  project: { id: string; workspacePath: string },
  symbolIndex: ReturnType<typeof symbolIndexRepository>,
  abortSignal?: AbortSignal
): Promise<string> {
  const root = project.workspacePath;
  const topLevel = listTopLevel(root, TOP_LEVEL_ENTRY_LIMIT);
  const manifestPaths = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "deno.json", "tsconfig.json", "vite.config.ts", "next.config.js", "README.md", "AGENTS.md"];
  const manifests = manifestPaths
    .map((path) => readOptionalWorkspaceText(root, path, path.toLowerCase().endsWith("readme.md") ? 2_000 : 4_000))
    .filter((item): item is { path: string; bytes: number; preview: string } => Boolean(item));
  const git = await gitStatus(root, { maxOutputBytes: 12 * 1024, timeoutMs: 1_000, ...(abortSignal ? { signal: abortSignal } : {}) }).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
  const symbols = symbolIndex.status(project.id);
  return JSON.stringify({
    kind: "workspace_discovery",
    root: ".",
    limits: { topLevelEntries: TOP_LEVEL_ENTRY_LIMIT, manifestPreviewBytes: 4_000, toolResultBytes: TOOL_RESULT_BYTE_LIMIT },
    topLevel,
    manifests,
    indicators: inferIndicators(topLevel, manifests),
    git,
    symbols,
    nextStep: "Use search_symbols/search_files/search_text/list_files/read_file narrowly for files relevant to the user's request. Do not call inspect_workspace again unless the project root changed.",
  });
}

function listTopLevel(root: string, limit: number): { entries: Array<{ path: string; type: "file" | "directory"; size?: number }>; truncated: boolean } {
  const entries: Array<{ path: string; type: "file" | "directory"; size?: number }> = [];
  const ignoredByGitignore = createGitignoreMatcher(root, (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } });
  let truncated = false;
  try {
    for (const child of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (isBuiltInIgnoredName(child.name, child.isDirectory())) continue;
      if (ignoredByGitignore(child.name, child.isDirectory())) continue;
      if (entries.length >= limit) { truncated = true; break; }
      const full = join(root, child.name);
      if (child.isDirectory()) entries.push({ path: child.name, type: "directory" });
      else if (child.isFile()) {
        let size: number | undefined;
        try { size = statSync(full).size; } catch { size = undefined; }
        entries.push({ path: child.name, type: "file", ...(size === undefined ? {} : { size }) });
      }
    }
  } catch {
    return { entries, truncated };
  }
  return { entries, truncated };
}

function readOptionalWorkspaceText(root: string, path: string, maxBytes: number): { path: string; bytes: number; preview: string } | null {
  try {
    const file = readWorkspaceFile(root, path, maxBytes);
    return { path: file.path, bytes: file.size, preview: file.content.slice(0, maxBytes) };
  } catch {
    return null;
  }
}

function inferIndicators(topLevel: { entries: Array<{ path: string; type: "file" | "directory" }> }, manifests: Array<{ path: string; preview: string }>): { languages: string[]; frameworks: string[] } {
  const languages = new Set<string>();
  const frameworks = new Set<string>();
  for (const entry of topLevel.entries) {
    if (/\.(ts|tsx)$/.test(entry.path)) languages.add("TypeScript");
    if (/\.(js|jsx|mjs|cjs)$/.test(entry.path)) languages.add("JavaScript");
    if (/\.py$/.test(entry.path)) languages.add("Python");
    if (/\.rs$/.test(entry.path)) languages.add("Rust");
    if (/\.go$/.test(entry.path)) languages.add("Go");
  }
  for (const manifest of manifests) {
    const text = manifest.preview.toLowerCase();
    if (manifest.path === "package.json") languages.add("JavaScript/TypeScript");
    if (manifest.path === "pyproject.toml") languages.add("Python");
    if (manifest.path === "Cargo.toml") languages.add("Rust");
    if (manifest.path === "go.mod") languages.add("Go");
    for (const fw of ["react", "vite", "next", "astro", "svelte", "vue", "vitest", "playwright", "express", "fastify"]) {
      if (text.includes(fw)) frameworks.add(fw);
    }
  }
  return { languages: [...languages], frameworks: [...frameworks] };
}

function capToolResult(toolName: string, result: string): string {
  const bytes = Buffer.byteLength(result, "utf8");
  if (bytes <= TOOL_RESULT_BYTE_LIMIT) return result;
  try {
    const parsed = JSON.parse(result) as any;
    if (Array.isArray(parsed.entries)) {
      return JSON.stringify({ ...parsed, entries: parsed.entries.slice(0, 120), truncatedForContext: true, originalBytes: bytes, note: `${toolName} returned a large result; only the first 120 entries are included. Narrow with list_files/search_files/search_text/read_file.` });
    }
  } catch {
    // Fall through to text head/tail summary.
  }
  const head = result.slice(0, Math.floor(TOOL_RESULT_BYTE_LIMIT * 0.65));
  const tail = result.slice(-Math.floor(TOOL_RESULT_BYTE_LIMIT * 0.25));
  return JSON.stringify({ truncatedForContext: true, tool: toolName, originalBytes: bytes, head, tail });
}

function capToolArgumentsForContext(toolName: string, rawArguments: string): string {
  const bytes = Buffer.byteLength(rawArguments, "utf8");
  if (bytes <= TOOL_RESULT_BYTE_LIMIT) return rawArguments;
  try {
    const parsed = JSON.parse(rawArguments) as Record<string, unknown>;
    if (toolName === "create_file" && typeof parsed.content === "string") {
      return JSON.stringify({
        ...parsed,
        content: `[omitted ${Buffer.byteLength(parsed.content, "utf8")} bytes already provided to create_file]`,
        truncatedForContext: true,
        originalArgumentBytes: bytes,
      });
    }
    if (toolName === "propose_patch" && typeof parsed.patch === "string") {
      return JSON.stringify({
        ...parsed,
        patch: `[omitted ${Buffer.byteLength(parsed.patch, "utf8")} bytes already provided to propose_patch]`,
        truncatedForContext: true,
        originalArgumentBytes: bytes,
      });
    }
  } catch {
    // Fall through to a compact opaque placeholder.
  }
  return JSON.stringify({ truncatedForContext: true, tool: toolName, originalArgumentBytes: bytes });
}

function duplicateToolResult(toolName: string, previousBytes: number): string {
  return JSON.stringify({ duplicate: true, tool: toolName, previousResultBytes: previousBytes, note: "Identical tool call already ran in this task. Morrow reused the previous observation and omitted duplicate output to preserve context." });
}

type Dependencies = {
  db: Database.Database;
  taskId: string;
  provider?: AiProvider;
  /** Ordered fallback providers tried (in order) if the primary fails to start. */
  fallbackProviders?: AiProvider[];
  now?: () => string;
  maxTurns?: number;
  /** Upper bound for unattended durable segments; injectable for boundary tests. */
  maxAutomaticSegments?: number;
  maxFileBytes?: number;
  maxContextBytes?: number;
  abortSignal?: AbortSignal;
  recovery?: { checkpointCursor: number; executionLease: { segmentId: string; ownerId: string; generation: number } };
  /** Deterministic crash-boundary hook used by restart tests. Production callers omit it. */
  onSegmentBoundary?: (reason: "context_pressure" | "turn_budget" | "provider_failure") => void | Promise<void>;
};

class AgentToolFailure extends Error {
  readonly resultJson: string;
  readonly errorType: "tool_failed" | "safe_read_rejected" | "tool_not_permitted_in_mode";

  constructor(message: string, result: unknown, errorType: "tool_failed" | "safe_read_rejected" | "tool_not_permitted_in_mode" = "tool_failed") {
    super(message);
    this.name = "AgentToolFailure";
    this.resultJson = JSON.stringify(result);
    this.errorType = errorType;
  }
}

/** The file a patch targets (old side, or new side for a creation hunk). */
function patchTargetFileName(patchFiles: PatchFile[]): string | undefined {
  const target = patchFiles.find((pf) => pf.oldPath !== "/dev/null") ?? patchFiles[0];
  return target?.oldPath !== "/dev/null" ? target?.oldPath : target?.newPath;
}

function patchFailureFeedback(
  workspacePath: string,
  patchFiles: PatchFile[],
  error: unknown,
  attemptsForPatch: number,
  attemptsForFile = 0,
): { message: string; result: Record<string, unknown> } {
  const currentContentLimit = 16 * 1024;
  const patchError = error instanceof PatchApplicationError ? error : null;
  const target = patchFiles.find((pf) => pf.oldPath !== "/dev/null") ?? patchFiles[0];
  const targetFile = target?.oldPath !== "/dev/null" ? target?.oldPath : target?.newPath;
  let current: Record<string, unknown> | null = null;
  if (targetFile && targetFile !== "/dev/null") {
    try {
      const fullPath = assertContainedRealPath(workspacePath, targetFile);
      const content = existsSync(fullPath) ? readFileSync(fullPath, "utf8") : "";
      const bytes = Buffer.byteLength(content, "utf8");
      current = {
        path: targetFile,
        hash: hashString(content),
        bytes,
        lineEnding: content.includes("\r\n") ? "CRLF" : "LF",
        content: content.slice(0, currentContentLimit),
        truncated: bytes > currentContentLimit,
      };
    } catch (readErr) {
      current = {
        path: targetFile,
        readError: readErr instanceof Error ? readErr.message : String(readErr),
      };
    }
  }
  const category = patchError?.category ?? (/Malformed patch|Hunk line count mismatch/i.test(error instanceof Error ? error.message : String(error)) ? "malformed_patch" : "context_mismatch");
  const retryExhausted = attemptsForPatch >= 2;
  // After repeated diff failures against the SAME file — regardless of hash —
  // the model is stuck hand-authoring unified diffs it cannot get right (the
  // classic beta.26 loop: each attempt has a different, still-wrong hunk header,
  // so no per-hash counter ever trips). Escalate to a strategy the model cannot
  // botch: call create_file with the complete file contents, which Morrow
  // applies as a safe, backed-up whole-file edit. This is the escape hatch out
  // of the malformed-patch loop.
  const switchToCreateFile = attemptsForFile >= 2 && targetFile !== undefined && targetFile !== "/dev/null";
  const message = patchError
    ? `Patch conflict in ${targetFile ?? "unknown file"}: ${patchError.category}`
    : error instanceof Error ? error.message : String(error);
  return {
    message,
    result: {
      error: message,
      kind: "patch_recovery_feedback",
      conflictCategory: category,
      targetFile,
      failedHunk: patchError ? {
        oldStart: patchError.hunk.oldStart,
        oldLines: patchError.hunk.oldLines,
        newStart: patchError.hunk.newStart,
        newLines: patchError.hunk.newLines,
        expected: patchError.expected,
        actual: patchError.actual,
        line: patchError.line,
      } : null,
      currentFile: current,
      attemptsForPatch,
      attemptsForFile,
      retryLimit: 2,
      retryExhausted,
      switchToCreateFile,
      instruction: switchToCreateFile
        ? `Editing ${targetFile} as a unified diff has now failed ${attemptsForFile} times. Stop authoring diffs for this file. Call create_file with path "${targetFile}" and content set to the COMPLETE, final text of the file (take currentFile.content and apply your intended change to it). Morrow will apply it as a safe, backed-up whole-file edit.`
        : retryExhausted
        ? "Stop cleanly and report the patch conflict. Do not resend this same patch again."
        : "Regenerate the patch against currentFile.content. Do not resend the stale patch unchanged.",
    },
  };
}

function malformedPatchFilesFromDiff(patch: string): PatchFile[] {
  const files: PatchFile[] = [];
  const lines = patch.split(/\r?\n/);
  let oldPath = "";
  for (const line of lines) {
    if (line.startsWith("--- ")) {
      oldPath = line.slice(4).trim().replace(/^a\//, "");
    } else if (line.startsWith("+++ ")) {
      const newPath = line.slice(4).trim().replace(/^b\//, "");
      files.push({ oldPath: oldPath || newPath, newPath, chunks: [] });
      oldPath = "";
    }
  }
  return files;
}

function extractOnlyFileContract(prompt: string): Set<string> | null {
  const match = /\b(?:using|with)\s+only\s+([^\n]{1,300})/i.exec(prompt);
  if (!match) return null;
  const files = [...match[1]!.matchAll(/\b[\w.-]+\.[A-Za-z0-9]{1,8}\b/g)]
    .map((m) => m[0].replace(/\\/g, "/"))
    .filter((name) => !name.includes("/"));
  return files.length > 0 ? new Set(files) : null;
}

function assertWriteAllowedByFileContract(path: string, allowedFiles: Set<string> | null): void {
  if (!allowedFiles) return;
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!allowedFiles.has(normalized)) {
    throw new AgentToolFailure(`File ${path} is outside the user's explicit allowed file list`, {
      error: `File ${path} is outside the user's explicit allowed file list`,
      kind: "file_contract_violation",
      path,
      allowedFiles: [...allowedFiles],
      instruction: `Do not create or modify auxiliary files. Use only these deliverable files: ${[...allowedFiles].join(", ")}. For verification, run commands like node --check script.js or node -e without writing temporary files.`,
    });
  }
}

export async function executeAgentChatTask({
  db,
  taskId,
  provider,
  fallbackProviders,
  now = () => new Date().toISOString(),
  maxTurns,
  maxAutomaticSegments,
  maxFileBytes,
  maxContextBytes,
  abortSignal,
  recovery,
  onSegmentBoundary,
}: Dependencies): Promise<void> {
  const projects = projectRepository(db);
  const tasks = taskRepository(db);
  const records = taskRecordsRepository(db);
  const convs = conversationsRepository(db);
  const routingRepo = taskRoutingRepository(db);
  const memoryRepo = memoryRepository(db);
  const approvals = approvalsRepository(db);
  const changeSets = changeSetsRepository(db);
  const continuationsRepo = taskContinuationsRepository(db);
  const contextSummaries = contextSummariesRepository(db);
  const symbolIndex = symbolIndexRepository(db);
  const continuity = executionContinuityRepository(db);

  const task = tasks.getTaskById(taskId);
  if (!task || task.kind !== "agent_chat" || !["queued", "running", "interrupted"].includes(task.status)) {
    throw new Error("Task is not available for agent execution");
  }
  const durableResume = continuity.latestCheckpoint(taskId) !== null;

  const project = projects.getProjectById(task.projectId);
  if (!project) {
    throw new Error("Project not found");
  }
  const projectId = project.id;
  const projectName = project.name;
  // A task assigned to a worktree executes entirely inside it: reads, writes,
  // and commands are scoped to the isolated checkout, never the main tree.
  let workspacePath = project.workspacePath;
  const assignedWorktreeId = (task as { worktreeId?: string | null }).worktreeId;
  if (assignedWorktreeId) {
    const worktreeRow = db.prepare("SELECT * FROM worktrees WHERE id = ?").get(assignedWorktreeId) as
      | { status: string; path: string; branch: string }
      | undefined;
    if (!worktreeRow || worktreeRow.status !== "active" || !existsSync(worktreeRow.path)) {
      throw new Error(
        `Assigned worktree is not available (${worktreeRow ? worktreeRow.status : "missing"}). Recreate it or start the task without a worktree.`
      );
    }
    workspacePath = worktreeRow.path;
  }

  // Find the assistant message associated with this task
  const allMessages = db.prepare("SELECT * FROM conversation_messages WHERE task_id = ?").all(taskId);
  if (allMessages.length === 0) {
    throw new Error("Assistant message not found for task");
  }
  const assistantMessageRow = allMessages[0] as any;
  const conversationId = assistantMessageRow.conversation_id;

  const event = (type: Parameters<typeof records.appendEvent>[0]["type"], payload: Record<string, unknown> = {}) => {
    return records.appendEvent({ id: randomUUID(), taskId, type, payload, createdAt: now() });
  };

  // A mission-linked task feeds meaningful tool failures into the mission's
  // failure ledger (loop detection, recovery ladder, /failures). Non-mission
  // tasks get a no-op reporter.
  const taskMissionId = (task as { missionId?: string | null }).missionId ?? null;
  const missionFailures = createMissionToolFailureReporter({
    service: taskMissionId
      ? new MissionService({
          repo: missionsRepository(db),
          getWorkspacePath: (pid) => projects.getProjectById(pid)?.workspacePath,
          backupDir: join(resolveMorrowHome(process.env), "mission-checkpoints"),
          now,
        })
      : null,
    missionId: taskMissionId,
    taskId,
    agentId: (task as { agentId?: string | null }).agentId ?? null,
    log: (message) => console.warn(`[mission ${taskMissionId}] ${message}`),
  });
  let turn = 0;
  let absoluteTurn = 0;
  const transitionAgentState = (state: AgentExecutionState, details: Record<string, unknown> = {}) => {
    const timestamp = now();
    try {
      return records.transitionAgentState(taskId, { id: randomUUID(), state, details, createdAt: timestamp });
    } catch (err) {
      const previous = records.getAgentState(taskId)?.state ?? null;
      console.warn("[agent_state_transition_rejected]", JSON.stringify({
        taskId,
        turn,
        previous,
        requested: state,
        event: typeof details.event === "string" ? details.event : "agent_state_transition",
        toolCallId: typeof details.toolCallId === "string" ? details.toolCallId : null,
        timestamp,
      }));
      throw err;
    }
  };

  // YOLO / auto-approve: resolve a freshly-created approval as approved without
  // blocking on a human. The approval record is still created and persisted so
  // the audit trail shows exactly what ran; we annotate the decision note so it
  // is never mistaken for an explicit human grant. The categorical `denied`
  // classification runs *before* any approval is created, so this can never run
  // a denied command or apply a denied patch.
  const autoResolveApproval = (approvalId: string): boolean => {
    approvals.resolve(approvalId, { decision: "allow_once", note: "auto-approved (yolo mode)", resolvedAt: now() });
    event("approval.resolved", { approvalId, decision: "allow_once", auto: true });
    return approvals.get(approvalId)?.status === "approved";
  };

  if (!records.getAgentState(taskId)) transitionAgentState("idle");
  if (!durableResume) transitionAgentState("understanding");
  if (durableResume && records.getAgentState(taskId)?.state === "interrupted") {
    transitionAgentState("understanding", { event: "durable_resume" });
    transitionAgentState("planning", { event: "durable_resume" });
  }

  // Define plan. Default to the full agent capability for an interactive
  // session; ask/plan flows downgrade explicitly via the routing decision.
  const agentMode: AgentMode = routingRepo.get(taskId)?.decision.mode ?? "agent";
  const plan = agentMode === "plan-only"
    ? [
        { id: randomUUID(), position: 1, title: "Understand Request", description: "Interpret the user request and decide what plan would best address it.", status: "pending" as const },
        { id: randomUUID(), position: 2, title: "Produce Plan", description: "Return a concise implementation plan without using tools or claiming execution.", status: "pending" as const }
      ]
    : [
        { id: randomUUID(), position: 1, title: "Analyze & Plan", description: "Understand request and determine necessary workspace inspection tools.", status: "pending" as const },
        { id: randomUUID(), position: 2, title: "Read Workspace", description: "Inspect project structure and read relevant files.", status: "pending" as const },
        { id: randomUUID(), position: 3, title: "Generate Answer", description: "Synthesize findings and stream response to user.", status: "pending" as const }
      ];
  if (!durableResume) {
    records.replacePlan(taskId, plan);
    event("plan.created", { stepCount: plan.length });
    transitionAgentState("planning", { stepCount: plan.length });
  } else if (records.listPlanSteps(taskId).length === 0) {
    // Compatibility for an execution that crashed before older runtimes
    // durably created plan rows. Do not emit replayed plan lifecycle events.
    records.replacePlan(taskId, plan);
  }

  // Resolve routing decision + preset-derived execution budgets
  const routing = routingRepo.get(taskId);
  // Auto-approve is only ever honored in agent mode (double guard: the server
  // already refuses to set it otherwise).
  const autoApprove = agentMode === "agent" && (routing?.decision.autoApprove ?? false);
  const presetId = routing?.presetId ?? DEFAULT_PRESET_ID;
  const preset = getPreset(presetId as any) ?? getPreset(DEFAULT_PRESET_ID)!;
  const providerId = (routing?.providerId ?? (assistantMessageRow.provider as ProviderId | null) ?? "openai") as ProviderId;
  const resolvedModel: string | undefined = routing?.model ?? assistantMessageRow.model ?? undefined;
  const useMemory = routing?.useMemory ?? true;
  // Mode is the single source of truth for which tools are exposed. plan-only
  // gets no tools, read-only (inspect) gets read-only tools, agent gets all.
  const activeToolProfile: ToolProfile = agentMode === "plan-only" ? "none" : agentMode === "agent" ? "agent" : "read-only";
  const turnsLimit = maxTurns ?? (agentMode === "plan-only" ? 1 : preset.maxToolIterations);
  const turnCeiling = adaptiveTurnCeiling(turnsLimit);
  const automaticSegmentLimit = Math.max(1, maxAutomaticSegments ?? MAX_AUTOMATIC_EXECUTION_SEGMENTS);
  const fileBytesLimit = maxFileBytes ?? 102400; // 100 KB per file
  const contextBytesLimit = maxContextBytes ?? preset.contextBudgetBytes;

  // Resolve active provider: an injected provider wins (tests); otherwise the
  // deterministic mock for demo mode, or a registry-built real provider.
  let activeProvider: AiProvider;
  let providerType: ProviderId;
  if (provider) {
    activeProvider = provider;
    providerType = ((provider as { id?: ProviderId }).id ?? "mock") as ProviderId;
  } else if (providerId === "mock" || process.env.MOCK_PROVIDER === "true") {
    // Tool-call ids must be unique per task: upsertToolCall keys on the id and
    // a fixed "call-1" would cross-update another task's row, leaving this
    // task's tool calls invisible. Namespace it to this task.
    const demoCallId = `demo-${taskId.slice(0, 8)}-read`;
    activeProvider = new MockProvider({
      chunks: [
        [
          { type: "tool_call", toolCalls: [{ id: demoCallId, index: 0, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "evidence.txt" }) } }] },
          { type: "done" }
        ],
        [
          { type: "text", text: "Based on the evidence, the system is fully operational." },
          { type: "done" }
        ]
      ],
      delayMs: 150
    });
    providerType = "mock";
  } else {
    try {
      activeProvider = createProvider(providerId, process.env, resolvedModel);
      providerType = providerId;
    } catch (e: any) {
      transitionAgentState("failed", { message: e.message || "Provider not configured" });
      records.transitionTask(taskId, "failed", { id: randomUUID(), createdAt: now(), payload: { message: e.message || "Provider not configured" } });
      convs.updateMessageContentAndState(assistantMessageRow.id, `Provider not available: ${e.message || "not configured"}`, "failed", now());
      return;
    }
  }

  const contextModel = resolvedModel || assistantMessageRow.model || `${providerType}-model`;
  const outputReserveTokens = preset.outputBudgetTokens ?? 2_048;
  const primaryRoute = activeProvider.route ?? {
    providerId: providerType,
    protocol: providerType === "mock" ? "mock" as const : "openai-chat" as const,
    endpointKind: "injected" as const,
    endpointHost: null,
    endpointLimitTokens: null,
    endpointLimitSource: "unknown" as const,
  };
  const effectiveContext = resolveEffectiveContext({
    providerId: providerType,
    selectedModel: contextModel,
    endpoint: {
      kind: primaryRoute.endpointKind,
      host: primaryRoute.endpointHost,
      protocol: primaryRoute.protocol,
      limitTokens: primaryRoute.endpointLimitTokens,
      limitSource: primaryRoute.endpointLimitSource,
    },
    outputReserveTokens,
  });
  const primaryRouteFingerprint = providerRouteFingerprint({
    providerId: providerType,
    model: contextModel,
    protocol: primaryRoute.protocol,
    endpointKind: primaryRoute.endpointKind,
    endpointHost: primaryRoute.endpointHost,
    endpointIdentityHash: primaryRoute.endpointIdentityHash,
  });
  const contextBudget = resolveContextBudget({
    providerId: providerType,
    model: contextModel,
    presetContextBudgetBytes: contextBytesLimit,
    outputBudgetTokens: preset.outputBudgetTokens,
    userContextWindowTokens: effectiveContext.effectiveRequestLimitTokens,
    toolCount: activeToolProfile === "none" ? 0 : activeToolProfile === "agent" ? 12 : 8,
  });

  // Stream candidates for live fallback: the primary first, then any injected
  // fallbacks (tests) or — on the real registry path — every other *configured*
  // routing candidate, in order. A candidate we cannot construct is skipped.
  const streamCandidates: FallbackCandidate[] = [{ id: providerType, provider: activeProvider }];
  if (fallbackProviders && fallbackProviders.length > 0) {
    fallbackProviders.forEach((fp, i) => {
      streamCandidates.push({ id: ((fp as { id?: ProviderId }).id ?? `fallback-${i}`) as string, provider: fp });
    });
  } else if (!provider && providerType !== "mock") {
    for (const cand of routing?.decision.candidates ?? []) {
      if (!cand.configured || cand.providerId === providerType || cand.providerId === "mock") continue;
      try {
        streamCandidates.push({ id: cand.providerId, provider: createProvider(cand.providerId, process.env) });
      } catch {
        /* unconfigurable candidate (e.g. missing key) — skip it */
      }
    }
  }

  const isLocalProvider = providerCapabilities(providerType)?.local ?? false;

  // Enforce honest execution disclosure. An agent-capable session can run
  // approved commands and apply approved patches, so it must NOT report
  // read-only / no-shell. Cost is reported as unknown for hosted providers
  // because Morrow does not meter spend; local/mock are genuinely $0.
  const canExecute = activeToolProfile === "agent";
  records.upsertDisclosure({
    taskId,
    executionMode: "agent-interactive",
    provider: providerType,
    networkAccess: providerType === "mock" ? "disabled" : "enabled",
    filesystemAccess: canExecute ? "workspace-write" : "read-only",
    shellExecution: canExecute,
    modelInvocation: true,
    workspaceScope: workspacePath,
    estimatedCostUsd: providerType === "mock" || isLocalProvider ? "$0.00" : "unknown (not metered)",
    createdAt: now(),
    updatedAt: now()
  });

  // Move into the running lifecycle. A fresh task is `queued`; a continuation or
  // restart resume arrives already `running` (the /resume route used
  // resumeInterruptedTask), or still `interrupted` if the executor was invoked
  // directly. Transition each correctly instead of unconditionally emitting
  // `running -> running` (which the state machine rejects, failing the resume).
  const entryStatus = tasks.getTaskById(taskId)?.status;
  if (entryStatus === "queued") {
    records.transitionTask(taskId, "running", { id: randomUUID(), createdAt: now(), payload: {} });
  } else if (entryStatus === "interrupted") {
    records.resumeInterruptedTask(taskId, { id: randomUUID(), createdAt: now(), payload: { reason: "continuation_resume" } });
  }
  // else already `running` (resumed via the route) — no duplicate task.running event.
  convs.updateMessageContentAndState(assistantMessageRow.id, "", "streaming", now());

  let executionOwnerId: string = recovery?.executionLease.ownerId ?? createExecutionLeaseOwnerId();
  const initialSegment = recovery
    ? continuity.getRunningSegment(taskId)
    : continuity.openSegment({
        taskId,
        missionId: taskMissionId,
        providerId: providerType,
        model: contextModel,
        routeJson: primaryRoute as unknown as Record<string, unknown>,
        ownerId: executionOwnerId,
        now: now(),
      });
  if (!initialSegment) throw new ExecutionLeaseFenceError("Recovered execution segment no longer exists");
  let currentSegment = initialSegment;
  if (recovery && (currentSegment.id !== recovery.executionLease.segmentId
    || currentSegment.ownerId !== recovery.executionLease.ownerId
    || currentSegment.generation !== recovery.executionLease.generation)) {
    throw new ExecutionLeaseFenceError("Recovered execution segment lease no longer matches the fenced claim");
  }

  const currentFence = () => ({ ownerId: executionOwnerId, generation: currentSegment.generation });
  const renewExecutionLease = (): void => {
    const leaseExpiresAt = new Date(Date.parse(now()) + 5 * 60_000).toISOString();
    if (!continuity.renewSegmentLease({ segmentId: currentSegment.id, ...currentFence(), leaseExpiresAt })) {
      throw new ExecutionLeaseFenceError("Execution segment lease was lost; stale execution was stopped");
    }
  };
  const failCurrentSegment = (reason: string): void => {
    if (!continuity.failSegment(currentSegment.id, reason, now(), currentFence())) {
      throw new ExecutionLeaseFenceError();
    }
  };

  // Setup tools definitions
  const tools: ToolDefinition[] = [
    {
      name: "inspect_workspace",
      description: "Performs bounded initial project discovery only: top-level structure, manifests, README/AGENTS previews, Git state, and symbol-index status. Does not recursively dump the repository; use search/list/read tools narrowly after this.",
      parameters: {
        type: "object",
        properties: {}
      }
    },
    {
      name: "list_files",
      description: "Lists a single directory relative to the workspace root with strict limits and ignore rules. Use this for narrow exploration after inspect_workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative directory path (e.g. '.' or 'src')" }
        },
        required: ["path"]
      }
    },
    {
      name: "read_file",
      description: "Reads the content of a specific source or text file in the workspace. Rejects secret files, binary formats, or files exceeding 100 KB.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path (e.g. 'package.json')" }
        },
        required: ["path"]
      }
    },
    {
      name: "search_text",
      description: "Searches safe text files for a literal query. Secret, binary, and oversized files are skipped; output is bounded.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Literal text to find" },
          path: { type: "string", description: "Optional relative directory" }
        },
        required: ["query"]
      }
    },
    {
      name: "search_files",
      description: "Finds safe workspace file paths containing a literal query. Secret paths are skipped and output is bounded.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Literal filename text to find" },
          path: { type: "string", description: "Optional relative directory" }
        },
        required: ["query"]
      }
    },
    {
      name: "search_symbols",
      description: "Searches the project symbol index for functions, classes, methods, types, variables, and JSON config keys. Prefer this before broad file searches. Returns concise locations only.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Symbol name or qualified-name text to find" },
          limit: { type: "number", description: "Maximum symbols to return, up to 50" }
        },
        required: ["query"]
      }
    },
    {
      name: "git_status",
      description: "Inspects concise Git status in the current project without changing Git state.",
      parameters: { type: "object", properties: {} }
    },
    {
      name: "git_diff",
      description: "Inspects current unstaged unified diffs for safe repository paths without changing Git state.",
      parameters: { type: "object", properties: {} }
    },
    {
      name: "git_log",
      description: "Inspects recent Git commit metadata without changing Git state.",
      parameters: {
        type: "object",
        properties: { limit: { type: "number", description: "Maximum recent commits, up to 20" } }
      }
    },
    {
      name: "run_command",
      description: "Run a verification, build, test, or mutation command safely. Denies metacharacters and privilege escalation. Scoped to the project workspace.",
      parameters: {
        type: "object",
        properties: {
          executable: { type: "string", description: "Executable name (e.g. 'pnpm' or 'git')" },
          args: { type: "array", items: { type: "string" }, description: "Command arguments" },
          cwd: { type: "string", description: "Optional working directory relative to project root" },
          purpose: { type: "string", description: "Reason for running this command" }
        },
        required: ["executable", "args", "purpose"]
      }
    },
    {
      name: "create_file",
      description: "Create a NEW file in the workspace from plain text content. This is the reliable way to add new files — prefer it over propose_patch for creation (no diff hunks to author). Parent directories are created automatically. Rejects absolute paths, traversal, secret names, and overwriting an existing file (edit those with propose_patch instead).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path to create (e.g. 'src/App.tsx')" },
          content: { type: "string", description: "Full text content of the new file" },
          purpose: { type: "string", description: "Optional reason for creating this file" }
        },
        required: ["path", "content"]
      }
    },
    {
      name: "create_directory",
      description: "Create a directory (recursively) in the workspace. Use this instead of shell 'mkdir' or PowerShell 'New-Item' — those are not available. Note: creating a file with create_file already makes its parent directories, so this is only needed for otherwise-empty directories.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative directory path to create (e.g. 'src/components')" }
        },
        required: ["path"]
      }
    },
    {
      name: "propose_patch",
      description: "Propose a unified diff patch to modify EXISTING workspace files (or create new ones via a '--- /dev/null' hunk). To create a new file from scratch, prefer create_file. Rejects absolute paths, binary files, traversal, and unauthorized directories.",
      parameters: {
        type: "object",
        properties: {
          patch: { type: "string", description: "Unified diff content" },
          explanation: { type: "string", description: "Reason for the changes" },
          files: { type: "array", items: { type: "string" }, description: "Relative paths of files expected to change" }
        },
        required: ["patch", "explanation", "files"]
      }
    },
    {
      name: "find_skill",
      description: "Search available skills by keyword. Skills are reusable workflows for common tasks (testing, refactoring, debugging, security, etc.). Returns matching skill IDs and descriptions. Call this when you think a specialized workflow might help with the current task.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keyword to search for (e.g. 'test', 'security', 'refactor')" }
        },
        required: ["query"]
      }
    },
    {
      name: "load_skill",
      description: "Load the full instructions for a skill by ID. After finding a relevant skill with find_skill, call this to read its complete workflow and follow its instructions step by step.",
      parameters: {
        type: "object",
        properties: {
          skill_id: { type: "string", description: "The skill ID to load (e.g. 'code-review', 'test-writer')" }
        },
        required: ["skill_id"]
      }
    },
    {
      name: "create_skill",
      description: "Create a new reusable skill from the current solution. Use after completing a complex multi-step task (5+ tool calls) that would be useful again. Generates SKILL.md + manifest + permissions + entrypoint + test files in the project's skills/ directory. The skill will be discoverable by find_skill in future sessions.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Lowercase kebab-case skill ID (e.g. 'my-workflow')" },
          name: { type: "string", description: "Human-readable name (e.g. 'My Workflow')" },
          description: { type: "string", description: "One-line description of what the skill does" },
          instructions: { type: "string", description: "Full step-by-step instructions the agent should follow when using this skill (20+ chars)" },
          requestedTools: { type: "array", items: { type: "string" }, description: "Tools this skill needs from: filesystem-read, filesystem-write, command-exec, git-inspection, search, network" },
          riskClass: { type: "string", enum: ["low", "medium", "high"], description: "Risk level (default: low)" },
          overwrite: { type: "boolean", description: "Overwrite if skill already exists (default: false)" }
        },
        required: ["id", "name", "description", "instructions"]
      }
    }
  ];

  // The exposed tool set is dictated by the mode. Inspect (read-only) never
  // sees run_command/propose_patch; plan-only sees nothing; only agent mode
  // exposes execution and write tools.
  const READ_ONLY_TOOL_NAMES = new Set([
    "inspect_workspace", "list_files", "read_file", "search_text", "search_files", "search_symbols", "git_status", "git_diff", "git_log", "find_skill", "load_skill",
  ]);
  const exposedTools: ToolDefinition[] =
    activeToolProfile === "none" ? [] : activeToolProfile === "agent" ? tools : tools.filter((t) => READ_ONLY_TOOL_NAMES.has(t.name));

  // Load conversation messages before this task's assistant message
  const chatMessages: ChatMessage[] = [];
  const dbMessages = convs.listMessages(conversationId);
  const latestUserPrompt = [...dbMessages].reverse().find((m) => m.id !== assistantMessageRow.id && m.role === "user")?.content ?? "";
  const allowedWriteFiles = extractOnlyFileContract(latestUserPrompt);
  
  // System instructions
  chatMessages.push({
    role: "system",
    content: `You are Morrow, a secure personal AI coding assistant.
You are running in an environment scoped to the project: ${projectName} located at ${workspacePath}.
You have access to tools to inspect the workspace, read files, run safe project commands (like running tests), and propose patches to write files.
You MUST choose relevant files, do NOT automatically ingest the entire repository.
If you need to explore, call inspect_workspace once for bounded root facts, prefer search_symbols before broad search, then use list_files/search_files/search_text/read_file only for paths relevant to the user's request.
You must run test/verification commands using run_command, and modify files using the file tools.
${allowedWriteFiles ? `The user explicitly constrained deliverable files to ONLY: ${[...allowedWriteFiles].join(", ")}. Treat this as a hard write contract: do not create or modify auxiliary files, test files, temp files, logs, package files, or directories outside that list. For calculations or checks, use run_command with node -e or existing files; do not write scratch verification files.` : ""}

File & directory operations — use the dedicated tools, NOT the shell:
- Create a new file: call create_file with a relative path and full content. Parent directories are created automatically.
- Create an empty directory: call create_directory. (Not needed before create_file — that already makes parents.)
- Edit an existing file: call propose_patch with a unified diff.
- Do NOT try to create files/directories with run_command. Shell built-ins and shells (mkdir, md, cmd, powershell/pwsh with New-Item, bash, sh) are unavailable and will be denied — creating a file or directory that way will fail. Use create_file / create_directory instead.

Running commands with run_command (each argument is a separate array element; the shell does NOT interpret them):
- Do NOT chain commands with && or ; or pipes, and do NOT wrap them in a shell. Issue one command per run_command call.
- Package managers work directly: run_command executable "npm" args ["install"]; executable "npm" args ["run","build"]; executable "npm" args ["test"]. Same for pnpm/yarn/node/git.
- Avoid interactive scaffolders (e.g. "npm create vite") — they hang waiting for input. Instead write the project files yourself with create_file and install dependencies with npm install.
- If a command is denied, do not repeat it. Switch to the allowed equivalent (a file tool, or a non-shell command) described in the error.

Morrow ships installed skills (reusable expert workflows). They ARE available — never tell the user skills are unavailable. When a relevant skill is listed below or found via find_skill, call load_skill for it and follow its workflow. After completing a complex multi-step task, save the approach with create_skill.`
  });

  // Deterministically surface installed skills relevant to this request so the
  // agent reliably uses them, rather than depending on the model deciding to
  // call find_skill. The model is told to load the best match first; that
  // produces a visible load_skill tool call and grounds it in a real workflow.
  if (agentMode !== "plan-only" && activeToolProfile !== "none") {
    const relevantSkills = discoverRelevantSkills(latestUserPrompt, workspacePath, process.env);
    if (relevantSkills.length > 0) {
      const list = relevantSkills.map((s) => `- ${s.id}: ${s.description || s.name}`).join("\n");
      chatMessages.push({
        role: "system",
        content: `Installed skills relevant to this request (these are installed and ready — do NOT claim skills are unavailable):\n${list}\n\nBefore doing other work, call load_skill with the single most relevant skill id above, then follow its instructions. You may also call find_skill to look for others.`,
      });
    }
  }
  if (agentMode === "plan-only") {
    chatMessages.push({
      role: "system",
      content: "You are in plan-only mode. Do not use tools, do not claim to have inspected files or run commands, and return only a concise actionable plan."
    });
  }

  // Inject user-controlled memory (bounded, deterministic, project-isolated).
  if (useMemory) {
    const entries = memoryRepo.listActiveForConversation(projectId, conversationId);
    const lines: string[] = [];
    let used = 0;
    const memoryCap = 4000;
    for (const entry of entries) {
      const line = `- (${entry.scope}) ${entry.content}`;
      if (used + line.length > memoryCap) break;
      lines.push(line);
      used += line.length + 1;
    }
    if (lines.length > 0) {
      chatMessages.push({
        role: "system",
        content: `Relevant saved memory for this project (user-controlled, may be edited or deleted by the user):\n${lines.join("\n")}`
      });
    }
  }

  const manualProjection = contextSummaries.latestManualForConversation(conversationId);
  if (manualProjection) {
    chatMessages.push({
      role: "system",
      content: `User-requested durable conversation compaction (deterministic; original records remain stored):\n${manualProjection.content}`,
    });
  }
  const projectedDbMessages = manualProjection
    ? dbMessages.slice(Math.min(dbMessages.length, manualProjection.sourceEndIndex + 1))
    : dbMessages;
  for (const msg of projectedDbMessages) {
    if (msg.id === assistantMessageRow.id) break;
    chatMessages.push({
      role: msg.role === "user" ? "user" : "assistant",
      content: msg.content
    });
  }

  async function executeApprovedTool(toolName: string, args: any, tcId: string): Promise<string> {
    renewExecutionLease();
    if (toolName === "run_command") {
      const exec = args.executable;
      const cmdArgs = args.args || [];
      const cmdCwd = args.cwd || "";
      const purpose = args.purpose || "";

      // Re-assert workspace containment of the working directory immediately
      // before execution (defense in depth: the cwd was also checked before the
      // approval was created). Rejects absolute paths, traversal, and symlink
      // escape.
      const resolvedCwd = cmdCwd ? assertContainedRealPath(workspacePath, cmdCwd) : workspacePath;

      transitionAgentState("executing_tool", { tool: "run_command" });
      // Dependency installs, builds, and test runs legitimately take minutes;
      // the default 30s ceiling was too tight for `npm install` / `npm run build`
      // and made ordinary project setup time out. Give those a generous ceiling
      // while keeping short-lived commands snappy.
      const runOptions: Parameters<typeof runProcessSafe>[4] = {
        timeoutMs: longRunningCommandTimeoutMs(exec, cmdArgs),
        maxOutputBytes: 65536,
      };
      if (abortSignal) {
        runOptions.abortSignal = abortSignal;
      }
      const result = await runProcessSafe(exec, cmdArgs, resolvedCwd, process.env, runOptions);

      if (result.terminationReason === "error") {
        throw new Error(result.error || "Process execution failed");
      }

      const resultStr = JSON.stringify({
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        terminationReason: result.terminationReason
      });

      records.appendEvidence({
        id: randomUUID(),
        taskId,
        type: "file",
        path: `${exec} ${cmdArgs.join(" ")}`,
        metadata: {
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          terminationReason: result.terminationReason
        },
        createdAt: now()
      });

      return resultStr;
    } else if (toolName === "propose_patch") {
      const patch = args.patch;
      const explanation = args.explanation;
      const files = args.files || [];

      const patchFiles = parseUnifiedDiff(patch);
      if (patchFiles.length === 0) {
        throw new Error("Malformed patch: could not parse any file hunks from the unified diff");
      }
      validatePatchPaths(workspacePath, patchFiles, PERMISSION_PROFILE.deniedNamePatterns);

      const diffHash = hashString(patch);
      const changeSet = changeSets.listByTask(taskId).find(cs => cs.diffHash === diffHash);
      if (!changeSet) {
        throw new Error(`Change set record not found for diff hash: ${diffHash}`);
      }
      const originalHashes = changeSet.originalHashes;

      transitionAgentState("applying_changes");

      // Revalidate workspace containment & original hashes. The real-path guard
      // re-checks symlink escape immediately before we touch the filesystem.
      validatePatchPaths(workspacePath, patchFiles, PERMISSION_PROFILE.deniedNamePatterns);
      for (const pf of patchFiles) {
        if (pf.oldPath !== "/dev/null") {
          const fullPath = assertContainedRealPath(workspacePath, pf.oldPath);
          const content = readFileSync(fullPath, "utf8");
          const currentHash = hashString(content);
          if (currentHash !== originalHashes[pf.oldPath]) {
            throw new Error(`File hashes changed between proposal and application for: ${pf.oldPath}`);
          }
        }
      }

      // Create backups under MORROW_HOME
      const backupsDir = join(resolveMorrowHome(process.env), "backups");
      mkdirSync(backupsDir, { recursive: true });

      const backupReferences: Record<string, string> = {};
      const postApplyHashes: Record<string, string> = {};

      // Apply the patch
      for (const pf of patchFiles) {
        const fullPath = pf.oldPath !== "/dev/null" ? assertContainedRealPath(workspacePath, pf.oldPath) : "";
        let originalContent: string | null = null;
        if (pf.oldPath !== "/dev/null" && existsSync(fullPath)) {
          originalContent = readFileSync(fullPath, "utf8");
          const h = originalHashes[pf.oldPath];
          if (!h) {
            throw new Error(`Missing original hash for: ${pf.oldPath}`);
          }
          const backupFile = join(backupsDir, `${h}.bak`);
          writeFileSync(backupFile, originalContent, "utf8");
          backupReferences[pf.oldPath] = h;
        }

        let newContent: string;
        try {
          newContent = applyUnifiedPatch(originalContent, pf.chunks);
        } catch (patchErr) {
          const attempts = (patchFailureCountsByHash.get(diffHash) ?? 0) + 1;
          patchFailureCountsByHash.set(diffHash, attempts);
          const targetName = patchTargetFileName(patchFiles);
          const fileAttempts = targetName ? (patchFailureCountsByFile.get(targetName) ?? 0) + 1 : 0;
          if (targetName) patchFailureCountsByFile.set(targetName, fileAttempts);
          const feedback = patchFailureFeedback(workspacePath, patchFiles, patchErr, attempts, fileAttempts);
          event("patch.recovery_feedback", {
            targetFile: pf.oldPath !== "/dev/null" ? pf.oldPath : pf.newPath,
            conflictCategory: (feedback.result as any).conflictCategory,
            attemptsForPatch: attempts,
            retryExhausted: (feedback.result as any).retryExhausted,
            instruction: (feedback.result as any).instruction,
          });
          throw new AgentToolFailure(feedback.message, feedback.result);
        }
        if (pf.oldPath !== "/dev/null" && originalContent !== null && hashString(newContent) === hashString(originalContent)) {
          throw new AgentToolFailure(`Patch produced no content changes for: ${pf.newPath}`, {
            error: `Patch produced no content changes for: ${pf.newPath}`,
            kind: "patch_no_effect",
            targetFile: pf.newPath,
            currentFile: {
              path: pf.newPath,
              hash: hashString(originalContent),
              bytes: Buffer.byteLength(originalContent, "utf8"),
              truncated: Buffer.byteLength(originalContent, "utf8") > 16 * 1024,
              content: originalContent.slice(0, 16 * 1024),
            },
            instruction: "Regenerate a patch that changes the target file, or stop cleanly if no change is needed.",
          });
        }
        const destPath = assertContainedRealPath(workspacePath, pf.newPath);
        mkdirSync(dirname(destPath), { recursive: true });
        writeFileSync(destPath, newContent, "utf8");

        postApplyHashes[pf.newPath] = hashString(newContent);

        records.appendEvidence({
          id: randomUUID(),
          taskId,
          type: "file",
          path: pf.newPath,
          metadata: { action: "patched", diffHash },
          createdAt: now()
        });
        event("evidence.persisted", { path: pf.newPath, size: Buffer.byteLength(newContent, "utf8"), action: "patched" });
      }

      changeSets.updateApplied(changeSet.id, postApplyHashes, backupReferences);

      return JSON.stringify({
        status: "success",
        appliedFiles: files,
        diffHash
      });
    } else if (toolName === "create_directory") {
      const relPath = args.path;
      // Re-assert containment immediately before touching the filesystem
      // (defense in depth against a symlinked ancestor appearing after approval).
      const destPath = assertContainedRealPath(workspacePath, relPath);
      transitionAgentState("executing_tool", { tool: "create_directory" });
      const created = !existsSync(destPath);
      mkdirSync(destPath, { recursive: true });
      records.appendEvidence({
        id: randomUUID(),
        taskId,
        type: "file",
        path: relPath,
        metadata: { action: "created_directory", alreadyExisted: !created },
        createdAt: now(),
      });
      event("evidence.persisted", { path: relPath, size: 0, action: "created_directory" });
      return JSON.stringify({ status: "success", path: relPath, created });
    } else if (toolName === "find_skill") {
      const query = (args.query || "").toLowerCase().trim();
      if (!query) return JSON.stringify({ skills: [] });
      // Scan skills/ directories: project workspace + MORROW_HOME
      const candidates = [join(workspacePath, "skills")];
      const morrowHome = resolveMorrowHome(process.env);
      if (morrowHome) candidates.push(join(morrowHome, "skills"));
      const skillsDir = process.env.MORROW_SKILLS_DIR;
      if (skillsDir) candidates.push(skillsDir);
      const results: { id: string; name: string; description: string }[] = [];
      const seen = new Set<string>();
      for (const dir of candidates) {
        if (!existsSync(dir)) continue;
        for (const entry of readdirSync(dir)) {
          const skillDir = join(dir, entry);
          if (!statSync(skillDir).isDirectory() || !existsSync(join(skillDir, "SKILL.md"))) continue;
          if (seen.has(entry)) continue;
          seen.add(entry);
          // Read name + description. Skills use either a "# Heading" + body or
          // YAML frontmatter (--- name: ... description: ... ---); handle both.
          const md = readFileSync(join(skillDir, "SKILL.md"), "utf8");
          let name = entry, desc = "";
          if (md.startsWith("---") && md.indexOf("\n---", 3) !== -1) {
            const fm = md.slice(3, md.indexOf("\n---", 3));
            name = (fm.match(/^name:\s*(.*)$/m)?.[1] ?? entry).trim().replace(/^["']|["']$/g, "");
            desc = (fm.match(/^description:\s*(.*)$/m)?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
          } else {
            const lines = md.split("\n").filter(l => l.trim());
            name = lines[0]?.replace(/^#\s*/, "").trim() || entry;
            desc = lines.slice(1).find(l => l.trim() && !l.startsWith("#"))?.trim() || "";
          }
          // Match against query
          const searchable = `${entry} ${name} ${desc}`.toLowerCase();
          if (!query || searchable.includes(query)) {
            results.push({ id: entry, name, description: desc });
          }
          if (results.length >= 10) break;
        }
        if (results.length >= 10) break;
      }
      return JSON.stringify({ skills: results });
    } else if (toolName === "load_skill") {
      const skillId = (args.skill_id || "").trim();
      if (!skillId || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(skillId)) {
        return JSON.stringify({ error: `Invalid skill ID: ${skillId}` });
      }
      // Try each candidate dir
      const candidates = [join(workspacePath, "skills")];
      const morrowHome = resolveMorrowHome(process.env);
      if (morrowHome) candidates.push(join(morrowHome, "skills"));
      const skillsDir = process.env.MORROW_SKILLS_DIR;
      if (skillsDir) candidates.push(skillsDir);
      for (const dir of candidates) {
        const mdPath = join(dir, skillId, "SKILL.md");
        if (existsSync(mdPath)) {
          return readFileSync(mdPath, "utf8");
        }
      }
      return JSON.stringify({ error: `Skill not found: ${skillId}` });
    } else if (toolName === "create_skill") {
      // ── Skill Creator (better than Hermes) ────────────────────────────────
      // Generates SKILL.md + manifest.json + permissions.json + src/index.ts +
      // test/index.test.ts. Validates, sandbox-checksums, deduplicates, backs up
      // on overwrite, and classifies risk. Every generated skill passes verifySkill.
      const KNOWN_TOOLS = new Set(["filesystem-read","filesystem-write","command-exec","git-inspection","search","network"]);
      const RISK_CLASSES = new Set(["low","medium","high"]);

      const id = (args.id || "").trim().toLowerCase();
      const name = (args.name || "").trim();
      const description = (args.description || "").trim();
      const instructions = (args.instructions || "").trim();
      const requestedTools = (args.requestedTools || []).filter(Boolean);
      const riskClass = args.riskClass || "low";

      // ── Validation ──────────────────────────────────────────────────────
      const issues: string[] = [];
      if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(id)) issues.push("id must be lowercase kebab-case (2-63 chars)");
      if (!name) issues.push("name is required");
      if (!description) issues.push("description is required");
      if (instructions.length < 20) issues.push("instructions must be at least 20 characters");
      for (const t of requestedTools) { if (!KNOWN_TOOLS.has(t)) issues.push(`unknown tool: ${t}`); }
      if (!RISK_CLASSES.has(riskClass)) issues.push(`riskClass must be low, medium, or high`);
      if (issues.length > 0) return JSON.stringify({ created: false, issues });

      // ── Determine target directory ──────────────────────────────────────
      const candidates = [join(workspacePath, "skills")];
      const morrowHome = resolveMorrowHome(process.env);
      if (morrowHome) candidates.push(join(morrowHome, "skills"));
      const skillsDir = process.env.MORROW_SKILLS_DIR;
      if (skillsDir) candidates.push(skillsDir);
      const targetRoot = candidates.find(d => existsSync(d)) || candidates[0]!;
      const targetDir = join(targetRoot, id);
      const overwrite = args.overwrite === true;

      // ── Check for existing ──────────────────────────────────────────────
      if (existsSync(targetDir)) {
        if (!overwrite) return JSON.stringify({ created: false, issues: [`Skill "${id}" already exists. Set overwrite=true to replace it.`] });
        // Backup before overwriting
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const backupDir = join(targetRoot, ".backups", id, stamp);
        mkdirSync(backupDir, { recursive: true });
        cpSync(targetDir, backupDir, { recursive: true });
      }

      // ── Generate files ──────────────────────────────────────────────────
      const scopes = ["workspace"];
      const permTools = requestedTools.length ? requestedTools : ["filesystem-read"];

      const skillMd = `# ${name}\n\n${description}\n\n## When to use\n\n${instructions}\n\n## Permissions\n- Tools: ${permTools.join(", ")}\n- Filesystem: ${scopes.join(", ")}\n- Network: none\n- Secrets: none\n`;
      const checksum = createHash("sha256").update(skillMd).digest("hex");

      const manifest = {
        id, name, version: "0.1.0", description, publisher: "auto", license: "MIT",
        checksum, entrypoint: "src/index.ts", supportedPlatforms: ["win32","linux","darwin"],
        requestedTools: permTools, requestedFilesystemScopes: scopes,
        requestedNetworkDomains: [], requiredSecrets: [], riskClass,
      };
      const permissions = { tools: permTools, filesystemScopes: scopes, networkDomains: [], requiredSecrets: [] };
      const entrySrc = `// Entry point for the "${id}" skill.\n// Implement the skill's behavior here within the declared permissions.\nexport const id = ${JSON.stringify(id)};\nexport {};\n`;
      const testSrc = `import { describe, it, expect } from "vitest";\ndescribe("${id}", () => {\n  it("has a valid manifest", () => {\n    const mf = require("../manifest.json");\n    expect(mf.id).toBe(${JSON.stringify(id)});\n  });\n});\n`;

      // ── Write files ─────────────────────────────────────────────────────
      mkdirSync(targetDir, { recursive: true });
      mkdirSync(join(targetDir, "src"), { recursive: true });
      mkdirSync(join(targetDir, "test"), { recursive: true });
      writeFileSync(join(targetDir, "SKILL.md"), skillMd, "utf8");
      writeFileSync(join(targetDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
      writeFileSync(join(targetDir, "permissions.json"), JSON.stringify(permissions, null, 2) + "\n", "utf8");
      writeFileSync(join(targetDir, "src/index.ts"), entrySrc, "utf8");
      writeFileSync(join(targetDir, "test/index.test.ts"), testSrc, "utf8");

      return JSON.stringify({
        created: true,
        id,
        directory: targetDir,
        riskClass,
        tools: permTools,
        checksum: checksum.slice(0, 16) + "...",
        overwritten: overwrite && existsSync(targetDir),
        note: `Skill "${id}" created. Enable it with: morrow skills enable ${id}`,
        skillsDirectory: targetRoot,
      });
    } else {
      throw new Error(`Forbidden tool: ${toolName}`);
    }
  }

  let noProgressTurns = 0;
  const seenToolSignatures = new Set<string>();
  const seenProgressFingerprints = new Set<string>();
  const toolResultBytesBySignature = new Map<string, number>();
  const patchFailureCountsByHash = new Map<string, number>();
  // Failed diff attempts keyed by TARGET FILE (not patch hash). A model that
  // keeps emitting differently-broken diffs for the same file never trips the
  // per-hash ceiling; this counter drives the escalation to create_file.
  const patchFailureCountsByFile = new Map<string, number>();
  // Bounded correction budget for malformed / schema-invalid tool arguments,
  // keyed by tool name so a provider that keeps emitting broken JSON for the
  // same tool is stopped after one corrective retry instead of looping.
  const malformedArgAttemptsByTool = new Map<string, number>();
  // Tight per-action loop detection: catches the same tool+args recurring within
  // a short window, stopping a stuck model sooner than the turn-budget ceiling.
  const loopDetector = createLoopDetector();
  let responseContent = assistantMessageRow.content || "";

  // Turn-boundary tracking. `responseContent` stays a whole-task accumulator
  // (every other call site below still reads it that way for cancellation/
  // failure/interruption messages), but each ReAct turn's OWN contribution is
  // just the slice added since `currentTurnStartLen` — that's what gets
  // published as a discrete `assistant.turn_completed` event, so a report can
  // pick exactly one canonical turn instead of concatenating all of them.
  let currentTurnId: string | null = null;
  let currentTurnStartLen = 0;
  let currentTurnOpen = false;
  const closeCurrentTurn = (opts: { final: boolean; hasToolCalls?: boolean; aborted?: boolean }): void => {
    if (!currentTurnOpen || !currentTurnId) return;
    currentTurnOpen = false;
    const text = responseContent.slice(currentTurnStartLen);
    if (!text.trim() && !opts.aborted) return;
    event("assistant.turn_completed", {
      turnId: currentTurnId,
      text,
      final: opts.final,
      hasToolCalls: opts.hasToolCalls ?? false,
      ...(opts.aborted ? { aborted: true } : {}),
    });
  };

  const continuation = continuationsRepo.get(taskId);
  if (continuation) {
    const messageToolCalls = convs.listToolCallsForMessage(assistantMessageRow.id);
    const incompleteTc = messageToolCalls.find(tc => tc.id === continuation.toolCallId);
    if (incompleteTc) {
      const approvalRecord = approvals.listByTask(taskId).find(a => 
        a.kind === (continuation.toolName === "propose_patch" ? "change_set" : "command") &&
        (a.status === "pending" || a.status === "approved" || a.status === "denied")
      );

      if (approvalRecord) {
        let isApproved = false;
        let decision = approvalRecord.decision;

        if (approvalRecord.status === "pending") {
          transitionAgentState("waiting_for_approval", { approvalId: approvalRecord.id });
          event("approval.requested", { approvalId: approvalRecord.id, kind: approvalRecord.kind });
          decision = (await ApprovalContinuationRegistry.awaitApproval(approvalRecord.id)) as any;
        }

        const updatedApproval = approvals.get(approvalRecord.id)!;
        if (updatedApproval.status === "approved") {
          isApproved = true;
        }

        if (durableResume && isApproved && incompleteTc.status === "running") {
          // Approval proves authorization, not whether the side effect happened.
          // After a process crash the interval between applying a patch/command
          // and durably recording its observation is ambiguous. Re-executing it
          // could duplicate external or workspace effects, so recovery must stop
          // for reconciliation instead of treating approval as an idempotency key.
          const message = `Recovery paused: ${continuation.toolName} may have executed before the restart and requires side-effect reconciliation.`;
          continuationsRepo.delete(taskId);
          failCurrentSegment("ambiguous_tool_effect");
          records.transitionAgentState(taskId, { id: randomUUID(), state: "interrupted", details: { reason: "ambiguous_tool_effect", toolCallId: continuation.toolCallId }, createdAt: now() });
          records.transitionTask(taskId, "interrupted", { id: randomUUID(), createdAt: now(), payload: { reason: "ambiguous_tool_effect", message } });
          convs.updateMessageContentAndState(assistantMessageRow.id, `${responseContent}\n\n[Paused: ${message}]`, "interrupted", now());
          event("task.recovery_required", { reason: "ambiguous_tool_effect", toolCallId: continuation.toolCallId });
          return;
        }

        let resultStr = "";
        let isSuccess = true;
        let errorType = null;
        let errorMessage = null;

        if (isApproved) {
          try {
            convs.upsertToolCall({
              id: incompleteTc.id,
              messageId: incompleteTc.messageId,
              taskId,
              toolName: incompleteTc.toolName,
              argsJson: incompleteTc.argsJson,
              status: "running",
              createdAt: incompleteTc.createdAt,
              startedAt: now(),
            });
            resultStr = await executeApprovedTool(continuation.toolName, continuation.args, continuation.toolCallId);
            missionFailures.reportSuccess(continuation.toolName, continuation.args);
          } catch (err: any) {
            isSuccess = false;
            errorType = err instanceof SafeReadError || err instanceof WorkspaceSearchError || err instanceof GitInspectionError ? "safe_read_rejected" : "tool_failed";
            errorMessage = err.message || "Unknown error";
            resultStr = JSON.stringify({ error: errorMessage });
            event("tool.failed", { toolName: continuation.toolName, message: errorMessage });
            missionFailures.reportFailure(continuation.toolName, continuation.args, errorMessage, errorType);
          }
        } else {
          isSuccess = false;
          errorType = "tool_failed";
          errorMessage = continuation.toolName === "propose_patch" ? "Patch application denied by user." : "Command execution denied by user.";
          resultStr = JSON.stringify({ error: errorMessage });
          event("tool.failed", { toolName: continuation.toolName, message: errorMessage });
          missionFailures.reportFailure(continuation.toolName, continuation.args, errorMessage, errorType);
        }

        convs.upsertToolCall({
          id: continuation.toolCallId,
          messageId: assistantMessageRow.id,
          taskId,
          toolName: continuation.toolName,
          argsJson: JSON.stringify(continuation.args),
          status: isSuccess ? "completed" : "failed",
          resultJson: resultStr,
          errorType: errorType ?? null,
          errorMessage: errorMessage ?? null,
          createdAt: incompleteTc.createdAt,
          startedAt: incompleteTc.startedAt ?? null,
          completedAt: now()
        });
        continuationsRepo.delete(taskId);

        // Mirror the live tool path: once a resumed tool has executed we are
        // back in the observe phase before the next model turn. Without this the
        // agent state would still read executing_tool/applying_changes and the
        // terminal transition to completed would be rejected.
        const resumedState = records.getAgentState(taskId)?.state;
        if (resumedState === "executing_tool" || resumedState === "applying_changes") {
          transitionAgentState("observing", { resumedTool: continuation.toolName });
        }
      }
    }
  }

  const VERIFY_OR_WRITE_TOOLS = new Set(["run_command", "propose_patch", "create_file", "create_directory"]);
  const completionStateFromCalls = (calls: ToolCallRecord[]): {
    failure: { tool: string; detail: string } | null;
    verification: { status: "passed" | "failed" | "missing"; toolCallId?: string; exitCode?: number };
  } => {
    let failure: { tool: string; detail: string } | null = null;
    let verification: { status: "passed" | "failed" | "missing"; toolCallId?: string; exitCode?: number } = { status: "missing" };
    for (const call of calls) {
      if (!VERIFY_OR_WRITE_TOOLS.has(call.toolName)) continue;
      // A call denied purely because the current mode forbids it (read-only /
      // plan-only) is an expected constraint, not a failed verification — it
      // must not block completion. See the matching skip in the live-path
      // bookkeeping above.
      if (call.errorType === "tool_not_permitted_in_mode") continue;
      let failedOutcome: string | null = call.status === "failed" ? (call.errorMessage ?? "tool failed") : null;
      if (call.toolName === "run_command" && call.status === "completed") {
        try {
          const result = JSON.parse(call.resultJson ?? "{}") as { exitCode?: number | null };
          if (typeof result.exitCode === "number") {
            verification = { status: result.exitCode === 0 ? "passed" : "failed", toolCallId: call.id, exitCode: result.exitCode };
            if (result.exitCode !== 0) failedOutcome = `command exited ${result.exitCode}`;
          }
        } catch { /* malformed raw results cannot establish passed verification */ }
      } else if (call.status === "completed") {
        const requiresVerification = taskMissionId !== null || verification.status !== "missing";
        if (requiresVerification) {
          verification = { status: "missing" };
          failedOutcome = "workspace changed without subsequent verification; run verification after the final write";
        }
      }
      failure = failedOutcome ? { tool: call.toolName, detail: failedOutcome } : null;
    }
    return { failure, verification };
  };

  const finalToolCalls = convs.listToolCallsForMessage(assistantMessageRow.id);
  const durableTurns = continuity.listProviderTurns(taskId);
  absoluteTurn = durableTurns.length;
  if (durableTurns.length > 0) {
    const callsById = new Map(finalToolCalls.map((call) => [call.id, call]));
    const turnsForProjection: DurableProviderTurn[] = [];
    for (const durable of durableTurns) {
      const rawCalls = durable.toolCalls as Array<{ id: string; name: string; arguments: string }>;
      const unresolved = rawCalls.find((raw) => {
        const call = callsById.get(raw.id);
        return !call || (call.status !== "completed" && call.status !== "failed");
      });
      if (unresolved) {
        const message = `Recovery paused: tool ${unresolved.name} (${unresolved.id}) has no durable terminal observation.`;
        failCurrentSegment("ambiguous_tool_effect");
        const currentState = records.getAgentState(taskId)?.state;
        if (currentState !== "interrupted") {
          records.transitionAgentState(taskId, { id: randomUUID(), state: "interrupted", details: { reason: "ambiguous_tool_effect", toolCallId: unresolved.id }, createdAt: now() });
        }
        records.transitionTask(taskId, "interrupted", { id: randomUUID(), createdAt: now(), payload: { reason: "ambiguous_tool_effect", message } });
        convs.updateMessageContentAndState(assistantMessageRow.id, `${responseContent}\n\n[Paused: ${message}]`, "interrupted", now());
        event("task.recovery_required", { reason: "ambiguous_tool_effect", toolCallId: unresolved.id });
        return;
      }
      const providerContinuation = continuity.loadProviderContinuation(taskId, durable.turnKey, primaryRouteFingerprint);
      turnsForProjection.push({
        turnKey: durable.turnKey,
        assistantText: durable.assistantText,
        toolCalls: rawCalls,
        ...(providerContinuation ? { providerContinuation, providerContinuationRouteFingerprint: primaryRouteFingerprint } : {}),
      });
      if (durable.segmentId === currentSegment.id) turn = Math.max(turn, durable.ordinal);
    }
    chatMessages.push(...buildProviderProjection({
      prefixMessages: [],
      turns: turnsForProjection,
      toolResults: finalToolCalls.map((call) => ({ id: call.id, toolName: call.toolName, result: call.resultJson || "" })),
      normalizeToolArguments: capToolArgumentsForContext,
    }));
  } else if (finalToolCalls.length > 0) {
    // Compatibility projection for tasks created before migration 32. It is
    // intentionally read-only; new turns are persisted discretely above.
    chatMessages.push({
      role: "assistant",
      content: responseContent,
      toolCalls: finalToolCalls.map(tc => ({ id: tc.id, type: "function", function: { name: tc.toolName, arguments: tc.argsJson } }))
    });
    for (const tc of finalToolCalls) chatMessages.push({ role: "tool", name: tc.toolName, toolCallId: tc.id, content: tc.resultJson || "" });
    turn = 1;
  }

  let appliedTaskProjectionId: string | null = null;
  const applyLatestTaskProjection = (): void => {
    const projection = contextSummaries.latestForTask(taskId);
    if (!projection || projection.id === appliedTaskProjectionId || projection.conversationId !== conversationId) return;
    const systemMessages = chatMessages.filter((message) => message.role === "system");
    const durableMessages = chatMessages.filter((message) => message.role !== "system");
    const end = Math.min(projection.sourceEndIndex, durableMessages.length - 1);
    if (end < 0) return;
    chatMessages.splice(0, chatMessages.length,
      ...systemMessages,
      { role: "system", content: `User-requested durable task compaction (task ${taskId}; original records remain stored):\n${projection.content}` },
      ...durableMessages.slice(end + 1));
    appliedTaskProjectionId = projection.id;
  };
  applyLatestTaskProjection();

  let completedWithoutMoreTools = false;
  let canonicalFinalText = "";
  let emptyFinalResponseRetries = 0;
  let providerRecoverySegments = 0;
  let forceProviderCompaction = false;
  let totalBytesRead = 0;
  // Tracks the outcome of the most recent workspace-mutating or verification
  // action so a natural end-of-conversation stop can be gated: the model must
  // not report "completed" when the last patch/file write failed, or the last
  // verification command exited non-zero. A subsequent successful mutation or a
  // clean verification clears it (the model recovered). See the completion gate
  // at the end of the loop.
  let lastVerificationFailure: { tool: string; detail: string } | null = completionStateFromCalls(finalToolCalls).failure;
  const steps = records.listPlanSteps(taskId);

  const planningStep = steps[0]!;
  const workspaceStep = steps.find((step) => step.title === "Read Workspace");
  const finalStep = steps[steps.length - 1]!;

  const resumableStep = durableResume ? steps.find((step) => step.status === "running") ?? steps.find((step) => step.status === "pending") : null;
  let activeStepId = (resumableStep ?? planningStep).id;
  if (!durableResume || resumableStep?.status !== "running") {
    records.updatePlanStepStatus(activeStepId, "running", now());
    event("step.started", { stepId: activeStepId });
  }

  const persistExecutionCheckpoint = async (phase: string): Promise<string> => {
    const status = await gitStatus(workspacePath, { maxOutputBytes: 16 * 1024, timeoutMs: 1_000, ...(abortSignal ? { signal: abortSignal } : {}) })
      .catch(() => ({ lines: [] as string[], truncated: false, timedOut: false }));
    const calls = convs.listToolCallsForMessage(assistantMessageRow.id);
    const tests = calls
      .filter((call) => call.toolName === "run_command")
      .map((call) => {
        let exitCode: number | null = null;
        try {
          const result = JSON.parse(call.resultJson ?? "{}") as Record<string, unknown>;
          exitCode = typeof result.exitCode === "number" ? result.exitCode : null;
        } catch { /* exact raw result remains durable on the tool-call row */ }
        return { command: call.argsJson, exitCode, result: call.resultJson ?? call.errorMessage ?? call.status };
      });
    const failedCalls = calls.filter((call) => call.status === "failed");
    const lastEvent = records.listEvents(taskId).at(-1);
    const snapshot: ExecutionCheckpointSnapshot = {
      version: 1,
      originalMission: latestUserPrompt,
      hardRequirements: latestUserPrompt.trim() ? [latestUserPrompt] : [],
      prohibitedActions: latestUserPrompt.split(/\r?\n/).map((line) => line.trim()).filter((line) => /\b(?:do not|don't|never|prohibited)\b/i.test(line)),
      acceptanceCriteria: latestUserPrompt.split(/\r?\n/).map((line) => line.trim()).filter((line) => /\b(?:must|acceptance|required|prove|verify)\b/i.test(line)),
      decisions: ["Continue through durable execution segments without treating an internal boundary as completion."],
      completedWork: calls.filter((call) => call.status === "completed").map((call) => `${call.toolName}: ${call.argsJson}`),
      currentPhase: phase,
      filesChanged: status.lines.filter((line) => !line.startsWith("## ")).map((line) => line.slice(3).trim()),
      gitStatus: status.lines.join("\n"),
      tests,
      unresolvedFailures: failedCalls.map((call) => `${call.toolName}: ${call.errorMessage ?? call.status}`),
      recoveryAttempts: records.listEvents(taskId).filter((item) => item.type === "provider.fallback" || item.type === "task.recovery_requeued").map((item) => `${item.type}: ${JSON.stringify(item.payload)}`),
      pendingWork: completedWithoutMoreTools ? [] : ["Continue provider execution and complete verification."],
      approvals: { records: approvals.listByTask(taskId).map((approval) => ({ id: approval.id, kind: approval.kind, status: approval.status, decision: approval.decision })) },
      taskId,
      missionId: taskMissionId,
      providerRouting: { providerId: providerType, model: contextModel, route: primaryRoute },
      providerContinuationRefs: continuity.listProviderContinuationRefs(taskId),
      evidenceRequired: ["All hard requirements evaluated", "Required verification passed", "One canonical final answer"],
    };
    const checkpointId = randomUUID();
    continuity.saveCheckpoint({
      id: checkpointId,
      taskId,
      missionId: taskMissionId,
      segmentId: currentSegment.id,
      cursor: lastEvent?.sequence ?? 0,
      snapshot,
      ...currentFence(),
      now: now(),
    });
    return checkpointId;
  };

  const interruptAtSegmentLimit = (checkpointId: string): boolean => {
    if (currentSegment.sequence < automaticSegmentLimit) return false;
    closeCurrentTurn({ final: false, aborted: true });
    const message = `Automatic execution paused after ${automaticSegmentLimit} durable segments to bound unattended provider and tool usage.`;
    failCurrentSegment("segment_budget_exhausted");
    transitionAgentState("interrupted", { reason: "segment_budget_exhausted", message, checkpointId, turns: absoluteTurn });
    records.transitionTask(taskId, "interrupted", { id: randomUUID(), createdAt: now(), payload: { reason: "segment_budget_exhausted", message, checkpointId } });
    convs.updateMessageContentAndState(assistantMessageRow.id, `${responseContent}\n\n[Paused: ${message}]`, "interrupted", now());
    if (activeStepId) records.updatePlanStepStatus(activeStepId, "skipped", now());
    return true;
  };

  const completeWithCanonicalAnswer = (finalText: string, sourceTurnKey: string): void => {
    const completionState = completionStateFromCalls(convs.listToolCallsForMessage(assistantMessageRow.id));
    const evidenceJson = {
      sourceTurnKey,
      durableEventCursor: records.listEvents(taskId).at(-1)?.sequence ?? 0,
      verification: completionState.verification,
      unresolvedBlocker: completionState.failure?.detail ?? null,
      unresolvedFailures: completionState.failure ? [`${completionState.failure.tool}: ${completionState.failure.detail}`] : [],
      status: taskMissionId ? "pending_mission_verification" : "completed",
    };
    db.transaction(() => {
      continuity.createCanonicalAnswer({
        id: randomUUID(), taskId, missionId: taskMissionId, segmentId: currentSegment.id, content: finalText, evidenceJson, ...currentFence(), now: now(),
      });
      if (!continuity.completeSegment(currentSegment.id, now(), currentFence())) throw new ExecutionLeaseFenceError();
      // Old/checkpoint fixtures can resume before the active lifecycle was
      // persisted. Walk only the missing legal states so canonical completion
      // remains transactional without weakening the state machine globally.
      const currentState = records.getAgentState(taskId)?.state;
      if (!currentState) transitionAgentState("idle");
      const resumableState = records.getAgentState(taskId)?.state;
      if (resumableState === "idle" || resumableState === "interrupted") transitionAgentState("understanding", { event: "canonical_completion_resume" });
      if (records.getAgentState(taskId)?.state === "understanding") transitionAgentState("planning", { event: "canonical_completion_resume" });
      const preCompletionState = records.getAgentState(taskId)?.state;
      if (preCompletionState === "waiting_for_approval" || preCompletionState === "executing_tool") transitionAgentState("observing", { event: "canonical_completion_resume" });
      if (records.getAgentState(taskId)?.state !== "completed") transitionAgentState("completed");
      records.transitionTask(taskId, "completed", { id: randomUUID(), createdAt: now(), payload: {} });
      convs.updateMessageContentAndState(assistantMessageRow.id, finalText, "completed", now());
    })();
  };

  // Handle AbortSignal cancellation
  const checkCancelled = (): boolean => {
    if (abortSignal?.aborted || tasks.getTaskById(taskId)?.status === "cancelled") {
      return true;
    }
    return false;
  };

  const handleCancellation = () => {
    closeCurrentTurn({ final: false, aborted: true });
    const currentTask = tasks.getTaskById(taskId);
    if (currentTask && currentTask.status !== "cancelled") {
      records.transitionTask(taskId, "cancelled", { id: randomUUID(), createdAt: now(), payload: {} });
    }
    transitionAgentState("cancelled");
    failCurrentSegment("cancelled");
    convs.updateMessageContentAndState(assistantMessageRow.id, responseContent, "cancelled", now());
    if (activeStepId) {
      records.updatePlanStepStatus(activeStepId, "failed", now());
    }
    const existingEvents = records.listEvents(taskId);
    if (!existingEvents.some(ev => ev.type === "task.cancelled")) {
      event("task.cancelled", {});
    }
  };

  const replayableFinalTurn = durableTurns.at(-1);
  if (replayableFinalTurn
    && replayableFinalTurn.isFinal
    && replayableFinalTurn.toolCalls.length === 0
    && replayableFinalTurn.assistantText.trim().length > 0
    && !lastVerificationFailure) {
    for (const step of steps) records.updatePlanStepStatus(step.id, "completed", now());
    completeWithCanonicalAnswer(replayableFinalTurn.assistantText, replayableFinalTurn.turnKey);
    return;
  }

  while (true) {
    if (checkCancelled()) {
      handleCancellation();
      return;
    }

    renewExecutionLease();
    applyLatestTaskProjection();

    turn++;
    absoluteTurn++;
    const responseLengthAtTurnStart = responseContent.length;
    currentTurnId = `${taskId}:turn-${absoluteTurn}`;
    currentTurnStartLen = responseLengthAtTurnStart;
    currentTurnOpen = true;
    event("assistant.turn_started", { turnId: currentTurnId });
    const completedToolSignatures: string[] = [];
    const repeatedToolSignatures: string[] = [];
    let loopDetected: { signature: string; count: number } | null = null;
    let hasToolCalls = false;
    const currentToolCalls: any[] = [];
    let currentReasoningContent = "";
    let currentServedBy = providerType as string;
    let currentRouteFingerprint = primaryRouteFingerprint;

    try {
      const preparedContext = prepareContextForProvider(chatMessages, {
        providerId: providerType,
        model: contextModel,
        // This first pass enforces the preset/user safety budget and performs
        // deterministic history compaction. The route-aware complete-envelope
        // gate below remains authoritative for the actual provider request,
        // including tools, continuation fields, overhead, and output reserve.
        maxInputTokens: contextBudget.maxInputTokens,
        compact: true,
        recentRawGroups: 1,
      });
      event("context.budget_calculated", {
        provider: providerType,
        model: contextModel,
        contextWindowTokens: contextBudget.contextWindowTokens,
        contextWindowSource: contextBudget.contextWindowSource,
        exactModelLimit: contextBudget.exactModelLimit,
        reservedOutputTokens: contextBudget.outputBudgetTokens,
        reservedTokens: contextBudget.reservedTokens,
        maxInputTokens: contextBudget.maxInputTokens,
        modelCapacityTokens: effectiveContext.advertisedModelCapacityTokens,
        modelCapacitySource: effectiveContext.advertisedModelCapacitySource,
        endpointLimitTokens: effectiveContext.configuredEndpointLimitTokens,
        endpointLimitSource: effectiveContext.endpointLimitSource,
        effectiveRequestLimitTokens: effectiveContext.effectiveRequestLimitTokens,
        effectiveLimitSource: effectiveContext.effectiveLimitSource,
        maximumInputTokens: effectiveContext.maximumInputTokens,
        endpointHost: effectiveContext.endpointHost,
        endpointKind: effectiveContext.endpointKind,
      });
      for (const op of preparedContext.operations) event(op.type, { ...op.payload, provider: providerType, model: contextModel });
      if (!preparedContext.ok) {
        failCurrentSegment("context_preflight_failed");
        transitionAgentState("failed", { message: preparedContext.actionableMessage });
        records.transitionTask(taskId, "failed", { id: randomUUID(), createdAt: now(), payload: { message: preparedContext.actionableMessage } });
        convs.updateMessageContentAndState(assistantMessageRow.id, preparedContext.actionableMessage, "failed", now());
        if (activeStepId) records.updatePlanStepStatus(activeStepId, "failed", now());
        return;
      }
      if (preparedContext.summary) {
        const record = contextSummaries.record({
          id: randomUUID(),
          projectId,
          conversationId,
          taskId,
          method: preparedContext.summary.method,
          content: preparedContext.summary.content,
          sourceStartIndex: preparedContext.summary.sourceStartIndex,
          sourceEndIndex: preparedContext.summary.sourceEndIndex,
          sourceMessageCount: preparedContext.summary.sourceMessageCount,
          createdAt: now(),
        });
        // This projection is already applied to the in-memory request below.
        // Reapplying it at the next loop would interpret its original durable
        // message cursor against the compacted transient projection and could
        // separate an assistant tool call from its result.
        appliedTaskProjectionId = record.id;
        const last = records.listEvents(taskId).filter((ev) => ev.type === "context.compaction_completed").at(-1);
        if (last) {
          event("context.compaction_completed", {
            summaryId: record.id,
            method: record.method,
            compactedGroups: preparedContext.compactedGroups,
            sourceMessageCount: record.sourceMessageCount,
          });
        }
      }
      if (preparedContext.removedGroups > 0 || preparedContext.compactedGroups > 0) {
        event("context.trimmed", {
          finalTokens: preparedContext.finalTokens,
          maxInputTokens: contextBudget.maxInputTokens,
          trimmedMessages: preparedContext.compactedGroups + preparedContext.removedGroups,
          compactedGroups: preparedContext.compactedGroups,
          removedGroups: preparedContext.removedGroups,
          countingMethod: preparedContext.tokenCount.method,
          exact: preparedContext.tokenCount.exact,
        });
        const checkpointId = await persistExecutionCheckpoint("context_compaction");
        if (interruptAtSegmentLimit(checkpointId)) return;
        currentSegment = continuity.rolloverSegment({
          taskId,
          currentSegmentId: currentSegment.id,
          reason: "context_pressure",
          providerId: providerType,
          model: contextModel,
          routeJson: primaryRoute as unknown as Record<string, unknown>,
          ownerId: executionOwnerId,
          generation: currentSegment.generation,
          now: now(),
        });
        // Full records remain durable in conversation/tool/turn tables. Only
        // the transient provider projection is replaced by the verified-fit
        // compacted projection, making repeated rebuilds idempotent.
        chatMessages.splice(0, chatMessages.length, ...preparedContext.messages);
        turn = 1;
        event("context.compaction_completed", {
          checkpointId,
          reason: "context_pressure",
          automaticContinuation: true,
          segmentSequence: currentSegment.sequence,
        });
        await onSegmentBoundary?.("context_pressure");
      }
      const candidateEnvelopes = streamCandidates.map((candidate) => {
        const candidateModel = candidate.id === providerType
          ? contextModel
          : (getProviderDefaultModel(candidate.id as ProviderId, process.env) ?? `${candidate.id}-model`);
        const route = candidate.provider.route ?? {
          providerId: candidate.id,
          protocol: candidate.id === "mock" ? "mock" as const : "openai-chat" as const,
          endpointKind: "injected" as const,
          endpointHost: null,
          endpointLimitTokens: null,
          endpointLimitSource: "unknown" as const,
        };
        const resolution = resolveEffectiveContext({
          providerId: candidate.id,
          selectedModel: candidateModel,
          endpoint: {
            kind: route.endpointKind,
            host: route.endpointHost,
            protocol: route.protocol,
            limitTokens: route.endpointLimitTokens,
            limitSource: route.endpointLimitSource,
          },
          outputReserveTokens,
        });
        const routeFingerprint = providerRouteFingerprint({
          providerId: candidate.id,
          model: candidateModel,
          protocol: route.protocol,
          endpointKind: route.endpointKind,
          endpointHost: route.endpointHost,
          endpointIdentityHash: route.endpointIdentityHash,
        });
        const candidateMessages = preparedContext.messages.map((message) => {
          if (!message.providerContinuation) return message;
          if (message.providerContinuationRouteFingerprint === routeFingerprint) return message;
          const { providerContinuation: _private, providerContinuationRouteFingerprint: _binding, ...publicMessage } = message;
          return publicMessage;
        });
        const candidateOptions = {
          ...(abortSignal ? { abortSignal } : {}),
          tools: exposedTools,
          model: candidateModel,
          timeoutMs: preset.timeoutMs,
          temperature: preset.temperature,
          maxOutputTokens: preset.outputBudgetTokens,
        };
        const envelope = {
          providerId: candidate.id,
          model: candidateModel,
          protocol: route.protocol,
          messages: candidateMessages,
          tools: exposedTools,
          outputReserveTokens,
        };
        return { candidate, candidateModel, route, resolution, routeFingerprint, candidateOptions, envelope };
      });
      const compactionThresholdRatio = forceProviderCompaction ? 0.65 : 0.8;
      const compactionNeeded = forceProviderCompaction || candidateEnvelopes.some(({ envelope, resolution }) =>
        measureProviderRequest(envelope).inputTokens >= Math.floor(resolution.maximumInputTokens * compactionThresholdRatio),
      );
      let projectionCheckpoint: ExecutionCheckpointSnapshot | null = null;
      let projectionCheckpointId: string | null = null;
      if (compactionNeeded) {
        projectionCheckpointId = await persistExecutionCheckpoint("context_compaction");
        projectionCheckpoint = continuity.latestCheckpoint(taskId)?.snapshot ?? null;
        if (!projectionCheckpoint) throw new Error("Durable context checkpoint was not persisted");
      }
      const projectedCandidates = candidateEnvelopes.map((item) => {
        const projection = projectionCheckpoint
          ? projectProviderRequest({ checkpoint: projectionCheckpoint, envelope: item.envelope, resolution: item.resolution, thresholdRatio: compactionThresholdRatio, recentRawGroups: 1, forceCompaction: forceProviderCompaction })
          : {
              envelope: item.envelope,
              admission: { ok: true as const, measurement: measureProviderRequest(item.envelope) },
              compacted: false,
              thresholdTokens: Math.floor(item.resolution.maximumInputTokens * compactionThresholdRatio),
              contentHash: createHash("sha256").update(JSON.stringify(item.envelope)).digest("hex"),
              originalMeasurement: measureProviderRequest(item.envelope),
            };
        return { ...item, projection };
      });
      const admittedCandidates = projectedCandidates.flatMap(({ candidate, candidateModel, resolution, routeFingerprint, candidateOptions, projection }) => {
        const admission = projection.admission;
        event("context.budget_calculated", {
          provider: candidate.id,
          model: candidateModel,
          modelCapacityTokens: resolution.advertisedModelCapacityTokens,
          modelCapacitySource: resolution.advertisedModelCapacitySource,
          endpointLimitTokens: resolution.configuredEndpointLimitTokens,
          endpointLimitSource: resolution.endpointLimitSource,
          effectiveLimitSource: resolution.effectiveLimitSource,
          outputReserveTokens,
          currentRequestTokens: admission.measurement.inputTokens,
          totalRequestTokens: admission.measurement.totalRequestTokens,
          maximumInputTokens: resolution.maximumInputTokens,
          effectiveRequestLimitTokens: resolution.effectiveRequestLimitTokens,
          admitted: admission.ok,
          compactionThresholdTokens: projection.thresholdTokens,
          projectionCompacted: projection.compacted,
          projectionHash: projection.contentHash,
        });
        return admission.ok
          ? [{ ...candidate, request: { messages: projection.envelope.messages, options: candidateOptions, routeFingerprint } }]
          : [];
      });
      if (admittedCandidates.length === 0) {
        throw new Error("Provider request cannot fit the verified endpoint limit after automatic compaction; no provider call was made.");
      }
      const opened = await openStreamWithFallback(
        admittedCandidates,
        preparedContext.messages,
        {
          ...(abortSignal ? { abortSignal } : {}),
          tools: exposedTools,
          model: resolvedModel || assistantMessageRow.model || undefined,
          timeoutMs: preset.timeoutMs,
          temperature: preset.temperature,
          maxOutputTokens: preset.outputBudgetTokens
        },
        globalRateGuard
      );
      const selectedCandidate = projectedCandidates.find(({ candidate }) => candidate.id === opened.servedBy);
      if (!selectedCandidate) throw new Error(`Selected provider route ${opened.servedBy} was not preflighted`);
      const selectedProjection = selectedCandidate.projection;
      let openedFreshSegment = false;
      if (selectedProjection?.compacted) {
        if (!projectionCheckpointId) throw new Error("Durable context checkpoint was not persisted");
        if (interruptAtSegmentLimit(projectionCheckpointId)) return;
        currentSegment = continuity.rolloverSegment({
          taskId,
          currentSegmentId: currentSegment.id,
          reason: "context_pressure",
          providerId: opened.servedBy,
          model: selectedCandidate.candidateModel,
          routeJson: selectedCandidate.route as unknown as Record<string, unknown>,
          ownerId: executionOwnerId,
          generation: currentSegment.generation,
          now: now(),
        });
        openedFreshSegment = true;
        chatMessages.splice(0, chatMessages.length, ...selectedProjection.envelope.messages);
        turn = 1;
        event("context.compaction_completed", {
          checkpointId: projectionCheckpointId,
          reason: "complete_envelope_threshold",
          automaticContinuation: true,
          projectionHash: selectedProjection.contentHash,
          thresholdTokens: selectedProjection.thresholdTokens,
          segmentSequence: currentSegment.sequence,
        });
        await onSegmentBoundary?.("context_pressure");
      }
      currentServedBy = opened.servedBy;
      currentRouteFingerprint = opened.routeFingerprint ?? primaryRouteFingerprint;
      if (opened.fellBackFrom.length > 0) {
        if (!openedFreshSegment) {
          const checkpointId = await persistExecutionCheckpoint("provider_route_switch");
          if (interruptAtSegmentLimit(checkpointId)) return;
          currentSegment = continuity.rolloverSegment({
            taskId,
            currentSegmentId: currentSegment.id,
            reason: "provider_failure",
            providerId: opened.servedBy,
            model: selectedCandidate.candidateModel,
            routeJson: selectedCandidate.route as unknown as Record<string, unknown>,
            ownerId: executionOwnerId,
            generation: currentSegment.generation,
            now: now(),
          });
          openedFreshSegment = true;
          await onSegmentBoundary?.("provider_failure");
        }
        event("provider.fallback", {
          from: opened.fellBackFrom,
          servedBy: opened.servedBy,
          freshSegment: openedFreshSegment,
          segmentSequence: currentSegment.sequence,
          model: selectedCandidate.candidateModel,
          routeFingerprint: currentRouteFingerprint,
          endpointKind: selectedCandidate.route.endpointKind,
          endpointHost: selectedCandidate.route.endpointHost,
          effectiveRequestLimitTokens: selectedCandidate.resolution.effectiveRequestLimitTokens,
          effectiveLimitSource: selectedCandidate.resolution.effectiveLimitSource,
        });
      }
      if (opened.deprioritizedRateLimited.length > 0) {
        event("provider.rate_limited", { deprioritized: opened.deprioritizedRateLimited, servedBy: opened.servedBy });
      }
      const stream = opened.stream;
      forceProviderCompaction = false;
      const servedModel = opened.servedBy === providerType
        ? (resolvedModel || assistantMessageRow.model || contextModel)
        : (getProviderDefaultModel(opened.servedBy as ProviderId, process.env) ?? `${opened.servedBy}-model`);

      for await (const chunk of stream) {
        if (checkCancelled()) {
          handleCancellation();
          return;
        }

        if (chunk.type === "error") {
          throw new ProviderError(chunk.error?.type ?? "provider_error", chunk.error?.message || "Model provider error", {
            kind: chunk.error?.kind ?? "unknown",
            retryable: chunk.error?.retryable ?? false,
            ...(chunk.error?.status !== undefined ? { status: chunk.error.status } : {}),
            ...(chunk.error?.retryAfterMs !== undefined ? { retryAfterMs: chunk.error.retryAfterMs } : {}),
          });
        }

        if (chunk.providerContinuation?.reasoningContent) {
          currentReasoningContent += chunk.providerContinuation.reasoningContent;
        }

        if (chunk.type === "done" && chunk.usage) {
          const cost = calculateUsageCost({
            inputTokens: chunk.usage.promptTokens,
            outputTokens: chunk.usage.completionTokens,
            ...(chunk.usage.cachedPromptTokens !== undefined ? { cachedInputTokens: chunk.usage.cachedPromptTokens } : {}),
          }, resolveModelMetadata(opened.servedBy, servedModel));
          event("provider.usage", {
            provider: opened.servedBy,
            model: servedModel,
            inputTokens: chunk.usage.promptTokens,
            outputTokens: chunk.usage.completionTokens,
            totalTokens: chunk.usage.promptTokens + chunk.usage.completionTokens,
            ...(chunk.usage.cachedPromptTokens !== undefined ? { cachedInputTokens: chunk.usage.cachedPromptTokens } : {}),
            ...(cost.known ? { estimatedCostUsd: cost.usd } : {}),
          });
        }

        if (chunk.type === "text" && chunk.text) {
          // If we transitioned to generating final text, mark Generate Answer as running
          if (activeStepId !== finalStep.id) {
            records.updatePlanStepStatus(activeStepId, "completed", now());
            event("step.completed", { stepId: activeStepId });
            activeStepId = finalStep.id;
            records.updatePlanStepStatus(activeStepId, "running", now());
            event("step.started", { stepId: activeStepId });
          }

          responseContent += chunk.text;
          convs.updateMessageContentAndState(assistantMessageRow.id, responseContent, "streaming", now());

          // Emit a live streaming text update event, scoped to this turn so
          // the CLI never has to guess where one turn ends and the next begins.
          event("evidence.persisted", { deltaText: chunk.text, turnId: currentTurnId });
        }

        if (chunk.type === "tool_call" && chunk.toolCalls) {
          if (activeToolProfile === "none") {
            throw new Error("Provider attempted a tool call while tools are disabled");
          }
          hasToolCalls = true;
          for (const tc of chunk.toolCalls) {
            const index = tc.index !== undefined ? tc.index : 0;
            if (!currentToolCalls[index]) {
              currentToolCalls[index] = { id: "", name: "", arguments: "" };
            }
            if (tc.id) currentToolCalls[index].id = tc.id;
            if (tc.function?.name) currentToolCalls[index].name = tc.function.name;
            if (tc.function?.arguments) {
              currentToolCalls[index].arguments += tc.function.arguments;
            }
          }
        }
      }
    } catch (e: any) {
      // A cancellation that surfaced as a thrown error (e.g. abort before the
      // first chunk) is a cancel, not a provider failure.
      if (checkCancelled() || abortSignal?.aborted) {
        handleCancellation();
        return;
      }
      closeCurrentTurn({ final: false, aborted: true });
      if ((isRetryableProviderError(e) || isProviderContextRejection(e)) && providerRecoverySegments < 2) {
        providerRecoverySegments++;
        forceProviderCompaction = isProviderContextRejection(e);
        const checkpointId = await persistExecutionCheckpoint("provider_recovery");
        if (interruptAtSegmentLimit(checkpointId)) return;
        const failedProvider = currentServedBy;
        currentSegment = continuity.rolloverSegment({
          taskId,
          currentSegmentId: currentSegment.id,
          reason: "provider_failure",
          providerId: providerType,
          model: contextModel,
          routeJson: primaryRoute as unknown as Record<string, unknown>,
          ownerId: executionOwnerId,
          generation: currentSegment.generation,
          now: now(),
        });
        event("provider.fallback", {
          from: [failedProvider],
          servedBy: providerType,
          freshSegment: true,
          checkpointId,
          recoveryAttempt: providerRecoverySegments,
          contextRejection: forceProviderCompaction,
        });
        await onSegmentBoundary?.("provider_failure");
        turn = 0;
        continue;
      }
      console.error("Provider stream error", e);
      const errMessage = e.message || "Failed to query AI provider";
      failCurrentSegment("provider_failure");
      transitionAgentState("failed", { message: errMessage });
      records.transitionTask(taskId, "failed", { id: randomUUID(), createdAt: now(), payload: { message: errMessage } });
      convs.updateMessageContentAndState(assistantMessageRow.id, responseContent + `\n\n[Error: ${errMessage}]`, "failed", now());
      if (activeStepId) {
        records.updatePlanStepStatus(activeStepId, "failed", now());
      }
      return;
    }

    // The stream for this turn ended normally: it produced either tool calls
    // (an intermediate turn) or none (this is the final, user-facing turn).
    // Close it now, before tool execution or a cancellation check can run —
    // the turn itself already finished regardless of what happens next.
    closeCurrentTurn({ final: !(hasToolCalls && currentToolCalls.length > 0), hasToolCalls: hasToolCalls && currentToolCalls.length > 0 });

    const turnText = responseContent.slice(responseLengthAtTurnStart);
    const durableTurnKey = createHash("sha256")
      .update(JSON.stringify({ segment: currentSegment.sequence, turn, text: turnText, toolCalls: currentToolCalls }))
      .digest("hex");
    continuity.recordProviderTurn({
      id: randomUUID(), taskId, segmentId: currentSegment.id, turnKey: durableTurnKey,
      ordinal: turn, assistantText: turnText, toolCalls: currentToolCalls,
      isFinal: !(hasToolCalls && currentToolCalls.length > 0), ...currentFence(), now: now(),
    });
    if (currentReasoningContent) {
      continuity.saveProviderContinuation({
        id: randomUUID(), taskId, segmentId: currentSegment.id, providerId: currentServedBy,
        routeFingerprint: currentRouteFingerprint,
        turnKey: durableTurnKey, state: { reasoningContent: currentReasoningContent }, ...currentFence(), now: now(),
      });
    }

    if (checkCancelled()) {
      handleCancellation();
      return;
    }

    if (hasToolCalls && currentToolCalls.length > 0) {
      transitionAgentState("executing_tool", { toolCount: currentToolCalls.length });
      // Transition step to Read Workspace
      if (workspaceStep && activeStepId !== workspaceStep.id) {
        records.updatePlanStepStatus(activeStepId, "completed", now());
        event("step.completed", { stepId: activeStepId });
        activeStepId = workspaceStep.id;
        records.updatePlanStepStatus(activeStepId, "running", now());
        event("step.started", { stepId: activeStepId });
      }

      const toolOutputs: ChatMessage[] = [];

      // Append assistant message with tool calls to prompt history
      chatMessages.push({
        role: "assistant",
        // Provider history is a projection of discrete turns. `responseContent`
        // is only the cumulative presentation buffer for the single UI row;
        // copying it here made turn N recursively contain turns 1..N-1.
        content: responseContent.slice(responseLengthAtTurnStart),
        ...(currentReasoningContent ? {
          providerContinuation: { reasoningContent: currentReasoningContent },
          providerContinuationRouteFingerprint: currentRouteFingerprint,
        } : {}),
        toolCalls: currentToolCalls.map(tc => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: capToolArgumentsForContext(tc.name, tc.arguments) }
        }))
      });

      for (const tc of currentToolCalls) {
        if (!tc.id || !tc.name) continue;

        // Persist tool call state
        const toolCallRecord = convs.upsertToolCall({
          id: tc.id,
          messageId: assistantMessageRow.id,
          taskId,
          toolName: tc.name,
          argsJson: tc.arguments,
          // A requested call waiting for approval has not entered the side-
          // effect window. It becomes running immediately before execution,
          // which makes restart reconciliation non-ambiguous.
          status: "requested",
          createdAt: now(),
          startedAt: now()
        });
        const toolSignature = `${tc.name}:${tc.arguments}`;
        const repeatedTool = seenToolSignatures.has(toolSignature);
        if (!repeatedTool) seenToolSignatures.add(toolSignature);
        const loop = loopDetector.record(toolCallSignature(tc.name, tc.arguments));
        if (loop.looping && !loopDetected) loopDetected = { signature: loop.signature, count: loop.count };
        const toolStartedAt = Date.now();
        event("tool.started", { id: tc.id, toolName: tc.name, ...displayTarget(tc.name, tc.arguments) });

        let resultStr = "";
        let isSuccess = true;
        let errorType = null;
        let errorMessage = null;
        let args: any = {};

        try {
          const toolDef = tools.find((t) => t.name === tc.name);
          const parsedArgs = repairAndParseToolArguments(tc.arguments);
          if (!parsedArgs.ok) {
            const attempts = (malformedArgAttemptsByTool.get(tc.name) ?? 0) + 1;
            malformedArgAttemptsByTool.set(tc.name, attempts);
            const retryExhausted = attempts >= 2;
            event("tool.arguments_rejected", { toolName: tc.name, reason: parsedArgs.reason, attempts, retryExhausted });
            throw new AgentToolFailure("Invalid tool arguments format", {
              error: "Invalid tool arguments format",
              kind: "malformed_tool_arguments",
              toolName: tc.name,
              reason: parsedArgs.reason satisfies ToolArgFailureReason,
              detail: parsedArgs.detail,
              expectedSchema: describeToolSchema(toolDef) ?? undefined,
              attempts,
              retryLimit: 2,
              retryExhausted,
              instruction: retryExhausted
                ? "Stop cleanly and report that the tool arguments could not be parsed. Do not resend the same malformed call."
                : "Call the tool again with a single valid JSON object matching the schema. No prose, code fences, or trailing commas.",
            });
          }
          args = parsedArgs.value;

          // Reject required-field, wrong-type, and absolute-path defects for the
          // workspace-mutating tools BEFORE dispatch, so a malformed patch/file
          // argument can never reach the applying_changes state. One bounded
          // correction is offered; the second failure stops cleanly.
          if (toolDef && (tc.name === "create_file" || tc.name === "propose_patch" || tc.name === "create_directory")) {
            // Curated load-bearing fields only — the executor tolerates omitted
            // explanation/files on propose_patch, so we don't newly reject them.
            const criticalRequired: Record<string, string[]> = {
              create_file: ["path", "content"],
              create_directory: ["path"],
              propose_patch: ["patch"],
            };
            const problem = validateToolArguments(toolDef, args, criticalRequired[tc.name]);
            if (problem) {
              const attempts = (malformedArgAttemptsByTool.get(tc.name) ?? 0) + 1;
              malformedArgAttemptsByTool.set(tc.name, attempts);
              const retryExhausted = attempts >= 2;
              event("tool.arguments_rejected", { toolName: tc.name, reason: `invalid_argument:${problem.problem}`, attempts, retryExhausted });
              throw new AgentToolFailure(`Invalid argument "${problem.field}" for ${tc.name}`, {
                error: `Invalid argument "${problem.field}" for ${tc.name}`,
                kind: "invalid_tool_arguments",
                toolName: tc.name,
                invalidField: problem.field,
                problem: problem.problem,
                expected: problem.expected,
                expectedSchema: describeToolSchema(toolDef) ?? undefined,
                attempts,
                retryLimit: 2,
                retryExhausted,
                instruction: retryExhausted
                  ? "Stop cleanly and report the invalid argument. Do not resend the same invalid call."
                  : `Fix the "${problem.field}" argument and call the tool once more.`,
              });
            }
          }

          // Defense in depth: execution/write tools are only ever permitted in
          // agent mode, even if a provider hallucinates a call the mode never
          // exposed. This is an expected, correct constraint (not a failed
          // verification) — it must not block an otherwise-complete read-only
          // or plan-only task from reporting `completed` (see
          // `tool_not_permitted_in_mode` handling in the completion gate).
          if ((tc.name === "run_command" || tc.name === "propose_patch" || tc.name === "create_file" || tc.name === "create_directory") && activeToolProfile !== "agent") {
            throw new AgentToolFailure(
              `Tool "${tc.name}" is not permitted in ${agentMode} mode`,
              { error: `Tool "${tc.name}" is not permitted in ${agentMode} mode`, kind: "tool_not_permitted_in_mode" },
              "tool_not_permitted_in_mode",
            );
          }

          const duplicateBytes = repeatedTool ? toolResultBytesBySignature.get(toolSignature) : undefined;
          if (duplicateBytes !== undefined) {
            resultStr = duplicateToolResult(tc.name, duplicateBytes);
            event("workspace.inspected", { kind: "duplicate_tool", toolName: tc.name, resultCount: 0, duplicate: true });
          } else if (tc.name === "inspect_workspace") {
            resultStr = await buildWorkspaceDiscovery(project, symbolIndex, abortSignal);
            const parsed = JSON.parse(resultStr) as { topLevel?: { entries?: unknown[] } };
            event("workspace.inspected", { kind: "workspace_discovery", resultCount: parsed.topLevel?.entries?.length ?? 0 });
          } else if (tc.name === "list_files") {
            const relPath = args.path || ".";
            const res = inspectWorkspace(project.workspacePath, { startPath: relPath, maxDepth: 1, maxResults: 100 });
            resultStr = JSON.stringify({
              entries: res.entries.map(e => ({ path: e.path, size: e.size })),
              truncatedByCount: res.truncatedByCount
            });
            event("workspace.inspected", { path: relPath, resultCount: res.entries.length });
          } else if (tc.name === "read_file") {
            const relPath = args.path;
            if (!relPath) throw new Error("Missing required argument: path");
            
            const fileData = readWorkspaceFile(project.workspacePath, relPath, fileBytesLimit);
            totalBytesRead += fileData.size;

            if (totalBytesRead > contextBytesLimit) {
              throw new SafeReadError(`Raw byte budget ceiling (${Math.round(contextBytesLimit / 1024)} KB) exceeded`);
            }

            resultStr = fileData.content;
            
            // Record task evidence for right inspector
            records.appendEvidence({
              id: randomUUID(),
              taskId,
              type: "file",
              path: fileData.path,
              metadata: { size: fileData.size },
              createdAt: now()
            });

            event("evidence.persisted", { path: fileData.path, size: fileData.size, action: "read" });
          } else if (tc.name === "search_text") {
            if (typeof args.query !== "string") throw new Error("Missing required argument: query");
            const result = searchText(project.workspacePath, args.query, {
              ...(typeof args.path === "string" ? { path: args.path } : {}),
              caseSensitive: args.caseSensitive === true,
              maxResults: 100,
              maxFiles: 500,
              maxFileBytes: Math.min(fileBytesLimit, 64 * 1024),
              timeoutMs: 1_000,
              ...(abortSignal ? { signal: abortSignal } : {}),
            });
            resultStr = JSON.stringify(result);
            totalBytesRead += Buffer.byteLength(resultStr, "utf8");
            if (totalBytesRead > contextBytesLimit) throw new SafeReadError(`Raw byte budget ceiling (${Math.round(contextBytesLimit / 1024)} KB) exceeded`);
            event("workspace.inspected", { kind: "search_text", query: args.query, resultCount: result.matches.length, truncated: result.truncatedByCount || result.truncatedByTimeout });
          } else if (tc.name === "search_files") {
            if (typeof args.query !== "string") throw new Error("Missing required argument: query");
            const result = searchFiles(project.workspacePath, args.query, {
              ...(typeof args.path === "string" ? { path: args.path } : {}),
              caseSensitive: args.caseSensitive === true,
              maxResults: 100,
              maxFiles: 500,
              timeoutMs: 1_000,
              ...(abortSignal ? { signal: abortSignal } : {}),
            });
            resultStr = JSON.stringify(result);
            totalBytesRead += Buffer.byteLength(resultStr, "utf8");
            if (totalBytesRead > contextBytesLimit) throw new SafeReadError(`Raw byte budget ceiling (${Math.round(contextBytesLimit / 1024)} KB) exceeded`);
            event("workspace.inspected", { kind: "search_files", query: args.query, resultCount: result.matches.length, truncated: result.truncatedByCount || result.truncatedByTimeout });
          } else if (tc.name === "search_symbols") {
            if (typeof args.query !== "string") throw new Error("Missing required argument: query");
            const limit = typeof args.limit === "number" ? Math.min(Math.max(Math.floor(args.limit), 1), 50) : 20;
            const status = symbolIndex.status(project.id);
            const matches = status.fileCount === 0 ? [] : symbolIndex.search(project.id, args.query, { limit });
            resultStr = JSON.stringify({
              query: args.query,
              status: status.fileCount === 0 ? "empty" : "ready",
              hint: status.fileCount === 0 ? "Symbol index is empty; run `morrow symbols rebuild`." : null,
              symbols: matches.map((symbol) => ({
                name: symbol.name,
                fqName: symbol.fqName,
                kind: symbol.kind,
                filePath: symbol.filePath,
                startLine: symbol.startLine,
                startColumn: symbol.startColumn,
                endLine: symbol.endLine,
                endColumn: symbol.endColumn,
                parentName: symbol.parentName,
                exported: symbol.exported,
              })),
            });
            totalBytesRead += Buffer.byteLength(resultStr, "utf8");
            if (totalBytesRead > contextBytesLimit) throw new SafeReadError(`Raw byte budget ceiling (${Math.round(contextBytesLimit / 1024)} KB) exceeded`);
            event("workspace.inspected", { kind: "search_symbols", query: args.query, resultCount: matches.length, empty: status.fileCount === 0 });
          } else if (tc.name === "git_status") {
            const result = await gitStatus(project.workspacePath, { maxOutputBytes: 64 * 1024, timeoutMs: 1_000, ...(abortSignal ? { signal: abortSignal } : {}) });
            resultStr = JSON.stringify(result);
            totalBytesRead += Buffer.byteLength(resultStr, "utf8");
            if (totalBytesRead > contextBytesLimit) throw new SafeReadError(`Raw byte budget ceiling (${Math.round(contextBytesLimit / 1024)} KB) exceeded`);
            event("workspace.inspected", { kind: "git_status", resultCount: result.lines.length, truncated: result.truncated || result.timedOut });
          } else if (tc.name === "git_diff") {
            const result = await gitDiff(project.workspacePath, { maxOutputBytes: 64 * 1024, timeoutMs: 1_000, ...(abortSignal ? { signal: abortSignal } : {}) });
            resultStr = JSON.stringify(result);
            totalBytesRead += Buffer.byteLength(resultStr, "utf8");
            if (totalBytesRead > contextBytesLimit) throw new SafeReadError(`Raw byte budget ceiling (${Math.round(contextBytesLimit / 1024)} KB) exceeded`);
            event("workspace.inspected", { kind: "git_diff", resultCount: result.files.length, truncated: result.truncated || result.timedOut });
          } else if (tc.name === "git_log") {
            const result = await gitLog(project.workspacePath, { maxOutputBytes: 64 * 1024, timeoutMs: 1_000, limit: typeof args.limit === "number" ? Math.min(Math.max(Math.floor(args.limit), 1), 20) : 20, ...(abortSignal ? { signal: abortSignal } : {}) });
            resultStr = JSON.stringify(result);
            totalBytesRead += Buffer.byteLength(resultStr, "utf8");
            if (totalBytesRead > contextBytesLimit) throw new SafeReadError(`Raw byte budget ceiling (${Math.round(contextBytesLimit / 1024)} KB) exceeded`);
            event("workspace.inspected", { kind: "git_log", resultCount: result.commits.length, truncated: result.truncated || result.timedOut });
          } else if (tc.name === "run_command") {
            const exec = args.executable;
            const cmdArgs = args.args || [];
            const cmdCwd = args.cwd || "";
            const purpose = args.purpose || "";

            if (typeof exec !== "string") {
              throw new Error("Missing required argument: executable");
            }

            // Command risk classification
            const policy = classifyCommand(exec, cmdArgs);
            if (policy.risk === "denied") {
              throw new Error(`Command denied: ${policy.reason}`);
            }

            // Reject a working directory that escapes the workspace before any
            // approval is created (categorical: cannot be bypassed by trust).
            if (cmdCwd) {
              assertContainedRealPath(project.workspacePath, cmdCwd);
            }

            // Check if there is already an approval decision for this command in this task
            const existingApprovals = approvals.listByTask(taskId);
            let approvalRecord = existingApprovals.find(a => 
              a.kind === "command" &&
              a.details.executable === exec &&
              JSON.stringify(a.details.args) === JSON.stringify(cmdArgs) &&
              a.details.cwd === cmdCwd
            );

            let isApproved = false;
            let reuseApproval = false;

            if (approvalRecord) {
              if (approvalRecord.status === "approved" && (approvalRecord.decision === "trust_project" || approvalRecord.details.toolCallId === tc.id)) {
                isApproved = true;
                reuseApproval = true;
              } else if (approvalRecord.status === "denied") {
                throw new Error(`Command execution denied by user.`);
              }
            }

            if (!reuseApproval) {
              // Not yet approved. Check project command trust — bound to the
              // exact (executable, argv, cwd), not the broad risk pattern.
              const trustKey = canonicalCommandTrustKey(exec, cmdArgs, cmdCwd);
              const isTrusted = approvals.getCommandTrust(project.id, trustKey) !== undefined;
              if (isTrusted) {
                isApproved = true;
              } else {
                // We must request approval!
                const approvalId = randomUUID();
                approvalRecord = approvals.create({
                  id: approvalId,
                  taskId,
                  projectId: project.id,
                  kind: "command",
                  summary: `Run command: ${exec} ${cmdArgs.join(" ")}`,
                  createdAt: now(),
                  details: {
                    executable: exec,
                    args: cmdArgs,
                    cwd: cmdCwd,
                    risk: policy.risk,
                    purpose,
                    pattern: policy.pattern,
                    toolCallId: tc.id,
                  }
                });

                if (autoApprove) {
                  // YOLO: resolve immediately, no continuation/human wait. We do
                  // NOT emit approval.requested (the CLI would prompt on it).
                  isApproved = autoResolveApproval(approvalRecord.id);
                  if (!isApproved) {
                    throw new Error(`Command execution denied by user.`);
                  }
                } else {
                  // Persist continuation state
                  continuationsRepo.save({
                    taskId,
                    toolCallId: tc.id,
                    toolName: tc.name,
                    args: args
                  });

                  // Transition state
                  transitionAgentState("waiting_for_approval", { approvalId: approvalRecord.id });
                  event("approval.requested", { approvalId: approvalRecord.id, kind: "command" });
                  await persistExecutionCheckpoint("waiting_for_approval");

                  // Block in-process
                  const decision = await ApprovalContinuationRegistry.awaitApproval(approvalRecord.id);

                  // Clean up continuation record
                  continuationsRepo.delete(taskId);

                  // Reload approval record
                  const updatedApproval = approvals.get(approvalRecord.id)!;
                  if (updatedApproval.status === "approved") {
                    isApproved = true;
                  } else {
                    throw new Error(`Command execution denied by user.`);
                  }
                }
              }
            }

            if (isApproved) {
              convs.upsertToolCall({
                id: tc.id, messageId: assistantMessageRow.id, taskId,
                toolName: tc.name, argsJson: tc.arguments, status: "running",
                createdAt: toolCallRecord.createdAt, startedAt: now(),
              });
              resultStr = await executeApprovedTool(tc.name, args, tc.id);
            }
          } else if (tc.name === "propose_patch" || tc.name === "create_file") {
            // create_file is a thin, reliable front end over propose_patch: it
            // takes plain path + content and synthesizes a creation diff, then
            // flows through the identical validate/approve/apply/change-set
            // pipeline (so /diff, /changes, backups, and undo all work).
            let patch: string;
            let explanation: string;
            let files: string[];
            // Set when a create_file call targeting an existing file was
            // automatically converted into a whole-file replacement edit, so the
            // final tool result can report the conversion truthfully.
            let createConvertedToEdit = false;
            if (tc.name === "create_file") {
              const relPath = args.path;
              if (typeof relPath !== "string" || !relPath.trim()) throw new Error("Missing required argument: path");
              if (typeof args.content !== "string") throw new Error("Missing required argument: content");
              assertWriteAllowedByFileContract(relPath, allowedWriteFiles);
              // Fail fast with a clear message on containment/denied-name before
              // synthesizing a diff. Parent directories are created on apply.
              validatePatchPaths(project.workspacePath, [{ oldPath: "/dev/null", newPath: relPath, chunks: [] }], PERMISSION_PROFILE.deniedNamePatterns);
              // Automatic edit fallback: if the target already exists, create_file
              // would otherwise dead-end on "it already exists, use an edit patch".
              // Instead switch strategy here and synthesize a whole-file
              // replacement diff so the model's create_file call still lands as a
              // real, backed-up, undoable edit. (Identical content still surfaces
              // as patch_no_effect at apply time, which is the honest signal.)
              const createDest = assertContainedRealPath(project.workspacePath, relPath);
              if (existsSync(createDest)) {
                // Only a *regular file* may be auto-overwritten. A directory (or
                // other special node) at the path is a hard error, never a
                // silent clobber.
                const destStat = statSync(createDest);
                if (!destStat.isFile()) {
                  throw new Error(`Cannot create ${relPath}: a non-file already exists at that path.`);
                }
                const existingContent = readFileSync(createDest, "utf8");
                // Destructive-overwrite guard: refuse to replace a NON-empty file
                // with empty or whitespace-only content. create_file's contract is
                // "full intended content", so an empty body against real content is
                // almost certainly a mistake, and there is nothing to justify
                // destroying the file. The model must use an explicit propose_patch
                // (or create_directory + delete) if emptying is truly intended.
                const existingIsNonEmpty = existingContent.trim().length > 0;
                const replacementIsEmpty = args.content.trim().length === 0;
                if (existingIsNonEmpty && replacementIsEmpty) {
                  event("tool.strategy_switch", { tool: "create_file", from: "create", to: "rejected", path: relPath, reason: "empty_overwrite" });
                  throw new AgentToolFailure(`Refusing to overwrite non-empty ${relPath} with empty content`, {
                    error: `Refusing to overwrite non-empty ${relPath} with empty content`,
                    kind: "unsafe_overwrite_rejected",
                    targetFile: relPath,
                    existingBytes: Buffer.byteLength(existingContent, "utf8"),
                    instruction: "The file already has content. If you intend to change it, call create_file with the complete new content, or propose_patch with an explicit diff. An empty replacement of a non-empty file is not applied automatically.",
                  });
                }
                patch = buildReplacementDiff(relPath, existingContent, args.content);
                explanation = typeof args.purpose === "string" && args.purpose.trim() ? args.purpose.trim() : `Overwrite existing ${relPath}`;
                createConvertedToEdit = true;
                event("tool.strategy_switch", { tool: "create_file", from: "create", to: "edit", path: relPath, reason: "target_exists" });
              } else {
                patch = buildCreationDiff(relPath, args.content);
                explanation = typeof args.purpose === "string" && args.purpose.trim() ? args.purpose.trim() : `Create ${relPath}`;
              }
              files = [relPath];
            } else {
              patch = args.patch;
              explanation = args.explanation;
              files = args.files || [];
              if (typeof patch !== "string") {
                throw new Error("Missing required argument: patch");
              }
            }
            // Normalized args for approval/continuation/execution so a create_file
            // resumes and executes as the propose_patch change it really is.
            const patchArgs = { patch, explanation, files };

            // 1. Parse unified diff. A patch that parses to zero files is
            // malformed input, not an empty success — beta.20 recorded these
            // as successful applications of nothing.
            let patchFiles: PatchFile[];
            try {
              patchFiles = parseUnifiedDiff(patch);
            } catch (patchErr) {
              const attempts = (patchFailureCountsByHash.get(hashString(patch)) ?? 0) + 1;
              patchFailureCountsByHash.set(hashString(patch), attempts);
              const malformedFiles = malformedPatchFilesFromDiff(patch);
              const targetName = patchTargetFileName(malformedFiles);
              const fileAttempts = targetName ? (patchFailureCountsByFile.get(targetName) ?? 0) + 1 : 0;
              if (targetName) patchFailureCountsByFile.set(targetName, fileAttempts);
              const feedback = patchFailureFeedback(project.workspacePath, malformedFiles, patchErr, attempts, fileAttempts);
              event("patch.recovery_feedback", {
                targetFile: (feedback.result as any).targetFile,
                conflictCategory: (feedback.result as any).conflictCategory,
                attemptsForPatch: attempts,
                retryExhausted: (feedback.result as any).retryExhausted,
                instruction: (feedback.result as any).instruction,
              });
              throw new AgentToolFailure(feedback.message, feedback.result);
            }
            if (patchFiles.length === 0) {
              throw new Error("Malformed patch: could not parse any file hunks from the unified diff");
            }
            for (const pf of patchFiles) {
              assertWriteAllowedByFileContract(pf.oldPath !== "/dev/null" ? pf.oldPath : pf.newPath, allowedWriteFiles);
              assertWriteAllowedByFileContract(pf.newPath, allowedWriteFiles);
            }

            // 2. Validate paths containment and safety
            validatePatchPaths(project.workspacePath, patchFiles, PERMISSION_PROFILE.deniedNamePatterns);

            // Calculate original hashes and exact diff hash
            const diffHash = hashString(patch);
            const originalHashes: Record<string, string> = {};
            for (const pf of patchFiles) {
              if (pf.oldPath !== "/dev/null") {
                const fullPath = assertContainedRealPath(project.workspacePath, pf.oldPath);
                if (existsSync(fullPath)) {
                  const content = readFileSync(fullPath, "utf8");
                  originalHashes[pf.oldPath] = hashString(content);
                } else {
                  throw new Error(`File found missing: ${pf.oldPath}`);
                }
              } else {
                // Creation hunk. Key the "was absent" marker by the NEW path so
                // undo can remove exactly the file we create; a bare "/dev/null"
                // key would leave created files un-undoable. Refuse to clobber an
                // existing file through a creation diff — that would overwrite
                // without a backup and make undo delete a pre-existing file.
                const destPath = assertContainedRealPath(project.workspacePath, pf.newPath);
                if (existsSync(destPath)) {
                  throw new Error(`Cannot create ${pf.newPath}: it already exists. Use an edit patch against the existing file instead.`);
                }
                originalHashes[pf.newPath] = "";
              }
            }

            transitionAgentState("proposing_changes");

            // 3. Dry-run verify it applies cleanly
            for (const pf of patchFiles) {
              let originalContent: string | null = null;
              if (pf.oldPath !== "/dev/null") {
                const fullPath = assertContainedRealPath(project.workspacePath, pf.oldPath);
                if (existsSync(fullPath)) {
                  originalContent = readFileSync(fullPath, "utf8");
                }
              }
              // This throws if there is a conflict
              try {
                applyUnifiedPatch(originalContent, pf.chunks);
              } catch (patchErr) {
                const attempts = (patchFailureCountsByHash.get(diffHash) ?? 0) + 1;
                patchFailureCountsByHash.set(diffHash, attempts);
                const targetName = patchTargetFileName(patchFiles);
                const fileAttempts = targetName ? (patchFailureCountsByFile.get(targetName) ?? 0) + 1 : 0;
                if (targetName) patchFailureCountsByFile.set(targetName, fileAttempts);
                const feedback = patchFailureFeedback(project.workspacePath, patchFiles, patchErr, attempts, fileAttempts);
                event("patch.recovery_feedback", {
                  targetFile: pf.oldPath !== "/dev/null" ? pf.oldPath : pf.newPath,
                  conflictCategory: (feedback.result as any).conflictCategory,
                  attemptsForPatch: attempts,
                  retryExhausted: (feedback.result as any).retryExhausted,
                  instruction: (feedback.result as any).instruction,
                });
                throw new AgentToolFailure(feedback.message, feedback.result);
              }
            }

            // 4. Check if there is already an approval decision for this change set in this task
            const existingApprovals = approvals.listByTask(taskId);
            let approvalRecord = existingApprovals.find(a => 
              a.kind === "change_set" &&
              a.details.diffHash === diffHash
            );

            let isApproved = false;

            if (approvalRecord) {
              if (approvalRecord.status === "approved" && approvalRecord.details.toolCallId === tc.id) {
                isApproved = true;
              } else if (approvalRecord.status === "denied") {
                throw new Error(`Patch application denied by user.`);
              }
            } else {
              // Transition through proposing_changes -> waiting_for_approval
              // We must request approval!
              const approvalId = randomUUID();
              approvalRecord = approvals.create({
                id: approvalId,
                taskId,
                projectId: project.id,
                kind: "change_set",
                summary: `Apply patch: ${explanation}`,
                createdAt: now(),
                details: {
                  explanation,
                  files,
                  diff: patch,
                  diffHash,
                  originalHashes,
                  toolCallId: tc.id,
                }
              });

              // Create change_set proposed record
              changeSets.create({
                id: randomUUID(),
                taskId,
                projectId: project.id,
                approvalId: approvalRecord.id,
                diff: patch,
                diffHash,
                originalHashes,
              });

              if (autoApprove) {
                // YOLO: resolve immediately, no continuation/human wait. We do
                // NOT emit approval.requested (the CLI would prompt on it).
                isApproved = autoResolveApproval(approvalRecord.id);
                if (!isApproved) {
                  throw new Error(`Patch application denied by user.`);
                }
              } else {
                // Persist continuation state. Always resume as propose_patch
                // with the normalized diff args — a create_file is a change_set
                // and executeApprovedTool only knows how to replay propose_patch.
                continuationsRepo.save({
                  taskId,
                  toolCallId: tc.id,
                  toolName: "propose_patch",
                  args: patchArgs
                });

                // Transition to waiting_for_approval
                transitionAgentState("waiting_for_approval", { approvalId: approvalRecord.id });
                event("approval.requested", { approvalId: approvalRecord.id, kind: "change_set" });
                await persistExecutionCheckpoint("waiting_for_approval");

                // Block in-process
                const decision = await ApprovalContinuationRegistry.awaitApproval(approvalRecord.id);

                // Clean up continuation
                continuationsRepo.delete(taskId);

                // Reload approval record
                const updatedApproval = approvals.get(approvalRecord.id)!;
                if (updatedApproval.status === "approved") {
                  isApproved = true;
                } else {
                  throw new Error(`Patch application denied by user.`);
                }
              }
            }

            if (isApproved) {
              convs.upsertToolCall({
                id: tc.id, messageId: assistantMessageRow.id, taskId,
                toolName: tc.name, argsJson: tc.arguments, status: "running",
                createdAt: toolCallRecord.createdAt, startedAt: now(),
              });
              resultStr = await executeApprovedTool("propose_patch", patchArgs, tc.id);
              // Report the create→edit conversion in the tool result so the model
              // (and /output) see that create_file landed as a backed-up edit of
              // an existing file rather than a fresh creation.
              if (createConvertedToEdit) {
                try {
                  const applied = JSON.parse(resultStr) as Record<string, unknown>;
                  applied.strategy = "create_to_edit";
                  applied.convertedToEdit = true;
                  applied.note = `create_file target ${files[0]} already existed; applied as a backed-up, undoable whole-file edit.`;
                  resultStr = JSON.stringify(applied);
                } catch { /* non-JSON result — leave as-is */ }
              }
            }
          } else if (tc.name === "create_directory") {
            const relPath = args.path;
            if (typeof relPath !== "string" || !relPath.trim()) throw new Error("Missing required argument: path");
            assertWriteAllowedByFileContract(relPath, allowedWriteFiles);
            // Reject absolute paths, traversal, symlink escape, and denied names
            // before any approval is created (categorical: cannot be bypassed).
            assertContainedRealPath(project.workspacePath, relPath);
            const dirArgs = { path: relPath };

            const existingApprovals = approvals.listByTask(taskId);
            let approvalRecord = existingApprovals.find(a =>
              a.kind === "command" && a.details.tool === "create_directory" && a.details.path === relPath
            );
            let isApproved = false;
            if (approvalRecord) {
              if (approvalRecord.status === "approved" && (approvalRecord.decision === "trust_project" || approvalRecord.details.toolCallId === tc.id)) {
                isApproved = true;
              } else if (approvalRecord.status === "denied") {
                throw new Error(`Directory creation denied by user.`);
              }
            }
            if (!isApproved && !approvalRecord) {
              approvalRecord = approvals.create({
                id: randomUUID(),
                taskId,
                projectId: project.id,
                kind: "command",
                summary: `Create directory: ${relPath}`,
                createdAt: now(),
                details: { tool: "create_directory", path: relPath, risk: "low", toolCallId: tc.id },
              });
              if (autoApprove) {
                isApproved = autoResolveApproval(approvalRecord.id);
                if (!isApproved) throw new Error(`Directory creation denied by user.`);
              } else {
                continuationsRepo.save({ taskId, toolCallId: tc.id, toolName: "create_directory", args: dirArgs });
                transitionAgentState("waiting_for_approval", { approvalId: approvalRecord.id });
                event("approval.requested", { approvalId: approvalRecord.id, kind: "command" });
                await persistExecutionCheckpoint("waiting_for_approval");
                await ApprovalContinuationRegistry.awaitApproval(approvalRecord.id);
                continuationsRepo.delete(taskId);
                if (approvals.get(approvalRecord.id)!.status === "approved") isApproved = true;
                else throw new Error(`Directory creation denied by user.`);
              }
            }
            if (isApproved) {
              convs.upsertToolCall({
                id: tc.id, messageId: assistantMessageRow.id, taskId,
                toolName: tc.name, argsJson: tc.arguments, status: "running",
                createdAt: toolCallRecord.createdAt, startedAt: now(),
              });
              resultStr = await executeApprovedTool("create_directory", dirArgs, tc.id);
            }
          } else if (tc.name === "find_skill" || tc.name === "load_skill") {
            // Read-only skill discovery/loading: no approval needed. (These were
            // advertised to the model but never dispatched here, so the model's
            // calls hit the Forbidden branch -- the cause of "Forbidden tool".)
            resultStr = await executeApprovedTool(tc.name, args, tc.id);
          } else if (tc.name === "create_skill") {
            if (activeToolProfile !== "agent") throw new Error(`Tool "create_skill" is not permitted in ${agentMode} mode`);
            resultStr = await executeApprovedTool(tc.name, args, tc.id);
          } else {
            throw new Error(`Forbidden tool: ${tc.name}`);
          }
        } catch (err: any) {
          isSuccess = false;
          errorType = err instanceof AgentToolFailure
            ? err.errorType
            : err instanceof SafeReadError || err instanceof WorkspaceSearchError || err instanceof GitInspectionError ? "safe_read_rejected" : "tool_failed";
          errorMessage = err.message || "Unknown error";
          resultStr = err instanceof AgentToolFailure ? err.resultJson : JSON.stringify({ error: errorMessage });
          event("tool.failed", { toolName: tc.name, message: errorMessage });
          missionFailures.reportFailure(tc.name, args, errorMessage, errorType);
        }
        if (isSuccess) missionFailures.reportSuccess(tc.name, args);

        // Completion-gate bookkeeping: a run_command that returns a non-zero
        // exit code is a *successful tool call* (it ran) but a *failed
        // verification* — the classic "tests failed yet the task said
        // completed" hole. Treat mutations/verifications that either threw or
        // exited non-zero as an outstanding failure; a clean one clears it.
        if (VERIFY_OR_WRITE_TOOLS.has(tc.name) && errorType !== "tool_not_permitted_in_mode") {
          let failedOutcome: string | null = null;
          if (!isSuccess) {
            failedOutcome = errorMessage ?? "tool failed";
          } else if (tc.name === "run_command") {
            try {
              const parsedRun = JSON.parse(resultStr) as { exitCode?: number | null };
              if (parsedRun.exitCode !== undefined && parsedRun.exitCode !== null && parsedRun.exitCode !== 0) {
                failedOutcome = `${args.executable ?? "command"} exited ${parsedRun.exitCode}`;
              }
            } catch { /* non-JSON result — treat as clean */ }
          }
          lastVerificationFailure = failedOutcome ? { tool: tc.name, detail: failedOutcome } : null;
        }

        const contextResultStr = isSuccess ? capToolResult(tc.name, resultStr) : resultStr;
        if (isSuccess && !repeatedTool) toolResultBytesBySignature.set(toolSignature, Buffer.byteLength(contextResultStr, "utf8"));

        // Complete tool call record. The database keeps raw output for /output;
        // only the model-facing context gets capped/summarized.
        convs.upsertToolCall({
          ...toolCallRecord,
          status: isSuccess ? "completed" : "failed",
          resultJson: resultStr,
          errorType,
          errorMessage,
          completedAt: now()
        });
        if (VERIFY_OR_WRITE_TOOLS.has(tc.name)) {
          lastVerificationFailure = completionStateFromCalls(convs.listToolCallsForMessage(assistantMessageRow.id)).failure;
        }
        if (isSuccess) {
          const progressFingerprint = toolProgressFingerprint(tc.name, args, contextResultStr);
          if (seenProgressFingerprints.has(progressFingerprint)) repeatedToolSignatures.push(progressFingerprint);
          else seenProgressFingerprints.add(progressFingerprint);
          completedToolSignatures.push(progressFingerprint);
        }
        let summary = isSuccess ? "completed" : "failed";
        try {
          const parsed = JSON.parse(resultStr) as { exitCode?: number | null; stdout?: string; stderr?: string; error?: string };
          if (parsed.exitCode !== undefined) summary = `exit ${parsed.exitCode ?? "unknown"}`;
          else if (parsed.error) summary = parsed.error.slice(0, 160);
          else if (parsed.stdout) summary = parsed.stdout.replace(/\s+/g, " ").slice(0, 160);
        } catch { /* non-JSON tool result uses its status summary */ }
        event("tool.completed", {
          id: tc.id,
          toolName: tc.name,
          status: isSuccess ? "completed" : "failed",
          elapsedMs: Date.now() - toolStartedAt,
          summary,
          ...(tc.name === "run_command" ? (() => {
            try {
              const parsed = JSON.parse(resultStr) as { exitCode?: unknown };
              return typeof parsed.exitCode === "number" ? { exitCode: parsed.exitCode } : {};
            } catch { return {}; }
          })() : {}),
          ...(isSuccess ? { outputRef: tc.id } : { error: errorMessage ?? summary }),
        });
        transitionAgentState("observing", {
          event: "tool_completed",
          toolCallId: tc.id,
          toolName: tc.name,
          status: isSuccess ? "completed" : "failed",
        });

        chatMessages.push({
          role: "tool",
          name: tc.name,
          toolCallId: tc.id,
          content: contextResultStr
        });
      }
      transitionAgentState("observing", { toolCount: currentToolCalls.length });
    } else {
      // A normal final turn must supply a user-facing answer. Treating an
      // empty provider turn as completion loses the mission outcome while
      // falsely presenting successful tools as a verified task.
      if (responseContent.length === responseLengthAtTurnStart) {
        // Some live providers occasionally finish a post-tool turn with only
        // usage metadata. Retry that empty turn once before recording an
        // incomplete task; no tool ran in this branch, so the retry has no
        // duplicate workspace side effect.
        if (emptyFinalResponseRetries < 1) {
          emptyFinalResponseRetries++;
          event("task.progress_warning", {
            reason: "empty_provider_response",
            message: "Provider returned no answer after tool completion; retrying the final response once.",
            turns: turn,
          });
          continue;
        }
        const message = "Provider ended without a final answer after tool execution; the result remains incomplete.";
        failCurrentSegment("missing_final_answer");
        transitionAgentState("interrupted", { reason: "missing_final_answer", message, turns: turn });
        records.transitionTask(taskId, "interrupted", { id: randomUUID(), createdAt: now(), payload: { reason: "missing_final_answer", message, turns: turn } });
        convs.updateMessageContentAndState(assistantMessageRow.id, responseContent + `\n\n[Incomplete: ${message}]`, "interrupted", now());
        if (activeStepId) records.updatePlanStepStatus(activeStepId, "skipped", now());
        return;
      }
      // No more tool calls and a final answer was streamed, so we're done.
      canonicalFinalText = responseContent.slice(responseLengthAtTurnStart);
      completedWithoutMoreTools = true;
      break;
    }

    if (loopDetected) {
      const message = `Loop detected: the same action repeated ${loopDetected.count} times without new progress.`;
      failCurrentSegment("loop_detected");
      transitionAgentState("interrupted", { reason: "loop_detected", message, turns: turn });
      records.transitionTask(taskId, "interrupted", { id: randomUUID(), createdAt: now(), payload: { reason: "loop_detected", message, turns: turn } });
      convs.updateMessageContentAndState(assistantMessageRow.id, responseContent + `\n\n[Paused: ${message}]`, "interrupted", now());
      if (activeStepId) records.updatePlanStepStatus(activeStepId, "skipped", now());
      return;
    }

    const madeProgress = turnMadeProgress({
      responseChars: currentToolCalls.length > 0 ? 0 : responseContent.length - responseLengthAtTurnStart,
      completedToolSignatures,
      repeatedToolSignatures,
    });
    noProgressTurns = madeProgress ? 0 : noProgressTurns + 1;
    if (noProgressTurns === 2) {
      event("task.progress_warning", {
        reason: "no_progress",
        message: "No new observable progress yet. Change strategy, gather new evidence, or finish with the verified result.",
        turns: turn,
      });
    }
    if (noProgressTurns >= 3) {
      const message = "Task stalled after three turns without new observable progress.";
      failCurrentSegment("stalled");
      transitionAgentState("interrupted", { reason: "stalled", message, turns: turn });
      records.transitionTask(taskId, "interrupted", { id: randomUUID(), createdAt: now(), payload: { reason: "stalled", message, turns: turn } });
      convs.updateMessageContentAndState(assistantMessageRow.id, responseContent + `\n\n[Paused: ${message}]`, "interrupted", now());
      if (activeStepId) records.updatePlanStepStatus(activeStepId, "skipped", now());
      return;
    }

    if (turn >= turnCeiling) {
      const checkpointId = await persistExecutionCheckpoint("adaptive_turn_boundary");
      if (interruptAtSegmentLimit(checkpointId)) return;
      currentSegment = continuity.rolloverSegment({
        taskId,
        currentSegmentId: currentSegment.id,
        reason: "turn_budget",
        providerId: providerType,
        model: contextModel,
        routeJson: primaryRoute as unknown as Record<string, unknown>,
        ownerId: executionOwnerId,
        generation: currentSegment.generation,
        now: now(),
      });
      event("context.compaction_completed", {
        checkpointId,
        reason: "turn_budget",
        automaticContinuation: true,
        segmentSequence: currentSegment.sequence,
      });
      await onSegmentBoundary?.("turn_budget");
      turn = 0;
      noProgressTurns = 0;
    }
  }

  if (checkCancelled()) {
    handleCancellation();
    return;
  }

  // Completion gate: the model stopped emitting tool calls (its "I'm done"
  // signal), but the last workspace mutation or verification it ran failed and
  // was never recovered. Reporting "completed" here would be dishonest — the
  // required change or check did not actually pass. Stop cleanly with an
  // incomplete status instead, so the CLI and /output show the truth.
  if (completedWithoutMoreTools && lastVerificationFailure) {
    const message = `Stopping with unverified result: the last ${lastVerificationFailure.tool === "run_command" ? "verification command" : "change"} did not succeed (${lastVerificationFailure.detail}).`;
    failCurrentSegment("unverified_completion");
    transitionAgentState("interrupted", { reason: "unverified_completion", message, turns: turn });
    records.transitionTask(taskId, "interrupted", { id: randomUUID(), createdAt: now(), payload: { reason: "unverified_completion", message, turns: turn } });
    convs.updateMessageContentAndState(assistantMessageRow.id, responseContent + `\n\n[Incomplete: ${message}]`, "interrupted", now());
    if (activeStepId) records.updatePlanStepStatus(activeStepId, "skipped", now());
    return;
  }

  // Complete plan steps
  records.updatePlanStepStatus(activeStepId, "completed", now());
  event("step.completed", { stepId: activeStepId });

  // Make sure all steps are complete
  for (const step of steps) {
    if (step.status !== "completed") {
      records.updatePlanStepStatus(step.id, "completed", now());
    }
  }

  // Final transition is atomic with canonical-answer creation. If the process
  // dies after the final provider turn was recorded but before this transaction,
  // the replayable-final-turn path above completes it without another request.
  const finalTurn = continuity.listProviderTurns(taskId).at(-1);
  if (!finalTurn || finalTurn.toolCalls.length > 0 || finalTurn.assistantText !== canonicalFinalText) {
    throw new Error("Canonical final turn is not durably recorded");
  }
  completeWithCanonicalAnswer(canonicalFinalText, finalTurn.turnKey);
}
