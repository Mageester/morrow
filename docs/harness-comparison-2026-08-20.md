# Morrow vs pi — same tasks, same model

**Morrow loses.** On 25 tasks run twice against `deepseek-v4-flash`, Morrow
solved fewer of them than pi, cost 2.4x as much per task, took more turns and
more tool calls, and claimed success it had not earned twice as often.

| | Morrow | pi |
| --- | ---: | ---: |
| Pass rate | **92%** (46/50) | **96%** (48/50) |
| Median cost per task | **$0.0017** | **$0.0007** |
| Median wall time | 14s | 13s |
| Median turns | 6 | 5 |
| Overclaimed (said done, was not) | **4** | 2 |

There is no reading of this table where the apparatus paid for itself. Morrow is
a harness with missions, requirements, completion contracts, an evidence ledger,
skills, Cortex and provider-compatibility repair; pi is 796 lines and seven
tools. Against the same model on the same work, the 796 lines won.

This document is the method and the caveats. The numbers above are the point.

## What was held constant

Same model and provider account. Same 25 tasks in the same order. Byte-identical
prompts. A fresh fixture per harness per task. The same 8-minute wall-clock
ceiling. The same hidden check, run the same way after the agent stopped.
Neither side got `AGENTS.md`/`CLAUDE.md`. Cost recomputed for both from one
price sheet applied to each harness's own token counts.

Full method, including what could *not* be held constant, is in
[`benchmarks/harness-comparison/README.md`](../benchmarks/harness-comparison/README.md).

## How the tasks were kept honest

25 tasks: 15 defect fixes, 10 small builds, all dependency-free Node ESM.

The hidden check never exists in the workspace the agent worked in. After the
agent stops, the workspace is copied elsewhere and the check is written into the
copy — nothing can read, edit, satisfy by name, or delete the thing that grades
it. For defect tasks the visible symptom is deliberately narrower than the
check, with the full contract stated in the fixture's `SPEC.md`, so
special-casing the one symptom the prompt names does not pass.

`validate.ts` asserts both directions for all 25: every check fails on the
untouched fixture (or the task is free) and passes on a committed reference
solution (or the task is impossible and the check is grading itself).

## Why Morrow costs more — and what it is not

The obvious hypothesis was that Morrow invalidates its own prompt cache.
Uncached input costs 50x cached on this provider, so a harness that keeps
breaking its prefix pays enormously for context it already sent.

**That hypothesis is wrong**, and it was cheap to disprove.
`benchmarks/harness-comparison/prefix-stability.ts` drives a real task through a
recording provider and measures each request against the standard a cache
requires — request N+1 must begin with request N, byte for byte. Morrow's
context is append-only across every request, and the tool-schema block is
byte-identical on all of them. Nothing is re-sent. "Make the context
cache-stable" is not available as a cheap win.

What the probe does establish is the fixed cost: **21 tool schemas, 12,745
characters (~3,190 tokens) — roughly twice the entire message history of the
finished task.** pi exposes seven tools and its whole first request was 1,752
tokens. This confirms by direct measurement the ~3,242-token schema figure this
repository had previously only inherited.

The recurring per-turn cost is measured but **not yet attributed**. Morrow's
median run spends 28,315 input tokens to pi's 12,537, and the deterministic
probe does not reproduce a gap that large, so something the live model does is
not in the scripted path. Per-request `[input, cached]` capture is now
instrumented in both adapters and will answer it; it was added after this run
started, so these results do not carry it. **No subsystem should be cut on the
strength of this document until that measurement exists.**

## Caveats, stated plainly

- **Two repeats, not three.** A third repeat was interrupted at 33 of 50 runs
  when its process died. Including a partial repeat would silently double-weight
  whichever tasks ran first, so `report.ts` drops incomplete repeats
  automatically and reports what it dropped. Two complete repeats is enough for
  the aggregate and is not enough to rank the harnesses on any single task.
- **One model.** Everything here is `deepseek-v4-flash`. A harness that carries
  weak models could plausibly look better on a weaker model and worse on a
  stronger one. This is one point on that curve.
- **Missions are dormant.** Morrow's mission, guardian and checkpoint machinery
  activates only for tasks carrying a mission id. These runs carry none, so this
  measures Morrow-without-missions. That apparatus costs nothing here and earns
  nothing here; it needs a different task shape to evaluate at all.
- **Claude Code is deliberately absent.** It cannot be pointed at
  `deepseek-v4-flash`, so including it would confound harness with model, and
  the model is the larger effect. An honest one-baseline result is worth more
  than a rigged two-baseline one.
- **pi's turn count is its own.** Morrow counts a turn per provider stream
  attempt; pi counts one per assistant message. They agree on clean runs and can
  differ by a retry.

## Reproducing

```bash
pnpm --filter @morrow/orchestrator exec tsx ../../benchmarks/harness-comparison/validate.ts
pnpm --filter @morrow/orchestrator exec tsx ../../benchmarks/harness-comparison/run.ts --harnesses morrow,pi --repeats 3
pnpm --filter @morrow/orchestrator exec tsx ../../benchmarks/harness-comparison/report.ts --input benchmarks/harness-comparison/results
```

Requires `DEEPSEEK_API_KEY` and `PI_BINARY`. Evidence streams to JSONL as it
lands, so an interrupted run still leaves usable data — as this one did.

---

## Headline

| Harness | Tasks scored | Passed | Pass rate | Median cost | Total cost | Median wall time | Median turns | Median tool calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| morrow | 50 | 46 | 92% | $0.0017 | $0.0867 | 14s | 6 | 7 |
| pi | 50 | 48 | 96% | $0.0007 | $0.0508 | 13s | 5 | 6 |

## Claim accuracy

A harness's own verdict versus the hidden check. `Overclaimed` is the number the harness reported finished that ground truth rejects — the failure mode that costs a user real trust.

| Harness | Overclaimed | Underclaimed | Timeouts | Excluded (environment) |
| --- | ---: | ---: | ---: | ---: |
| morrow | 4 | 0 | 0 | 0 |
| pi | 2 | 0 | 0 | 0 |

## Where the tokens go

`First turn` is what the harness spends before the task has generated any conversation at all — system prompt, tool schemas, injected context. `Total input` is every input token across the run. The gap between them is the conversation; the first-turn figure is the fixed cost of the harness existing.

| Harness | Median first-turn input | Median total input | Median turns |
| --- | ---: | ---: | ---: |
| morrow | 3963 | 28315 | 6 |
| pi | 1752 | 12537 | 5 |

## Per task

| Task | Category | morrow result | pi result | morrow cost | pi cost | morrow turns | pi turns |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| `pagination-last-page` | defect | 1/2 | 2/2 | $0.0014 | $0.0006 | 6 | 6 |
| `esm-require` | defect | 1/2 | 2/2 | $0.0017 | $0.0004 | 6 | 5 |
| `authz-and-or` | defect | 0/2 | 0/2 | $0.0022 | $0.0006 | 8 | 7 |
| `date-utc-drift` | defect | 2/2 | 2/2 | $0.0014 | $0.0006 | 6 | 6 |
| `retry-inverted` | defect | 2/2 | 2/2 | $0.0016 | $0.0005 | 7 | 4 |
| `merge-mutates` | defect | 2/2 | 2/2 | $0.0019 | $0.0006 | 6 | 5 |
| `csv-quoted-commas` | defect | 2/2 | 2/2 | $0.0017 | $0.0008 | 7 | 4 |
| `sort-numeric` | defect | 2/2 | 2/2 | $0.0014 | $0.0005 | 6 | 5 |
| `regex-escape` | defect | 2/2 | 2/2 | $0.0017 | $0.0006 | 8 | 6 |
| `async-foreach` | defect | 2/2 | 2/2 | $0.0011 | $0.0005 | 5 | 5 |
| `cache-ttl` | defect | 2/2 | 2/2 | $0.0016 | $0.0005 | 6 | 5 |
| `debounce-timer` | defect | 2/2 | 2/2 | $0.0015 | $0.0004 | 5 | 4 |
| `build-slugify` | build | 2/2 | 2/2 | $0.0015 | $0.0005 | 5 | 5 |
| `build-semver` | build | 2/2 | 2/2 | $0.0024 | $0.0013 | 7 | 7 |
| `build-ini` | build | 2/2 | 2/2 | $0.0015 | $0.0006 | 5 | 5 |
| `build-argv` | build | 2/2 | 2/2 | $0.0023 | $0.0016 | 6 | 6 |
| `build-flatten` | build | 2/2 | 2/2 | $0.0024 | $0.0041 | 10 | 10 |
| `build-token-bucket` | build | 2/2 | 2/2 | $0.0015 | $0.0007 | 5 | 5 |
| `build-event-emitter` | build | 2/2 | 2/2 | $0.0017 | $0.0010 | 7 | 5 |
| `build-wordcount-cli` | build | 2/2 | 2/2 | $0.0020 | $0.0011 | 9 | 8 |
| `two-bugs-one-symptom` | defect | 2/2 | 2/2 | $0.0017 | $0.0006 | 5 | 5 |
| `stateful-bug` | defect | 2/2 | 2/2 | $0.0016 | $0.0006 | 5 | 5 |
| `regression-guard` | defect | 2/2 | 2/2 | $0.0020 | $0.0010 | 6 | 5 |
| `multi-file-contract` | defect | 2/2 | 2/2 | $0.0018 | $0.0012 | 7 | 6 |
| `build-json-pointer` | build | 2/2 | 2/2 | $0.0018 | $0.0046 | 7 | 8 |

## Self-reported cost, as a cross-check

Every dollar figure above is recomputed from one price sheet applied to each harness's own token counts. These are the harnesses' own totals, for comparison:

| Harness | Self-reported total | Recomputed total |
| --- | ---: | ---: |
| morrow | $0.0867 | $0.0867 |
| pi | $0.0508 | $0.0508 |
