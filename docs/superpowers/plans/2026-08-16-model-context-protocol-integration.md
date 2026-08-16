# Model Context Protocol (MCP) Integration Implementation Plan

> **Goal:** Implement full Model Context Protocol (MCP) client support in Morrow across stdio and SSE transports with config discovery, tool namespacing, lazy lifecycle pooling, fine-grained permissions, Web UI & CLI management, and 1-click templates.

**Tech Stack:** TypeScript, Node.js, Fastify, Better-SQLite3, Vitest, React, Tailwind / Vanilla CSS design tokens.

---

### Task 1: Implement SSE Transport & Extended Protocol Client

**Files:**
- Modify: `services/orchestrator/src/mcp/client.ts`
- Add: `services/orchestrator/src/mcp/sse-transport.ts`
- Modify: `services/orchestrator/test/mcp.test.ts`
- Add: `services/orchestrator/test/mcp-sse.test.ts`

- [ ] **Step 1: Write failing SSE transport tests with mock HTTP/SSE server**
- [ ] **Step 2: Implement SSE transport (`spawnSseTransport`) with custom headers and reconnect support**
- [ ] **Step 3: Add `readResource` and resource listing to `McpClient`**
- [ ] **Step 4: Run focused unit tests to green**

---

### Task 2: Multi-Source Server Configuration & Registry

**Files:**
- Add: `services/orchestrator/src/mcp/config.ts`
- Modify: `services/orchestrator/src/mcp/trust.ts`
- Modify: `services/orchestrator/src/database.ts` (if MCP server table needed)
- Add: `services/orchestrator/test/mcp-config.test.ts`

- [ ] **Step 1: Write config discovery tests (`.morrow/mcp.json`, `~/.morrow/mcp.json`, database)**
- [ ] **Step 2: Implement configuration parser, environment variable expansion, and validation**
- [ ] **Step 3: Extend trust store for remote URL endpoints alongside stdio command fingerprints**
- [ ] **Step 4: Verify config resolution order and trust invalidation**

---

### Task 3: Connection Pool & Lifecycle Management

**Files:**
- Add: `services/orchestrator/src/mcp/pool.ts`
- Add: `services/orchestrator/test/mcp-pool.test.ts`

- [ ] **Step 1: Write pool lifecycle tests (lazy initialization, connection reuse, idle reaping, auto-reconnect)**
- [ ] **Step 2: Implement `McpPool` managing active client instances and health states**
- [ ] **Step 3: Hook into orchestrator shutdown for clean termination**

---

### Task 4: Dynamic Tool Catalog & Execution Bridge

**Files:**
- Add: `services/orchestrator/src/mcp/tool-bridge.ts`
- Modify: `services/orchestrator/src/tools/catalog.ts`
- Modify: `services/orchestrator/src/execution/agent.ts`
- Add: `services/orchestrator/test/mcp-tool-bridge.test.ts`

- [ ] **Step 1: Write tests for dynamic tool registration (`mcp__<server>__<tool>`) and parameter schemas**
- [ ] **Step 2: Implement `read_mcp_resource` tool**
- [ ] **Step 3: Wire MCP tool dispatch into agent execution loop with error trapping**

---

### Task 5: Permissions & Approval Gate

**Files:**
- Add: `services/orchestrator/src/security/mcp-policy.ts`
- Modify: `services/orchestrator/src/security/agent-execution-policy.ts`
- Add: `services/orchestrator/test/mcp-security.test.ts`

- [ ] **Step 1: Write tests for auto-approval on read-only tools vs. confirmation on mutating tools**
- [ ] **Step 2: Implement per-server / per-tool policy evaluator and persistent user approval settings**

---

### Task 6: Orchestrator REST & SSE API Endpoints

**Files:**
- Modify: `services/orchestrator/src/server.ts`
- Add: `services/orchestrator/test/mcp-api.test.ts`

- [ ] **Step 1: Add `/api/mcp/servers` (GET, POST, DELETE), `/api/mcp/test` (POST), and `/api/mcp/tools` (GET)**
- [ ] **Step 2: Verify endpoints with authentication & local-guard protection**

---

### Task 7: CLI Management Commands

**Files:**
- Modify: `apps/cli/src/` (add `commands/mcp.ts` and CLI routing)
- Add: `apps/cli/test/mcp-cli.test.ts`

- [ ] **Step 1: Implement `morrow mcp list`, `add`, `test`, `trust`, `remove`**
- [ ] **Step 2: Add interactive template selection in CLI (`morrow mcp add --template github`)**

---

### Task 8: Web UI Management & 1-Click Templates

**Files:**
- Modify: `apps/web/src/` (Settings view, MCP tab, status badges, tool inspector, template modal)
- Add / Update: Templates definition (`templates/mcp-templates.ts`)

- [ ] **Step 1: Build MCP Server Management panel in Settings**
- [ ] **Step 2: Add connection test ping with latency indicator and tool schema viewer**
- [ ] **Step 3: Implement 1-Click template wizard (GitHub, SQLite, Postgres, Fetch, Brave Search)**

---

### Task 9: Full End-to-End Suite & Documentation

**Files:**
- Add: `services/orchestrator/test/mcp-e2e.test.ts`
- Modify: `docs/architecture.md`, `agent_docs/project_overview.md`, `CHANGELOG.md`

- [ ] **Step 1: Run comprehensive multi-layer test suite (in-process mocks, stdio & SSE fixtures)**
- [ ] **Step 2: Run `pnpm check`, `pnpm test`, and `pnpm build`**
- [ ] **Step 3: Document architecture and release notes**
