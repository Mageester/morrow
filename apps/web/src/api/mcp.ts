import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { api } from "./client.js";

export const McpServerConfigSchema = z.object({
  transport: z.enum(["stdio", "sse"]).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  disabled: z.boolean().optional(),
  allowedTools: z.array(z.string()).optional(),
  permissions: z.object({
    autoApprove: z.array(z.string()).optional(),
    requireApproval: z.array(z.string()).optional(),
  }).optional(),
}).passthrough();

export const McpServerItemSchema = z.object({
  id: z.string(),
  config: McpServerConfigSchema,
  trusted: z.boolean(),
});

export const McpToolSchema = z.object({
  namespacedName: z.string(),
  serverId: z.string(),
  rawName: z.string(),
  description: z.string().optional(),
  inputSchema: z.any().optional(),
  autoApprove: z.boolean(),
});

export const McpTestResultSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number(),
  tools: z.array(z.object({
    name: z.string(),
    description: z.string().optional(),
    inputSchema: z.any().optional(),
  })),
  resources: z.array(z.object({
    uri: z.string(),
    name: z.string(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
  })),
  error: z.string().optional(),
});

export type McpServerItem = z.infer<typeof McpServerItemSchema>;
export type McpTool = z.infer<typeof McpToolSchema>;
export type McpTestResult = z.infer<typeof McpTestResultSchema>;

export const mcpQueries = {
  servers(projectId?: string) {
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    return queryOptions({
      queryKey: ["mcp", "servers", projectId ?? "global"] as const,
      queryFn: () => api.get(`/api/mcp/servers${qs}`, z.object({ servers: z.array(McpServerItemSchema) })),
    });
  },
  tools(projectId?: string) {
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    return queryOptions({
      queryKey: ["mcp", "tools", projectId ?? "global"] as const,
      queryFn: () => api.get(`/api/mcp/tools${qs}`, z.object({ tools: z.array(McpToolSchema) })),
    });
  },
};

export const mcpApi = {
  createServer(id: string, config: unknown) {
    return api.post("/api/mcp/servers", { id, config }, z.object({ ok: z.boolean(), id: z.string() }));
  },
  deleteServer(id: string) {
    return api.delete(`/api/mcp/servers/${encodeURIComponent(id)}`, z.object({ ok: z.boolean() }));
  },
  trustServer(id: string, config?: unknown) {
    return api.post(`/api/mcp/trust/${encodeURIComponent(id)}`, { config }, z.object({ ok: z.boolean(), trusted: z.boolean() }));
  },
  testServer(serverId: string, config: unknown) {
    return api.post("/api/mcp/test", { serverId, config }, McpTestResultSchema);
  },
  updateToolPermission(serverId: string, toolName: string, policy: "always_allow" | "require_approval" | "deny") {
    return api.put(`/api/mcp/permissions/${encodeURIComponent(serverId)}/${encodeURIComponent(toolName)}`, { policy }, z.object({ ok: z.boolean() }));
  },
};
