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
import { symbolIndexRepository } from "../repositories/symbols.js";
import { ApprovalContinuationRegistry } from "./continuation.js";
import { classifyCommand, canonicalCommandTrustKey } from "../tools/command-policy.js";
import { PERMISSION_PROFILE } from "../tools/catalog.js";
import { runProcessSafe } from "../tools/command-executor.js";
import { parseUnifiedDiff, validatePatchPaths, applyUnifiedPatch, hashString, assertContainedRealPath } from "../tools/diff-applier.js";
import { resolveMorrowHome } from "../home.js";
import { missionsRepository } from "../repositories/missions.js";
import { MissionService } from "../mission/service.js";
import { createMissionToolFailureReporter } from "../mission/tool-failure-reporter.js";
import { AiProvider, ChatMessage, ToolDefinition, ProviderChunk } from "../provider/base.js";
import { createProvider, providerCapabilities } from "../provider/registry.js";
import { openStreamWithFallback, type FallbackCandidate } from "../provider/fallback.js";
import { globalRateGuard } from "../provider/rate-guard.js";
import { getPreset, DEFAULT_PRESET_ID } from "../routing/presets.js";
import { MockProvider } from "../provider/mock.js";
import { adaptiveTurnCeiling, turnMadeProgress } from "./adaptive-budget.js";
import { createLoopDetector, toolCallSignature } from "./loop-detector.js";
import { prepareContextForProvider, resolveContextBudget } from "./context-budget.js";
import type { AgentExecutionState, AgentMode, ProviderId, ToolProfile } from "@morrow/contracts";

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
  maxFileBytes?: number;
  maxContextBytes?: number;
  abortSignal?: AbortSignal;
};

export async function executeAgentChatTask({
  db,
  taskId,
  provider,
  fallbackProviders,
  now = () => new Date().toISOString(),
  maxTurns,
  maxFileBytes,
  maxContextBytes,
  abortSignal
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

  const task = tasks.getTaskById(taskId);
  if (!task || task.kind !== "agent_chat" || !["queued", "running", "interrupted"].includes(task.status)) {
    throw new Error("Task is not available for agent execution");
  }

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
  const transitionAgentState = (state: AgentExecutionState, details: Record<string, unknown> = {}) =>
    records.transitionAgentState(taskId, { id: randomUUID(), state, details, createdAt: now() });

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
  transitionAgentState("understanding");

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
  records.replacePlan(taskId, plan);
  event("plan.created", { stepCount: plan.length });
  transitionAgentState("planning", { stepCount: plan.length });

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
  const fileBytesLimit = maxFileBytes ?? 102400; // 100 KB per file
  const contextBytesLimit = maxContextBytes ?? preset.contextBudgetBytes;
  const contextBudget = resolveContextBudget({
    providerId,
    model: resolvedModel || assistantMessageRow.model || `${providerId}-default`,
    presetContextBudgetBytes: contextBytesLimit,
    outputBudgetTokens: preset.outputBudgetTokens,
    toolCount: activeToolProfile === "none" ? 0 : activeToolProfile === "agent" ? 12 : 8,
  });

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
      event("task.failed", { message: e.message || "Provider not configured" });
      return;
    }
  }

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
      name: "propose_patch",
      description: "Propose a unified diff patch to modify workspace files. Rejects absolute paths, binary files, traversal, and unauthorized directories.",
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
  
  // System instructions
  chatMessages.push({
    role: "system",
    content: `You are Morrow, a secure personal AI coding assistant.
You are running in an environment scoped to the project: ${projectName} located at ${workspacePath}.
You have access to tools to inspect the workspace, read files, run safe project commands (like running tests), and propose patches to write files.
You MUST choose relevant files, do NOT automatically ingest the entire repository.
If you need to explore, call inspect_workspace once for bounded root facts, prefer search_symbols before broad search, then use list_files/search_files/search_text/read_file only for paths relevant to the user's request.
You must run test/verification commands using run_command, and propose file modifications using propose_patch.
Morrow ships installed skills (reusable expert workflows). They ARE available — never tell the user skills are unavailable. When a relevant skill is listed below or found via find_skill, call load_skill for it and follow its workflow. After completing a complex multi-step task, save the approach with create_skill.`
  });

  // Deterministically surface installed skills relevant to this request so the
  // agent reliably uses them, rather than depending on the model deciding to
  // call find_skill. The model is told to load the best match first; that
  // produces a visible load_skill tool call and grounds it in a real workflow.
  if (agentMode !== "plan-only" && activeToolProfile !== "none") {
    const latestUserPrompt = [...dbMessages].reverse().find((m) => m.id !== assistantMessageRow.id && m.role === "user")?.content ?? "";
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

  for (const msg of dbMessages) {
    if (msg.id === assistantMessageRow.id) break;
    chatMessages.push({
      role: msg.role === "user" ? "user" : "assistant",
      content: msg.content
    });
  }

  async function executeApprovedTool(toolName: string, args: any, tcId: string): Promise<string> {
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
      const runOptions: Parameters<typeof runProcessSafe>[4] = {
        timeoutMs: 30000,
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

        const newContent = applyUnifiedPatch(originalContent, pf.chunks);
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
        event("evidence.persisted", { path: pf.newPath, size: Buffer.byteLength(newContent, "utf8") });
      }

      changeSets.updateApplied(changeSet.id, postApplyHashes, backupReferences);

      return JSON.stringify({
        status: "success",
        appliedFiles: files,
        diffHash
      });
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

  let turn = 0;
  let noProgressTurns = 0;
  const seenToolSignatures = new Set<string>();
  const toolResultBytesBySignature = new Map<string, number>();
  // Tight per-action loop detection: catches the same tool+args recurring within
  // a short window, stopping a stuck model sooner than the turn-budget ceiling.
  const loopDetector = createLoopDetector();
  let responseContent = assistantMessageRow.content || "";

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

        let resultStr = "";
        let isSuccess = true;
        let errorType = null;
        let errorMessage = null;

        if (isApproved) {
          try {
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

  const finalToolCalls = convs.listToolCallsForMessage(assistantMessageRow.id);
  if (finalToolCalls.length > 0) {
    chatMessages.push({
      role: "assistant",
      content: responseContent,
      toolCalls: finalToolCalls.map(tc => ({
        id: tc.id,
        type: "function",
        function: { name: tc.toolName, arguments: tc.argsJson }
      }))
    });

    for (const tc of finalToolCalls) {
      chatMessages.push({
        role: "tool",
        name: tc.toolName,
        toolCallId: tc.id,
        content: tc.resultJson || ""
      });
    }
    turn = 1;
  }

  let completedWithoutMoreTools = false;
  let totalBytesRead = 0;
  const steps = records.listPlanSteps(taskId);

  const planningStep = steps[0]!;
  const workspaceStep = steps.find((step) => step.title === "Read Workspace");
  const finalStep = steps[steps.length - 1]!;

  let activeStepId = planningStep.id;
  records.updatePlanStepStatus(activeStepId, "running", now());
  event("step.started", { stepId: activeStepId });

  // Handle AbortSignal cancellation
  const checkCancelled = (): boolean => {
    if (abortSignal?.aborted || tasks.getTaskById(taskId)?.status === "cancelled") {
      return true;
    }
    return false;
  };

  const handleCancellation = () => {
    const currentTask = tasks.getTaskById(taskId);
    if (currentTask && currentTask.status !== "cancelled") {
      records.transitionTask(taskId, "cancelled", { id: randomUUID(), createdAt: now(), payload: {} });
    }
    transitionAgentState("cancelled");
    convs.updateMessageContentAndState(assistantMessageRow.id, responseContent, "cancelled", now());
    if (activeStepId) {
      records.updatePlanStepStatus(activeStepId, "failed", now());
    }
    const existingEvents = records.listEvents(taskId);
    if (!existingEvents.some(ev => ev.type === "task.cancelled")) {
      event("task.cancelled", {});
    }
  };

  while (turn < turnCeiling) {
    if (checkCancelled()) {
      handleCancellation();
      return;
    }

    turn++;
    const responseLengthAtTurnStart = responseContent.length;
    const completedToolSignatures: string[] = [];
    const repeatedToolSignatures: string[] = [];
    let loopDetected: { signature: string; count: number } | null = null;
    let hasToolCalls = false;
    const currentToolCalls: any[] = [];

    try {
      const contextModel = resolvedModel || assistantMessageRow.model || `${providerType}-model`;
      const preparedContext = prepareContextForProvider(chatMessages, {
        providerId: providerType,
        model: contextModel,
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
      });
      for (const op of preparedContext.operations) event(op.type, { ...op.payload, provider: providerType, model: contextModel });
      if (!preparedContext.ok) {
        transitionAgentState("failed", { message: preparedContext.actionableMessage });
        records.transitionTask(taskId, "failed", { id: randomUUID(), createdAt: now(), payload: { message: preparedContext.actionableMessage } });
        convs.updateMessageContentAndState(assistantMessageRow.id, preparedContext.actionableMessage, "failed", now());
        if (activeStepId) records.updatePlanStepStatus(activeStepId, "failed", now());
        event("task.failed", { message: preparedContext.actionableMessage });
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
      }
      const opened = await openStreamWithFallback(
        streamCandidates,
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
      if (opened.fellBackFrom.length > 0) {
        event("provider.fallback", { from: opened.fellBackFrom, servedBy: opened.servedBy });
      }
      if (opened.deprioritizedRateLimited.length > 0) {
        event("provider.rate_limited", { deprioritized: opened.deprioritizedRateLimited, servedBy: opened.servedBy });
      }
      const stream = opened.stream;

      for await (const chunk of stream) {
        if (checkCancelled()) {
          handleCancellation();
          return;
        }

        if (chunk.type === "error") {
          throw new Error(chunk.error?.message || "Model provider error");
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
          
          // Emit a live streaming text update event
          event("evidence.persisted", { deltaText: chunk.text });
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
      console.error("Provider stream error", e);
      const errMessage = e.message || "Failed to query AI provider";
      transitionAgentState("failed", { message: errMessage });
      records.transitionTask(taskId, "failed", { id: randomUUID(), createdAt: now(), payload: { message: errMessage } });
      convs.updateMessageContentAndState(assistantMessageRow.id, responseContent + `\n\n[Error: ${errMessage}]`, "failed", now());
      if (activeStepId) {
        records.updatePlanStepStatus(activeStepId, "failed", now());
      }
      event("task.failed", { message: errMessage });
      return;
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
        content: responseContent,
        toolCalls: currentToolCalls.map(tc => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments }
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
          status: "running",
          createdAt: now(),
          startedAt: now()
        });
        const toolSignature = `${tc.name}:${tc.arguments}`;
        const repeatedTool = seenToolSignatures.has(toolSignature);
        if (repeatedTool) repeatedToolSignatures.push(toolSignature);
        else seenToolSignatures.add(toolSignature);
        const loop = loopDetector.record(toolCallSignature(tc.name, tc.arguments));
        if (loop.looping && !loopDetected) loopDetected = { signature: loop.signature, count: loop.count };
        const toolStartedAt = Date.now();
        event("tool.started", { id: tc.id, toolName: tc.name });

        let resultStr = "";
        let isSuccess = true;
        let errorType = null;
        let errorMessage = null;
        let args: any = {};

        try {
          try {
            args = JSON.parse(tc.arguments || "{}");
          } catch {
            throw new Error("Invalid tool arguments format");
          }

          // Defense in depth: execution/write tools are only ever permitted in
          // agent mode, even if a provider hallucinates a call the mode never
          // exposed.
          if ((tc.name === "run_command" || tc.name === "propose_patch") && activeToolProfile !== "agent") {
            throw new Error(`Tool "${tc.name}" is not permitted in ${agentMode} mode`);
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

            event("evidence.persisted", { path: fileData.path, size: fileData.size });
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
              resultStr = await executeApprovedTool(tc.name, args, tc.id);
            }
          } else if (tc.name === "propose_patch") {
            const patch = args.patch;
            const explanation = args.explanation;
            const files = args.files || [];

            if (typeof patch !== "string") {
              throw new Error("Missing required argument: patch");
            }

            // 1. Parse unified diff. A patch that parses to zero files is
            // malformed input, not an empty success — beta.20 recorded these
            // as successful applications of nothing.
            const patchFiles = parseUnifiedDiff(patch);
            if (patchFiles.length === 0) {
              throw new Error("Malformed patch: could not parse any file hunks from the unified diff");
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
                originalHashes[pf.oldPath] = "";
              }
            }

            // 3. Dry-run verify it applies cleanly
            for (const pf of patchFiles) {
              const fullPath = assertContainedRealPath(project.workspacePath, pf.oldPath);
              let originalContent: string | null = null;
              if (pf.oldPath !== "/dev/null" && existsSync(fullPath)) {
                originalContent = readFileSync(fullPath, "utf8");
              }
              // This throws if there is a conflict
              applyUnifiedPatch(originalContent, pf.chunks);
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
              transitionAgentState("proposing_changes");
              
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
                // Persist continuation state
                continuationsRepo.save({
                  taskId,
                  toolCallId: tc.id,
                  toolName: tc.name,
                  args: args
                });

                // Transition to waiting_for_approval
                transitionAgentState("waiting_for_approval", { approvalId: approvalRecord.id });
                event("approval.requested", { approvalId: approvalRecord.id, kind: "change_set" });

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
              resultStr = await executeApprovedTool(tc.name, args, tc.id);
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
          errorType = err instanceof SafeReadError || err instanceof WorkspaceSearchError || err instanceof GitInspectionError ? "safe_read_rejected" : "tool_failed";
          errorMessage = err.message || "Unknown error";
          resultStr = JSON.stringify({ error: errorMessage });
          event("tool.failed", { toolName: tc.name, message: errorMessage });
          missionFailures.reportFailure(tc.name, args, errorMessage, errorType);
        }
        if (isSuccess) missionFailures.reportSuccess(tc.name, args);

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
        if (isSuccess) completedToolSignatures.push(toolSignature);
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
          ...(isSuccess ? { outputRef: tc.id } : { error: errorMessage ?? summary }),
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
      // No more tool calls, we're done
      completedWithoutMoreTools = true;
      break;
    }

    if (loopDetected) {
      const message = `Loop detected: the same action repeated ${loopDetected.count} times without new progress.`;
      transitionAgentState("interrupted", { reason: "loop_detected", message, turns: turn });
      records.transitionTask(taskId, "interrupted", { id: randomUUID(), createdAt: now(), payload: { reason: "loop_detected", message, turns: turn } });
      convs.updateMessageContentAndState(assistantMessageRow.id, responseContent + `\n\n[Paused: ${message}]`, "interrupted", now());
      if (activeStepId) records.updatePlanStepStatus(activeStepId, "skipped", now());
      return;
    }

    const madeProgress = turnMadeProgress({
      responseChars: responseContent.length - responseLengthAtTurnStart,
      completedToolSignatures,
      repeatedToolSignatures,
    });
    noProgressTurns = madeProgress ? 0 : noProgressTurns + 1;
    if (noProgressTurns >= 3) {
      const message = "Task stalled after three turns without new observable progress.";
      transitionAgentState("interrupted", { reason: "stalled", message, turns: turn });
      records.transitionTask(taskId, "interrupted", { id: randomUUID(), createdAt: now(), payload: { reason: "stalled", message, turns: turn } });
      convs.updateMessageContentAndState(assistantMessageRow.id, responseContent + `\n\n[Paused: ${message}]`, "interrupted", now());
      if (activeStepId) records.updatePlanStepStatus(activeStepId, "skipped", now());
      return;
    }
  }

  if (checkCancelled()) {
    handleCancellation();
    return;
  }

  if (!completedWithoutMoreTools && turn >= turnCeiling) {
    const loopErrMsg = `Task adaptive turn budget reached (${turnCeiling}); continue the mission when ready.`;
    transitionAgentState("interrupted", { reason: "turn_budget_reached", message: loopErrMsg, turns: turn });
    records.transitionTask(taskId, "interrupted", { id: randomUUID(), createdAt: now(), payload: { reason: "turn_budget_reached", message: loopErrMsg, turns: turn } });
    convs.updateMessageContentAndState(assistantMessageRow.id, responseContent + `\n\n[Paused: ${loopErrMsg}]`, "interrupted", now());
    if (activeStepId) {
      records.updatePlanStepStatus(activeStepId, "skipped", now());
    }
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

  // Final transition to completed
  transitionAgentState("completed");
  records.transitionTask(taskId, "completed", { id: randomUUID(), createdAt: now(), payload: {} });
  convs.updateMessageContentAndState(assistantMessageRow.id, responseContent, "completed", now());
  event("task.completed", {});
}
