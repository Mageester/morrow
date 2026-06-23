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
- **B11 (partial) — MCP client: VERIFIED** (stdio JSON-RPC client, framing,
  spawn transport, tool filtering, trust). HTTP/routes/OAuth pending.
- **Persistent named agents** feature landed in the tree (`feat(agents)`).
- Baseline: orchestrator 259 tests, CLI 124, contracts 4, web 8 — all green.

> NOTE: the live `skills/` directory contains ~20 extra skills created via the
> skill creator (untracked). Do NOT commit or delete them. Tests assert the 6
> built-ins as a subset, not an exact list.

## Exact next step — B18 doctor + updater foundations (Distribution)

CLI-side, testable, advances §13 Distribution. `apps/cli` already has a `doctor`
stub (`main.ts` `case "doctor"`).

1. `apps/cli/src/commands/doctor.ts` (extract from wherever `doctor` lives): run
   a set of pure-ish **checks** returning `{ name, status: 'ok'|'warn'|'fail',
   detail, fix? }`: node version ≥22, pnpm present, Morrow home writable, DB
   migrations up to date (call `/api/health` → `migrations.latest`), provider
   configured (call `/api/provider/status`), service reachable. Each check is a
   function `() => Promise<CheckResult>` so they unit-test with injected probes.
2. `runDoctor(checks)` aggregates; exit non-zero if any `fail`. JSON + table out.
3. `apps/cli/src/service/update.ts`: `checkForUpdate(currentVersion, fetchImpl?)`
   that compares the local version to a source (e.g. the package.json on the
   remote/git tag) — keep the source injectable; return `{ current, latest,
   updateAvailable }`. (Actual self-update of a pnpm monorepo is `git pull` +
   `pnpm install` + rebuild — wire a `morrow update` that runs those via the
   service lifecycle, guarded.)
4. Tests: `apps/cli/test/doctor.test.ts` — `runDoctor` aggregates ok/warn/fail
   and sets exit code; a failing check surfaces its fix hint.
   `apps/cli/test/update.test.ts` — `checkForUpdate` reports updateAvailable when
   latest>current (injected fetch), and false when equal.
5. `pnpm check && pnpm test && pnpm build`. Update matrix §13 (Doctor, Update/
   rollback) → VERIFIED/PARTIAL + status. Commit + push.

## Failing test to write first

`apps/cli/test/doctor.test.ts` — "runDoctor returns a non-zero exit code when any
check reports fail, and zero when all pass/warn".

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
