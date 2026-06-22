# Continuation

> Always names the **exact** next step so any agent (or a fresh session) can
> resume without re-deriving context. Update this at every interruption.

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
- **B5 — Skill Creator: VERIFIED.**
- **B6 — Skill Curator: VERIFIED** (dedupe/backup/rollback/archive/restore/pin/
  update). §6 Skills is now fully VERIFIED.
- Baseline: orchestrator 215 tests, CLI 124, contracts 4, web 8 — all green.
  `pnpm check/test/build` green.

## Exact next step — B7 cron scheduler (isolated scheduled runs + notifications)

Goal: schedule jobs (e.g. "every morning, inspect the workspace") that run
unattended in isolated task runs. Keep the schedule math pure/deterministic.

1. New `services/orchestrator/src/schedule/cron.ts` (pure, no clock inside):
   - `parseCron(expr)` → structured fields (support 5-field `m h dom mon dow`
     with `*`, ranges `a-b`, lists `a,b`, steps `*/n`). Throw on invalid.
   - `nextRun(expr, fromDate)` → next `Date` strictly after `fromDate` (UTC).
   Deterministic; unit-test against known expressions.
2. `services/orchestrator/src/database.ts` — migration 14:
   `CREATE TABLE schedules (id TEXT PRIMARY KEY, project_id TEXT NOT NULL
   REFERENCES projects(id) ON DELETE CASCADE, cron TEXT NOT NULL, task_kind TEXT
   NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, last_run_at TEXT, next_run_at
   TEXT NOT NULL, created_at TEXT NOT NULL);` (bump `database.test.ts` 13 → 14.)
3. `repositories/schedules.ts` — CRUD + `due(now)` (enabled && next_run_at<=now)
   + `markRan(id, ranAt, nextAt)`.
4. Contracts: `ScheduleSchema`, `CreateScheduleSchema` (validates cron via
   `parseCron`). Routes: `GET/POST /api/projects/:id/schedules`,
   `DELETE /api/schedules/:id`, `POST /api/schedules/:id/run` (run now).
5. A `SchedulerTicker` (in orchestrator `index.ts`, injectable interval + clock)
   that, on tick, finds `due` schedules, creates an **isolated** task per the
   schedule (reuse `tasks.createTask` + `deps.runner.run`), then `markRan` with
   the next `nextRun`. Notifications: emit a `task.created`/completion the CLI can
   surface (defer external delivery to messaging, B17).
6. Tests first (red):
   - `test/cron.test.ts` — `parseCron`/`nextRun` against known cases (every
     minute, `*/15`, `0 9 * * 1-5`, end-of-month rollover, invalid throws).
   - `test/schedules.test.ts` — repo `due`/`markRan`; API create→list→run→delete;
     a fake-clock ticker creates exactly one task when a schedule is due and
     advances `next_run_at`.
7. CLI: `morrow schedule list|add <cron> <kind>|remove <id>|run <id>` over the API.
8. `pnpm check && pnpm test && pnpm build`. Update matrix §3 (Scheduled jobs) +
   §11 (Cron scheduler, Isolated scheduled runs, Notifications) → VERIFIED +
   status. Commit `feat(schedule): cron scheduler with isolated runs` + push.

## Failing test to write first

`test/cron.test.ts` — "nextRun('*/15 * * * *', 2026-01-01T00:07:00Z) === 00:15:00Z".

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
