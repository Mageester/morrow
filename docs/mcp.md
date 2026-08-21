# Model Context Protocol (MCP) in Morrow

Morrow provides native, first-class integration with the open [Model Context Protocol (MCP)](https://modelcontextprotocol.io), allowing your agent to seamlessly connect to external tools, databases, APIs, and resource providers.

---

## Key Capabilities

1. **Multi-Transport Execution**:
   - `stdio`: Spawns and manages local CLI server processes (e.g. `uvx mcp-server-sqlite`, `npx @modelcontextprotocol/server-postgres`).
   - `sse`: Connects to remote or local HTTP Server-Sent Event endpoints with automatic `endpoint` negotiation and custom authentication headers.
2. **Multi-Source Configuration Discovery**:
   - Workspace project configuration (`.morrow/mcp.json` / `.mcp.json`)
   - User-global configuration (`~/.morrow/mcp.json` / `~/.mcp.json`)
   - Interactive database settings (managed via Web UI & CLI)
   - Recursive environment variable substitution (`${VAR}` and `$VAR`).
3. **Collision-Free Tool Namespacing**:
   - All MCP tools are dynamically exposed to the LLM agent using explicit double-underscore namespacing: `mcp__<serverId>__<toolName>` (e.g., `mcp__sqlite__read_query`).
4. **Resource Protocol Support**:
   - Dedicated `read_mcp_resource` tool allows the agent to read structured MCP URI resources (e.g., `kb://docs/getting-started`, `memo://notes/1`).
5. **Security & Approval Governance**:
   - Auto-approves safe read-only tools by default heuristics (`get_*`, `list_*`, `read_*`, `search_*`, etc.).
   - Halts and prompts for user confirmation before executing mutating actions (`write_*`, `create_*`, `delete_*`, etc.), with support for persistent "always allow" rules.
   - Requires explicit trust verification before executing unknown local executables or remote endpoints.
6. **Lazy Connection Pooling & Auto-Healing**:
   - Connections open on-demand when tools are listed or invoked, stay warm across session turns, and auto-reconnect if severed.

## Safety and lifecycle

- Trust is bound to the exact stdio command/arguments or SSE URL. Editing or
  revoking that trust prevents discovery and new connections; an already
  pooled client is not retroactively invalidated by a trust-row change.
- Revoking the assigned agent or team while a task is running aborts its
  active MCP request through the task cancellation signal. Task teardown closes
  pooled clients and transports. Cancel the task itself when an existing MCP
  connection must stop immediately.
- MCP results are external, untrusted data. Tool approval, allow-lists, and
  the agent's task policy still apply; Morrow does not treat server output as
  permission or instructions.

---

## Configuration Format

Morrow supports the standard MCP `mcpServers` JSON format:

```json
{
  "mcpServers": {
    "sqlite": {
      "command": "uvx",
      "args": ["mcp-server-sqlite", "--db-path", "${DB_PATH:-./app.db}"]
    },
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres", "${DATABASE_URL}"]
    },
    "github": {
      "transport": "sse",
      "url": "https://mcp.github.com/sse",
      "headers": {
        "Authorization": "Bearer ${GITHUB_TOKEN}"
      }
    }
  }
}
```

---

## CLI Management Commands

```bash
# List all configured MCP servers and their trust status
morrow mcp list

# List available 1-click starter templates
morrow mcp templates

# Add a server from a 1-click template (github, sqlite, postgres, fetch, brave)
morrow mcp add --template sqlite

# Add a custom stdio server
morrow mcp add my-tool --command npx --args "-y,my-mcp-server"

# Add a remote SSE server
morrow mcp add remote-api --url "https://api.example.com/sse"

# Test connection, latency, and tool discovery
morrow mcp test sqlite

# Trust an untrusted server configuration
morrow mcp trust sqlite

# List all discovered tools and active approval policies
morrow mcp tools

# Remove a database-managed server
morrow mcp remove my-tool
```

---

## Web UI Settings

Open **Settings → MCP Servers** in the Morrow Web UI to:
- Browse and 1-click install starter templates
- Add custom stdio / SSE servers through an interactive wizard
- Run live latency pings and inspect tool JSON schemas
- Toggle tool approval policies between "Auto-allow" and "Require confirmation"
