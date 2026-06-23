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
- **B17 (partial) — Messaging adapters + notifications: VERIFIED.**
- **B11 (partial) — MCP client: VERIFIED** (stdio client, framing, transport,
  tool filtering, trust).
- **B18 (partial) — Doctor + updater: VERIFIED.**
- **B20 (partial) — Hermes import: VERIFIED** (`@morrow/hermes-compat` real
  package: config parse + honest mapping, no secret leak). CLI wiring pending.
- **Persistent named agents** feature landed in the tree (`feat(agents)`).
- Baseline: orchestrator 259, CLI 130, contracts 4, web 8, **hermes-compat 4** —
  all green (5 workspace packages).

> NOTE: the live `skills/` directory contains ~20 extra skills created via the
> skill creator (untracked). Do NOT commit or delete them. Tests assert the 6
> built-ins as a subset, not an exact list.

## Exact next step — B9 execution backend interface + local backend

Define one interface for command execution so Docker/SSH can slot in later. The
local backend wraps the existing `runProcessSafe`; it is fully testable.

1. New `services/orchestrator/src/backends/types.ts`: `ExecutionBackend`
   interface `{ id: string; run(cmd: { executable; args; cwd; env?; timeoutMs?;
   abortSignal? }) => Promise<{ exitCode; stdout; stderr; durationMs }>;
   dispose?(): Promise<void> }`. Plus a `BackendCommand`/`BackendResult` type.
2. `services/orchestrator/src/backends/local.ts`: `localBackend(opts?)` that
   delegates to `runProcessSafe` (already env-filtered, ptree-killed on timeout).
   Enforce an env allow-list and `no-new-privileges` posture is already in
   `command-executor`; just surface it through the interface.
3. (Docker/SSH stubs that throw "not configured" with a clear message are OK as
   placeholders — do NOT fake execution. Their real impls need
   docker/ssh and are CI-untestable; mark them MISSING/PARTIAL honestly.)
4. Tests `test/backends.test.ts`: `localBackend.run` executes a trivial command
   (`node -e "process.stdout.write('hi')"`) and returns stdout/exitCode; respects
   a pre-aborted signal; times out a long command. Keep commands tiny + portable.
5. Wire is optional this slice — the agent already calls `runProcessSafe`
   directly; the interface is the architectural seam for B-later Docker/SSH.
6. `pnpm check && pnpm test && pnpm build`. Update matrix §4 (Unified backend
   interface, Local) + status. Commit + push.

## Failing test to write first

`test/backends.test.ts` — "localBackend.run executes a command and returns its
stdout and exit code".

## Still remaining (multi-session): B9 Docker/SSH real impls, B15 browser, B16
desktop, B19 installers, B21 TUI live tree/Ctrl+K; finish partials (compareBaseline
agent wiring, MCP HTTP+routes, apply-update automation, CLI `morrow import`).

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
