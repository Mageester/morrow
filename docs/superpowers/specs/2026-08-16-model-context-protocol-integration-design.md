# Model Context Protocol (MCP) Integration Design

Date: 2026-08-16

## Goal

Provide Morrow with full, native Model Context Protocol (MCP) client capabilities across stdio and SSE transports. Agents can dynamically discover, inspect, and invoke external MCP tools and read MCP resources with standard naming conventions (`mcp__<server_name>__<tool_name>`), fine-grained approval/permission policies, lazy pooled connection lifecycle management, curated 1-click templates, and complete UI/CLI management.

## Scope & High-Level Invariants

1. **Dual-Source Configuration:**
   - Workspace config: `<workspace>/.morrow/mcp.json`
   - User global config: `~/.morrow/mcp.json`
   - Database / UI config: Orchestrator SQLite settings repository (`mcp_servers` and `mcp.trust.*`)
   - Precedence: Workspace overrides User config, which overrides UI database defaults. Standard `mcpServers` format compatible with Claude Desktop and MCP ecosystem.

2. **Transports:**
   - `stdio`: Local subprocess execution via stdin/stdout framing, with environment variable filtering (`filterEnv`) and process trust fingerprinting (`mcpTrustStore`).
   - `sse`: Server-Sent Events over HTTP with custom header/auth support for remote and self-hosted MCP endpoints.

3. **Tool Naming & Namespacing:**
   - MCP tools are mapped into the orchestrator tool catalog using double-underscore namespacing: `mcp__<server_name>__<tool_name>`.
   - Dedicated `read_mcp_resource` tool registered globally, enabling models to read MCP URIs on demand.

4. **Permissions & Trust:**
   - Process-level trust: Command + argument SHA-256 fingerprint verified against `mcpTrustStore` before initial process launch.
   - Per-server and per-tool execution policies:
     - Read-only / safe tools: auto-approved by default.
     - Mutating / external actions: prompt user for approval unless toggled to "Always Allow" in UI/CLI settings.

5. **Lifecycle Management:**
   - Lazy pooled connection manager: Servers start on-demand when tools are listed/invoked, remain warm across conversational turns, and shut down gracefully upon orchestrator stop or 15-minute idle timeout.
   - Automatic reconnect: Dropped SSE streams or crashed stdio subprocesses attempt one clean reconnect on subsequent tool invocation.

6. **UI & CLI:**
   - Web UI Settings panel with live connection indicators, test ping buttons, permission toggles, and exposed tool explorer.
   - Curated 1-click template library for popular servers (GitHub, SQLite, PostgreSQL, Fetch, Brave Search).
   - CLI subcommands: `morrow mcp list`, `morrow mcp add`, `morrow mcp test`, `morrow mcp trust`, `morrow mcp remove`.

7. **Verification & Hard Enforcement:**
   - Multi-layer testing: deterministic in-process mock tests, live loopback stdio & SSE fixture tests, CLI tests, and API integration tests.
