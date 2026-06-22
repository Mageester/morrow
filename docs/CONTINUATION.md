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
- Baseline: orchestrator 197 tests, CLI 109, contracts 4, web 8 — all green.
  `pnpm check/test/build` green.

## Exact next step — B10: live provider fallback-on-error

Today `routing/router.ts` sets `fallbackUsed` only from *static* config (an
unconfigured preferred provider falls back to a configured one). The gap is a
*live* fallback: when the chosen provider throws at stream start, retry the turn
with the next configured candidate before failing the task.

1. Read `services/orchestrator/src/execution/agent.ts` around provider streaming
   (search `streamChat` / `provider.`) and `routing/router.ts` `routePreset`
   (it already produces an ordered `candidates` list).
2. Add a thin helper, e.g. `services/orchestrator/src/provider/fallback.ts`:
   `async function streamWithFallback(candidates, makeProvider, attempt)` that
   tries each configured candidate in order, catching connection/stream-start
   errors (use `provider/connectivity.ts` error classes / `error_classifier`
   patterns) and moving to the next; throws only when all fail. Distinguish
   *retryable* provider errors (network/5xx/429) from *fatal* ones (bad request)
   — only fall back on retryable.
3. Wire it where the agent first opens the stream. Record which provider actually
   served the turn (update routing decision `providerId` + set a
   `fallbackUsed`/`fallbackFrom` detail on an event) so the transcript is honest.
4. Tests first (red) — `test/provider-fallback.test.ts`:
   - "falls back to the next candidate when the first throws a retryable error"
   - "does not fall back on a fatal (non-retryable) error"
   - "throws when every candidate fails, with an aggregated reason".
   Use two `MockProvider`s (extend MockProvider with a `throwAtStart` option or a
   provider stub that throws) — the first throws, the second streams text.
   Then an agent-level test: a task whose primary provider throws still completes
   via the fallback and the served provider is recorded.
5. `pnpm check && pnpm test && pnpm build`. Update matrix §12 "Fallback" row →
   VERIFIED + status. Commit `feat(provider): live fallback on retryable errors`
   + push.

## Failing test to write first

`test/provider-fallback.test.ts` — "falls back to the next configured candidate
when the first provider throws a retryable error".

## Deferred from B8 (pick up later)

- `POST /api/tasks/:taskId/retry` — re-queue a `failed`/`interrupted` task as a
  fresh attempt (must NOT resurrect `cancelled`; keep separate from `/resume`,
  which continues a saved tool-call continuation). Needs a task state-machine
  reset (status → queued, clear `task_continuations`, reset assistant message).
- Extend `Idempotency-Key` handling to the agent-chat task-creation path
  (`POST /api/conversations/:id/messages`) using the same `readIdempotencyKey`
  helper already in `server.ts`.

## Open risks / notes

- Don't fall back on a *fatal* request error (e.g. malformed tool schema) — that
  would mask a real bug and waste every provider. Classify first.
- Live fallback must re-check the abort signal between attempts so cancel/panic
  still wins.

## Broader remaining backlog (see MORROW_BACKLOG.md)

Highest-value, CI-testable next: B10 live provider fallback-on-error, B4 skill
usage tracking + skill→slash, B5 Skill Creator. Heavier/needs-environment: B7
cron, B9 Docker/SSH backends, B11 MCP client, B15 browser, B16 desktop, B17
messaging, B19 installers. Full Hermes parity is multi-session; this file is the
handoff each time.
