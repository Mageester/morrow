/**
 * Naming a conversation from its opening message.
 *
 * Every chat was created as "New Conversation" and stayed that way unless
 * someone renamed it by hand, so a sidebar of real work read as an identical
 * list with nothing to tell one entry from another. The first thing a person
 * asked for is the most reliable name available without involving a model — no
 * extra request, no token cost, no waiting, and no invented summary that might
 * describe the conversation wrongly.
 *
 * The rename applies only while the title is still the untouched default, so a
 * name someone chose is never overwritten.
 */

export const DEFAULT_CONVERSATION_TITLE = "New Conversation";

const MAX_TITLE_LENGTH = 60;

/** Fenced blocks, inline code, links, headings, list bullets, emphasis. */
function stripMarkdown(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1");
}

/**
 * Derives a conversation title from the opening message, or null when the
 * message offers nothing usable (an empty prompt, or one that is only a code
 * block). A null result leaves the default in place rather than inventing a
 * name the message does not support.
 */
export function deriveConversationTitle(content: string): string | null {
  const cleaned = stripMarkdown(content).replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return null;

  // Prefer ending on the first sentence when there is one close enough to read
  // as a title on its own.
  const sentence = /^(.{10,}?[.!?])(\s|$)/.exec(cleaned)?.[1];
  const candidate = sentence && sentence.length <= MAX_TITLE_LENGTH
    ? sentence.replace(/[.]$/, "")
    : cleaned;

  if (candidate.length <= MAX_TITLE_LENGTH) return candidate;

  // Otherwise cut at the last word boundary that fits, so a title never ends
  // mid-word.
  const clipped = candidate.slice(0, MAX_TITLE_LENGTH);
  const boundary = clipped.lastIndexOf(" ");
  const trimmed = (boundary > MAX_TITLE_LENGTH * 0.5 ? clipped.slice(0, boundary) : clipped).trimEnd();
  return `${trimmed}…`;
}

/** True when the stored title is still the untouched default. */
export function isDefaultConversationTitle(title: string): boolean {
  return title.trim().length === 0 || title.trim() === DEFAULT_CONVERSATION_TITLE;
}
