import type { AgentMode, Conversation, Project } from "@morrow/contracts";
import type { Context } from "../cli/context.js";
import type { MorrowApi, TaskAggregate } from "../client/api.js";
import { ensureRunning } from "../service/lifecycle.js";
import { resolveProject, ask, isInteractive, select, shortId, relativeTime } from "./common.js";
import { streamChatTask } from "./stream.js";
import { renderMarkdown } from "../cli/markdown.js";
import { flagString, flagBool } from "../cli/args.js";
import { CliError, EXIT, usageError } from "../cli/errors.js";
import { compactWordmark, greeting, modeLabel, parseModeName, privacyLabel } from "../cli/identity.js";
import { readLineWithCompletion, PROMPT_EXIT } from "../terminal/prompt.js";
import type { SendOptions, SessionBackend } from "../terminal/session-types.js";
import { startShell } from "../terminal/ink/shell.js";
import { buildFileIndex, completeFile } from "../terminal/ink/file-index.js";
import { discoverSkills } from "../skills/registry.js";
import { MORROW_VERSION } from "../service/update.js";
import { builtinRegistry } from "../terminal/commands/index.js";
import { createLineSurface } from "../terminal/commands/line-surface.js";
import { localSkillsRoot } from "./skills.js";
import { loadHistory, appendHistory } from "../terminal/history.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { shouldUseInteractive } from "../terminal/capabilities.js";
import { oauthLogin, OAUTH_ELIGIBLE } from "./providers.js";
import { streamTaskEvents } from "../client/sse.js";
import type { SessionMeta } from "../terminal/events.js";
import { gitSummary, gitSummaryText, gitStatus } from "../cli/gitinfo.js";
import { formatContextStatus, formatMissionResult, formatTaskTree } from "../terminal/mission-control.js";
import { buildTaskReport, defaultReportFilename, findLatestTaskId, type ReportKind } from "../terminal/output-report.js";
import { parseTaskReportArgs, resolveTaskReference } from "../terminal/task-reference.js";

/** Capability mode: flag > config default > agent (the primary product). */
export function resolveMode(ctx: Context): AgentMode {
  if (flagBool(ctx.flags, "plan")) return "plan-only";
  if (flagBool(ctx.flags, "ask") || flagBool(ctx.flags, "read-only") || flagBool(ctx.flags, "inspect")) return "read-only";
  if (flagBool(ctx.flags, "build")) return "agent";
  const configured = ctx.config.get("defaults.mode") as AgentMode | undefined;
  return configured ?? "agent";
}

/** Whether to use Unicode glyphs: config > MORROW_ASCII env > on by default. */
export function resolveUnicode(ctx: Context): boolean {
  const cfg = ctx.config.get("ui.unicode") as boolean | undefined;
  if (cfg !== undefined) return cfg;
  return process.env.MORROW_ASCII !== "1";
}

function resolveDisplayedRecordId(items: Array<{ id: string }>, ref: string, prefixes: string[]): string {
  const lowered = ref.trim().toLowerCase();
  const matches = items.filter((item) => {
    const id = item.id.toLowerCase();
    const withoutPrefix = prefixes.reduce((value, prefix) => value.replace(new RegExp(`^${prefix}-`), ""), id);
    return id === lowered || id.startsWith(lowered) || withoutPrefix === lowered || withoutPrefix.startsWith(lowered);
  });
  if (matches.length !== 1) throw new Error(matches.length === 0 ? "not found" : "ambiguous");
  return matches[0]!.id;
}

/**
 * Whether to auto-approve (YOLO): flag > config default > off. Only ever active
 * in agent mode — inspect/plan never request approvals, so auto-approve there
 * would be a meaningless (and misleading) label.
 */
export function resolveAutoApprove(ctx: Context, mode: AgentMode): boolean {
  if (mode !== "agent") return false;
  // Presence matters: `morrow fix` passes yolo=false deliberately so the
  // command's documented approval boundary wins over a persisted YOLO default.
  // Treating only true as an override silently re-armed autonomy.
  if (Object.prototype.hasOwnProperty.call(ctx.flags, "yolo")) return flagBool(ctx.flags, "yolo");
  return (ctx.config.get("defaults.autoApprove") as boolean | undefined) ?? false;
}

interface SessionState {
  preset: string;
  provider: string | undefined;
  model: string | undefined;
  worktreeId: string | undefined;
  missionId: string | undefined;
  mode: AgentMode;
  useMemory: boolean;
  autoApprove: boolean;
}

export async function chatCommand(ctx: Context): Promise<number> {
  await ensureRunning(ctx);
  const api = ctx.api();
  const project = await resolveProject(ctx, api, { required: true, autoCreateMissing: true });
  if (!project) return EXIT.NOT_FOUND;

  const mode = resolveMode(ctx);
  const session: SessionState = {
    preset: ctx.preset(),
    provider: ctx.provider(),
    model: ctx.model(),
    worktreeId: flagString(ctx.flags, "worktree"),
    missionId: flagString(ctx.flags, "mission"),
    mode,
    useMemory: (ctx.config.get("defaults.useMemory") as boolean | undefined) ?? true,
    autoApprove: resolveAutoApprove(ctx, mode),
  };

  const conversation = await resolveConversation(ctx, api, project.id);

  const message = flagString(ctx.flags, "message") ?? flagString(ctx.flags, "m");
  if (message) {
    // Make the target explicit before any one-shot work so a command can never
    // silently act on a different project than the user expects.
    if (!ctx.out.json) {
      const projectName = project.workspacePath.split(/[\\/]/).filter(Boolean).pop() ?? project.workspacePath;
      ctx.out.diag(ctx.out.gray(`  ${projectName}  ${project.workspacePath}  ·  ${modeLabel(session.mode, session.autoApprove)}`));
    }
    return runOneShot(ctx, api, conversation, message, session);
  }

  if (!isInteractive(ctx)) {
    throw usageError("No message provided and not running in an interactive terminal.", "Use --message \"…\" for non-interactive use.");
  }

  return runRepl(ctx, api, project, conversation, session);
}

/**
 * The full-screen interactive session: one event-driven terminal application
 * wired to the live orchestrator. Replaces the line REPL on capable terminals.
 */
/**
 * The one adapter from the terminal's backend contract to the orchestrator API.
 *
 * Both surfaces — the shell and the plain-line fallback — construct their
 * session through this, so neither can develop a private notion of what
 * "send a message" or "list checkpoints" means. `active` is mutable because
 * `/new` and `/resume` change which conversation messages go to.
 */
function buildBackend(
  ctx: Context,
  api: MorrowApi,
  project: Project,
  conversation: Conversation,
  session: SessionState,
  /** Mutated in place when the active conversation changes, so `/status` and
   *  `/sessions` report where messages are actually going. Without this the
   *  session facts were captured once at startup and quietly went stale the
   *  moment anyone resumed. */
  info?: { conversationId: string; conversationTitle: string },
): SessionBackend {
  // The active conversation is mutable: `/new` and `/resume` change which one
  // messages go to. Every method reads `active` rather than closing over the
  // conversation it started with, or a resumed session would keep writing into
  // the previous one.
  let active: Conversation = conversation;

  const adopt = (next: Conversation): Conversation => {
    active = next;
    if (info) {
      info.conversationId = next.id;
      info.conversationTitle = next.title;
    }
    return next;
  };

  const backend: SessionBackend = {
    async send(text, opts) {
      const sent = await api.sendMessage(active.id, text, {
        preset: opts.preset,
        ...(opts.provider ? { providerId: opts.provider } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        mode: opts.mode,
        useMemory: opts.useMemory,
        ...(opts.autoApprove && opts.mode === "agent" ? { autoApprove: true } : {}),
        ...(session.worktreeId ? { worktreeId: session.worktreeId } : {}),
        ...(session.missionId ? { missionId: session.missionId } : {}),
        ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
      });
      return {
        taskId: sent.task.id,
        routing: {
          provider: sent.routing.providerId,
          model: sent.routing.model,
          preset: sent.routing.presetId,
          fallback: sent.routing.fallbackUsed,
          overridden: sent.routing.overridden,
          privacy: sent.routing.privacy,
          reasoning: sent.routing.reasoning,
        },
      };
    },
    subscribe: (taskId, signal, after) => streamTaskEvents(api.baseUrl, taskId, { signal, ...(after !== undefined ? { after } : {}) }),
    cancel: (taskId) => api.cancelTask(taskId),
    resume: (taskId) => api.resumeTask(taskId, project.id).then(() => undefined),
    compact: (taskId, settings) => {
      const options = {
        preset: settings.preset,
        ...(settings.provider ? { providerId: settings.provider } : {}),
        ...(settings.model ? { model: settings.model } : {}),
      };
      const request = taskId
        ? api.compactTask(taskId, project.id, options)
        : api.compactConversation(active.id, project.id, options);
      return request.then((result) => ({ ...result, routing: { provider: result.routing.providerId, model: result.routing.model, preset: result.routing.presetId, fallback: result.routing.fallbackUsed, overridden: result.routing.overridden, privacy: result.routing.privacy, reasoning: result.routing.reasoning } }));
    },
    async getApproval(id) {
      const a = await api.getApproval(id);
      return { id: a.id, kind: a.kind, details: a.details, projectId: a.projectId };
    },
    resolveApproval: (id, decision, trustPattern) =>
      api
        .resolveApproval(id, { projectId: project.id, decision: decision as any, ...(trustPattern ? { trustPattern } : {}) })
        .then(() => undefined),
    getPlan: (taskId) => api.getTask(taskId).then((aggregate) => aggregate.plan),
    getTask: (taskId) => api.getTask(taskId),
    getFinalAnswer: async (taskId) => {
      const messages = await api.listMessages(active.id);
      return [...messages].reverse().find((message) => message.taskId === taskId && message.role === "assistant")?.content ?? null;
    },
    exportReport: async (taskId, kind, finalAnswer, requestedName) => {
      const aggregate = await api.getTask(taskId);
      return writeTaskReport(ctx, taskId, aggregate, kind, finalAnswer, requestedName);
    },
    getTaskTree: (taskId) => api.getTaskTree(taskId),
    getTaskDiff: (taskId) =>
      api.getTaskDiff(taskId).then((d) => ({ diff: d.diff, files: d.files })),
    undoTask: (taskId) =>
      api.undoTask(taskId).then((u) => ({ status: u.status, restoredFiles: u.restoredFiles })),
    search: (query) =>
      api
        .search(project.id, query, { limit: 25 })
        .then((res) => res.hits.map((h) => ({ kind: h.kind, title: h.title, snippet: h.snippet }))),
    recordSkillUse: (skillId) => api.recordSkillUse(project.id, skillId).then(() => undefined),
    getLatestMission: () => api.listMissions(project.id).then((ms) => ms[0] ?? null).catch(() => null),
    getIntelligence: () => api.getIntelligence(project.id).catch(() => null),
    patchConvention: async (conventionId, approval) => {
      const intelligence = await api.getIntelligence(project.id);
      const fullId = resolveDisplayedRecordId(intelligence.conventions, conventionId, ["conv"]);
      await api.patchConvention(project.id, fullId, approval);
    },
    addRule: async (text) => { await api.addRule(project.id, text); },
    removeRule: async (ruleId) => {
      const fullId = resolveDisplayedRecordId(await api.listRules(project.id), ruleId, ["rule"]);
      await api.deleteRule(project.id, fullId);
    },
    getMissionImpact: (missionId) => api.listMissionImpact(missionId).catch(() => []),
    getMissionRevisions: (missionId) => api.listMissionRevisions(missionId).catch(() => []),
    listAgents: () => api.listAgents(project.id).catch(() => []),
    getCapabilities: () => import("./capabilities.js").then((m) => m.reportCapabilities(api)),
    listModels: () => api.listModels(),
    getModelBudgets: () => api.getModelBudgets(),
    listProviders: () => api.listProviders(),
    getGitStatus: async () => gitStatus(project.workspacePath),
    getCortexStaleness: () => api.intelligenceStaleness(project.id).catch(() => null),
    listTasks: () => api.listTasks(project.id),

    // ── The surface the command layer reads ─────────────────────────────────
    // Thin delegation, deliberately: a command must not be able to reach a URL
    // of its own, and putting these here is what keeps the whole command
    // surface testable against one fake.
    health: () => api.health(),
    listConversations: () => api.listConversations(project.id),
    newConversation: async (title) => adopt(await api.createConversation(project.id, title)),
    switchConversation: async (id) => {
      const target = await api.getConversation(id);
      // Never cross a project boundary silently: an id from another project is
      // a mistake, and following it would send the next message somewhere the
      // user cannot see.
      if (target.projectId !== project.id) {
        throw new Error("That conversation belongs to a different project.");
      }
      return adopt(target);
    },
    listMessages: () => api.listMessages(active.id),

    listCheckpoints: () => api.listCheckpoints(project.id),
    saveCheckpoint: async (name) => {
      const saved = await api.createCheckpoint(project.id, { name });
      return { name: saved.name, fileCount: saved.fileCount };
    },
    restoreCheckpoint: async (name) => {
      const restored = await api.restoreCheckpoint(project.id, name);
      return { restoredFiles: restored.restoredFiles, deletedFiles: restored.deletedFiles };
    },
    deleteCheckpoint: async (name) => {
      await api.deleteCheckpoint(project.id, name);
    },

    listProcesses: () => api.listProcesses(project.id),
    killProcess: async (id, force) => {
      await api.terminateProcess(id, force ?? false);
    },

    listWorktrees: () => api.listWorktrees(project.id),
    inspectWorktree: (id) => api.getWorktree(id),
    removeWorktree: async (id, preserve) => {
      await api.removeWorktree(id, preserve ?? false);
    },
    listIntegrations: () => api.listIntegrations(project.id),
    checkIntegration: (worktreeId) => api.checkIntegration(worktreeId),
    applyIntegration: (id) => api.applyIntegration(id),

    listMemory: () => api.listProjectMemory(project.id),
    addMemory: (content) => api.addMemory(project.id, "project", content, active.id),
    forgetMemory: async (id) => {
      await api.deleteMemory(project.id, id);
    },

    listTools: () => api.listTools(),
    permissions: () => api.permissions(),
    audit: (limit) => api.audit(project.id, limit),
    listPresets: () => api.listPresets(),

    listMissions: () => api.listMissions(project.id),
    getMissionResult: (missionId) => api.getMissionResult(missionId),
    retryTask: async (taskId) => {
      const task = await api.retryTask(taskId);
      return { taskId: task.id };
    },

    listSkills: async () =>
      discoverSkills(localSkillsRoot()).map((skill) => ({
        id: skill.id,
        description: skill.manifest.description ?? "",
      })),
  };

  return backend;
}

async function runInteractiveSession(
  ctx: Context,
  api: MorrowApi,
  project: Project,
  conversation: Conversation,
  session: SessionState,
  unicode: boolean
): Promise<number> {
  // `project` is already the object `chatCommand` resolved — no need to fetch
  // it again. Start both network reads *before* the synchronous git
  // inspection below: `fetch()` hands its request off to the OS immediately,
  // so those responses can arrive while this thread is blocked spawning git,
  // rather than waiting for git to finish before either request is even sent.
  const providerStatusPromise = api.providerStatus().catch(() => null);
  const priorHistoryPromise = api.listMessages(conversation.id).catch(() => []);
  // Real, project-scoped recent activity for the startup panel — never
  // another project's, since it's already scoped by `project.id`.
  const recentConversationsPromise = api.listConversations(project.id).catch(() => []);
  const git = gitSummary(project.workspacePath);
  const [providerStatus, priorHistory, recentConversations] = await Promise.all([providerStatusPromise, priorHistoryPromise, recentConversationsPromise]);
  const providerName = session.provider ?? providerStatus?.provider ?? "auto";
  const modelName = session.model ?? providerStatus?.model ?? "auto";
  const projectName = project.workspacePath.split(/[\\/]/).filter(Boolean).pop() ?? project.workspacePath;
  const name = (ctx.config.get("user.name") as string | undefined)?.trim();
  // Onboarding facts: whether a provider is really configured and whether we
  // resumed prior history, so the empty-state welcome can guide honestly.
  const priorMessages = priorHistory.length;
  const initialTaskId = findLatestTaskId(priorHistory);

  const meta: SessionMeta = {
    greeting: greeting(new Date()),
    ...(name ? { name } : {}),
    projectName,
    workspacePath: project.workspacePath,
    branch: gitSummaryText(git),
    provider: providerName,
    model: modelName,
    privacy: privacyLabel(providerName),
    mode: modeLabel(session.mode, session.autoApprove),
    memory: session.useMemory,
    autoApprove: session.autoApprove,
    ...(providerStatus ? { providerConfigured: providerStatus.configured } : {}),
    gitRepo: git.branch !== null,
    resumed: priorMessages > 0,
    priorMessages,
  };
  const settings: SendOptions = {
    mode: session.mode,
    autoApprove: session.autoApprove,
    ...(session.provider ? { provider: session.provider } : {}),
    ...(session.model ? { model: session.model } : {}),
    preset: session.preset,
    useMemory: session.useMemory,
  };

  const sessionInfo = {
    projectId: project.id,
    projectName,
    workspacePath: project.workspacePath,
    conversationId: conversation.id,
    conversationTitle: conversation.title,
    serviceUrl: api.baseUrl,
    version: MORROW_VERSION,
  };
  const backend = buildBackend(ctx, api, project, conversation, session, sessionInfo);



  // Verified local skills become namespaced /skill:<id> commands, registered in
  // the same registry as everything else so they autocomplete and appear in
  // /help rather than existing as a parallel naming convention.
  const localSkills = discoverSkills(localSkillsRoot()).map((skill) => ({
    id: skill.id,
    description: skill.manifest.description ?? "",
  }));

  const historyFile = join(ctx.paths.home, "history");

  const fileIndex = buildFileIndex(project.workspacePath);
  const shell = startShell({
    backend,
    cwdLabel: projectName,
    history: loadHistory(historyFile),
    ...(initialTaskId ? { initialTaskId } : {}),
    onCompleteFile: (prefix) => completeFile(fileIndex, prefix),
    onHistoryAppend: (line) => appendHistory(historyFile, line),
    sendOptions: settings,
    session: sessionInfo,
    skills: localSkills,
    unicode,
  });
  await shell.done;
  return EXIT.OK;
}

export async function resolveConversation(ctx: Context, api: MorrowApi, projectId: string): Promise<Conversation> {
  const resumeId = flagString(ctx.flags, "resume");
  if (resumeId !== undefined) {
    if (resumeId) {
      let conversation: Conversation;
      try {
        conversation = await api.getConversation(resumeId);
      } catch {
        throw new CliError(`Conversation not found: ${resumeId}`, { code: "NOT_FOUND", exitCode: EXIT.NOT_FOUND });
      }
      // Never cross a project boundary silently: a conversation id from a
      // different project than the one just resolved (by --project, cwd, or
      // default) is almost certainly a mistake, not an intentional jump —
      // and jumping there anyway is exactly the failure mode this guards
      // against. Require the explicit --project that actually owns it.
      if (conversation.projectId !== projectId) {
        throw new CliError(`Conversation ${resumeId} belongs to a different project.`, {
          code: "PROJECT_MISMATCH",
          exitCode: EXIT.USAGE,
          hint: `Pass --project ${conversation.projectId} to resume it explicitly.`,
        });
      }
      return conversation;
    }
    const existing = await api.listConversations(projectId);
    if (existing.length === 0) return api.createConversation(projectId, "New Conversation");
    if (!isInteractive(ctx)) return existing[0]!;
    const idx = await select(ctx, "Resume a session", existing, (conversation) => `${conversation.title}  ${ctx.out.gray(shortId(conversation.id))}  ${ctx.out.gray(relativeTime(conversation.updatedAt))}`);
    return existing[idx]!;
  }
  if (flagBool(ctx.flags, "new")) {
    return api.createConversation(projectId, flagString(ctx.flags, "title"));
  }
  // Default: resume the most recent conversation, or create one.
  const existing = await api.listConversations(projectId);
  if (existing.length > 0) return existing[0]!;
  return api.createConversation(projectId, "New Conversation");
}

function sendOptions(s: SessionState) {
  return {
    preset: s.preset,
    ...(s.provider ? { providerId: s.provider } : {}),
    ...(s.model ? { model: s.model } : {}),
    ...(s.worktreeId ? { worktreeId: s.worktreeId } : {}),
    ...(s.missionId ? { missionId: s.missionId } : {}),
    mode: s.mode,
    useMemory: s.useMemory,
    // Only send autoApprove when it is meaningfully on (agent mode); the server
    // ignores it otherwise, but keeping the wire honest avoids confusion.
    ...(s.autoApprove && s.mode === "agent" ? { autoApprove: true } : {}),
  };
}

function writeTaskReport(
  ctx: Context,
  taskId: string,
  aggregate: TaskAggregate,
  kind: ReportKind,
  finalAnswer: string | null,
  requestedName?: string
): string {
  const reportsDir = join(ctx.paths.home, "reports");
  mkdirSync(reportsDir, { recursive: true });
  const safeRequested = requestedName ? basename(requestedName).replace(/[^A-Za-z0-9_.-]+/g, "-") : "";
  const filename = safeRequested && safeRequested !== "." && safeRequested !== ".."
    ? (safeRequested.toLowerCase().endsWith(".md") ? safeRequested : `${safeRequested}.md`)
    : defaultReportFilename(taskId);
  const path = join(reportsDir, filename);
  writeFileSync(path, buildTaskReport(aggregate, { kind, ...(finalAnswer ? { legacyFinalAnswerFallback: finalAnswer } : {}) }), "utf8");
  return path;
}

async function runOneShot(ctx: Context, api: MorrowApi, conversation: Conversation, message: string, session: SessionState): Promise<number> {
  const sent = await api.sendMessage(conversation.id, message, sendOptions(session));
  const result = await streamChatTask(ctx, api, sent.task.id, sent.routing, { showActivity: !ctx.out.json });

  if (ctx.out.json) {
    ctx.out.data({
      conversationId: conversation.id,
      status: result.status,
      routing: sent.routing,
      content: result.content,
      evidence: result.aggregate.evidence.map((e) => ({ path: e.path, metadata: e.metadata })),
      toolCalls: result.aggregate.toolCalls.map((t) => ({ tool: t.toolName, status: t.status, error: t.errorMessage ?? null })),
      task: { id: result.aggregate.task.id, status: result.aggregate.task.status },
    });
  }
  return result.status === "completed" ? EXIT.OK : result.status === "cancelled" ? EXIT.CANCELLED : EXIT.ERROR;
}

async function runRepl(ctx: Context, api: MorrowApi, project: Project, initial: Conversation, session: SessionState): Promise<number> {
  let conversation = initial;
  const out = ctx.out;
  const unicode = resolveUnicode(ctx);

  // Capable interactive terminal → the full-screen event-driven session app.
  // Everything else (redirected, CI, JSON, dumb, MORROW_TUI=0) → line renderer.
  if (shouldUseInteractive({ json: out.json, isTTY: Boolean(process.stdout.isTTY), stdinIsTTY: Boolean(process.stdin.isTTY), env: process.env })) {
    return runInteractiveSession(ctx, api, project, conversation, session, unicode);
  }

  // `project` is already resolved — start the network read and the
  // synchronous git inspection together rather than sequentially.
  const providerStatusPromise = api.providerStatus().catch(() => null);
  const git = gitSummary(project.workspacePath);
  const providerStatus = await providerStatusPromise;

  const providerName = session.provider ?? providerStatus?.provider ?? "auto";
  const modelName = session.model ?? providerStatus?.model ?? "auto";
  const projectName = project.workspacePath.split(/[\\/]/).filter(Boolean).pop() ?? project.workspacePath;
  const name = (ctx.config.get("user.name") as string | undefined)?.trim();
  const history = await api.listMessages(conversation.id);
  const resuming = history.length > 0;

  // The compact mark, not the block-letter wordmark. A nine-line ASCII banner
  // on every single launch is the opposite of restrained branding, and this
  // surface is the fallback — the one used when the terminal is least able to
  // spare the rows.
  out.print(compactWordmark(out, unicode));
  out.print("  " + greeting(new Date()) + (name ? `, ${name}.` : "."));
  out.print();
  out.keyValue([
    ["Project", `${projectName}  ${out.gray(project.workspacePath)}`],
    ["Branch", gitSummaryText(git)],
    ["Model", `${modelName}  ${out.gray("·")}  ${privacyLabel(providerName)}`],
    ["Mode", modeLabel(session.mode, session.autoApprove)],
    ...(session.worktreeId ? [["Worktree", shortId(session.worktreeId)] as [string, string]] : []),
    ["Memory", session.useMemory ? "project context on" : "off"],
    ["Session", `${conversation.title}  ${out.gray(shortId(conversation.id))}${resuming ? out.gray("  · resumed") : ""}`],
  ]);
  if (session.autoApprove) {
    out.print();
    out.print("  " + out.yellow(`${unicode ? "⚠" : "!"} YOLO is on: commands and patches run without asking.`));
    out.print("  " + out.gray("   Denied actions (shells, deletes, history rewrites) are still blocked. Toggle with /yolo."));
  }
  out.print();
  out.print("  " + out.gray("What should we work on?  ") + out.gray("(type / for commands · Tab completes · /exit to quit)"));

  // Replay existing history for context continuity.
  if (resuming) {
    out.print();
    for (const m of history.slice(-6)) renderHistoryMessage(ctx, m.role, m.content, m.streamingState);
  }

  // The same registry the shell uses, rendered as plain lines. A terminal that
  // cannot host the full surface still gets the whole command set.
  const lineBackend = buildBackend(ctx, api, project, conversation, session);
  const lineSettings: SendOptions = {
    mode: session.mode,
    autoApprove: session.autoApprove,
    ...(session.provider ? { provider: session.provider } : {}),
    ...(session.model ? { model: session.model } : {}),
    preset: session.preset,
    useMemory: session.useMemory,
  };
  let lineExit = false;
  const runLineCommand = createLineSurface({
    registry: builtinRegistry(),
    backend: lineBackend,
    settings: lineSettings,
    session: {
      projectId: project.id,
      projectName,
      workspacePath: project.workspacePath,
      conversationId: conversation.id,
      conversationTitle: conversation.title,
      serviceUrl: api.baseUrl,
      version: MORROW_VERSION,
    },
    print: (text) => out.print(text),
    exit: () => {
      lineExit = true;
    },
  });

  while (true) {
    if (lineExit) return EXIT.OK;
    out.print();
    const result = await readLineWithCompletion({
      out,
      unicode,
      label: out.green(unicode ? "› " : "> "),
      labelWidth: 2,
    });
    if (result === PROMPT_EXIT) {
      out.info("Goodbye.");
      return EXIT.OK;
    }
    const line = result.trim();
    if (!line) continue;

    if (line.startsWith("/")) {
      const outcome = await runLineCommand(line);
      if (outcome.exited) return EXIT.OK;
      if (outcome.handled) continue;
    }

    try {
      const sent = await api.sendMessage(conversation.id, line, sendOptions(session));
      out.print(out.magenta("morrow › "));
      await streamChatTask(ctx, api, sent.task.id, sent.routing, { showActivity: true });
    } catch (e: any) {
      out.error(e?.message ?? String(e));
    }
  }
}

function renderHistoryMessage(ctx: Context, role: string, content: string, state?: string) {
  const out = ctx.out;
  if (role === "user") {
    out.print(out.green("you › ") + content);
  } else {
    const label = out.magenta("morrow › ");
    const body = state && state !== "completed" ? out.gray(`[${state}] `) + content : renderMarkdown(content, out);
    out.print(label + body);
  }
}

async function latestTaskId(api: MorrowApi, conversationId: string): Promise<string | null> {
  const messages = await api.listMessages(conversationId);
  return [...messages].reverse().find((message) => Boolean(message.taskId))?.taskId ?? null;
}
