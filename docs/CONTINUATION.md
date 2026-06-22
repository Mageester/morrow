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
- Baseline: orchestrator 207 tests, CLI 109, contracts 4, web 8 — all green.
  `pnpm check/test/build` green.

## Exact next step — B4: skill usage tracking + skill→slash commands

Goal: persist how often each skill is used, and expose installed skills as slash
commands so the user can invoke them by name.

1. `services/orchestrator/src/database.ts` — migration 13:
   `CREATE TABLE skill_usage (skill_id TEXT NOT NULL, project_id TEXT NOT NULL
   REFERENCES projects(id) ON DELETE CASCADE, count INTEGER NOT NULL DEFAULT 0,
   last_used_at TEXT, PRIMARY KEY (project_id, skill_id));`
   (Bump `database.test.ts` count 12 → 13.)
2. `services/orchestrator/src/repositories/skill-usage.ts` — `recordUse(projectId,
   skillId, at)` (upsert increment) + `listByProject(projectId)` returning
   `{skillId,count,lastUsedAt}` sorted by count desc.
3. Contracts — `SkillUsageSchema` ({skillId,count,lastUsedAt|null}). Route
   `GET /api/projects/:projectId/skills/usage` and
   `POST /api/projects/:projectId/skills/:skillId/use`.
4. CLI — the skill registry (`apps/cli/src/skills/registry.ts`) already discovers
   local skills; expose each discovered skill as a `/skill:<id>` (or `/<id>`)
   slash command in the registry feeding `SLASH_COMMANDS`/completion, and call
   the `use` endpoint when invoked. Keep it additive to the static command list.
5. Tests first (red):
   - `test/skill-usage.test.ts` — increments and orders by count; isolates by
     project.
   - api test — POST use then GET usage reflects the count.
   - CLI — discovered skills surface as commands (extend `skills.test.ts`).
6. `pnpm check && pnpm test && pnpm build`. Update matrix §5 rows (Slash commands
   from skills, Usage tracking) → VERIFIED + status. Commit
   `feat(skills): usage tracking and skill slash commands` + push.

## Failing test to write first

`test/skill-usage.test.ts` — "recordUse increments the per-project counter and
listByProject orders by count descending".

## Deferred (pick up later)

- **B8 retry:** `POST /api/tasks/:taskId/retry` — re-queue a `failed`/
  `interrupted` task as a fresh attempt (NOT `cancelled`; separate from
  `/resume`). Needs a task state-machine reset (status → queued, clear
  `task_continuations`, reset assistant message).
- **B8 idempotency** on the agent-chat creation path
  (`POST /api/conversations/:id/messages`) via the existing `readIdempotencyKey`.
- **B10 rate-limit guard:** token-bucket/backoff before B10 is fully closed.

## Open risks / notes

- Skill→slash must not collide with built-in commands; namespace (e.g.
  `/skill:<id>`) or check against `SLASH_COMMANDS` before registering.
- Recording a use is a write; gate it behind the same project resolution as other
  routes (404 on unknown project).

## Broader remaining backlog (see MORROW_BACKLOG.md)

Highest-value, CI-testable next: B10 live provider fallback-on-error, B4 skill
usage tracking + skill→slash, B5 Skill Creator. Heavier/needs-environment: B7
cron, B9 Docker/SSH backends, B11 MCP client, B15 browser, B16 desktop, B17
messaging, B19 installers. Full Hermes parity is multi-session; this file is the
handoff each time.
