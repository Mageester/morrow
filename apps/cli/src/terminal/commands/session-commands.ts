/**
 * Session commands: starting, resuming, browsing and exporting a conversation.
 *
 * Every one of these acts on Morrow's durable conversation store through the
 * backend contract. None of them keeps a private CLI-side history file, which
 * is what the mission means by "sessions must use the durable state
 * architecture" — a crashed terminal loses the screen, never the work.
 */
import { report, type Report } from "../report.js";
import { errorText, relativeTime, shortId } from "./format.js";
import type { Command, CommandContext, CommandResult } from "./registry.js";

const unavailable = (what: string): CommandResult => ({
  notice: { level: "warn", text: `${what} is not available from this session.` },
});

export const helpCommand: Command = {
  name: "help",
  aliases: ["?"],
  summary: "list commands, or explain one",
  usage: "[command]",
  // Session, not "help": this is the entry point to the session's own surface,
  // and it has to lead the palette's browse order. The Help category is for
  // reference material (/shortcuts, /doctor), which nobody needs first.
  category: "session",
  complete: (prefix, ctx) => ctx.registry.names().filter((name) => name.startsWith(prefix)),
  run(args, ctx) {
    if (args.sub) {
      const command = ctx.registry.get(args.sub);
      if (!command) {
        const near = ctx.registry.suggest(args.sub);
        return {
          notice: {
            level: "warn",
            text: near.length > 0 ? `No /${args.sub}. Did you mean ${near.map((n) => `/${n}`).join(", ")}?` : `No /${args.sub}.`,
          },
        };
      }
      const builder = report(`/${command.name}${command.usage ? ` ${command.usage}` : ""}`)
        .subtitle(command.summary);
      if (command.details) builder.text(command.details);
      if (command.aliases?.length) builder.fields([{ label: "Aliases", value: command.aliases.map((a) => `/${a}`).join(", ") }]);
      if (command.subcommands?.length) {
        builder.fields([{ label: "Arguments", value: command.subcommands.join(" · ") }]);
      }
      return { report: builder.build() };
    }

    const builder = report("Commands").subtitle(`${ctx.registry.commands.length} available`);
    for (const category of ["session", "model", "work", "project", "safety", "help"] as const) {
      const commands = ctx.registry.inCategory(category);
      if (commands.length === 0) continue;
      builder.heading(CATEGORY_TITLES[category]);
      builder.list(
        commands.map((command) => ({
          text: `/${command.name}${command.usage ? ` ${command.usage}` : ""}`,
          detail: command.summary,
          marker: " ",
        })),
      );
    }
    builder.hint("/help <command> for detail · Ctrl+G for keyboard shortcuts");
    return { report: builder.build() };
  },
};

const CATEGORY_TITLES = {
  session: "Session",
  model: "Model & routing",
  work: "Work",
  project: "Project",
  safety: "Safety & control",
  help: "Help",
} as const;

export const newCommand: Command = {
  name: "new",
  summary: "start a fresh conversation",
  usage: "[title]",
  category: "session",
  details:
    "Opens a new durable conversation in this project. The previous one is kept and can be reopened with /resume.",
  async run(args, ctx) {
    if (!ctx.backend.newConversation) return unavailable("Starting a conversation");
    try {
      const conversation = await ctx.backend.newConversation(args.raw || undefined);
      ctx.clearScreen();
      return {
        notice: { level: "info", text: `New conversation — ${conversation.title}` },
      };
    } catch (error) {
      return { notice: { level: "error", text: `Could not start a conversation: ${errorText(error)}` } };
    }
  },
};

export const sessionsCommand: Command = {
  name: "sessions",
  summary: "list recent conversations in this project",
  category: "session",
  async run(_args, ctx) {
    if (!ctx.backend.listConversations) return unavailable("Session history");
    try {
      const conversations = await ctx.backend.listConversations();
      if (conversations.length === 0) {
        return { notice: { level: "info", text: "No saved conversations yet." } };
      }
      const rows = conversations.slice(0, 20).map((conversation) => [
        conversation.id === ctx.session.conversationId ? "●" : " ",
        conversation.title,
        shortId(conversation.id),
        relativeTime(conversation.updatedAt),
      ]);
      return {
        report: report("Sessions")
          .subtitle(`${conversations.length} in ${ctx.session.projectName}`)
          .table(["", "Title", "Id", "Updated"], rows)
          .hint("/resume to switch")
          .build(),
      };
    } catch (error) {
      return { notice: { level: "error", text: `Could not list sessions: ${errorText(error)}` } };
    }
  },
};

export const resumeCommand: Command = {
  name: "resume",
  summary: "reopen a previous conversation",
  usage: "[id]",
  category: "session",
  details: "With no argument, opens a picker over recent conversations. Given an id, switches straight to it.",
  async complete(prefix, ctx) {
    if (!ctx.backend.listConversations) return [];
    const conversations = await ctx.backend.listConversations().catch(() => []);
    return conversations.map((conversation) => conversation.id).filter((id) => id.startsWith(prefix));
  },
  async run(args, ctx) {
    if (!ctx.backend.listConversations || !ctx.backend.switchConversation) return unavailable("Resume");
    let conversations;
    try {
      conversations = await ctx.backend.listConversations();
    } catch (error) {
      return { notice: { level: "error", text: `Could not list sessions: ${errorText(error)}` } };
    }
    if (conversations.length === 0) return { notice: { level: "info", text: "No saved conversations to resume." } };

    const switchTo = async (id: string): Promise<CommandResult> => {
      try {
        const conversation = await ctx.backend.switchConversation!(id);
        ctx.clearScreen();
        return { notice: { level: "info", text: `Resumed — ${conversation.title}` } };
      } catch (error) {
        return { notice: { level: "error", text: `Could not resume: ${errorText(error)}` } };
      }
    };

    if (args.sub) {
      const match =
        conversations.find((conversation) => conversation.id === args.sub) ??
        conversations.find((conversation) => conversation.id.startsWith(args.sub));
      if (!match) {
        return { notice: { level: "warn", text: `No conversation matching "${args.sub}".` } };
      }
      return switchTo(match.id);
    }

    ctx.overlays.set({
      kind: "select",
      title: "Resume a conversation",
      items: conversations.slice(0, 50).map((conversation) => ({
        id: conversation.id,
        label: conversation.title,
        hint: `${shortId(conversation.id)}  ${relativeTime(conversation.updatedAt)}`,
        current: conversation.id === ctx.session.conversationId,
      })),
      onChoose: (id) => {
        if (id) void switchTo(id).then((result) => result.notice && ctx.emit({ type: "notice", ...result.notice }));
      },
    });
    return { deferred: true };
  },
};

export const historyCommand: Command = {
  name: "history",
  summary: "show this conversation's saved messages",
  usage: "[limit]",
  category: "session",
  async run(args, ctx) {
    if (!ctx.backend.listMessages) return unavailable("History");
    try {
      const messages = await ctx.backend.listMessages();
      if (messages.length === 0) return { notice: { level: "info", text: "This conversation has no saved messages yet." } };
      const limit = Number.parseInt(args.sub, 10);
      const kept = Number.isFinite(limit) && limit > 0 ? messages.slice(-limit) : messages.slice(-30);
      const builder = report("History").subtitle(
        kept.length === messages.length ? `${messages.length} messages` : `last ${kept.length} of ${messages.length}`,
      );
      for (const message of kept) {
        builder.list([
          {
            text: message.role === "user" ? "you" : "morrow",
            tone: message.role === "user" ? "accent" : "muted",
            marker: " ",
            detail: relativeTime(message.createdAt),
          },
        ]);
        builder.text(oneScreen(message.content), message.role === "user" ? "normal" : "muted");
      }
      return { report: builder.build() };
    } catch (error) {
      return { notice: { level: "error", text: `Could not read history: ${errorText(error)}` } };
    }
  },
};

/** Trim a stored message to something that belongs in a scrollback panel. */
function oneScreen(text: string, lines = 6): string {
  const rows = text.split("\n");
  if (rows.length <= lines) return text;
  return [...rows.slice(0, lines), `… ${rows.length - lines} more lines`].join("\n");
}

export const compactCommand: Command = {
  name: "compact",
  summary: "summarise history into a continuation note",
  category: "session",
  details:
    "Writes a deterministic summary of the conversation so far and continues from it. No model request is made to produce the summary.",
  async run(_args, ctx) {
    if (!ctx.backend.compact) return unavailable("Compaction");
    try {
      const result = await ctx.backend.compact(ctx.lastTaskId(), { ...ctx.settings });
      if (!result.compacted) {
        return { notice: { level: "info", text: "Nothing to compact yet." } };
      }
      return {
        report: report("Context compacted")
          .fields([
            { label: "Source messages", value: String(result.summary.sourceMessageCount) },
            { label: "Method", value: result.summary.method },
            { label: "Route", value: `${result.routing.provider}/${result.routing.model}` },
            { label: "Privacy", value: result.routing.privacy },
          ])
          .hint("No model request was made to produce this summary.")
          .build(),
      };
    } catch (error) {
      return { notice: { level: "error", text: `Could not compact context: ${errorText(error)}` } };
    }
  },
};

export const exportCommand: Command = {
  name: "export",
  summary: "write a sanitised report of the last task to a file",
  usage: "[filename]",
  category: "session",
  async run(args, ctx) {
    const taskId = ctx.lastTaskId();
    if (!taskId) return { notice: { level: "info", text: "No task in this session to export yet." } };
    if (!ctx.backend.exportReport) return unavailable("Export");
    try {
      const answer = ctx.backend.getFinalAnswer ? await ctx.backend.getFinalAnswer(taskId).catch(() => null) : null;
      const path = await ctx.backend.exportReport(taskId, "full", answer, args.raw || undefined);
      return { notice: { level: "info", text: `Exported to ${path}` } };
    } catch (error) {
      return { notice: { level: "error", text: `Could not export: ${errorText(error)}` } };
    }
  },
};

export const clearCommand: Command = {
  name: "clear",
  summary: "clear the screen",
  category: "session",
  details:
    "Clears the terminal. The saved conversation and the model's context are untouched — use /compact to shorten what the model is sent.",
  run(_args, ctx) {
    ctx.clearScreen();
    return {};
  },
};

export const exitCommand: Command = {
  name: "exit",
  aliases: ["quit"],
  summary: "leave Morrow",
  category: "session",
  run(_args, ctx) {
    ctx.exit();
    return {};
  },
};

export function conversationReport(title: string, lines: string[]): Report {
  return report(title).text(lines.join("\n")).build();
}

export const SESSION_COMMANDS: Command[] = [
  helpCommand,
  newCommand,
  sessionsCommand,
  resumeCommand,
  historyCommand,
  compactCommand,
  exportCommand,
  clearCommand,
  exitCommand,
];
