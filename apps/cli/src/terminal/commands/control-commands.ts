/**
 * Safety, permission and run-control commands.
 *
 * The rule here is disclosure: every one of these tells the truth about what
 * Morrow is allowed to do and what it just did. `/yolo` in particular states
 * its own limits rather than claiming unlimited autonomy, because a mode that
 * over-promises is a mode nobody can safely leave on.
 */
import { yoloPolicyText, yoloStatusText } from "../yolo.js";
import { report } from "../report.js";
import { errorText, relativeTime, shortId } from "./format.js";
import type { Command, CommandResult } from "./registry.js";

const unavailable = (what: string): CommandResult => ({
  notice: { level: "warn", text: `${what} is not available from this session.` },
});

export const toolsCommand: Command = {
  name: "tools",
  summary: "tools the agent can call, and what each may touch",
  category: "safety",
  async run(_args, ctx) {
    if (!ctx.backend.listTools) return unavailable("Tool catalogue");
    try {
      const tools = await ctx.backend.listTools();
      if (tools.length === 0) return { notice: { level: "info", text: "No tools are registered." } };
      const enabled = tools.filter((tool) => tool.enabled);
      return {
        report: report("Tools")
          .subtitle(`${enabled.length} enabled of ${tools.length}`)
          .table(
            ["", "Tool", "Effect", "What it does"],
            tools.map((tool) => [
              tool.enabled ? "●" : "○",
              tool.name,
              tool.sideEffect,
              tool.description.replace(/\s+/g, " ").slice(0, 70),
            ]),
            tools.map((tool) =>
              !tool.enabled ? "muted" : tool.sideEffect === "read-only" ? undefined : ("warning" as const),
            ),
          )
          .hint("/permissions shows the boundaries these run inside")
          .build(),
      };
    } catch (error) {
      return { notice: { level: "error", text: `Could not read the tool catalogue: ${errorText(error)}` } };
    }
  },
};

export const permissionsCommand: Command = {
  name: "permissions",
  summary: "what Morrow may read, write and run",
  category: "safety",
  async run(_args, ctx) {
    if (!ctx.backend.permissions) return unavailable("Permissions");
    try {
      const profile = await ctx.backend.permissions();
      return {
        report: report("Permissions")
          .subtitle(`mode ${ctx.settings.mode}${ctx.settings.autoApprove ? " · auto-approve on" : ""}`)
          .fields([
            { label: "Workspace", value: ctx.session.workspacePath },
            { label: "Filesystem", value: profile.filesystemAccess },
            { label: "Write access", value: profile.writeAccess ? "yes" : "no", tone: profile.writeAccess ? "warning" : "success" },
            { label: "Shell execution", value: profile.shellExecution ? "yes" : "no", tone: profile.shellExecution ? "warning" : "success" },
            { label: "Network", value: profile.networkAccess },
            { label: "Tool profile", value: profile.defaultToolProfile },
            {
              label: "Approvals",
              value: ctx.settings.autoApprove
                ? "auto-approved in-workspace (YOLO) — every decision is still recorded"
                : "commands and patches require your approval",
            },
          ])
          .heading("Never permitted")
          .list([
            ...profile.deniedPathRules.slice(0, 8).map((rule) => ({ text: rule, marker: "✕", tone: "danger" as const })),
            ...profile.deniedNamePatterns.slice(0, 8).map((rule) => ({ text: rule, marker: "✕", tone: "danger" as const })),
          ])
          .heading("Limits")
          .fields([
            { label: "Max file size", value: `${Math.round(profile.limits.maxFileBytes / 1024)} KB` },
            { label: "Max inspect results", value: String(profile.limits.maxInspectResults) },
            { label: "Max inspect depth", value: String(profile.limits.maxInspectDepth) },
          ])
          .build(),
      };
    } catch (error) {
      return { notice: { level: "error", text: `Could not read permissions: ${errorText(error)}` } };
    }
  },
};

export const yoloCommand: Command = {
  name: "yolo",
  summary: "auto-approve in-workspace edits and commands",
  usage: "[on|off|status|policy]",
  category: "safety",
  subcommands: ["on", "off", "status", "policy"],
  details: "Only meaningful in Build mode. Every auto-approved action is still recorded in the audit log.",
  complete: (prefix) => ["on", "off", "status", "policy"].filter((value) => value.startsWith(prefix)),
  run(args, ctx) {
    if (args.sub === "policy") {
      return { report: report("YOLO policy").text(yoloPolicyText()).build() };
    }
    if (args.sub === "status") {
      return { notice: { level: ctx.settings.autoApprove ? "warn" : "info", text: yoloStatusText(ctx.settings.autoApprove) } };
    }
    if (ctx.settings.mode !== "agent") {
      return { notice: { level: "warn", text: "YOLO only applies in Build mode. Run /mode build first." } };
    }
    if (args.sub && args.sub !== "on" && args.sub !== "off") {
      return { notice: { level: "warn", text: "Usage: /yolo [on|off|status|policy]" } };
    }
    ctx.settings.autoApprove = args.sub === "on" ? true : args.sub === "off" ? false : !ctx.settings.autoApprove;
    return {
      notice: { level: ctx.settings.autoApprove ? "warn" : "info", text: yoloStatusText(ctx.settings.autoApprove) },
    };
  },
};

export const stopCommand: Command = {
  name: "stop",
  aliases: ["cancel"],
  summary: "cancel the running task",
  category: "safety",
  details: "Same as Ctrl+C while work is in flight. Anything already applied stays applied — use /undo to roll it back.",
  run(_args, ctx) {
    if (!ctx.interrupt()) return { notice: { level: "info", text: "Nothing is running." } };
    return { notice: { level: "warn", text: "Stopping. Completed work is preserved; /undo rolls back file changes." } };
  },
};

export const panicCommand: Command = {
  name: "panic",
  summary: "cancel everything and disable auto-approval",
  category: "safety",
  run(_args, ctx) {
    const wasRunning = ctx.interrupt();
    const wasAuto = ctx.settings.autoApprove;
    ctx.settings.autoApprove = false;
    return {
      notice: {
        level: "warn",
        text: `Panic stop.${wasRunning ? " Running task cancelled." : ""}${wasAuto ? " Auto-approval disabled." : ""}`,
      },
    };
  },
};

export const continueCommand: Command = {
  name: "continue",
  summary: "resume the last interrupted task",
  category: "safety",
  async run(_args, ctx) {
    if (ctx.activeTaskId()) return { notice: { level: "warn", text: "Something is already running." } };
    const taskId = ctx.lastTaskId();
    if (!taskId) return { notice: { level: "info", text: "No task in this session to resume." } };
    try {
      await ctx.backend.resume(taskId);
      return { notice: { level: "info", text: `Resuming task ${shortId(taskId)}.` } };
    } catch (error) {
      return { notice: { level: "error", text: `Could not resume: ${errorText(error)}` } };
    }
  },
};

export const auditCommand: Command = {
  name: "audit",
  summary: "recent recorded actions and their provenance",
  usage: "[limit]",
  category: "safety",
  async run(args, ctx) {
    if (!ctx.backend.audit) return unavailable("Audit log");
    try {
      const limit = Number.parseInt(args.sub, 10);
      const entries = await ctx.backend.audit(Number.isFinite(limit) && limit > 0 ? limit : 20);
      if (entries.length === 0) return { notice: { level: "info", text: "No audit entries yet." } };
      return {
        report: report("Audit")
          .subtitle(`${entries.length} most recent`)
          .table(
            ["Status", "Kind", "Route", "Tools", "When"],
            entries.map((entry) => [
              entry.status,
              entry.kind,
              entry.provider && entry.model ? `${entry.provider}/${entry.model}` : "—",
              String(entry.toolCalls),
              relativeTime(entry.createdAt),
            ]),
            entries.map((entry) => (entry.status === "failed" ? "danger" : undefined)),
          )
          .build(),
      };
    } catch (error) {
      return { notice: { level: "error", text: `Could not read the audit log: ${errorText(error)}` } };
    }
  },
};

export const CONTROL_COMMANDS: Command[] = [
  toolsCommand,
  permissionsCommand,
  yoloCommand,
  stopCommand,
  panicCommand,
  continueCommand,
  auditCommand,
];
