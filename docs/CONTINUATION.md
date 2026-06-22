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

## Where we are

- Durable docs written and maintained (parity matrix, master goal, backlog,
  status, this file).
- **B1 — Full-text search: DONE & VERIFIED.** FTS5 `search_index` (migration 10)
  over conversations/messages/tasks/memory; `searchRepository`;
  `GET /api/projects/:id/search`; CLI `/search` + `MorrowApi.search`. 20
  orchestrator + 3 CLI tests green. `pnpm check/test/build` green.

## Exact next step — B2: Memory provenance + pin + tiers

1. `packages/contracts/src/index.ts` — extend `MemoryScopeSchema` with
   `episodic`, `procedural`, `knowledge`; add `pinned: z.boolean()` and an
   `originTaskId: z.string().nullable()` (or a `provenance` object) to
   `MemoryEntrySchema`; extend `CreateMemoryEntrySchema` with optional `pinned`.
2. `services/orchestrator/src/database.ts` — migration 11: `ALTER TABLE
   memory_entries ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0; ADD COLUMN
   origin_task_id TEXT;` (FTS triggers already key off `content`, no change
   needed there — but update the `search_mem_*` body if scope label changes).
3. `services/orchestrator/src/repositories/memory.ts` — map `pinned`/origin;
   add `setPinned(id, pinned, updatedAt)`; make retrieval order pinned-first
   (`ORDER BY pinned DESC, created_at ASC`).
4. `services/orchestrator/src/server.ts` — extend `PATCH /api/memory/:id` to
   accept `{ pinned?: boolean }`; allow new scopes in create.
5. Tests: extend `test/memory.test.ts` — pinned ordering, new scopes round-trip,
   origin provenance preserved. Update `database.test.ts` migration count to 11.
6. CLI: surface pin in `/memory` flow (optional this slice; can defer to B-later).
7. `pnpm check && pnpm test && pnpm build`. Update matrix §7 rows
   (Episodic/procedural/knowledge, Provenance, Pin) + status. Commit
   `feat(memory): provenance, pinning, and memory tiers` and push.

## Failing test to write first

`test/memory.test.ts` — "returns pinned entries before unpinned ones regardless
of creation order" (write red against current repo, then implement).

## Open risks / notes

- Migration 11 changes `memory_entries`; the FTS `search_mem_au` trigger fires on
  `UPDATE OF content` only — pin/origin updates won't touch the index, which is
  correct (pin state isn't searchable). No trigger change required.
- Bumping `MemoryScopeSchema` is a breaking enum widening; check every consumer
  (`server.ts` create route conditionals, CLI memory command) compiles.
- Keep memory strictly project-isolated (existing invariant + test).
