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

- **Full-text search (B1)** — project-scoped FTS5 over conversations, messages,
  tasks, and memory. `search_index` virtual table + triggers (migration 10),
  `searchRepository`, `GET /api/projects/:id/search`, CLI `/search` command +
  `MorrowApi.search`. Tests: orchestrator 17 (`search.test.ts`,
  `search-api.test.ts`), CLI 3 (`api-search.test.ts`). `pnpm check/test/build`
  green.

## Changelog (newest first)

- 2026-06-22 — B1 full-text session & memory search landed (FTS5). Matrix §3 +
  §7 FTS rows → VERIFIED.
- 2026-06-22 — Authored parity matrix, master goal, backlog, status, and
  continuation docs from first-hand inspection of both repos. Baseline captured.
