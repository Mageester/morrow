import type { AgentMode, Conversation, Project } from "@morrow/contracts";
import type { Context } from "../cli/context.js";
import type { MorrowApi, TaskAggregate } from "../client/api.js";
import { ensureRunning } from "../service/lifecycle.js";
import { resolveProject, ask, isInteractive, select, shortId, relativeTime } from "./common.js";
import { streamChatTask } from "./stream.js";
import { renderMarkdown } from "../cli/markdown.js";
import { flagString, flagBool } from "../cli/args.js";
import { CliError, EXIT, usageError } from "../cli/errors.js";
import { largeWordmark, greeting, modeLabel, parseModeName, privacyLabel } from "../cli/identity.js";
import { readLineWithCompletion, PROMPT_EXIT } from "../terminal/prompt.js";
import { InteractiveSession, type SessionBackend, type SessionSettings } from "../terminal/session.js";
import { SLASH_COMMANDS, type SlashCommand } from "../terminal/commands.js";
import { skillsAsSlashCommands } from "../skills/registry.js";
import { localSkillsRoot } from "./skills.js";
import { loadHistory, appendHistory } from "../terminal/history.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { nodeTermIO } from "../terminal/runtime.js";
import { shouldUseInteractive } from "../terminal/capabilities.js";
import { streamTaskEvents } from "../client/sse.js";
import type { SessionMeta } from "../terminal/events.js";
import type { PaletteItem } from "../terminal/palette.js";
import { gitSummary, gitSummaryText, gitStatus } from "../cli/gitinfo.js";
import { formatContextStatus, formatMissionResult, formatTaskTree } from "../terminal/mission-control.js";
import { buildTaskReport, defaultReportFilename, findLatestTaskId, type ReportKind } from "../terminal/output-report.js";

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
  if (flagBool(ctx.flags, "yolo")) return true;
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
  const git = gitSummary(project.workspacePath);
  const [providerStatus, priorHistory] = await Promise.all([providerStatusPromise, priorHistoryPromise]);
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
  const settings: SessionSettings = {
    mode: session.mode,
    autoApprove: session.autoApprove,
    ...(session.provider ? { provider: session.provider } : {}),
    ...(session.model ? { model: session.model } : {}),
    preset: session.preset,
    useMemory: session.useMemory,
  };

  const backend: SessionBackend = {
    async send(text, opts) {
      const sent = await api.sendMessage(conversation.id, text, {
        preset: opts.preset,
        ...(opts.provider ? { providerId: opts.provider } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        mode: opts.mode,
        useMemory: opts.useMemory,
        ...(opts.autoApprove && opts.mode === "agent" ? { autoApprove: true } : {}),
        ...(session.worktreeId ? { worktreeId: session.worktreeId } : {}),
        ...(session.missionId ? { missionId: session.missionId } : {}),
      });
      return { taskId: sent.task.id };
    },
    subscribe: (taskId, signal) => streamTaskEvents(api.baseUrl, taskId, { signal }),
    cancel: (taskId) => api.cancelTask(taskId),
    resume: (taskId) => api.resumeTask(taskId).then(() => undefined),
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
      const messages = await api.listMessages(conversation.id);
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
    getGitStatus: async () => gitStatus(project.workspacePath),
    getCortexStaleness: () => api.intelligenceStaleness(project.id).catch(() => null),
  };

  // Verified local skills become namespaced /skill:<id> commands (autocomplete + help).
  const skillCommands: SlashCommand[] = skillsAsSlashCommands(localSkillsRoot()).map((c) => ({
    name: c.name,
    description: c.description,
  }));

  const historyFile = join(ctx.paths.home, "history");

  // Real model data feeds the Ctrl+K palette (project/session search deferred).
  const models = await api.listModels().catch(() => []);
  const extraPaletteItems: PaletteItem[] = models
    .filter((m) => m.available)
    .slice(0, 40)
    .map((m) => ({ kind: "model" as const, label: m.model.id, hint: m.model.label, run: `/model ${m.model.id}` }));

  const app = new InteractiveSession({
    io: nodeTermIO(process.stdout),
    stdin: process.stdin,
    out: ctx.out,
    unicode,
    meta,
    settings,
    backend,
    commands: [...SLASH_COMMANDS, ...skillCommands],
    extraPaletteItems,
    history: loadHistory(historyFile),
    onHistory: (line) => appendHistory(historyFile, line),
    initialTaskId,
  });
  try {
    await app.run();
  } finally {
    app.teardown();
  }
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

  for (const line of largeWordmark(out, unicode)) out.print(line);
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

  while (true) {
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
      const result = await handleSlash(ctx, api, project.id, conversation, session, line);
      if (result.exit) return EXIT.OK;
      if (result.conversation) conversation = result.conversation;
      continue;
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

interface SlashResult {
  exit?: boolean;
  conversation?: Conversation;
}

async function handleSlash(ctx: Context, api: MorrowApi, projectId: string, conversation: Conversation, session: SessionState, line: string): Promise<SlashResult> {
  const out = ctx.out;
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();

  switch (cmd) {
    case "help":
      printReplHelp(ctx);
      return {};
    case "capabilities": {
      const { reportCapabilities, capabilityLines } = await import("./capabilities.js");
      const report = await reportCapabilities(api);
      for (const l of capabilityLines(report, out, resolveUnicode(ctx))) out.print(l);
      return {};
    }
    case "exit":
    case "quit":
      out.info("Goodbye.");
      return { exit: true };
    case "clear":
      process.stdout.write("\x1bc");
      return {};
    case "new": {
      const conv = await api.createConversation(projectId, arg || undefined);
      out.success(`Started new conversation ${shortId(conv.id)}.`);
      return { conversation: conv };
    }
    case "resume": {
      if (!arg) {
        const list = await api.listConversations(projectId);
        out.heading("Conversations");
        list.forEach((c) => out.print(`  ${out.cyan(shortId(c.id))}  ${c.title}  ${out.gray(relativeTime(c.updatedAt))}`));
        return {};
      }
      try {
        const conv = await api.getConversation(arg);
        out.success(`Resumed ${conv.title} (${shortId(conv.id)}).`);
        const hist = await api.listMessages(conv.id);
        for (const m of hist.slice(-6)) renderHistoryMessage(ctx, m.role, m.content, m.streamingState);
        return { conversation: conv };
      } catch {
        out.error(`Conversation not found: ${arg}`);
        return {};
      }
    }
    case "sessions": {
      const list = await api.listConversations(projectId);
      out.heading("Sessions");
      list.forEach((c) => out.print(`  ${out.cyan(shortId(c.id))}  ${c.title}  ${out.gray(relativeTime(c.updatedAt))}`));
      return {};
    }
    case "project":
      out.info(`Active project: ${projectId}`);
      return {};
    case "provider": {
      if (arg) {
        session.provider = arg === "auto" ? undefined : arg;
        out.success(`Provider set to ${session.provider ?? "auto (preset routing)"}.`);
      } else {
        const ps = await api.listProviders();
        out.heading("Providers");
        ps.forEach((p) => out.print(`  ${p.configured ? out.green("●") : out.gray("○")} ${p.id}  ${out.gray(p.label)}`));
      }
      return {};
    }
    case "model": {
      if (arg) {
        session.model = arg === "auto" ? undefined : arg;
        out.success(`Model set to ${session.model ?? "auto (preset routing)"} — session preserved.`);
      } else {
        const models = await api.listModels();
        const { modelPickerLines } = await import("../terminal/model-picker.js");
        for (const l of modelPickerLines(models, { provider: session.provider, model: session.model }, out, resolveUnicode(ctx))) out.print(l);
      }
      return {};
    }
    case "preset": {
      if (arg) {
        session.preset = arg;
        out.success(`Preset set to ${arg}.`);
      } else {
        const presets = await api.listPresets();
        out.heading("Presets");
        presets.forEach((p) => out.print(`  ${p.available ? out.green("●") : out.gray("○")} ${p.preset.id}  ${out.gray(p.preset.description)}`));
      }
      return {};
    }
    case "mode": {
      if (!arg) {
        out.info(`Mode: ${modeLabel(session.mode, session.autoApprove)}  ·  switch: /mode ask|plan|build|mission`);
        return {};
      }
      const next = parseModeName(arg);
      if (next === null) {
        out.warn("Usage: /mode [ask|plan|build|mission]");
        return {};
      }
      if (next === "mission") {
        // Mission is the distinct verified-objective flow. Start one from the
        // shell prompt or `morrow mission "<objective>"`, then inspect it with
        // /tree, /result, and /context.
        out.info("Mission mode runs a verified autonomous objective with criteria, evidence, and review.");
        out.info(`Start one with:  ${out.cyan('morrow mission "<objective>"')}   ·   inspect with /tree /result /context`);
        return {};
      }
      session.mode = next as AgentMode;
      // Leaving Build (agent) mode makes auto-approve meaningless; turn it off so
      // the label can never claim YOLO for a mode that does not execute.
      if (session.mode !== "agent" && session.autoApprove) session.autoApprove = false;
      out.success(`Mode set to ${modeLabel(session.mode, session.autoApprove)}.`);
      return {};
    }
    case "yolo": {
      if (session.mode !== "agent") {
        out.warn(`YOLO only applies in Build mode (current: ${modeLabel(session.mode)}). Switch with /mode build first.`);
        return {};
      }
      session.autoApprove = arg === "on" ? true : arg === "off" ? false : !session.autoApprove;
      if (session.autoApprove) {
        out.warn("YOLO on: commands and patches will run without asking. Denied actions (shells, deletes, history rewrites) stay blocked.");
      } else {
        out.success("YOLO off: edits and commands require approval again.");
      }
      return {};
    }
    case "tools": {
      const tools = await api.listTools();
      out.heading("Tools (read-only)");
      tools.forEach((t) => out.print(`  ${out.cyan(t.name)}  ${out.gray(t.description)}`));
      return {};
    }
    case "permissions": {
      const perm = await api.permissions();
      out.heading("Permissions");
      out.keyValue([
        ["filesystem", perm.filesystemAccess],
        ["shell", String(perm.shellExecution)],
        ["network", perm.networkAccess],
        ["write", String(perm.writeAccess)],
      ]);
      return {};
    }
    case "status": {
      const health = await api.health().catch(() => null);
      out.heading("Status");
      out.keyValue([
        ["service", health ? "running" : "unreachable"],
        ["conversation", `${conversation.title} (${shortId(conversation.id)})`],
        ["project", projectId],
        ["preset", session.preset],
        ["provider", session.provider ?? "auto"],
        ["model", session.model ?? "auto"],
        ["mode", modeLabel(session.mode, session.autoApprove)],
        ["memory", session.useMemory ? "on" : "off"],
      ]);
      return {};
    }
    case "history": {
      const msgs = await api.listMessages(conversation.id);
      out.heading(`History (${msgs.length})`);
      for (const m of msgs) renderHistoryMessage(ctx, m.role, m.content, m.streamingState);
      return {};
    }
    case "inspect": {
      const started = await api.startInspectWorkspace(projectId);
      out.info("Inspecting workspace…");
      const { streamTaskEvents } = await import("../client/sse.js");
      for await (const ev of streamTaskEvents(api.baseUrl, started.taskId, {})) {
        if (ev.type === "workspace.inspected") out.success(`Inspected workspace (${(ev.payload as any).resultCount} entries).`);
      }
      return {};
    }
    case "ps": {
      const parts = (arg ?? "").split(/\s+/).filter(Boolean);
      try {
        if (parts[0] === "kill") {
          if (!parts[1]) { out.warn("Usage: /ps kill <id>"); return {}; }
          const all = await api.listProcesses(projectId);
          const matches = all.filter((p) => p.id === parts[1] || p.id.startsWith(parts[1]!));
          if (matches.length !== 1) { out.warn(matches.length === 0 ? `No process matching "${parts[1]}".` : `"${parts[1]}" is ambiguous.`); return {}; }
          await api.terminateProcess(matches[0]!.id, true);
          out.success(`Terminating ${matches[0]!.id.slice(0, 8)}.`);
          return {};
        }
        const processes = await api.listProcesses(projectId);
        if (processes.length === 0) { out.info("No background processes. Start one with `morrow processes start -- <cmd> …`."); return {}; }
        out.heading(`Processes (${processes.length})`);
        for (const p of processes) {
          const cmd = [p.command, ...p.args].join(" ").slice(0, 60);
          out.print(`  ${p.id.slice(0, 8)}  ${p.status.padEnd(9)}  ${cmd}${p.exitCode !== null ? out.gray(`  exit ${p.exitCode}`) : ""}`);
        }
        return {};
      } catch (e: any) {
        out.error(e?.message ?? String(e));
        return {};
      }
    }
    case "worktrees":
    case "worktree": {
      const parts = (arg ?? "").split(/\s+/).filter(Boolean);
      const verb = parts[0] ?? "list";
      const ref = parts[1];
      try {
        const all = await api.listWorktrees(projectId);
        const resolve = (value: string | undefined) => {
          if (!value) return undefined;
          const matches = all.filter((w) => w.id === value || w.id.startsWith(value) || w.branch === value || w.branch === `morrow/${value}`);
          return matches.length === 1 ? matches[0] : null;
        };
        if (verb === "show") {
          const match = resolve(ref);
          if (match === undefined) { out.warn("Usage: /worktrees show <id|name>"); return {}; }
          if (match === null) { out.warn(`No unambiguous worktree matching "${ref}".`); return {}; }
          const status = await api.getWorktree(match.id);
          out.heading(`Worktree ${status.branch}`);
          out.keyValue([
            ["status", status.status],
            ["path", status.path],
            ["dirty", status.dirty ? `yes (${status.dirtyFiles.length})` : "no"],
            ["commits ahead", String(status.aheadCommits.length)],
            ["task", status.taskId ?? "-"],
            ["agent", status.agentId ?? "-"],
          ]);
          for (const f of status.dirtyFiles.slice(0, 10)) out.print(`  M ${f}`);
          return {};
        }
        if (verb === "remove") {
          const match = resolve(ref);
          if (match === undefined) { out.warn("Usage: /worktrees remove <id|name>"); return {}; }
          if (match === null) { out.warn(`No unambiguous worktree matching "${ref}".`); return {}; }
          await api.removeWorktree(match.id, parts.includes("--preserve"));
          out.success(`Removed worktree ${match.branch} (branch retained).`);
          return {};
        }
        if (all.length === 0) { out.info("No worktrees. Create one with `morrow worktrees create <name>`."); return {}; }
        out.heading(`Worktrees (${all.length})`);
        for (const w of all) {
          const assoc = [w.taskId ? `task ${w.taskId.slice(0, 8)}` : "", w.agentId ? `agent ${w.agentId.slice(0, 8)}` : ""].filter(Boolean).join(", ");
          out.print(`  ${w.id.slice(0, 8)}  ${w.status.padEnd(9)}  ${w.branch}  ${out.gray(assoc || w.path)}`);
        }
        return {};
      } catch (e: any) {
        out.error(e?.message ?? String(e));
        return {};
      }
    }
    case "checkpoint": {
      const parts = (arg ?? "").split(/\s+/).filter(Boolean);
      const verb = parts[0] ?? "list";
      const name = parts[1];
      const usage = "Usage: /checkpoint save <name> [file …] | list | restore <name> | delete <name>";
      try {
        if (verb === "list") {
          const list = await api.listCheckpoints(projectId);
          if (list.length === 0) {
            out.info("No checkpoints yet. Create one with /checkpoint save <name>.");
            return {};
          }
          out.heading(`Checkpoints (${list.length})`);
          for (const cp of list) {
            out.print(`  ${out.bold(cp.name)}  ${out.gray(`${cp.fileCount} file${cp.fileCount === 1 ? "" : "s"} · ${cp.createdAt}`)}`);
          }
          return {};
        }
        if (!name) { out.warn(usage); return {}; }
        if (verb === "save") {
          const files = parts.slice(2);
          const created = await api.createCheckpoint(projectId, { name, ...(files.length > 0 ? { files } : {}) });
          out.success(`Checkpoint "${created.name}" saved (${created.fileCount} file${created.fileCount === 1 ? "" : "s"}).`);
          for (const s of created.skipped) out.warn(`Skipped ${s.path}: ${s.reason}`);
          return {};
        }
        if (verb === "restore") {
          const res = await api.restoreCheckpoint(projectId, name);
          const total = res.restoredFiles.length + res.deletedFiles.length;
          out.success(total === 0 ? `Workspace already matches "${name}".` : `Restored "${name}" (${res.restoredFiles.length} written, ${res.deletedFiles.length} removed).`);
          if (res.safetyCheckpoint) out.info(`Previous state saved as "${res.safetyCheckpoint}" — restore it to undo.`);
          return {};
        }
        if (verb === "delete") {
          await api.deleteCheckpoint(projectId, name);
          out.success(`Deleted checkpoint "${name}".`);
          return {};
        }
        out.warn(usage);
        return {};
      } catch (e: any) {
        out.error(e?.message ?? String(e));
        return {};
      }
    }
    case "diff": {
      const msgs = await api.listMessages(conversation.id);
      const taskIds = msgs.map(m => m.taskId).filter(Boolean) as string[];
      taskIds.reverse();

      let latestDiff: any = null;
      let latestTaskId: string | null = null;

      for (const tid of taskIds) {
        const diffData = await api.getTaskDiff(tid);
        if (diffData && diffData.diff) {
          latestDiff = diffData;
          latestTaskId = tid;
          break;
        }
      }

      if (!latestDiff) {
        out.info("No Morrow-owned changes exist for this session.");
        return {};
      }

      out.print();
      out.heading(`Latest applied change (Task ${shortId(latestTaskId!)}, state: ${latestDiff.state})`);
      out.print(`${out.bold("Files changed:")} ${latestDiff.files.join(", ")}`);
      out.print();
      out.print(out.bold("Unified Diff:"));
      const diffLines = latestDiff.diff.split("\n");
      for (const line of diffLines) {
        if (line.startsWith("+") && !line.startsWith("+++")) {
          out.print(out.green(line));
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          out.print(out.red(line));
        } else {
          out.print(line);
        }
      }
      return {};
    }
    case "undo": {
      const msgs = await api.listMessages(conversation.id);
      const taskIds = msgs.map(m => m.taskId).filter(Boolean) as string[];
      taskIds.reverse();

      let targetTaskId: string | null = null;
      let targetDiff: any = null;

      for (const tid of taskIds) {
        const diffData = await api.getTaskDiff(tid);
        if (diffData && diffData.diff && diffData.state === "applied") {
          targetTaskId = tid;
          targetDiff = diffData;
          break;
        }
      }

      if (!targetTaskId) {
        out.info("No applicable Morrow-owned change set found to undo.");
        return {};
      }

      out.print();
      out.heading("Rollback Morrow-Owned Change Set");
      out.print(`${out.bold("Task:")} ${shortId(targetTaskId)}`);
      out.print(`${out.bold("Files to restore:")} ${targetDiff.files.join(", ")}`);
      out.print();

      const answer = (await ask("Confirm targeted rollback of these changes? [y/N]: ")).trim().toLowerCase();
      if (answer === "y" || answer === "yes") {
        try {
          const res = await api.undoTask(targetTaskId);
          out.success(`Successfully rolled back changes. Restored/removed files: ${res.restoredFiles.join(", ")}`);
        } catch (e: any) {
          out.error(`Rollback failed: ${e.message}`);
        }
      } else {
        out.info("Rollback cancelled.");
      }
      return {};
    }
    case "tree": {
      const taskId = await latestTaskId(api, conversation.id);
      if (!taskId) {
        out.info("No mission task exists yet.");
        return {};
      }
      const tree = await api.getTaskTree(taskId);
      for (const line of formatTaskTree(tree)) out.print(line);
      return {};
    }
    case "result": {
      const taskId = await latestTaskId(api, conversation.id);
      if (!taskId) {
        out.info("No mission result exists yet.");
        return {};
      }
      const aggregate = await api.getTask(taskId);
      for (const line of formatMissionResult(aggregate)) out.print(line);
      return {};
    }
    case "context": {
      const taskId = await latestTaskId(api, conversation.id);
      if (!taskId) {
        out.info("No mission context exists yet.");
        return {};
      }
      const aggregate = await api.getTask(taskId);
      for (const line of formatContextStatus(aggregate)) out.print(line);
      return {};
    }
    case "output": {
      const taskId = await latestTaskId(api, conversation.id);
      if (!taskId) {
        out.info("No task output is available yet.");
        return {};
      }
      const kind: ReportKind = arg === "full" ? "full" : arg === "failures" ? "failures" : "summary";
      const [aggregate, messages] = await Promise.all([api.getTask(taskId), api.listMessages(conversation.id)]);
      const finalAnswer = [...messages].reverse().find((message) => message.taskId === taskId && message.role === "assistant")?.content ?? null;
      out.print(buildTaskReport(aggregate, { kind, ...(finalAnswer ? { legacyFinalAnswerFallback: finalAnswer } : {}) }));
      return {};
    }
    case "export": {
      const taskId = await latestTaskId(api, conversation.id);
      if (!taskId) {
        out.info("No task output is available yet.");
        return {};
      }
      const [aggregate, messages] = await Promise.all([api.getTask(taskId), api.listMessages(conversation.id)]);
      const finalAnswer = [...messages].reverse().find((message) => message.taskId === taskId && message.role === "assistant")?.content ?? null;
      const path = writeTaskReport(ctx, taskId, aggregate, "full", finalAnswer, arg || undefined);
      out.success(`Exported report: ${path}`);
      return {};
    }
    case "cancel":
      out.info("Nothing is currently streaming (cancel works during a response with Ctrl+C).");
      return {};
    case "memory":
      session.useMemory = !session.useMemory;
      out.success(`Memory ${session.useMemory ? "enabled" : "disabled"} for this session.`);
      return {};
    // ── New commands ──────────────────────────────────────────────────────────
    case "tasks": {
      const tasks = await api.listTasks(projectId);
      const limit = arg ? parseInt(arg, 10) || 10 : 10;
      const recent = tasks.slice(-limit).reverse();
      out.heading(`Tasks (${tasks.length} total, showing ${recent.length})`);
      for (const t of recent) {
        const statusIcon = t.status === "completed" ? out.green("✓") : t.status === "failed" ? out.red("✗") : t.status === "running" ? out.yellow("⟳") : t.status === "cancelled" ? out.gray("⊘") : "○";
        out.print(`  ${statusIcon} ${out.cyan(shortId(t.id))}  ${t.status.padEnd(12)}  ${out.gray(t.kind ?? "agent")}`);
      }
      return {};
    }
    case "memory-search": {
      if (!arg) { out.warn("Usage: /memory-search <query>"); return {}; }
      const results = await api.search(projectId, arg, { kinds: ["memory"], limit: 10 });
      out.heading(`Memory search: "${arg}"`);
      if (results.hits.length === 0) out.info("No memory entries found.");
      else for (const h of results.hits) out.print(`  ${out.cyan(`[${h.kind}]`)} ${h.title}  ${out.gray("— " + h.snippet.replace(/\s+/g, " ").trim())}`);
      return {};
    }
    case "audit": {
      const limit = arg ? parseInt(arg, 10) || 20 : 20;
      const entries = await api.audit(projectId, limit);
      out.heading(`Audit log (${entries.length})`);
      for (const e of entries) {
        const ts = new Date(e.createdAt).toLocaleTimeString();
        const status = e.status === "completed" ? out.green("✓") : e.status === "failed" ? out.red("✗") : "○";
        out.print(`  ${out.gray(ts)}  ${status}  ${e.kind.padEnd(15)}  ${out.gray(e.provider ?? "unknown")}`);
      }
      return {};
    }
    case "cost": {
      const msgs = await api.listMessages(conversation.id);
      const taskIds = msgs.map(m => m.taskId).filter(Boolean) as string[];
      let total = "not yet calculated";
      for (const tid of taskIds.reverse()) {
        try {
          const agg = await api.getTask(tid);
          if (agg.disclosure?.estimatedCostUsd) {
            total = `$${agg.disclosure.estimatedCostUsd}`;
            break;
          }
        } catch {}
      }
      out.info(`Estimated session cost: ${total}`);
      return {};
    }
    case "skill-search": {
      const { localSkillsIndex } = await import("./skills.js");
      const skills = localSkillsIndex();
      const q = arg.toLowerCase();
      const matches = skills.filter(s => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
      out.heading(`Skills matching "${arg}" (${matches.length})`);
      for (const s of matches.slice(0, 15)) {
        out.print(`  ${out.cyan(s.name)}  ${out.gray(s.description.slice(0, 80))}`);
      }
      if (matches.length > 15) out.gray(`  …and ${matches.length - 15} more`);
      return {};
    }
    case "fork": {
      const forked = await api.createConversation(projectId, arg || `${conversation.title} (fork)`);
      out.success(`Forked to ${forked.title} (${shortId(forked.id)}).`);
      // Copy last N messages to give context
      const msgs = await api.listMessages(conversation.id);
      const context = msgs.slice(-6);
      for (const m of context) {
        // Insert a summary note as context
      }
      return { conversation: forked };
    }
    case "stash": {
      if (!arg) { out.warn("Usage: /stash <name> — saves session as a named checkpoint"); return {}; }
      const summary = `[Stash: ${arg}] ${new Date().toISOString()}`;
      await api.addMemory(projectId, "conversation", summary, conversation.id);
      out.success(`Stashed checkpoint "${arg}" to project memory.`);
      return {};
    }
    case "bench": {
      out.info("Running provider latency benchmark…");
      const providers = await api.listProviders();
      const configured = providers.filter(p => p.configured);
      if (configured.length === 0) { out.warn("No providers configured."); return {}; }
      out.heading("Latency (ms)");
      for (const p of configured) {
        try {
          const start = Date.now();
          const result = await api.testProvider(p.id);
          const elapsed = Date.now() - start;
          const status = result.ok ? out.green(`${elapsed}ms`) : out.red("failed");
          out.print(`  ${p.id.padEnd(15)}  ${status}`);
        } catch {
          out.print(`  ${p.id.padEnd(15)}  ${out.red("unreachable")}`);
        }
      }
      return {};
    }
    case "versions": {
      const nodeVer = process.versions.node;
      const morrowVer = (await import("../main.js")).VERSION;
      // Use the shared hardened resolver (ranked candidates, no shell, bounded
      // timeout, .cmd/.bat via ComSpec, semver-validated) instead of a naive
      // `execSync("pnpm --version")`, which shells out with ambiguous PATH/.cmd
      // resolution, can hang with no timeout, and leaks stderr/Corepack chatter.
      const { probePnpm } = await import("../service/pnpm.js");
      const pnpm = probePnpm(process.env);
      const pnpmVer = pnpm.ok ? pnpm.detail : "unknown";
      out.heading("Versions");
      out.keyValue([["node", nodeVer], ["pnpm", pnpmVer], ["morrow", morrowVer]]);
      return {};
    }
    case "bugs":
      out.info("Open an issue: https://github.com/Mageester/morrow/issues/new");
      out.info("Include: `morrow doctor` output, reproduction steps, and logs.");
      return {};
    case "theme": {
      const themes = ["dawn", "midnight", "forest", "ocean", "mono"];
      if (!arg || !themes.includes(arg)) {
        out.heading("Available themes");
        themes.forEach(t => out.print(`  ${t === (ctx.config.get("ui.theme") as string || "dawn") ? out.green("●") : " "} ${t}`));
        return {};
      }
      ctx.config.set("ui.theme", arg, "user");
      out.success(`Theme set to "${arg}". Restart your session to apply.`);
      return {};
    }
    case "connect": {
      if (!arg) { out.warn("Usage: /connect <provider-id>"); return {}; }
      const providers = await api.listProviders();
      const match = providers.find(p => p.id === arg);
      if (!match) { out.warn(`Provider "${arg}" not found. Use /provider to list available.`); return {}; }
      if (match.configured) { out.info(`Provider "${arg}" is already configured.`); return {}; }
      out.info(`To configure ${match.label || arg}, set the ${match.id.toUpperCase()}_API_KEY environment variable and restart.`);
      return {};
    }
    case "share": {
      const fmt = arg || "markdown";
      const { exportConversationToText } = await import("./conversations.js");
      const text = await exportConversationToText(api, conversation.id);
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filename = `morrow-session-${ts}.md`;
      const { writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const outPath = join(process.cwd(), filename);
      writeFileSync(outPath, `# Morrow Session Export\n\n${text}`);
      out.success(`Exported to ${outPath}`);
      return {};
    }
    case "shortcuts": {
      out.heading("Keyboard shortcuts");
      out.keyValue([
        ["Ctrl+C", "cancel running task (x2 to exit)"],
        ["Ctrl+K", "open command palette"],
        ["Ctrl+R", "search command history"],
        ["Ctrl+O", "view last command output"],
        ["Ctrl+L", "clear screen / repaint"],
        ["Tab", "complete slash command"],
        ["↑/↓", "history recall"],
        ["Esc", "close overlay / dismiss completion"],
      ]);
      return {};
    }
    case "compact":
      return compact(ctx, api, conversation);
    default:
      out.warn(`Unknown command: /${cmd}. Type /help.`);
      return {};
  }
}

async function compact(ctx: Context, api: MorrowApi, conversation: Conversation): Promise<SlashResult> {
  const out = ctx.out;
  const msgs = await api.listMessages(conversation.id);
  if (msgs.length < 2) {
    out.info("Not enough conversation yet to compact.");
    return {};
  }
  out.info("Summarizing this conversation into a memory note…");
  const sent = await api.sendMessage(
    conversation.id,
    "Summarize our conversation so far in 5 concise bullet points capturing key facts and decisions. Output only the bullets.",
    { preset: ctx.preset(), useMemory: true }
  );
  const result = await streamChatTask(ctx, api, sent.task.id, sent.routing, { showActivity: false });
  if (result.status === "completed" && result.content.trim()) {
    const project = await api.getConversation(conversation.id);
    await api.addMemory(project.projectId, "conversation", result.content.trim(), conversation.id);
    out.success("Saved a conversation summary to memory; it will be injected into future turns.");
  } else {
    out.warn("Could not generate a summary.");
  }
  return {};
}

function printReplHelp(ctx: Context) {
  const out = ctx.out;
  out.heading("Chat commands");
  const rows: Array<[string, string]> = [
    ["/help", "show this help"],
    ["/capabilities", "what this build can actually do right now"],
    ["/new [title]", "start a new conversation"],
    ["/resume [id]", "list or resume a conversation"],
    ["/sessions", "list recent conversations"],
    ["/project", "show the active project"],
    ["/provider [id]", "show providers or set the active provider"],
    ["/model [id]", "show models or set the active model"],
    ["/preset [id]", "show presets or set the active preset"],
    ["/mode [kind]", "show or set ask | plan | build | mission"],
    ["/yolo [on|off]", "toggle auto-approve (Build mode); denied actions stay blocked"],
    ["/tools", "list available read-only tools"],
    ["/permissions", "show the permission profile"],
    ["/status", "show service and session status"],
    ["/history", "show full conversation history"],
    ["/inspect", "run a safe workspace inspection"],
    ["/diff", "show the current session's latest Morrow-owned applied change"],
    ["/undo", "rollback the latest Morrow-owned change in the session"],
    ["/tree", "show the current mission task tree"],
    ["/result", "show final evidence and next action"],
    ["/context", "show context usage, compaction, and token-count confidence"],
    ["/output [full|failures]", "show the durable final report for the latest task"],
    ["/cancel", "cancel info (use Ctrl+C while streaming)"],
    ["/memory", "toggle memory for this session"],
    ["/compact", "summarize history into a memory note"],
    ["/export [file]", "export a sanitized task report"],
    ["/clear", "clear the screen"],
    ["/exit", "quit"],
  ];
  out.keyValue(rows);
}

async function latestTaskId(api: MorrowApi, conversationId: string): Promise<string | null> {
  const messages = await api.listMessages(conversationId);
  return [...messages].reverse().find((message) => Boolean(message.taskId))?.taskId ?? null;
}
