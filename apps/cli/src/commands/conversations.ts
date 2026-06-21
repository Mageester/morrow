import { writeFileSync } from "node:fs";
import type { Context } from "../cli/context.js";
import type { MorrowApi } from "../client/api.js";
import { ensureRunning } from "../service/lifecycle.js";
import { resolveProject, shortId, relativeTime } from "./common.js";
import { statusColor } from "./projects.js";
import { renderMarkdown } from "../cli/markdown.js";
import { flagString, flagBool } from "../cli/args.js";
import { usageError, EXIT } from "../cli/errors.js";

export async function conversationsCommand(ctx: Context, sub: string, args: string[]): Promise<number> {
  await ensureRunning(ctx);
  const api = ctx.api();
  switch (sub) {
    case undefined:
    case "list":
      return list(ctx, api);
    case "show":
      return show(ctx, api, args);
    case "rename":
      return rename(ctx, api, args);
    case "archive":
      return archive(ctx, api, args);
    case "export":
      return exportCmd(ctx, api, args);
    default:
      throw usageError(`Unknown conversations subcommand: ${sub}`, "Try: list, show, rename, archive, export");
  }
}

async function list(ctx: Context, api: MorrowApi): Promise<number> {
  const project = await resolveProject(ctx, api, { required: true });
  if (!project) return EXIT.NOT_FOUND;
  const includeArchived = flagBool(ctx.flags, "all") || flagBool(ctx.flags, "archived");
  const conversations = await api.listConversations(project.id, includeArchived);
  if (ctx.out.json) {
    ctx.out.data(conversations);
    return EXIT.OK;
  }
  if (conversations.length === 0) {
    ctx.out.info("No conversations yet. Start one with `morrow chat`.");
    return EXIT.OK;
  }
  ctx.out.heading(`Conversations — ${project.name}`);
  ctx.out.table(
    ["id", "title", "updated", ""],
    conversations.map((c) => [ctx.out.cyan(shortId(c.id)), c.title, ctx.out.gray(relativeTime(c.updatedAt)), c.archived ? ctx.out.gray("archived") : ""])
  );
  return EXIT.OK;
}

async function show(ctx: Context, api: MorrowApi, args: string[]): Promise<number> {
  const id = args[0];
  if (!id) throw usageError("Usage: morrow conversations show <id>");
  const conversation = await api.getConversation(id);
  const messages = await api.listMessages(id);
  if (ctx.out.json) {
    ctx.out.data({ conversation, messages });
    return EXIT.OK;
  }
  ctx.out.heading(`${conversation.title} (${shortId(conversation.id)})`);
  for (const m of messages) {
    if (m.role === "user") {
      ctx.out.print(ctx.out.green("you › ") + m.content);
    } else {
      const meta = ctx.out.gray(`morrow${m.provider ? ` · ${m.provider}` : ""}${m.model ? ` · ${m.model}` : ""}${m.streamingState !== "completed" ? ` · ${m.streamingState}` : ""} › `);
      ctx.out.print(meta + renderMarkdown(m.content, ctx.out));
    }
    ctx.out.print();
  }
  return EXIT.OK;
}

async function rename(ctx: Context, api: MorrowApi, args: string[]): Promise<number> {
  const id = args[0];
  const title = args.slice(1).join(" ") || flagString(ctx.flags, "title");
  if (!id || !title) throw usageError('Usage: morrow conversations rename <id> "New title"');
  const updated = await api.updateConversation(id, { title });
  ctx.out.success(`Renamed to "${updated.title}".`);
  if (ctx.out.json) ctx.out.data(updated);
  return EXIT.OK;
}

async function archive(ctx: Context, api: MorrowApi, args: string[]): Promise<number> {
  const id = args[0];
  if (!id) throw usageError("Usage: morrow conversations archive <id> [--unarchive]");
  const unarchive = flagBool(ctx.flags, "unarchive");
  const updated = await api.updateConversation(id, { archived: !unarchive });
  ctx.out.success(`${unarchive ? "Unarchived" : "Archived"} "${updated.title}".`);
  if (ctx.out.json) ctx.out.data(updated);
  return EXIT.OK;
}

async function exportCmd(ctx: Context, api: MorrowApi, args: string[]): Promise<number> {
  const id = args[0];
  if (!id) throw usageError("Usage: morrow conversations export <id> [--out file] [--format text|json|md]");
  const format = flagString(ctx.flags, "format") ?? "md";
  const conversation = await api.getConversation(id);
  const messages = await api.listMessages(id);
  let content: string;
  if (format === "json") {
    content = JSON.stringify({ conversation, messages }, null, 2);
  } else {
    content = renderExport(conversation.title, messages, format === "text");
  }
  const outFile = flagString(ctx.flags, "out");
  if (outFile) {
    writeFileSync(outFile, content);
    ctx.out.success(`Exported ${messages.length} messages to ${outFile}.`);
  } else if (ctx.out.json) {
    ctx.out.data({ conversation, messages });
  } else {
    ctx.out.print(content);
  }
  return EXIT.OK;
}

function renderExport(title: string, messages: Array<{ role: string; content: string; provider?: string | null | undefined; model?: string | null | undefined; createdAt: string; streamingState: string }>, plain: boolean): string {
  const lines: string[] = [];
  lines.push(plain ? `${title}` : `# ${title}`);
  lines.push("");
  for (const m of messages) {
    const who = m.role === "user" ? "User" : `Morrow${m.provider ? ` (${m.provider}/${m.model})` : ""}`;
    lines.push(plain ? `${who}:` : `## ${who}`);
    if (m.streamingState !== "completed") lines.push(`_[${m.streamingState}]_`);
    lines.push(m.content);
    lines.push("");
  }
  return lines.join("\n");
}

/** Used by the chat REPL `/export` command. */
export async function exportConversationToText(api: MorrowApi, conversationId: string): Promise<string> {
  const conversation = await api.getConversation(conversationId);
  const messages = await api.listMessages(conversationId);
  return renderExport(conversation.title, messages, false);
}
