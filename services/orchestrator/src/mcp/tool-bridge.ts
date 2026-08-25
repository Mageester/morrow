import type { ToolDefinition } from "../provider/base.js";
import type { McpTool, McpResourceContent } from "./client.js";
import type { McpPool } from "./pool.js";
import type { McpServerConfig } from "./config.js";

export function isMcpTool(name: string): boolean {
  return name.startsWith("mcp__") || name === "read_mcp_resource";
}

export function getReadMcpResourceToolDefinition(): ToolDefinition {
  return {
    name: "read_mcp_resource",
    description: "Read the direct contents of a resource URI from a configured MCP server (e.g. database schema, documentation, or application memory).",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "The MCP server name (e.g. 'sqlite', 'github', 'memo')" },
        uri: { type: "string", description: "The resource URI to read (e.g. 'memo://notes/1', 'file:///data.json')" },
      },
      required: ["server", "uri"],
    },
  };
}

export function buildMcpToolDefinitions(
  mcpTools: Map<string, { serverId: string; tool: McpTool; rawName: string }>
): ToolDefinition[] {
  const definitions: ToolDefinition[] = [];

  for (const [namespacedName, { serverId, tool }] of mcpTools.entries()) {
    const inputSchema = tool.inputSchema && typeof tool.inputSchema === "object"
      ? (tool.inputSchema as { type?: string; properties?: Record<string, any>; required?: string[] })
      : { type: "object", properties: {} };

    const parameters: { type: "object"; properties: Record<string, any>; required?: string[] } = {
      type: "object",
      properties: inputSchema.properties ?? {},
    };
    if (inputSchema.required) {
      parameters.required = inputSchema.required;
    }

    definitions.push({
      name: namespacedName,
      description: `[MCP: ${serverId}] ${tool.description || tool.name}`,
      parameters,
    });
  }

  return definitions;
}

export function formatMcpResult(result: unknown): string {
  if (result === null || result === undefined) return "(no output)";
  if (typeof result === "string") return result;

  if (typeof result === "object") {
    const res = result as Record<string, any>;
    if (Array.isArray(res.content)) {
      const parts = res.content.map((item: any) => {
        if (typeof item === "string") return item;
        if (item.type === "text" && typeof item.text === "string") return item.text;
        if (item.type === "resource" && item.resource) {
          return `[Resource: ${item.resource.uri}]\n${item.resource.text ?? "(binary)"}`;
        }
        return JSON.stringify(item);
      });
      return parts.join("\n\n");
    }
  }

  return JSON.stringify(result, null, 2);
}

export async function executeMcpTool(
  name: string,
  args: unknown,
  pool: McpPool,
  configs: Record<string, McpServerConfig>,
  signal?: AbortSignal,
): Promise<{ content: string; isError?: boolean }> {
  let onAbort: (() => void) | undefined;
  try {
    if (signal?.aborted) throw new Error("AbortError");
    // `signal` is the task's, not this call's: the agent builds one per task
    // and hands the same instance to every tool call it makes. `{ once: true }`
    // only unregisters on an abort that fires — on the normal path it never
    // does, so a listener per MCP tool call stayed on that signal for the life
    // of the task. Detached in the finally below instead.
    const abort = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("AbortError"));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    const run = async () => {
    if (name === "read_mcp_resource") {
      const parsed = (args && typeof args === "object" ? args : {}) as { server?: string; uri?: string };
      if (!parsed.server || !parsed.uri) {
        return {
          content: "MCP tool error: both 'server' and 'uri' arguments are required for read_mcp_resource.",
          isError: true,
        };
      }
      const res = await pool.readResource(parsed.server, parsed.uri, configs, signal);
      if (!res.contents || res.contents.length === 0) {
        return { content: `Resource "${parsed.uri}" is empty or not found.` };
      }
      const formatted = res.contents
        .map((c) => `[URI: ${c.uri}${c.mimeType ? ` (${c.mimeType})` : ""}]\n${c.text ?? (c.blob ? `[Binary blob: ${c.blob.length} bytes]` : "")}`)
        .join("\n\n");
      return { content: formatted, isError: false };
    }

    const rawResult = await pool.callNamespacedTool(name, args, configs, signal);
    return { content: formatMcpResult(rawResult), isError: false };
    };
    return await Promise.race([run(), abort]);
  } catch (err: any) {
    return {
      content: `MCP tool error: ${err?.message ?? String(err)}`,
      isError: true,
    };
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}
