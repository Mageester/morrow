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
- Baseline: orchestrator 193 tests, CLI 109, contracts 4, web 8 — all green.
  `pnpm check/test/build` green.

## Exact next step — B8: Idempotency keys + explicit retry

Goal: a retried task-creation request must not spawn a duplicate task, and a
failed/interrupted task must be retryable on demand.

1. `services/orchestrator/src/database.ts` — migration 12:
   `ALTER TABLE tasks ADD COLUMN idempotency_key TEXT;`
   `CREATE UNIQUE INDEX tasks_idempotency_key_idx ON tasks(project_id, idempotency_key) WHERE idempotency_key IS NOT NULL;`
   (Bump `database.test.ts` migration count 11 → 12.)
2. `services/orchestrator/src/repositories/tasks.ts` — accept optional
   `idempotencyKey` on `createTask`; add `findByIdempotencyKey(projectId, key)`.
3. Task-creation routes in `server.ts` (`POST .../tasks/inspect-workspace` and the
   message/agent-chat task creation path): read an `Idempotency-Key` header (or
   body field); if a task with that (projectId,key) exists, return it (200) instead
   of creating a new one.
4. Explicit retry: `POST /api/tasks/:taskId/retry` — only valid for `failed` or
   `interrupted` tasks; re-queue via the runner (mirror `/resume` wiring in
   `server.ts`, but reset to a fresh attempt rather than continuing a saved
   tool-call continuation). Distinguish from `/resume` (which continues a paused
   tool call).
5. Tests first (red):
   - `test/tasks.test.ts` — "createTask with the same idempotency key returns the
     existing task and does not insert a duplicate"; "different keys create
     distinct tasks"; "null key is unconstrained".
   - `test/api.test.ts` (or new `test/idempotency-api.test.ts`) — repeated POST
     with the same `Idempotency-Key` yields one task; `/retry` re-queues a failed
     task and rejects a non-failed one with 409.
6. CLI: optional — add `--idempotency-key` to task creation and a `retry`
   subcommand; can defer.
7. `pnpm check && pnpm test && pnpm build`. Update matrix §3 rows
   (Retry → VERIFIED, Idempotency → VERIFIED) + status. Commit
   `feat(runtime): idempotent task creation and explicit retry` + push.

## Failing test to write first

`test/tasks.test.ts` — "createTask with a repeated idempotency key returns the
existing task without inserting a duplicate".

## Open risks / notes

- The unique partial index must allow many NULL keys (existing tasks). SQLite
  partial unique index `WHERE idempotency_key IS NOT NULL` does exactly this.
- `/retry` must not resurrect a `cancelled` task (see existing
  `agent-security.test.ts` "does not resurrect a cancelled task"). Restrict retry
  to `failed`/`interrupted` only.
- Keep `/resume` (continuation) and `/retry` (fresh attempt) clearly separate.

## Broader remaining backlog (see MORROW_BACKLOG.md)

Highest-value, CI-testable next: B10 live provider fallback-on-error, B4 skill
usage tracking + skill→slash, B5 Skill Creator. Heavier/needs-environment: B7
cron, B9 Docker/SSH backends, B11 MCP client, B15 browser, B16 desktop, B17
messaging, B19 installers. Full Hermes parity is multi-session; this file is the
handoff each time.
