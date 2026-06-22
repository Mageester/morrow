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
- Baseline: orchestrator 211 tests, CLI 112, contracts 4, web 8 — all green.
  `pnpm check/test/build` green.

## Exact next step — finish B8 retry, then B5 Skill Creator

### Immediate (small, finishes an open partial) — `POST /api/tasks/:taskId/retry`

1. Read the task status state-machine in
   `services/orchestrator/src/repositories/task-records.ts` (`transitionTask`)
   and `recovery.ts` to see valid transitions and how `resumeInterruptedTask`
   re-queues.
2. Add `retryTask(taskId)` to `task-records.ts` (or a small helper) that, only
   for `failed`/`interrupted` tasks: resets status → `queued`, clears
   `task_continuations` for the task, and resets the assistant message
   (`streaming_state` → `queued`, content cleared) so the runner re-runs from a
   clean slate. Must reject `cancelled`/`running`/`completed`/`verified` (409).
3. `server.ts` — `POST /api/tasks/:taskId/retry`: 404 unknown, 409 wrong status,
   else reset + `deps.runner.run(taskId)`, return the task (202).
4. Tests: `test/api.test.ts` (or new `test/retry-api.test.ts`) — retry a failed
   task re-runs it; retrying a `completed`/`cancelled` task → 409. Reuse the
   `agent-security.test.ts` "does not resurrect a cancelled task" invariant.
5. Update matrix §3 "Retry" row → VERIFIED. Commit `feat(runtime): explicit task
   retry` + push.

### Then (large, high value) — B5 Skill Creator

Interview → generate skill (SKILL.md + manifest.json + permissions.json +
entrypoint) → **sandbox verify** (reuse `apps/cli/src/skills/registry.ts`
`verifySkill` + a dry-run) → permission review → install into the local skills
dir on approval. New `services/orchestrator/src/skills/creator.ts` +
`apps/cli` interview flow. Then B6 Curator (dedupe/improve/stale/pin/backup/
rollback). See `MORROW_BACKLOG.md`.

## Deferred (pick up later)

- **B8 idempotency** on the agent-chat creation path
  (`POST /api/conversations/:id/messages`) via the existing `readIdempotencyKey`.
- **B10 rate-limit guard:** token-bucket/backoff before B10 is fully closed.

## Open risks / notes

- `/retry` must NOT resurrect a `cancelled` task — restrict to
  `failed`/`interrupted` and keep it distinct from `/resume` (continuation).
- Clearing `task_continuations` is required so retry is a *fresh* attempt, not a
  resumed tool call.

## Broader remaining backlog (see MORROW_BACKLOG.md)

Highest-value, CI-testable next: B10 live provider fallback-on-error, B4 skill
usage tracking + skill→slash, B5 Skill Creator. Heavier/needs-environment: B7
cron, B9 Docker/SSH backends, B11 MCP client, B15 browser, B16 desktop, B17
messaging, B19 installers. Full Hermes parity is multi-session; this file is the
handoff each time.
