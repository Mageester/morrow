# Performance and harness comparison — 2026-08-23

Measured implementation commit: `f4c158e1bad7d769197bad22b2f9d3bad0534bdf`  
Release baseline: `91544415673ef3e550f77ff6aad13f6064c98f38` (`v0.4.0`)  
Machine: Fedora Linux 44, kernel 7.1.8, Intel Core Ultra 5 226V (8 cores), x86-64, Node 22.23.2.

No provider credential was available, so this pass spent no provider money and
does not replace the live DeepSeek comparison from 2026-08-20. The ordinary
provider benchmark exited truthfully with `No provider route is configured`.

## User-perceived startup

| Metric | Before | After | Change | CI budget |
| --- | ---: | ---: | ---: | ---: |
| `morrow --version` cold process, median | 230 ms (10 runs) | 23.8 ms (7 runs) | **-89.6%** | 150 ms |
| Built service process to `/api/health`, median | 549 ms (7 runs) | 557.8 ms (5 runs) | no material change | 1,200 ms |
| Deterministic task start to first provider text chunk | not separately baselined | 30.0 ms | gate only | 250 ms |

The CLI win comes from answering the simple version diagnostic before loading
tsx and the terminal command registry. The packaged launcher already had this
fast path; source installs now have it too. Service boot and first-token numbers
are recorded as budgets, not claimed as wins.

Reproduce the current medians and enforce the budgets:

```bash
pnpm build
pnpm --filter @morrow/orchestrator benchmark:startup --check
```

The command creates isolated temporary homes and databases. It never reads or
writes the operator's Morrow data.

## Ordered SQLite hot reads

The three chronological list queries used in conversation projection had an
index for filtering, but SQLite still built a temporary B-tree for every
`ORDER BY created_at, rowid`. Migration 65 extends the existing indexes with
`created_at`; the implicit rowid suffix provides the deterministic tie-break.

On a synthetic 8,000-row list, 15 samples per query:

| Query | Prior single-column index | Ordered index | Change |
| --- | ---: | ---: | ---: |
| Messages by conversation | 7.181 ms | 5.478 ms | **-23.7%** |
| Tool calls by message | 8.448 ms | 7.504 ms | **-11.2%** |
| Tool calls by task | 8.461 ms | 7.652 ms | **-9.6%** |

```bash
pnpm --filter @morrow/orchestrator benchmark:query-latency
pnpm --filter @morrow/orchestrator benchmark:query-plans
```

The first command measures the old and new index shapes against the same rows.
The second is the CI gate: all three production-order queries must use an index
without `USE TEMP B-TREE FOR ORDER BY`. The remaining teammate-trust sort has at
most two indexed candidates and is not represented as a latency win.

## Deterministic Morrow versus pi

The new local comparison gives both harnesses the same three file tasks and the
same scripted model decisions. Every run is hidden-check graded. The provider
is a loopback OpenAI-compatible fixture with synthetic usage derived from each
harness's actual request bytes; DeepSeek V4 Flash's shared price sheet converts
those tokens to an estimated cost. This measures harness overhead, not model
quality.

Three repeats, nine tasks per row:

| Harness | Passed | Median input | Median output | Provider calls | Tool calls | Median wall | Estimated cost/task |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Morrow, prior broad coding profile | 9/9 | 15,829 | 107 | 4 | 3 | 29.2 ms | $0.002246 |
| Morrow, focused bounded-file profile | 9/9 | 10,239 | 107 | 4 | 3 | 24.0 ms | $0.001463 |
| pi 0.84.1 | 9/9 | 6,240 | 103 | 4 | 3 | 574.4 ms | $0.000902 |

For these bounded tasks, Morrow's focused profile reduced median input tokens by
**35.3%** and estimated cost by **34.9%**, with the same passes, provider calls,
and tool calls. It keeps inspect/read/search, diff, command verification,
patch/create/append, and oversized-result retrieval. Broad, browser, skill,
team, process, and repository-wide requests retain their larger profiles. The
`focused-tool-profile` ablation restores the prior profile for repeatable A/B
measurement.

Morrow still used **64% more input tokens** than pi in this fixture and cost
62% more. That gap remains work to do. The wall-clock row must not be read as a
speed comparison: Morrow is invoked in-process, while pi is deliberately driven
as its shipping CLI and therefore includes a fresh process startup on every
task. Tokens, calls, hidden-check outcome, and cost are the controlled claims.

```bash
PI_BINARY="$(command -v pi)" pnpm --filter @morrow/orchestrator exec tsx \
  ../../benchmarks/harness-comparison/deterministic.ts --repeats 3
```

## Existing hot paths rechecked

The 361-message/24-tool microbenchmark remained in the established range:
exact token counting 0.078 ms/op, request measurement 2.397 ms/op, compaction
projection 3.287 ms/op, guarded 199 KB redaction 0.388 ms/op, durable event
append 0.021 ms/op, and a 2,000-chunk coalesced stream 42.465 ms versus 998.416
ms when persisted per chunk. These are validation numbers, not new wins.

```bash
pnpm --filter @morrow/orchestrator benchmark:hot-paths
```

## Limits

- The live benchmark, live TTFT, and live cost comparison were not rerun because
  no provider route was configured.
- The deterministic comparison covers three bounded file tasks. It proves the
  profile retains those capabilities; it does not establish a general quality
  ranking.
- Timings are local machine measurements and CI budgets deliberately include
  substantial headroom for runner variance.
