import type { AgentMode, Conversation } from "@morrow/contracts";
import type { Context } from "../cli/context.js";
import type { MorrowApi } from "../client/api.js";
import { ensureRunning } from "../service/lifecycle.js";
import { resolveProject, ask, isInteractive, select, shortId, relativeTime } from "./common.js";
import { streamChatTask } from "./stream.js";
import { renderMarkdown } from "../cli/markdown.js";
import { flagString, flagBool } from "../cli/args.js";
import { CliError, EXIT, usageError } from "../cli/errors.js";
import { largeWordmark, greeting, modeLabel, privacyLabel } from "../cli/identity.js";
import { readLineWithCompletion, PROMPT_EXIT } from "../terminal/prompt.js";
import { InteractiveSession, type SessionBackend, type SessionSettings } from "../terminal/session.js";
import { nodeTermIO } from "../terminal/runtime.js";
import { shouldUseInteractive } from "../terminal/capabilities.js";
import { streamTaskEvents } from "../client/sse.js";
import type { SessionMeta } from "../terminal/events.js";
import type { PaletteItem } from "../terminal/palette.js";
import { gitSummary, gitSummaryText } from "../cli/gitinfo.js";

/** Capability mode: flag > config default > agent (the primary product). */
export function resolveMode(ctx: Context): AgentMode {
  if (flagBool(ctx.flags, "plan")) return "plan-only";
  if (flagBool(ctx.flags, "read-only") || flagBool(ctx.flags, "inspect")) return "read-only";
  const configured = ctx.config.get("defaults.mode") as AgentMode | undefined;
  return configured ?? "agent";
}

/** Whether to use Unicode glyphs: config > MORROW_ASCII env > on by default. */
export function resolveUnicode(ctx: Context): boolean {
  const cfg = ctx.config.get("ui.unicode") as boolean | undefined;
  if (cfg !== undefined) return cfg;
  return process.env.MORROW_ASCII !== "1";
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
    mode,
    useMemory: (ctx.config.get("defaults.useMemory") as boolean | undefined) ?? true,
    autoApprove: resolveAutoApprove(ctx, mode),
  };

  const conversation = await resolveConversation(ctx, api, project.id);

  const message = flagString(ctx.flags, "message") ?? flagString(ctx.flags, "m");
  if (message) {
    return runOneShot(ctx, api, conversation, message, session);
  }

  if (!isInteractive(ctx)) {
    throw usageError("No message provided and not running in an interactive terminal.", "Use --message \"…\" for non-interactive use.");
  }

  return runRepl(ctx, api, project.id, conversation, session);
}

/**
 * The full-screen interactive session: one event-driven terminal application
 * wired to the live orchestrator. Replaces the line REPL on capable terminals.
 */
async function runInteractiveSession(
  ctx: Context,
  api: MorrowApi,
  projectId: string,
  conversation: Conversation,
  session: SessionState,
  unicode: boolean
): Promise<number> {
  const project = await api.getProject(projectId);
  const providerStatus = await api.providerStatus().catch(() => null);
  const providerName = session.provider ?? providerStatus?.provider ?? "auto";
  const modelName = session.model ?? providerStatus?.model ?? "auto";
  const projectName = project.workspacePath.split(/[\\/]/).filter(Boolean).pop() ?? project.workspacePath;
  const git = gitSummary(project.workspacePath);
  const name = (ctx.config.get("user.name") as string | undefined)?.trim();

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
      });
      return { taskId: sent.task.id };
    },
    subscribe: (taskId, signal) => streamTaskEvents(api.baseUrl, taskId, { signal }),
    cancel: (taskId) => api.cancelTask(taskId),
    async getApproval(id) {
      const a = await api.getApproval(id);
      return { id: a.id, kind: a.kind, details: a.details, projectId: a.projectId };
    },
    resolveApproval: (id, decision, trustPattern) =>
      api
        .resolveApproval(id, { projectId: project.id, decision: decision as any, ...(trustPattern ? { trustPattern } : {}) })
        .then(() => undefined),
  };

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
    extraPaletteItems,
  });
  try {
    await app.run();
  } finally {
    app.teardown();
  }
  return EXIT.OK;
}

async function resolveConversation(ctx: Context, api: MorrowApi, projectId: string): Promise<Conversation> {
  const resumeId = flagString(ctx.flags, "resume");
  if (resumeId !== undefined) {
    if (resumeId) {
      try {
        return await api.getConversation(resumeId);
      } catch {
        throw new CliError(`Conversation not found: ${resumeId}`, { code: "NOT_FOUND", exitCode: EXIT.NOT_FOUND });
      }
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
    mode: s.mode,
    useMemory: s.useMemory,
    // Only send autoApprove when it is meaningfully on (agent mode); the server
    // ignores it otherwise, but keeping the wire honest avoids confusion.
    ...(s.autoApprove && s.mode === "agent" ? { autoApprove: true } : {}),
  };
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

async function runRepl(ctx: Context, api: MorrowApi, projectId: string, initial: Conversation, session: SessionState): Promise<number> {
  let conversation = initial;
  const out = ctx.out;
  const unicode = resolveUnicode(ctx);

  // Capable interactive terminal → the full-screen event-driven session app.
  // Everything else (redirected, CI, JSON, dumb, MORROW_TUI=0) → line renderer.
  if (shouldUseInteractive({ json: out.json, isTTY: Boolean(process.stdout.isTTY), stdinIsTTY: Boolean(process.stdin.isTTY), env: process.env })) {
    return runInteractiveSession(ctx, api, projectId, conversation, session, unicode);
  }

  const project = await api.getProject(projectId);
  const providerStatus = await api.providerStatus().catch(() => null);

  const providerName = session.provider ?? providerStatus?.provider ?? "auto";
  const modelName = session.model ?? providerStatus?.model ?? "auto";
  const projectName = project.workspacePath.split(/[\\/]/).filter(Boolean).pop() ?? project.workspacePath;
  const git = gitSummary(project.workspacePath);
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
      const result = await handleSlash(ctx, api, projectId, conversation, session, line);
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
        out.success(`Model set to ${session.model ?? "auto (preset routing)"}.`);
      } else {
        const models = await api.listModels();
        out.heading("Models");
        models.filter((m) => m.available).forEach((m) => out.print(`  ${out.cyan(m.model.id)}  ${out.gray(m.model.label)}`));
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
        out.info(`Mode: ${modeLabel(session.mode, session.autoApprove)}`);
        return {};
      }
      const next = arg === "inspect" ? "read-only" : arg === "plan" ? "plan-only" : arg;
      if (next !== "agent" && next !== "read-only" && next !== "plan-only") {
        out.warn("Usage: /mode [agent|inspect|plan]");
        return {};
      }
      session.mode = next as AgentMode;
      // Leaving agent mode makes auto-approve meaningless; turn it off so the
      // label can never claim YOLO for a mode that does not execute.
      if (session.mode !== "agent" && session.autoApprove) session.autoApprove = false;
      out.success(`Mode set to ${modeLabel(session.mode, session.autoApprove)}.`);
      return {};
    }
    case "yolo": {
      if (session.mode !== "agent") {
        out.warn(`YOLO only applies in agent mode (current: ${modeLabel(session.mode)}). Switch with /mode agent first.`);
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
    case "cancel":
      out.info("Nothing is currently streaming (cancel works during a response with Ctrl+C).");
      return {};
    case "memory":
      session.useMemory = !session.useMemory;
      out.success(`Memory ${session.useMemory ? "enabled" : "disabled"} for this session.`);
      return {};
    case "compact":
      return compact(ctx, api, conversation);
    case "export": {
      const { exportConversationToText } = await import("./conversations.js");
      const text = await exportConversationToText(api, conversation.id);
      if (arg) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(arg, text);
        out.success(`Exported to ${arg}.`);
      } else {
        out.print(text);
      }
      return {};
    }
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
    ["/new [title]", "start a new conversation"],
    ["/resume [id]", "list or resume a conversation"],
    ["/sessions", "list recent conversations"],
    ["/project", "show the active project"],
    ["/provider [id]", "show providers or set the active provider"],
    ["/model [id]", "show models or set the active model"],
    ["/preset [id]", "show presets or set the active preset"],
    ["/mode [kind]", "show or set agent | inspect | plan"],
    ["/yolo [on|off]", "toggle auto-approve (agent mode); denied actions stay blocked"],
    ["/tools", "list available read-only tools"],
    ["/permissions", "show the permission profile"],
    ["/status", "show service and session status"],
    ["/history", "show full conversation history"],
    ["/inspect", "run a safe workspace inspection"],
    ["/diff", "show the current session's latest Morrow-owned applied change"],
    ["/undo", "rollback the latest Morrow-owned change in the session"],
    ["/cancel", "cancel info (use Ctrl+C while streaming)"],
    ["/memory", "toggle memory for this session"],
    ["/compact", "summarize history into a memory note"],
    ["/export [file]", "export the conversation as text"],
    ["/clear", "clear the screen"],
    ["/exit", "quit"],
  ];
  out.keyValue(rows);
}
