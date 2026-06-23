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
- **B5 — Skill Creator: VERIFIED.** **B6 — Skill Curator: VERIFIED.**
  §6 Skills fully VERIFIED.
- **B7 — Cron scheduler: VERIFIED.**
- **B13 (partial) — Diagnostics + baseline: VERIFIED** (tsc/eslint parsers,
  `compareBaseline`, `/diagnostics` route). Agent auto-gate pending.
- Baseline: orchestrator 239 tests, CLI 124, contracts 4, web 8 — all green.
  `pnpm check/test/build` green.

> NOTE: the live `skills/` directory may contain extra skills created by the user
> or a concurrent agent (untracked). Do NOT commit or delete them — they are
> unrelated changes. Tests assert the 6 built-ins as a subset, not an exact list.

## Exact next step — B14 subagent delegation + task graph (parent/child tasks)

Advances §14 "Subagents / delegation" and §3 "Task graph / child tasks" — a
subagent is just a child task with its own scope. A top completion criterion.

1. `services/orchestrator/src/database.ts` — migration 15:
   `ALTER TABLE tasks ADD COLUMN parent_task_id TEXT REFERENCES tasks(id) ON
   DELETE CASCADE;` + `CREATE INDEX tasks_parent_idx ON tasks(parent_task_id);`
   (bump `database.test.ts` 14 → 15; update `runner.test.ts` manual schema +
   `tasks.ts` map/insert to carry `parentTaskId`).
2. `repositories/tasks.ts` — accept optional `parentTaskId` on createTask; add
   `listChildren(parentId)` and a `taskTree(rootId)` helper (or build the tree in
   the route from `listByProject`).
3. Contracts: extend `TaskSchema` with `parentTaskId: z.string().nullable()`
   (update every consumer/fixture). Add `SpawnSubagentSchema` `{ projectId,
   parentTaskId, kind, label? }`.
4. Route `POST /api/tasks/:taskId/subagents` → create a child task (same project,
   `parentTaskId` set) and run it; `GET /api/tasks/:taskId/tree` → the task and
   its descendants. Guard: child kind limited to `inspect_workspace` for now
   (agent_chat children need a conversation — defer).
5. Tests first (red): `test/subagents.test.ts` — createTask with parent links;
   `listChildren`; API spawns a child and the tree includes it; cascade delete
   removes children. `test/tasks.test.ts` — parentTaskId round-trips.
6. CLI: optional `morrow tasks tree <id>` over `/tree`.
7. `pnpm check && pnpm test && pnpm build`. Update matrix §14 (Subagents) + §3
   (Task graph / child tasks) → VERIFIED + status. Commit + push.

## Failing test to write first

`test/subagents.test.ts` — "POST /api/tasks/:id/subagents creates a child task
whose parentTaskId is the parent and which appears in the parent's tree".

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
