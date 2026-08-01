export interface NormalizedLegacyToolCall {
  name: string;
  arguments: string;
}

export interface NormalizedLegacyToolResponse {
  text: string;
  toolCalls: NormalizedLegacyToolCall[];
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function scalar(value: string): string | number | boolean {
  const decoded = decodeXml(value.trim());
  if (decoded === "true") return true;
  if (decoded === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(decoded)) return Number(decoded);
  return decoded;
}

/**
 * Some OpenAI-compatible routes occasionally return XML-shaped tool calls as
 * assistant text. Normalize only trailing, exposed tool blocks. Execution still
 * passes through normal schema, permission, approval, and containment checks.
 */
export function normalizeTrailingLegacyToolCalls(
  text: string,
  exposedToolNames: ReadonlySet<string>,
): NormalizedLegacyToolResponse | null {
  const toolPattern = /<([a-zA-Z][\w-]*)>\s*([\s\S]*?)\s*<\/\1>/g;
  const matches = [...text.matchAll(toolPattern)].filter((match) => exposedToolNames.has(match[1]!));
  if (matches.length === 0) return null;

  const last = matches.at(-1)!;
  if (text.slice((last.index ?? 0) + last[0].length).trim() !== "") return null;

  const calls: NormalizedLegacyToolCall[] = [];
  for (const match of matches) {
    const body = match[2] ?? "";
    const args: Record<string, string | number | boolean> = {};
    const argPattern = /<([a-zA-Z][\w-]*)>([\s\S]*?)<\/\1>/g;
    for (const arg of body.matchAll(argPattern)) {
      args[arg[1]!] = scalar(arg[2] ?? "");
    }
    if (Object.keys(args).length === 0) return null;
    calls.push({ name: match[1]!, arguments: JSON.stringify(args) });
  }

  return {
    text: text.slice(0, matches[0]!.index ?? 0).trimEnd(),
    toolCalls: calls,
  };
}
