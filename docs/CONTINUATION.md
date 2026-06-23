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
- **B7 — Cron scheduler: VERIFIED** (pure cron engine, schedules repo,
  `SchedulerTicker`, API + CLI). Isolated runs verified.
- Baseline: orchestrator 227 tests, CLI 124, contracts 4, web 8 — all green.
  `pnpm check/test/build` green.

> NOTE: the live `skills/` directory may contain extra skills created by the user
> or a concurrent agent (untracked). Do NOT commit or delete them — they are
> unrelated changes. Tests assert the 6 built-ins as a subset, not an exact list.

## Exact next step — B13 LSP diagnostics + baseline-before-write verification

Two coding-intelligence rows (§8). Keep it provider-agnostic and testable.

1. Baseline-before-write (smaller, do first): in the agent's write path
   (`execution/agent.ts` around `propose_patch`/diff apply, and
   `workspace/validator.ts`), capture a "baseline" check result (e.g. run the
   project's verify command or a targeted type/lint check) BEFORE applying a
   change, then compare AFTER, so the agent never reports success when it made
   things worse. Add `services/orchestrator/src/workspace/baseline.ts`
   (`captureBaseline(runner, cwd)` / `compareBaseline(before, after)` — pure
   diff of error counts). Unit-test the comparison with synthetic before/after.
2. LSP diagnostics client: new `services/orchestrator/src/lsp/diagnostics.ts`.
   Start narrow and deterministic — wrap `tsc --noEmit` / `eslint -f json` as a
   "diagnostics provider" returning structured `{file,line,severity,message}`
   (a real LSP stdio client can come later; the contract is what matters).
   Add a `GET /api/projects/:id/diagnostics` route that runs the configured
   provider in the workspace (respecting command policy + timeouts).
3. Tests: `test/baseline.test.ts` (compareBaseline: improved/worse/same),
   `test/diagnostics.test.ts` (parse a known tsc/eslint output fixture into
   structured diagnostics; never throws on empty).
4. `pnpm check && pnpm test && pnpm build`. Update matrix §8 (LSP diagnostics,
   Baseline-before-write) → VERIFIED + status. Commit + push.

## Failing test to write first

`test/baseline.test.ts` — "compareBaseline reports a regression when the after
count exceeds the before count for the same file".

## Bigger remaining (multi-session, see MORROW_BACKLOG.md)

B9 Docker/SSH backends; B11 MCP client; B14 worktrees + subagents; B15 browser;
B16 desktop; B17 messaging adapters (+ notification delivery); B18 doctor/
updater/uninstall; B19 installers; B20 Hermes import; B21 TUI live tree/Ctrl+K.

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
