import { Button } from "@morrow/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  CircleAlert,
  Loader2,
  Network,
  Play,
  Plus,
  Radio,
  Shield,
  ShieldAlert,
  Trash2,
  Wrench,
} from "lucide-react";
import { useState } from "react";
import { mcpApi, mcpQueries, type McpServerItem, type McpTestResult } from "../../api/mcp.js";

const MCP_TEMPLATES = [
  {
    id: "github",
    name: "GitHub",
    transport: "sse" as const,
    url: "https://mcp.github.com/sse",
    description: "GitHub repositories, issues, and PR management over SSE",
  },
  {
    id: "sqlite",
    name: "SQLite",
    transport: "stdio" as const,
    command: "uvx",
    args: ["mcp-server-sqlite", "--db-path", "./app.db"],
    description: "Local SQLite database querying & schema inspection",
  },
  {
    id: "postgres",
    name: "PostgreSQL",
    transport: "stdio" as const,
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"],
    description: "PostgreSQL database queries and tables",
  },
  {
    id: "fetch",
    name: "Fetch",
    transport: "stdio" as const,
    command: "uvx",
    args: ["mcp-server-fetch"],
    description: "Web content fetch and conversion for agents",
  },
  {
    id: "brave",
    name: "Brave Search",
    transport: "stdio" as const,
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-brave-search"],
    description: "Brave Search web search intelligence API",
  },
];

export function McpSettingsSection() {
  const queryClient = useQueryClient();
  const serversQuery = useQuery(mcpQueries.servers());
  const toolsQuery = useQuery(mcpQueries.tools());

  const [customId, setCustomId] = useState("");
  const [customTransport, setCustomTransport] = useState<"stdio" | "sse">("stdio");
  const [customCommand, setCustomCommand] = useState("");
  const [customArgs, setCustomArgs] = useState("");
  const [customUrl, setCustomUrl] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);
  const [testResults, setTestResults] = useState<Record<string, McpTestResult>>({});
  const [testingServerId, setTestingServerId] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: ({ id, config }: { id: string; config: unknown }) => mcpApi.createServer(id, config),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["mcp"] });
      setShowAddForm(false);
      setCustomId("");
      setCustomCommand("");
      setCustomArgs("");
      setCustomUrl("");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => mcpApi.deleteServer(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["mcp"] }),
  });

  const trustMutation = useMutation({
    mutationFn: ({ id, config }: { id: string; config?: unknown }) => mcpApi.trustServer(id, config),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["mcp"] }),
  });

  const permissionMutation = useMutation({
    mutationFn: ({ serverId, toolName, policy }: { serverId: string; toolName: string; policy: "always_allow" | "require_approval" }) =>
      mcpApi.updateToolPermission(serverId, toolName, policy),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["mcp", "tools"] }),
  });

  async function runTest(server: McpServerItem) {
    setTestingServerId(server.id);
    try {
      const res = await mcpApi.testServer(server.id, server.config);
      setTestResults((prev) => ({ ...prev, [server.id]: res }));
    } catch (err: any) {
      setTestResults((prev) => ({
        ...prev,
        [server.id]: { ok: false, latencyMs: 0, tools: [], resources: [], error: err.message },
      }));
    } finally {
      setTestingServerId(null);
    }
  }

  function handleAddCustom() {
    if (!customId.trim()) return;
    const config =
      customTransport === "sse"
        ? { transport: "sse", url: customUrl.trim() }
        : {
            transport: "stdio",
            command: customCommand.trim(),
            args: customArgs.trim() ? customArgs.trim().split(/\s+/) : [],
          };
    createMutation.mutate({ id: customId.trim(), config });
  }

  function handleAddTemplate(tpl: (typeof MCP_TEMPLATES)[number]) {
    const config =
      tpl.transport === "sse"
        ? { transport: "sse", url: tpl.url }
        : { transport: "stdio", command: tpl.command, args: tpl.args };
    createMutation.mutate({ id: tpl.id, config });
  }

  const servers = serversQuery.data?.servers ?? [];
  const tools = toolsQuery.data?.tools ?? [];

  return (
    <article aria-labelledby="settings-mcp-heading" className="morrow-settings-page">
      <header className="morrow-settings-head">
        <h2 id="settings-mcp-heading">Model Context Protocol (MCP)</h2>
        <p>
          Connect external tool servers and data providers adhering to the open Model Context Protocol. Servers
          execute on-demand with configurable security approval boundaries.
        </p>
      </header>

      {/* 1-Click Templates */}
      <p className="morrow-settings-label">1-Click Starter Templates</p>
      <div className="morrow-setting-row morrow-setting-row--stacked">
        <div>
          <b>Quick-add popular MCP servers</b>
          <p>Instantly register curated MCP servers for databases, APIs, and web tools.</p>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "8px" }}>
          {MCP_TEMPLATES.map((tpl) => {
            const alreadyAdded = servers.some((s) => s.id === tpl.id);
            return (
              <Button
                disabled={alreadyAdded || createMutation.isPending}
                key={tpl.id}
                onClick={() => handleAddTemplate(tpl)}
                size="compact"
                variant={alreadyAdded ? "ghost" : "secondary"}
              >
                {alreadyAdded ? <Check size={14} /> : <Plus size={14} />}
                {tpl.name} ({tpl.transport})
              </Button>
            );
          })}
        </div>
      </div>

      {/* Configured Servers */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "24px" }}>
        <p className="morrow-settings-label" style={{ margin: 0 }}>
          Configured Servers ({servers.length})
        </p>
        <Button onClick={() => setShowAddForm(!showAddForm)} size="compact" variant="secondary">
          <Plus size={14} />
          {showAddForm ? "Cancel" : "Add Custom Server"}
        </Button>
      </div>

      {showAddForm ? (
        <div
          style={{
            border: "1px solid var(--border-subtle, #333)",
            borderRadius: "8px",
            padding: "16px",
            margin: "12px 0",
            backgroundColor: "var(--bg-subtle, rgba(255,255,255,0.02))",
          }}
        >
          <b>New MCP Server</b>
          <div style={{ display: "grid", gap: "12px", marginTop: "12px" }}>
            <div>
              <label style={{ display: "block", fontSize: "12px", marginBottom: "4px" }}>Server ID (Name)</label>
              <input
                onChange={(e) => setCustomId(e.target.value)}
                placeholder="e.g. my-database"
                style={{ width: "100%", padding: "6px 8px" }}
                value={customId}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: "12px", marginBottom: "4px" }}>Transport</label>
              <select
                onChange={(e) => setCustomTransport(e.target.value as "stdio" | "sse")}
                style={{ width: "100%", padding: "6px 8px" }}
                value={customTransport}
              >
                <option value="stdio">stdio (Local process executable)</option>
                <option value="sse">sse (Remote Server-Sent Events HTTP URL)</option>
              </select>
            </div>
            {customTransport === "stdio" ? (
              <>
                <div>
                  <label style={{ display: "block", fontSize: "12px", marginBottom: "4px" }}>Executable Command</label>
                  <input
                    onChange={(e) => setCustomCommand(e.target.value)}
                    placeholder="e.g. npx, uvx, node, python"
                    style={{ width: "100%", padding: "6px 8px" }}
                    value={customCommand}
                  />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: "12px", marginBottom: "4px" }}>Arguments (space separated)</label>
                  <input
                    onChange={(e) => setCustomArgs(e.target.value)}
                    placeholder="e.g. -y @modelcontextprotocol/server-sqlite --db-path ./db.sqlite"
                    style={{ width: "100%", padding: "6px 8px" }}
                    value={customArgs}
                  />
                </div>
              </>
            ) : (
              <div>
                <label style={{ display: "block", fontSize: "12px", marginBottom: "4px" }}>SSE Endpoint URL</label>
                <input
                  onChange={(e) => setCustomUrl(e.target.value)}
                  placeholder="https://mcp.example.com/sse"
                  style={{ width: "100%", padding: "6px 8px" }}
                  value={customUrl}
                />
              </div>
            )}
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end", marginTop: "8px" }}>
              <Button onClick={() => setShowAddForm(false)} size="compact" variant="ghost">
                Cancel
              </Button>
              <Button
                disabled={!customId.trim() || (customTransport === "stdio" ? !customCommand.trim() : !customUrl.trim()) || createMutation.isPending}
                onClick={handleAddCustom}
                size="compact"
              >
                Save & Trust Server
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {serversQuery.isPending ? (
        <p className="morrow-settings-status">Loading MCP servers…</p>
      ) : servers.length === 0 ? (
        <p className="morrow-settings-status">No MCP servers configured yet. Add one above.</p>
      ) : (
        <div style={{ display: "grid", gap: "12px", marginTop: "12px" }}>
          {servers.map((server) => {
            const test = testResults[server.id];
            const isTesting = testingServerId === server.id;
            const target =
              server.config.transport === "sse"
                ? server.config.url
                : `${server.config.command ?? ""} ${(server.config.args ?? []).join(" ")}`.trim();

            return (
              <div
                key={server.id}
                style={{
                  border: "1px solid var(--border-subtle, #333)",
                  borderRadius: "8px",
                  padding: "16px",
                  backgroundColor: "var(--bg-card, rgba(255,255,255,0.01))",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <b style={{ fontSize: "15px" }}>{server.id}</b>
                      <span
                        style={{
                          fontSize: "11px",
                          padding: "2px 6px",
                          borderRadius: "4px",
                          backgroundColor: "var(--bg-subtle, #222)",
                          textTransform: "uppercase",
                        }}
                      >
                        {server.config.transport ?? "stdio"}
                      </span>
                      {server.trusted ? (
                        <span style={{ fontSize: "11px", color: "var(--color-success, #4ade80)", display: "flex", alignItems: "center", gap: "4px" }}>
                          <Shield size={12} /> Trusted
                        </span>
                      ) : (
                        <span style={{ fontSize: "11px", color: "var(--color-warning, #facc15)", display: "flex", alignItems: "center", gap: "4px" }}>
                          <ShieldAlert size={12} /> Untrusted
                        </span>
                      )}
                    </div>
                    <code style={{ fontSize: "12px", color: "var(--text-muted, #888)", display: "block", marginTop: "4px" }}>
                      {target}
                    </code>
                  </div>
                  <div style={{ display: "flex", gap: "6px" }}>
                    {!server.trusted ? (
                      <Button
                        disabled={trustMutation.isPending}
                        onClick={() => trustMutation.mutate({ id: server.id, config: server.config })}
                        size="compact"
                        variant="secondary"
                      >
                        <Shield size={13} /> Trust
                      </Button>
                    ) : null}
                    <Button
                      disabled={isTesting}
                      onClick={() => runTest(server)}
                      size="compact"
                      variant="secondary"
                    >
                      {isTesting ? <Loader2 className="animate-spin" size={13} /> : <Play size={13} />}
                      Test Ping
                    </Button>
                    <Button
                      disabled={deleteMutation.isPending}
                      onClick={() => deleteMutation.mutate(server.id)}
                      size="compact"
                      variant="ghost"
                    >
                      <Trash2 size={13} />
                    </Button>
                  </div>
                </div>

                {/* Test Ping Results */}
                {test ? (
                  <div
                    style={{
                      marginTop: "12px",
                      padding: "10px",
                      borderRadius: "6px",
                      backgroundColor: test.ok ? "rgba(74, 222, 128, 0.08)" : "rgba(248, 113, 113, 0.08)",
                      border: `1px solid ${test.ok ? "rgba(74, 222, 128, 0.2)" : "rgba(248, 113, 113, 0.2)"}`,
                      fontSize: "12px",
                    }}
                  >
                    {test.ok ? (
                      <div>
                        <span style={{ color: "var(--color-success, #4ade80)", fontWeight: "bold" }}>
                          ✓ Connection OK ({test.latencyMs}ms)
                        </span>
                        <span style={{ marginLeft: "12px", color: "var(--text-muted, #aaa)" }}>
                          Discovered {test.tools.length} tool(s), {test.resources.length} resource(s)
                        </span>
                        {test.tools.length > 0 ? (
                          <div style={{ marginTop: "6px", display: "flex", flexWrap: "wrap", gap: "4px" }}>
                            {test.tools.map((t) => (
                              <code
                                key={t.name}
                                style={{
                                  padding: "2px 6px",
                                  borderRadius: "4px",
                                  backgroundColor: "rgba(0,0,0,0.3)",
                                  fontSize: "11px",
                                }}
                              >
                                {t.name}
                              </code>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <div style={{ color: "var(--color-error, #f87171)" }}>
                        <CircleAlert size={14} style={{ display: "inline", verticalAlign: "middle", marginRight: "4px" }} />
                        Connection failed: {test.error}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {/* Discovered Tools & Permission Overrides */}
      <p className="morrow-settings-label" style={{ marginTop: "32px" }}>
        Discovered MCP Tools & Approval Policies
      </p>
      {toolsQuery.isPending ? (
        <p className="morrow-settings-status">Discovering MCP tools…</p>
      ) : tools.length === 0 ? (
        <p className="morrow-settings-status">No MCP tools currently available. Ensure servers are reachable and trusted.</p>
      ) : (
        <div style={{ display: "grid", gap: "8px", marginTop: "12px" }}>
          {tools.map((tool) => (
            <div
              key={tool.namespacedName}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "10px 14px",
                border: "1px solid var(--border-subtle, #2a2a2a)",
                borderRadius: "6px",
              }}
            >
              <div>
                <code style={{ fontSize: "13px", fontWeight: "bold", color: "var(--color-cyan, #38bdf8)" }}>
                  {tool.namespacedName}
                </code>
                <p style={{ margin: "2px 0 0", fontSize: "12px", color: "var(--text-muted, #888)" }}>
                  {tool.description || "No description provided"}
                </p>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <span style={{ fontSize: "11px", color: tool.autoApprove ? "#4ade80" : "#facc15" }}>
                  {tool.autoApprove ? "Auto-allow" : "Require confirmation"}
                </span>
                <Button
                  disabled={permissionMutation.isPending}
                  onClick={() =>
                    permissionMutation.mutate({
                      serverId: tool.serverId,
                      toolName: tool.rawName,
                      policy: tool.autoApprove ? "require_approval" : "always_allow",
                    })
                  }
                  size="compact"
                  variant="secondary"
                >
                  {tool.autoApprove ? "Require Confirmation" : "Auto-Allow"}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}
