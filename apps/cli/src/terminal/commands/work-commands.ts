/**
 * Commands about the work itself: what Morrow is doing, what it changed, what
 * it cost, and how to undo it.
 *
 * Each one reads live state from the runtime rather than from anything the
 * terminal remembered. A status line that agrees with the screen but not with
 * the service is worse than no status line.
 */
import { buildTaskReport, type ReportKind } from "../output-report.js";
import { report } from "../report.js";
import { errorText, formatCost, formatElapsed, formatTokens, percent, relativeTime, shortId, summarizeList } from "./format.js";
import type { Command, CommandContext, CommandResult } from "./registry.js";

const unavailable = (what: string): CommandResult => ({
  notice: { level: "warn", text: `${what} is not available from this session.` },
});

export const statusCommand: Command = {
  name: "status",
  summary: "where you are, what you're talking to, and whether it's healthy",
  category: "work",
  async run(_args, ctx) {
    const health = ctx.backend.health ? await ctx.backend.health().catch(() => null) : null;
    const git = ctx.backend.getGitStatus ? await ctx.backend.getGitStatus().catch(() => null) : null;
    const active = ctx.activeTaskId();

    const builder = report("Status")
      .fields([
        { label: "Project", value: ctx.session.projectName },
        { label: "Workspace", value: ctx.session.workspacePath },
        { label: "Conversation", value: `${ctx.session.conversationTitle} (${shortId(ctx.session.conversationId)})` },
        {
          label: "Branch",
          value: git?.isRepo
            ? `${git.branch ?? "detached"}${git.staged.length + git.modified.length + git.untracked.length > 0 ? " · uncommitted changes" : " · clean"}`
            : "not a Git repository",
        },
      ])
      .heading("Route")
      .fields([
        { label: "Provider", value: ctx.settings.provider ?? "auto" },
        { label: "Model", value: ctx.settings.model ?? "preset default" },
        { label: "Preset", value: ctx.settings.preset },
        { label: "Mode", value: ctx.settings.mode },
        { label: "Auto-approve", value: ctx.settings.autoApprove ? "on (YOLO)" : "off" },
        { label: "Memory", value: ctx.settings.useMemory ? "on" : "off" },
      ])
      .heading("Service")
      .fields([
        { label: "Endpoint", value: ctx.session.serviceUrl },
        {
          label: "Health",
          value: health ? (health.ok ? "healthy" : "unhealthy") : "unreachable",
          tone: health?.ok ? "success" : "danger",
        },
        { label: "Version", value: ctx.session.version },
        { label: "Task", value: active ? `running (${shortId(active)})` : "idle" },
      ]);

    return { report: builder.build() };
  },
};

export const contextCommand: Command = {
  name: "context",
  summary: "how much of the model's context window is in use",
  category: "work",
  details:
    "Reports the measured window, not an estimate. When Morrow cannot assert a model's real context size it says so rather than showing a reassuring percentage.",
  run(_args, ctx) {
    const usage = ctx.contextUsage();
    if (!usage) {
      return { notice: { level: "info", text: "No context measurement yet — send a message first." } };
    }
    const used = usage.usedTokens;
    const limit = usage.contextLimitTokens ?? null;
    const builder = report("Context")
      .fields([
        { label: "Used", value: `${formatTokens(used)} tokens (${usage.method})` },
        { label: "Window", value: limit ? formatTokens(limit) : "unknown for this model" },
        { label: "Consumed", value: percent(used, limit) },
        { label: "Confidence", value: usage.contextWindowConfidence ?? usage.contextWindowSource },
      ]);

    builder.heading("Budget").fields([
      { label: "Request limit", value: usage.effectiveRequestLimitTokens ? formatTokens(usage.effectiveRequestLimitTokens) : null },
      { label: "Output reserve", value: usage.outputReserveTokens ? formatTokens(usage.outputReserveTokens) : null },
      { label: "Safety margin", value: usage.safetyMarginTokens ? formatTokens(usage.safetyMarginTokens) : null },
      { label: "Tool definitions", value: usage.toolReserveTokens ? formatTokens(usage.toolReserveTokens) : null },
      { label: "Compaction target", value: usage.compactionTargetTokens ? formatTokens(usage.compactionTargetTokens) : null },
    ]);

    if (usage.compactedGroups > 0 || usage.removedGroups > 0) {
      builder.heading("Compaction").fields([
        { label: "Compacted", value: `${usage.compactedGroups} message groups` },
        { label: "Dropped", value: `${usage.removedGroups} message groups` },
      ]);
    }

    if (limit && used / limit > 0.8) builder.hint("Approaching the window — /compact writes a continuation summary.");
    return { report: builder.build() };
  },
};

export const costCommand: Command = {
  name: "cost",
  summary: "tokens and estimated spend for this session",
  category: "work",
  run(_args, ctx) {
    const usage = ctx.usage();
    if (!usage) return { notice: { level: "info", text: "No usage recorded yet in this session." } };
    const builder = report("Usage")
      .subtitle(`${usage.calls} request${usage.calls === 1 ? "" : "s"} · ${usage.provider}/${usage.model}`)
      .fields([
        { label: "Input", value: `${formatTokens(usage.inputTokens)} tokens` },
        {
          label: "Cached input",
          value:
            usage.cachedInputTokens == null
              ? "not reported"
              : `${formatTokens(usage.cachedInputTokens)}${usage.cacheBreakdownComplete ? "" : " (partial — some responses did not report)"}`,
        },
        { label: "Output", value: `${formatTokens(usage.outputTokens)} tokens` },
        { label: "Total", value: `${formatTokens(usage.totalTokens)} tokens` },
        {
          label: "Estimated cost",
          value: usage.estimatedCostUsd == null ? "no pricing for this model" : formatCost(usage.estimatedCostUsd),
        },
      ]);
    if (usage.providerChanges.length > 0) {
      builder.fields([{ label: "Routes used", value: summarizeList(usage.providerChanges, 4) }]);
    }
    return { report: builder.build() };
  },
};

export const tasksCommand: Command = {
  name: "tasks",
  summary: "recent and running tasks in this project",
  usage: "[limit]",
  category: "work",
  async run(args, ctx) {
    if (!ctx.backend.listTasks) return unavailable("Task history");
    try {
      const tasks = await ctx.backend.listTasks();
      if (tasks.length === 0) return { notice: { level: "info", text: "No tasks in this project yet." } };
      const limit = Number.parseInt(args.sub, 10);
      const kept = tasks.slice(0, Number.isFinite(limit) && limit > 0 ? limit : 15);
      return {
        report: report("Tasks")
          .subtitle(`${tasks.length} total`)
          .table(
            ["State", "Kind", "Id", "When"],
            kept.map((task) => [task.status, task.kind, shortId(task.id), relativeTime(task.createdAt)]),
            kept.map((task) =>
              task.status === "failed" ? "danger" : task.status === "running" ? "accent" : undefined,
            ),
          )
          .hint("/output <id> for a task's full report")
          .build(),
      };
    } catch (error) {
      return { notice: { level: "error", text: `Could not list tasks: ${errorText(error)}` } };
    }
  },
};

export const outputCommand: Command = {
  name: "output",
  summary: "the durable report for a finished task",
  usage: "[summary|full|failures] [task-id]",
  category: "work",
  subcommands: ["summary", "full", "failures"],
  details: "Reads the report the orchestrator stored, so it survives a terminal that scrolled away or crashed.",
  complete: (prefix) => ["summary", "full", "failures"].filter((value) => value.startsWith(prefix)),
  async run(args, ctx) {
    const kinds = new Set(["summary", "full", "failures"]);
    const kind = (args.tokens.find((token) => kinds.has(token.toLowerCase())) ?? "summary") as ReportKind;
    const reference = args.tokens.find((token) => !kinds.has(token.toLowerCase()));
    const taskId = reference ?? ctx.lastTaskId();
    if (!taskId) return { notice: { level: "info", text: "No task in this session yet. Send a message first." } };

    try {
      const aggregate = await ctx.backend.getTask(taskId);
      const answer = ctx.backend.getFinalAnswer ? await ctx.backend.getFinalAnswer(taskId).catch(() => null) : null;
      const text = buildTaskReport(aggregate, { kind, ...(answer ? { legacyFinalAnswerFallback: answer } : {}) });
      return { report: report(`Task ${shortId(taskId)}`).subtitle(kind).text(text).build() };
    } catch (error) {
      return { notice: { level: "error", text: `Could not read task ${shortId(taskId)}: ${errorText(error)}` } };
    }
  },
};

export const diffCommand: Command = {
  name: "diff",
  summary: "what Morrow changed in the last task",
  category: "work",
  async run(_args, ctx) {
    const taskId = ctx.lastTaskId();
    if (!taskId) return { notice: { level: "info", text: "No task in this session yet." } };
    if (!ctx.backend.getTaskDiff) return unavailable("Diff");
    try {
      const result = await ctx.backend.getTaskDiff(taskId);
      if (!result.diff || result.files.length === 0) {
        return { notice: { level: "info", text: "That task made no file changes." } };
      }
      return {
        report: report("Changes")
          .subtitle(`${result.files.length} file${result.files.length === 1 ? "" : "s"} · task ${shortId(taskId)}`)
          .diff(result.diff)
          .hint("/undo rolls this back")
          .build(),
      };
    } catch (error) {
      return { notice: { level: "error", text: `Could not read the diff: ${errorText(error)}` } };
    }
  },
};

export const undoCommand: Command = {
  name: "undo",
  summary: "roll back the last task's file changes",
  category: "work",
  details: "Restores the files that task wrote to their pre-task contents. Only Morrow-owned changes are touched.",
  async run(_args, ctx) {
    const taskId = ctx.lastTaskId();
    if (!taskId) return { notice: { level: "info", text: "No task in this session to undo." } };
    if (!ctx.backend.undoTask) return unavailable("Undo");
    try {
      const result = await ctx.backend.undoTask(taskId);
      if (result.restoredFiles.length === 0) {
        return { notice: { level: "info", text: `Nothing to undo — status ${result.status}.` } };
      }
      return {
        report: report("Rolled back")
          .subtitle(`${result.restoredFiles.length} file${result.restoredFiles.length === 1 ? "" : "s"} restored`)
          .list(result.restoredFiles.map((file) => ({ text: file, marker: "·" })))
          .build(),
      };
    } catch (error) {
      return { notice: { level: "error", text: `Could not undo: ${errorText(error)}` } };
    }
  },
};

export const changesCommand: Command = {
  name: "changes",
  aliases: ["git"],
  summary: "working tree status for this repository",
  category: "work",
  async run(_args, ctx) {
    if (!ctx.backend.getGitStatus) return unavailable("Git status");
    const git = await ctx.backend.getGitStatus().catch(() => null);
    if (!git || !git.isRepo) return { notice: { level: "info", text: "This workspace is not a Git repository." } };

    const total = git.staged.length + git.modified.length + git.untracked.length;
    const builder = report("Working tree")
      .subtitle(
        `${git.branch ?? "detached"}${git.ahead ? ` · ${git.ahead} ahead` : ""}${git.behind ? ` · ${git.behind} behind` : ""}`,
      );
    if (total === 0) {
      builder.text("Clean — nothing staged, modified or untracked.", "success");
      return { report: builder.build() };
    }
    if (git.staged.length > 0) {
      builder.heading(`Staged (${git.staged.length})`);
      builder.list(git.staged.map((file) => ({ text: file, tone: "success" as const, marker: "+" })));
    }
    if (git.modified.length > 0) {
      builder.heading(`Modified (${git.modified.length})`);
      builder.list(git.modified.map((file) => ({ text: file, tone: "warning" as const, marker: "~" })));
    }
    if (git.untracked.length > 0) {
      builder.heading(`Untracked (${git.untracked.length})`);
      builder.list(git.untracked.map((file) => ({ text: file, tone: "muted" as const, marker: "?" })));
    }
    return { report: builder.build() };
  },
};

export const searchCommand: Command = {
  name: "search",
  summary: "full-text search across this project's saved work",
  usage: "<query>",
  category: "work",
  async run(args, ctx) {
    if (!args.raw) return { notice: { level: "warn", text: "Usage: /search <query>" } };
    if (!ctx.backend.search) return unavailable("Search");
    try {
      const hits = await ctx.backend.search(args.raw);
      if (hits.length === 0) return { notice: { level: "info", text: `No matches for "${args.raw}".` } };
      return {
        report: report("Search")
          .subtitle(`${hits.length} match${hits.length === 1 ? "" : "es"} for "${args.raw}"`)
          .list(
            hits.slice(0, 25).map((hit) => ({
              text: hit.title,
              marker: "·",
              detail: hit.snippet.replace(/\s+/g, " ").trim().slice(0, 120),
            })),
          )
          .build(),
      };
    } catch (error) {
      return { notice: { level: "error", text: `Search failed: ${errorText(error)}` } };
    }
  },
};

export const checkpointCommand: Command = {
  name: "checkpoint",
  summary: "snapshot and restore workspace files by name",
  usage: "[list|save <name>|restore <name>|delete <name>]",
  category: "work",
  subcommands: ["list", "save", "restore", "delete"],
  details:
    "A checkpoint captures the workspace files Morrow can see. Restoring one takes its own safety snapshot first, so a restore is itself undoable.",
  complete: (prefix) => ["list", "save", "restore", "delete"].filter((value) => value.startsWith(prefix)),
  async run(args, ctx) {
    const { listCheckpoints, saveCheckpoint, restoreCheckpoint, deleteCheckpoint } = ctx.backend;
    if (!listCheckpoints) return unavailable("Checkpoints");

    const action = args.sub || "list";
    const name = args.rest;

    try {
      if (action === "list") {
        const checkpoints = await listCheckpoints();
        if (checkpoints.length === 0) {
          return { notice: { level: "info", text: "No checkpoints yet. /checkpoint save <name> creates one." } };
        }
        return {
          report: report("Checkpoints")
            .table(
              ["Name", "Files", "Created"],
              checkpoints.map((entry) => [entry.name, String(entry.fileCount), relativeTime(entry.createdAt)]),
            )
            .build(),
        };
      }

      if (action === "save") {
        if (!name) return { notice: { level: "warn", text: "Usage: /checkpoint save <name>" } };
        if (!saveCheckpoint) return unavailable("Saving a checkpoint");
        const saved = await saveCheckpoint(name);
        return { notice: { level: "info", text: `Checkpoint "${saved.name}" saved — ${saved.fileCount} files.` } };
      }

      if (action === "restore") {
        if (!name) return { notice: { level: "warn", text: "Usage: /checkpoint restore <name>" } };
        if (!restoreCheckpoint) return unavailable("Restoring a checkpoint");
        const restored = await restoreCheckpoint(name);
        return {
          report: report(`Restored "${name}"`)
            .fields([
              { label: "Files restored", value: String(restored.restoredFiles.length) },
              { label: "Files deleted", value: restored.deletedFiles.length > 0 ? String(restored.deletedFiles.length) : null },
            ])
            .build(),
        };
      }

      if (action === "delete") {
        if (!name) return { notice: { level: "warn", text: "Usage: /checkpoint delete <name>" } };
        if (!deleteCheckpoint) return unavailable("Deleting a checkpoint");
        await deleteCheckpoint(name);
        return { notice: { level: "info", text: `Checkpoint "${name}" deleted.` } };
      }

      return { notice: { level: "warn", text: "Usage: /checkpoint [list|save <name>|restore <name>|delete <name>]" } };
    } catch (error) {
      return { notice: { level: "error", text: `Checkpoint ${action} failed: ${errorText(error)}` } };
    }
  },
};

export const processesCommand: Command = {
  name: "ps",
  aliases: ["processes"],
  summary: "background processes the agent started",
  usage: "[kill <id>]",
  category: "work",
  subcommands: ["kill"],
  async run(args, ctx) {
    if (!ctx.backend.listProcesses) return unavailable("Process listing");
    try {
      if (args.sub === "kill") {
        if (!args.rest) return { notice: { level: "warn", text: "Usage: /ps kill <id>" } };
        if (!ctx.backend.killProcess) return unavailable("Terminating a process");
        await ctx.backend.killProcess(args.rest, true);
        return { notice: { level: "info", text: `Terminated ${shortId(args.rest)}.` } };
      }
      const processes = await ctx.backend.listProcesses();
      const live = processes.filter((entry) => entry.status === "running");
      if (processes.length === 0) return { notice: { level: "info", text: "No background processes." } };
      return {
        report: report("Processes")
          .subtitle(`${live.length} running of ${processes.length}`)
          .table(
            ["State", "Command", "PID", "Id", "Started"],
            processes.slice(0, 20).map((entry) => [
              entry.status,
              [entry.command, ...entry.args].join(" ").slice(0, 48),
              entry.pid == null ? "—" : String(entry.pid),
              shortId(entry.id),
              relativeTime(entry.startedAt),
            ]),
            processes.slice(0, 20).map((entry) =>
              entry.status === "running" ? "accent" : entry.status === "failed" ? "danger" : undefined,
            ),
          )
          .hint("/ps kill <id> stops one")
          .build(),
      };
    } catch (error) {
      return { notice: { level: "error", text: `Could not read processes: ${errorText(error)}` } };
    }
  },
};

export const worktreesCommand: Command = {
  name: "worktrees",
  summary: "isolated worktrees agents are working in",
  usage: "[show <id>|remove <id>]",
  category: "work",
  subcommands: ["show", "remove"],
  async run(args, ctx) {
    if (!ctx.backend.listWorktrees) return unavailable("Worktrees");
    try {
      if (args.sub === "show") {
        if (!args.rest) return { notice: { level: "warn", text: "Usage: /worktrees show <id>" } };
        if (!ctx.backend.inspectWorktree) return unavailable("Worktree inspection");
        const detail = await ctx.backend.inspectWorktree(args.rest);
        return {
          report: report(`Worktree ${shortId(detail.id)}`)
            .fields([
              { label: "Branch", value: detail.branch },
              { label: "Path", value: detail.path },
              { label: "Base", value: detail.baseRef },
              { label: "Status", value: detail.status },
              { label: "On disk", value: detail.exists ? "yes" : "no" },
              { label: "Dirty", value: detail.dirty ? summarizeList(detail.dirtyFiles, 5) : "clean" },
            ])
            .list(detail.aheadCommits.map((commit) => ({ text: `${commit.hash.slice(0, 7)} ${commit.subject}`, marker: "·" })))
            .build(),
        };
      }
      if (args.sub === "remove") {
        if (!args.rest) return { notice: { level: "warn", text: "Usage: /worktrees remove <id>" } };
        if (!ctx.backend.removeWorktree) return unavailable("Removing a worktree");
        await ctx.backend.removeWorktree(args.rest);
        return { notice: { level: "info", text: `Worktree ${shortId(args.rest)} removed.` } };
      }
      const worktrees = await ctx.backend.listWorktrees();
      if (worktrees.length === 0) return { notice: { level: "info", text: "No agent worktrees." } };
      return {
        report: report("Worktrees")
          .table(
            ["Status", "Branch", "Id", "Created"],
            worktrees.map((entry) => [entry.status, entry.branch, shortId(entry.id), relativeTime(entry.createdAt)]),
          )
          .hint("/worktrees show <id> · /integrate check <id>")
          .build(),
      };
    } catch (error) {
      return { notice: { level: "error", text: `Worktree command failed: ${errorText(error)}` } };
    }
  },
};

export const integrateCommand: Command = {
  name: "integrate",
  summary: "review and apply a worktree's branch",
  usage: "[list|check <worktree-id>|apply <attempt-id>]",
  category: "work",
  subcommands: ["list", "check", "apply"],
  async run(args, ctx) {
    if (!ctx.backend.listIntegrations) return unavailable("Integrations");
    try {
      if (args.sub === "check") {
        if (!args.rest) return { notice: { level: "warn", text: "Usage: /integrate check <worktree-id>" } };
        if (!ctx.backend.checkIntegration) return unavailable("Integration checks");
        const attempt = await ctx.backend.checkIntegration(args.rest);
        {
          const builder = report("Integration check")
            .tone(attempt.status === "conflicted" ? "warning" : "normal")
            .fields([
              { label: "Attempt", value: shortId(attempt.id) },
              { label: "Source", value: attempt.sourceBranch },
              { label: "Target", value: attempt.targetBranch },
              { label: "Status", value: attempt.status },
              { label: "Conflicts", value: attempt.conflictedFiles.length > 0 ? summarizeList(attempt.conflictedFiles, 5) : null },
            ]);
          if (attempt.status === "clean") builder.hint(`/integrate apply ${shortId(attempt.id)}`);
          return { report: builder.build() };
        };
      }
      if (args.sub === "apply") {
        if (!args.rest) return { notice: { level: "warn", text: "Usage: /integrate apply <attempt-id>" } };
        if (!ctx.backend.applyIntegration) return unavailable("Applying an integration");
        const attempt = await ctx.backend.applyIntegration(args.rest);
        return {
          notice: {
            level: attempt.status === "applied" ? "info" : "warn",
            text: `Integration ${shortId(attempt.id)}: ${attempt.status}${attempt.errorDetail ? ` — ${attempt.errorDetail}` : ""}`,
          },
        };
      }
      const attempts = await ctx.backend.listIntegrations();
      if (attempts.length === 0) return { notice: { level: "info", text: "No integration attempts." } };
      return {
        report: report("Integrations")
          .table(
            ["Status", "Source", "Target", "Id", "When"],
            attempts.map((entry) => [
              entry.status,
              entry.sourceBranch,
              entry.targetBranch,
              shortId(entry.id),
              relativeTime(entry.createdAt),
            ]),
            attempts.map((entry) => (entry.status === "conflicted" || entry.status === "failed" ? "danger" : undefined)),
          )
          .build(),
      };
    } catch (error) {
      return { notice: { level: "error", text: `Integration command failed: ${errorText(error)}` } };
    }
  },
};

export const retryCommand: Command = {
  name: "retry",
  summary: "run the last task again",
  category: "work",
  details: "Re-submits the previous task's input as a new task. The original task and its record are left alone.",
  async run(_args, ctx) {
    const taskId = ctx.lastTaskId();
    if (!taskId) return { notice: { level: "info", text: "No task in this session to retry." } };
    if (ctx.activeTaskId()) return { notice: { level: "warn", text: "Something is already running — stop it first." } };
    if (!ctx.backend.retryTask) return unavailable("Retry");
    try {
      const result = await ctx.backend.retryTask(taskId);
      return { notice: { level: "info", text: `Retrying — task ${shortId(result.taskId)}.` } };
    } catch (error) {
      return { notice: { level: "error", text: `Could not retry: ${errorText(error)}` } };
    }
  },
};

export const WORK_COMMANDS: Command[] = [
  statusCommand,
  contextCommand,
  costCommand,
  tasksCommand,
  outputCommand,
  diffCommand,
  undoCommand,
  changesCommand,
  searchCommand,
  checkpointCommand,
  processesCommand,
  worktreesCommand,
  integrateCommand,
  retryCommand,
];

export { formatElapsed };
