# Hot-path performance

Morrow's per-turn cost is dominated by a handful of pure functions and durable
writes that run once per provider chunk, once per tool call, or once per token.
This document records what those are, what they cost, and how to re-measure them
so a regression shows up as a number rather than as "the agent feels slow".

## Reproducing

```bash
pnpm --filter @morrow/orchestrator exec tsx benchmark/hot-paths.ts
pnpm --filter @morrow/orchestrator exec tsx benchmark/explain-hot-queries.ts
```

`hot-paths.ts` measures token accounting, canonical request projection, context
trimming, secret redaction, and durable writes against a realistic 361-message /
24-tool context. `explain-hot-queries.ts` runs `EXPLAIN QUERY PLAN` over the
statements Morrow issues most often and exits non-zero if any of them falls back
to a table scan, or if a chronological conversation/tool-call list needs a
temporary sort. It is meant to be cheap enough to run in CI.

## Measured baseline (2026-08-19, 361-message context, SSD)

| Path | Before | After |
| --- | ---: | ---: |
| `countChatTokens` (exact tiktoken route) | 25.95 ms | 0.05 ms |
| `measureProviderRequest` | 27.02 ms | 1.48 ms |
| `projectProviderRequest` (per turn) | 84.70 ms | 3.78 ms |
| `trimMessagesToBudget` | 2.63 ms | 0.06 ms |
| `redactSecrets` on a 199 KB source blob | 2.03 ms | 0.34 ms |
| `redactSecrets` on a 120 KB JSON blob | 1.76 ms | 0.23 ms |
| Durable event write (`synchronous=FULL` vs `NORMAL`, see note) | 0.71 ms | 0.10 ms |
| Persisting one 2000-chunk streamed response | 999 ms | 42 ms |

## Where the cost was

**Token counting was recomputed from scratch several times per turn.** One
provider projection measures the same history three times — the original
measurement, the admission check, and the envelope hash — and compaction
re-measures every candidate. Counts are now memoized per message, keyed by
message identity and *validated* against the exact fields the counters read,
because the agent rewrites message bodies in place. A stale count would
mis-budget the context, so a memo entry is only reused when every counted field
still compares equal. Tool-schema reserves are memoized on the schema array.

**`measureProviderRequest` copied every message before counting**, which both
allocated a fresh array per call and defeated the memo. The three fields the
copy removed are accounted for separately and are read by neither counter, so
counting the caller's objects directly is equivalent.

**`trimMessagesToBudget` was quadratic**, rebuilding and re-counting the whole
candidate history at every position. It now accumulates suffix totals.

**Redaction ran seven regex passes over every string** crossing a persistence or
log boundary — including whole files and command output. It now runs a single
superset test first and returns untouched strings immediately.
`test/redaction-fast-path.test.ts` asserts the guard never disagrees with the
unguarded chain, across a curated corpus and 20,000 seeded random strings.

**Streamed text was persisted once per provider chunk** — often once per token —
each write rewriting the whole accumulated message (redacted end to end, so
quadratic in response length) plus a durable event insert. Writes are now
coalesced into a flush window (`MORROW_STREAM_FLUSH_MS`, default 60ms). Nothing
is dropped or reordered, and every exit from the stream — normal end,
cancellation, provider error — forces a flush before anything else is recorded.
`test/streaming-write-coalescing.test.ts` is the contract.

**SQLite's durability mode was left implicit.** Under WAL, `synchronous =
NORMAL` fsyncs at checkpoints instead of at every commit: a crashed Morrow
process — the failure the durable log exists to survive — loses nothing, and
only an OS crash or power loss can drop the most recent commits, with no risk of
corruption. Explicitly setting it measures 7x faster than `FULL` (0.71ms ->
0.10ms per event on SSD).

Note the honest scope of that win. better-sqlite3's SQLite is built with
`SQLITE_DEFAULT_WAL_SYNCHRONOUS=1`, so a connection that opens an *already-WAL*
database was silently getting `NORMAL` anyway. The old code only ran `FULL` on
the very first open, where `journal_mode = WAL` is applied to a fresh database
after the connection has already defaulted to `FULL`. So this change makes the
mode explicit and consistent, and fixes first-run write cost, but it is not a 7x
improvement on a steady-state install — that install was already at `NORMAL` by
accident. `MORROW_SQLITE_SYNCHRONOUS=FULL` opts back in. `prepare` is also memoized by SQL
text (installed after migrations, PRAGMAs excluded, bounded), and
`task_evidence` gained the `task_id` index it was missing.

**The exact tokenizer cost ~350ms and ~66MB to build**, lazily, inside the
user's first turn. It is now built at boot on an idle process — but only when an
OpenAI-family provider is actually configured, so a local-only install never
carries the memory. `MORROW_DISABLE_TOKENIZER_WARMUP=true` disables it.

## Ordering bug found on the way

`task_evidence`, `conversation_messages`, `approvals`, and `action_attempts`
were listed with `ORDER BY created_at ASC, id ASC`. `created_at` is an ISO
string with millisecond resolution and `id` is a random UUID, so any rows
written inside the same millisecond came back in arbitrary order — measured at
164 out of 200 trials for three screenshots captured back to back. The listings
now tie-break on `rowid`, which is insertion order, matching what
`message_tool_calls` already did. `test/same-millisecond-ordering.test.ts`
covers it.

This surfaced as an intermittent failure of the responsive-validation contract
test: the faster agent simply lands more writes inside one millisecond.

## Deliberately not done

**Parallel tool execution.** Morrow's read tools (`read_file`, `list_files`,
`search_text`, `inspect_workspace`) are synchronous local filesystem calls, so
overlapping them buys nothing; the tools that are actually slow (`run_command`,
browser actions) mutate state and cannot be reordered safely. The sequential
tool loop is not where the time goes.

## 2026-08-23 follow-up

Migration 65 replaced the single-column conversation and tool-call lookup
indexes with `(foreign_key, created_at)` indexes. This preserved the filtering
prefix and removed three temporary chronological sorts. The repeatable
8,000-row benchmark measured 9.6% to 23.7% lower list latency; see
[`performance-report-2026-08-23.md`](performance-report-2026-08-23.md) for the
numbers, environment, commands, startup budgets, and deterministic pi comparison.
