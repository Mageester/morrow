# Continuation

> Always names the **exact** next step so any agent (or a fresh session) can
> resume without re-deriving context. Update this at every interruption.

## Resume command

```bash
cd "C:/Users/aidan/OneDrive/Documents/PlaceHolder"
git checkout feat/morrow-agent-terminal
pnpm install
pnpm test            # expect green baseline
```

## Where we are

Durable docs written (parity matrix, master goal, backlog, status, this file).
Baseline green: 105 tests. Beginning backlog item **B1 — Session & memory search
(FTS)**.

## Exact next step

Implement **B1. Session & memory search (FTS5)**:

1. `packages/contracts/src/index.ts` — add `SearchQuerySchema`,
   `SearchHitSchema`, `SearchResponseSchema` (kinds: `conversation`, `message`,
   `task`, `memory`).
2. `services/orchestrator/src/repositories/search.ts` — new repo. Create FTS5
   virtual tables + triggers in a migration in `database.ts`; expose
   `search(projectId, query, opts)` returning ranked hits with snippets.
3. `services/orchestrator/src/server.ts` — add
   `GET /api/projects/:projectId/search?q=...&kind=...`.
4. `services/orchestrator/src/repositories/search.test.ts` — index fixtures,
   assert ranking, snippet, scope filter, and empty-query handling.
5. `apps/cli` — add `/search` slash command + `search` subcommand using the API
   client; render hits in the TUI.
6. Run `pnpm check && pnpm test && pnpm build`. Update matrix §3/§7 rows + status.
7. Commit `feat(search): full-text session and memory search` and push.

## Failing test to write first

`services/orchestrator/src/repositories/search.test.ts` — "ranks an exact phrase
match in a message above a partial match and returns a snippet" (write red, then
implement to green).

## Open risks / notes

- `better-sqlite3` is already a dependency; confirm FTS5 is compiled in (it is in
  the prebuilt binaries). Add a guard + clear error if `fts5` is unavailable.
- Keep search **project-scoped**; never index across projects.
- Do not index secrets: exclude memory entries flagged secret (none yet) and
  redact obvious token patterns at index time.
