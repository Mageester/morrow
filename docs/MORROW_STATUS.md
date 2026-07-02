# Morrow Status

Snapshot of what is **verified working** right now, updated as slices land.

## Build / test health (2026-07-02, latest)

- `pnpm check`, `pnpm test`, and `pnpm build`: green.
- `pnpm test`: **orchestrator 344 · CLI 149 · web 22 · contracts 4 ·
  hermes-compat 4 — all green (523 total)**.
- Orchestrator smoke suites: `vertical-slice`, `providers`, `agent-alpha`, and
  `sqlite` all verified passing this session (2026-07-02).
- `pnpm run test:e2e` (Playwright): **11/11 green** (2026-07-02).

> See `docs/CURRENT_STATE.md` for the authoritative verified snapshot.

## Verified capabilities (evidence in tree)

- Project + task lifecycle, sqlite persistence (`repositories/*`, `database.ts`).
- Agent execution loop with adaptive budget (`execution/agent.ts`,
  `adaptive-budget.ts`).
- Approval → patch → verify → diff → undo workflow
  (`agent-repair-integration.test.ts`).
- Pause/resume + cancel + panic (`/resume`, `/cancel`, `commands/panic.ts`).
- Provider registry + health test + routing/presets/fallback flag
  (`provider/*`, `routing/*`).
- Memory CRUD across project/conversation/user scopes (`repositories/memory.ts`).
- Terminal TUI: slash autocomplete, tool cards, bounded `/output`, `/diff`,
  `/undo`, no-color/ASCII fallback, YOLO disclosure.
- Onboarding (CLI + web), service lifecycle, signed skill verification.

## In progress

See `CONTINUATION.md` for the exact next step.

## Recently verified

- **Local browser control (B15, partial)** — `browser/playwright.ts` launches a
  real Playwright Chromium session (visible unless explicitly headless), attaches
  to Chrome/Chromium/Edge CDP endpoints, and supports isolated or persistent
  sessions, semantic refs, navigation/click/fill/key/select, dialogs, bounded
  screenshots, scoped uploads/downloads, console/page-error evidence, timeout,
  cancellation, pause/resume/panic and owned-process cleanup. `browser/audit.ts`
  persists sanitized task-scoped records through the append-only audit log.
  `browser-injection.test.ts` launches a local controlled page and proves the
  full safety path; managed/cloud browsers remain unsupported.

- **Tamper-evident audit store (B22b)** — `audit/log.ts` hash-chains each entry
  (`hash = sha256(prevHash + canonical(entry))`); `repositories/audit-log.ts` is
  append-only (no update/delete) and `verify()` recomputes the chain to detect
  any edit, reorder, or drop, reporting the first broken `seq`. Migration 18.
  Tests: `audit-log.test.ts` (5). Orchestrator 269 green.
- **Persisted command history (B21, partial)** — `terminal/history.ts`
  (load/append, consecutive-dedup, max-trim, ignore blank/exit noise), wired into
  the interactive session via `history`/`onHistory` so up-arrow recall survives a
  restart. Tests: `terminal-history.test.ts` (5). CLI 135 green.
- **Execution backend interface (B9, partial)** — `backends/types.ts`
  `ExecutionBackend` contract + `backends/local.ts` (delegates to the contained
  `runProcessSafe`) + honest `dockerBackend`/`sshBackend` stubs that refuse until
  configured (Morrow never fakes remote/sandboxed execution). Tests:
  `backends.test.ts` (5: exec, exit code, pre-abort, timeout, stub refusal).
  Orchestrator 264 green.
- **Hermes import (B20, partial)** — `@morrow/hermes-compat` is now a real
  workspace package: `parseHermesEnv` (KEY=VALUE + key: value, comments/blanks/
  export/quotes), `mapToMorrow` (maps only keys we understand; unknowns →
  `unmapped`; secrets recorded as env *names* + presence, never values), and a
  `summarizeImport` proven not to leak secret values. Tests: `import.test.ts`
  (4). Workspace now 5 packages; all check/test/build green.
- **Doctor + updater (B18, partial)** — `morrow doctor` now aggregates checks via
  the testable `service/doctor-checks.ts` `aggregateDoctor` (critical vs warning);
  new `morrow update` reports availability via `service/update.ts`
  (`compareSemver`, `checkForUpdate`, injectable `fetchLatestVersion`). Tests:
  `doctor-update.test.ts` (6). CLI 130 green.
- **MCP client (B11, partial)** — `mcp/client.ts`: a transport-agnostic JSON-RPC
  2.0 MCP client (initialize / tools/list / tools/call) with an allow-list that
  filters discovered tools and refuses disallowed calls; `mcp/framing.ts`
  (newline-delimited, malformed-line-tolerant); `mcp/stdio-transport.ts` (spawns
  a server with a filtered env); `mcp/trust.ts` (command+args fingerprint trust,
  settings-backed, no new migration). Tests: `mcp.test.ts` (6, in-process fake
  server). Orchestrator 259 green.
- **Messaging adapters + notifications (B17, partial)** —
  `messaging/adapter.ts`: a `MessageAdapter` contract with a generic
  `webhookAdapter` (works for Slack/Discord incoming webhooks) and a
  `telegramAdapter` (bot token redacted from any error), `loadAdaptersFromEnv`,
  and `notifyAll` fan-out. `POST /api/notify` (injectable adapters seam) and the
  scheduler ticker now notify on a fired schedule (best-effort). Tests:
  `messaging.test.ts` (8) + `schedules.test.ts` notification case. Orchestrator 253.
- **Subagent delegation + task graph (B14, partial)** — `parent_task_id`
  (migration 16) + `tasks.listChildren`; `POST /api/tasks/:id/subagents` spawns
  an isolated child task through the normal runner; `GET /api/tasks/:id/tree`
  returns the recursive descendant tree. Composes with the persistent named
  agents feature now in the tree (`repositories/agents.ts`, `feat(agents)`).
  Tests: `subagents.test.ts` (6). Orchestrator 244 green. (NOTE: my task-graph
  data model was committed inside the concurrent `feat(agents)` commit; my
  subagent routes are in `feat(tasks): subagent delegation`.)
- **Code diagnostics + baseline (B13, partial)** — `workspace/diagnostics.ts`:
  tsc + eslint output parsers → normalized `Diagnostic[]`, and `compareBaseline`
  (error-count-aware, tolerant of line shifts) to prove a change didn't regress.
  `GET /api/projects/:id/diagnostics` (injectable runner). Tests:
  `diagnostics.test.ts` (9) + `diagnostics-api.test.ts` (3). Orchestrator 239 green.
- **Cron scheduler (B7)** — pure UTC cron engine (`schedule/cron.ts`:
  parse/nextRun, leap-day + weekday correct), `schedules` table (migration 14) +
  repo, `SchedulerTicker` (injectable clock) firing isolated task runs through
  the normal runner + containment, API (`GET/POST .../schedules`,
  `DELETE/run`), CLI `schedule list|add|remove|run`, started in `index.ts`
  (disable with `MORROW_DISABLE_SCHEDULER`). Tests: `cron.test.ts` (7) +
  `schedules.test.ts` (8). Orchestrator 227 green.
- **Skill Curator (B6)** — `apps/cli/src/skills/curator.ts`: deterministic
  duplicate detection (`findDuplicates`, Jaccard over SKILL.md), backup/rollback
  (re-verified restore + safety backup), archive/restore (out of discovery),
  pin (config), and an "improve" path (`skills update` = backup → overwrite →
  re-verify). CLI subcommands: dedupe/update/backup/backups/rollback/archive/
  restore/archived/pin/unpin. Tests: `test/skill-curator.test.ts` (5). CLI 124 green.
- **Skill Creator (B5)** — `apps/cli/src/skills/creator.ts`: `validateSkillSpec`
  (id/tool/secret safety), `generateSkillFiles` (checksum matches generated
  SKILL.md so the bundle passes the same `verifySkill` gate as discovery),
  `installSkill` (stages to temp, sandbox-verifies, moves into place, refuses to
  overwrite). `skills create` is now a guided interview/flag flow with a
  permission-review confirm. Tests: `test/skill-creator.test.ts` (7). CLI 119 green.
- **Explicit task retry (B8 retry)** — `records.retryTask` resets a
  `failed`/`interrupted` task to a clean `queued` state (clears continuation +
  agent-state history + assistant message, preserves event audit);
  `POST /api/tasks/:id/retry` (409 unless retryable; never resurrects
  `cancelled`); CLI `MorrowApi.retryTask`. Tests: `test/retry.test.ts` (4).
  Orchestrator 215 green.
- **Skill usage tracking + skill→slash commands (B4)** — per-project
  `skill_usage` counters (migration 13, repo, `GET .../skills/usage` +
  `POST .../skills/:id/use`, `MorrowApi.recordSkillUse`). Verified local skills
  surface as `/skill:<id>` commands (namespaced, never colliding with built-ins),
  wired into the interactive session and invoked via `onSlash`, recording use.
  Tests: orchestrator `skill-usage.test.ts`, CLI `skills.test.ts` +
  `api-search.test.ts`. Suites: orchestrator 211, CLI 112 green.
- **Live provider fallback (B10, partial)** — `provider/fallback.ts`
  `openStreamWithFallback` retries the next configured candidate when the primary
  fails to *start* streaming with a retryable error (transport/timeout/429/5xx);
  fatal request errors and mid-stream errors are never masked; cancellation is
  never a fallback trigger. Wired into `execution/agent.ts`, emits a
  `provider.fallback` event. Tests: `provider-fallback.test.ts` (8) +
  `agent-fallback.test.ts` (2). Orchestrator suite 207 green.
- **Idempotent task creation (B8, partial)** — `tasks(project_id,
  idempotency_key)` partial unique index (migration 12); a repeated
  inspect-workspace request carrying the same `Idempotency-Key` (header or body)
  returns the original task instead of spawning a duplicate. Tests:
  `tasks.test.ts` + `idempotency-api.test.ts`. Orchestrator suite 197 green.
- **Security hard-blocks (B22, partial)** — `command-policy.ts` now denies
  force-push (`git push --force/-f/--force-with-lease`), direct network-transfer
  tools (curl/wget/nc/scp/ssh/rsync/…), and workspace-redirect escapes
  (`git -C`, `--git-dir`, `--prefix`, …), without over-denying read-only flags
  like `git log -C`. Enforced categorically in the agent before any approval, so
  YOLO can never bypass. Tests: `command-policy.test.ts` (8) + end-to-end
  YOLO-bypass cases in `agent-yolo.test.ts`. Orchestrator suite 193 green.
- **Loop detection (B3)** — `execution/loop-detector.ts`: pure, deterministic
  sliding-window detector keyed on stable (arg-order-independent) tool-call
  signatures. Wired into `execution/agent.ts`; a repeated identical action is
  interrupted with reason `loop_detected` and never marked success. Tests:
  `loop-detector.test.ts` (11) + `agent-loop.test.ts` (2). Orchestrator suite
  186 green.
- **Memory provenance, pinning, tiers (B2)** — `pinned` + `originTaskId` (FK to
  tasks, migration 11); `episodic`/`procedural`/`knowledge` recall tiers;
  pin-first ordering in `listActiveForConversation`/`listByProject`; PATCH
  `{pinned}`; CLI `memory pin/unpin` + pinned column. Tests: orchestrator 173
  green (memory + contracts updated), CLI 109 green.
- **Full-text search (B1)** — project-scoped FTS5 over conversations, messages,
  tasks, and memory. `search_index` virtual table + triggers (migration 10),
  `searchRepository`, `GET /api/projects/:id/search`, CLI `/search` command +
  `MorrowApi.search`. Tests: orchestrator 17 (`search.test.ts`,
  `search-api.test.ts`), CLI 3 (`api-search.test.ts`). `pnpm check/test/build`
  green.

## Changelog (newest first)

- 2026-06-23 — B15 local Playwright/CDP browser slice landed. Matrix §9 browser,
  sessions/screenshots/uploads, and prompt-injection protection → VERIFIED;
  managed/cloud browser providers remain missing.
- 2026-06-23 — Tamper-evident hash-chained audit store landed (B22b). Matrix §2
  Persistent audit log → VERIFIED.
- 2026-06-23 — Persisted command history landed (B21 partial). Matrix §1 Command
  history → VERIFIED.
- 2026-06-23 — Execution backend interface + local backend landed (B9 partial).
  Matrix §4 Unified interface + Local → VERIFIED; Docker/SSH → SCAFFOLD stubs.
- 2026-06-23 — Hermes config import landed (B20 partial). Matrix §13
  Migration/import → PARTIAL. `@morrow/hermes-compat` is now a real package.
- 2026-06-23 — Doctor aggregation + updater landed (B18 partial). Matrix §13
  Doctor → VERIFIED, Update → PARTIAL.
- 2026-06-23 — MCP client landed (B11 partial). Matrix §10 MCP stdio client →
  VERIFIED; tool filtering + trust → PARTIAL.
- 2026-06-23 — Messaging adapters + notifications landed (B17 partial). Matrix
  §11 Notifications → VERIFIED, adapters → PARTIAL.
- 2026-06-23 — Subagent delegation + task graph landed (B14 partial). Matrix §3
  Task graph + §14 Subagents → VERIFIED. Persistent named agents feature also
  landed in the tree (concurrent `feat(agents)` commit, integrated).
- 2026-06-23 — Code diagnostics + baseline comparison landed (B13 partial).
  Matrix §8 LSP diagnostics → VERIFIED.
- 2026-06-23 — Cron scheduler landed (B7). Matrix §3 Scheduled jobs + §11 Cron
  scheduler/Isolated runs → VERIFIED. (Also: bundled-skills tests relaxed to a
  subset assertion now that the skill creator writes into the live skills dir.)
- 2026-06-22 — Skill Curator landed (B6). Matrix §6 fully VERIFIED (Creator +
  Curator).
- 2026-06-22 — Skill Creator landed (B5). Matrix §6 (interview→generate, sandbox
  test, permission review+install) → VERIFIED.
- 2026-06-22 — Explicit task retry landed (B8 retry). Matrix §3 Retry → VERIFIED.
- 2026-06-22 — Skill usage tracking + skill→slash commands landed (B4). Matrix
  §5 both rows → VERIFIED.
- 2026-06-22 — Live provider fallback landed (B10 partial). Matrix §12 Fallback
  → VERIFIED. New `provider.fallback` task event.
- 2026-06-22 — Idempotent task creation landed (B8 partial). Matrix §3
  Idempotency → VERIFIED.
- 2026-06-22 — Security hard-blocks (force-push, network-exfil,
  workspace-redirect) landed. Matrix §2 hard-block row → VERIFIED.
- 2026-06-22 — B3 loop detection landed. Matrix §3 "Loop detection" → VERIFIED.
- 2026-06-22 — B2 memory provenance + pinning + tiers landed. Matrix §7 rows
  (Episodic/procedural/knowledge, Provenance, Pin) → VERIFIED.
- 2026-06-22 — B1 full-text session & memory search landed (FTS5). Matrix §3 +
  §7 FTS rows → VERIFIED.
- 2026-06-22 — Authored parity matrix, master goal, backlog, status, and
  continuation docs from first-hand inspection of both repos. Baseline captured.
