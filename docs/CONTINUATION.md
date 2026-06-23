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
- **B20 (partial) — Hermes import: VERIFIED.**
- **B9 (partial) — Execution backend interface + local backend: VERIFIED.**
  Docker/SSH are honest stubs (SCAFFOLD).
- **Persistent named agents** feature landed in the tree (`feat(agents)`).
- Baseline: orchestrator 264, CLI 130, contracts 4, web 8, hermes-compat 4 —
  all green (5 workspace packages).

> NOTE: the live `skills/` directory contains ~20 extra skills created via the
> skill creator (untracked). Do NOT commit or delete them. Tests assert the 6
> built-ins as a subset, not an exact list.

## Exact next step — B21 TUI: persisted cross-session command history

Small, CLI-only, testable. The terminal prompt has an in-memory history ring;
persist it across sessions so up-arrow recall survives a restart.

1. `apps/cli/src/terminal/history.ts` (pure I/O-light): `loadHistory(file,
   max=500)` reads newline-delimited lines (returns [] if missing/unreadable);
   `appendHistory(file, line)` appends de-duplicated-consecutive, trimming the
   file to `max` lines; ignore blank/`/exit`-type noise per a small filter.
2. Wire into `apps/cli/src/commands/chat.ts`: load history into the
   `InteractiveSession` `history` option (already supported via SessionDeps);
   on submit of a non-slash line, append to the history file under the Morrow
   home (`ctx.paths` / `resolveMorrowHome`). Keep it best-effort (never throw).
3. Tests `apps/cli/test/terminal-history.test.ts`: load missing→[]; append then
   load round-trips; consecutive duplicates collapse; file trims to max; blank
   lines ignored.
4. `pnpm check && pnpm test && pnpm build`. Update matrix §1 (Command history) →
   VERIFIED + status. Commit + push.

## Failing test to write first

`apps/cli/test/terminal-history.test.ts` — "appendHistory then loadHistory
round-trips lines and collapses consecutive duplicates".

## Still remaining (multi-session)

B9 Docker/SSH real impls; B15 browser (Playwright/CDP — CI-untestable here);
B16 desktop (UIA/AX/AT-SPI); B19 installers (Windows/Ubuntu); finish partials:
compareBaseline → agent write-path gate, MCP HTTP transport + routes,
apply-update automation + rollback + uninstall, CLI `morrow import` over
`@morrow/hermes-compat`, append-only tamper-evident audit store (B22).

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
