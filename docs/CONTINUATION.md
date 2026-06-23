# Continuation

> Always names the **exact** next step so any agent (or a fresh session) can
> resume without re-deriving context. Update this at every interruption.

## Concurrent-agent collision (2026-06-23) — RESOLVED

A second agent built a **persistent named agents** feature on this same branch.
Resolved cleanly:
- The migration-id collision (both claimed `id:15`) was fixed by renumbering mine
  to 16. The other agent then committed `feat(agents): persistent named agent
  teams + granular permissions` (`2dc4362`), which **included** my task-graph data
  model (migration 16 `task_parent_links`, `Task.parentTaskId`,
  `tasks.listChildren`, `SpawnSubagentSchema`).
- I then landed B14 subagent routes on top: `feat(tasks): subagent delegation`
  (`6d8a23d`). The user authorized "take over fully"; the other agent is stopped.
- Tree is GREEN: orchestrator 244, CLI 124, contracts 4, web 8.

The `skills/` directory contains ~20 extra skills created via the skill creator
(by the user/other agent). They are untracked — do NOT commit or delete them.

## Resume command

```bash
cd "C:/Users/aidan/OneDrive/Documents/PlaceHolder"
git checkout feat/morrow-agent-terminal
pnpm install
pnpm check && pnpm test && pnpm build   # expect green
```

## Where we are (all committed + pushed on feat/morrow-agent-terminal)

- Durable docs maintained (parity matrix, master goal, backlog, status, this).
- **B1 — Full-text search: VERIFIED.**
- **B2 — Memory provenance + pin + tiers: VERIFIED.**
- **B3 — Loop detection: VERIFIED.**
- **B22 (partial) — Security hard-blocks: VERIFIED** (force-push, network-exfil,
  workspace-redirect escape, enforced before approval; YOLO cannot bypass).
- **B8 (partial) — Idempotent task creation: VERIFIED** (partial unique index +
  `Idempotency-Key` replay on inspect-workspace). REMAINING: `/retry` route +
  agent-chat creation path.
- **B10 (partial) — Live provider fallback: VERIFIED** (`openStreamWithFallback`,
  retryable-only, no mid-stream switch, `provider.fallback` event). REMAINING:
  explicit rate-limit guard/backoff.
- **B4 — Skill usage tracking + skill→slash: VERIFIED** (`skill_usage` table,
  repo, API, CLI client; verified skills → `/skill:<id>` wired + invoked).
- **B8 — Idempotency + retry: VERIFIED** (idempotent creation + `/retry`).
- **B5 — Skill Creator: VERIFIED.** **B6 — Skill Curator: VERIFIED.**
  §6 Skills fully VERIFIED.
- **B7 — Cron scheduler: VERIFIED.**
- **B13 (partial) — Diagnostics + baseline: VERIFIED.**
- **B14 (partial) — Subagent delegation + task graph: VERIFIED.** Worktrees pending.
- **B17 (partial) — Messaging adapters + notifications: VERIFIED** (webhook +
  telegram, `/api/notify`, scheduler notifications). SMTP/native Slack pending.
- **Persistent named agents** feature landed in the tree (`feat(agents)`).
- Baseline: orchestrator 253 tests, CLI 124, contracts 4, web 8 — all green.

> NOTE: the live `skills/` directory contains ~20 extra skills created via the
> skill creator (untracked). Do NOT commit or delete them. Tests assert the 6
> built-ins as a subset, not an exact list.

## Exact next step — B11 MCP client (stdio first) + trust records

Completion criterion: "use MCP/plugins". Start with a stdio JSON-RPC client; keep
the process spawn injectable so it is testable with a fake server script.

1. New `services/orchestrator/src/mcp/client.ts`:
   - `McpClient` over a stdio transport (newline-delimited or
     Content-Length-framed JSON-RPC 2.0). Methods: `initialize()`,
     `listTools()`, `callTool(name, args)`, `close()`. Injectable spawn (a
     `{ stdin, stdout, kill }` duplex) so tests use an in-process fake.
   - Pure `framing.ts`: encode/decode JSON-RPC messages; unit-test round-trip.
   - Tool filtering: an allow-list of tool names the client will expose.
2. Trust records: `services/orchestrator/src/mcp/trust.ts` — a `settings`-table
   (key `mcp.trust.<serverId>`) record of an approved server command+args hash;
   `isTrusted`/`trust`/`revoke`. A server is only auto-startable once trusted.
3. Contracts: `McpServerSchema`, `McpToolSchema`, `McpCallResultSchema`.
4. A small registry `mcp/registry.ts` reading server configs from a JSON file
   under the Morrow home (stdio command + args + env allow-list). Do NOT execute
   an untrusted server.
5. Routes (read-only first): `GET /api/mcp/servers`, `GET /api/mcp/:id/tools`
   (spawns, initializes, lists, closes), `POST /api/mcp/:id/call`
   (trust-gated). Spawn injectable via `ServerDependencies.mcpSpawn?`.
6. Tests first (red) `test/mcp.test.ts`: framing round-trip; `McpClient` against
   an in-process fake server (initialize → listTools → callTool → close);
   tool-filtering hides disallowed tools; trust gate blocks an untrusted call.
7. `pnpm check && pnpm test && pnpm build`. Update matrix §10 → status. Commit+push.

## Failing test to write first

`test/mcp.test.ts` — "McpClient.listTools returns the fake server's tools after
initialize (in-process stdio transport)".

## Deferred / bigger remaining (multi-session, see MORROW_BACKLOG.md)

Wire `compareBaseline` into the agent write path (finish B13). B9 Docker/SSH
backends; B11 MCP client; B15 browser; B16 desktop; B17 messaging adapters (+
notification delivery); B18 doctor/updater/uninstall; B19 installers; B20 Hermes
import; B21 TUI live tree/Ctrl+K.

## Deferred (pick up later)

- **B8 idempotency** on the agent-chat creation path
  (`POST /api/conversations/:id/messages`) via the existing `readIdempotencyKey`.
- **B10 rate-limit guard:** token-bucket/backoff before B10 is fully closed.
- **B6 Curator** follows B5: dedupe (similarity over installed SKILL.md),
  improve successful skills, stale/archive lifecycle, pin, backup, rollback.

## Bigger remaining (multi-session)

B7 cron/scheduler + isolated runs + notifications; B9 execution backend interface
+ Docker/SSH; B11 MCP client; B13 LSP diagnostics; B14 worktrees + subagents;
B15 browser; B16 desktop; B17 messaging adapters; B18 doctor/updater/uninstall;
B19 Windows/Ubuntu installers; B20 Hermes import; B21 TUI live task tree/Ctrl+K/
persisted history. Full Hermes parity is multi-session — this file is the handoff.

## Broader remaining backlog (see MORROW_BACKLOG.md)

Highest-value, CI-testable next: B10 live provider fallback-on-error, B4 skill
usage tracking + skill→slash, B5 Skill Creator. Heavier/needs-environment: B7
cron, B9 Docker/SSH backends, B11 MCP client, B15 browser, B16 desktop, B17
messaging, B19 installers. Full Hermes parity is multi-session; this file is the
handoff each time.
