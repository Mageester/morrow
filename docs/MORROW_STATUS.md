# Morrow Status

Snapshot of what is **verified working** right now, updated as slices land.

## Build / test health (2026-06-22)

- `pnpm test`: **105 tests / 23 files green** (apps/cli). Contracts + orchestrator
  suites green (turbo-cached).
- Orchestrator HTTP routes: ~45 (`services/orchestrator/src/server.ts`).
- Agent tools: 10. Built-in signed skills: 6.

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
