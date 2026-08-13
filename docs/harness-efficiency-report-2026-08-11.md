# Morrow harness efficiency investigation

Date: 2026-08-11  
Branch: `codex/agent-freedom-release`  
HEAD at verification: `c1b35d6fbcb997e435e08c5aff8487a01325aa77` (`feat(web): polish command workspace and reasoning controls`)

## Executive result

This pass found and repaired four correctness/efficiency defects in the execution
harness and added a deterministic economics benchmark. The repairs are local and
fully tested. They do not establish that Morrow is more efficient than Hermes,
Pi, or another harness: Hermes is installed locally, but Pi is not discoverable,
and no equivalent black-box task set was run.

The largest measured remaining opportunity is harness-generated tool-schema
overhead. In the simple local task, Morrow's conservative request measurement was
12,945 input tokens, of which 12,297 were tool schemas and 14 were protocol
overhead. That is approximately 95% of the measured request envelope. The
current agent profile intentionally exposes the complete executable tool catalog;
changing that contract needs a separate capability/success benchmark, so this
pass records the opportunity rather than making an unsafe speculative reduction.

The corrected deterministic run produced 13 successes, one intentional partial
artifact outcome, and one intentional bounded provider failure across 15 scenarios:

| Outcome | Count | Rate |
| --- | ---: | ---: |
| Success | 13 | 86.7% |
| Partial | 1 | 6.7% |
| Failure | 1 | 6.7% |

These rates are Morrow-only local fixture evidence, not a product-wide success
claim.

## Scope and evidence boundaries

- No provider credentials or secrets were inspected.
- No live provider call was made in this pass; live spend was `$0.00`.
- The reasoning wire test uses a mocked local `fetch` and never opens a socket.
- The deterministic task provider is an in-process transcript provider. Its usage
  values are synthetic but derived from Morrow's measured request envelope.
- Provider-reported reasoning-token fields are absent from the current provider
  usage contract, so `reasoningTokens` is recorded as `null`, never fabricated as
  zero.
- Time-to-first-token is represented locally by time to the first scripted
  provider chunk. It is a proxy, not live provider TTFT.
- An earlier append-only benchmark row set exposed a fixture ordering mistake in
  the long-context scenario. Those rows remain in
  `benchmarks/harness-economics/deterministic-evidence-2026-08-11.jsonl`; the
  corrected derived report uses rows tagged
  `benchmarkRun=corrected-fixture-2026-08-11`.

Runtime checks found no Morrow orchestrator listening on port 4317. The only
Morrow-repository listeners were the existing web Vite processes: PID 43736 on
4318 and PID 42936 on 4319. Their command lines identify `apps/web` Vite, not the
orchestrator. The checked-out worktree was the requested path and was two commits
ahead of `main` with no merge-base divergence (`main...HEAD = 0 2`).

Hermes was available as `Hermes Agent v0.18.2 (2026.7.7.2)`; `pi` was not on PATH.
The comparison is therefore explicitly deferred. A historical, already-present
Morrow live snapshot records two failed DeepSeek rows, not a fresh comparison:
V4 Flash had 2 provider calls, 1 tool call, 7,285 input tokens, 804 output tokens,
and 8,828 ms; V4 Pro had 3 provider calls, 2 tool calls, 10,236 input tokens,
496 output tokens, and 13,628 ms. See
`benchmarks/harness-economics/morrow-live-deepseek-snapshot.json`.

## Deterministic baseline

The benchmark is implemented in
`benchmarks/harness-economics/deterministic.ts` and writes append-only JSONL
evidence plus a derived JSON/SVG summary. Every task uses the same local model
label (`deepseek-v4-flash`), provider route label, balanced preset, fixed clock,
isolated temporary workspace, and scripted transcript. Costs use the explicit
DeepSeek V4 Flash price object in `metrics.ts`; they are estimates, not provider
metering.

Latest corrected run (`corrected-fixture-2026-08-11`):

| Scenario | Outcome | Provider calls | Tool calls | Input tokens | Output tokens | Task ms | Extra evidence |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| simple answer | success | 1 | 0 | 12,945 | 12 | 125 | no verification needed |
| read/search/summarize | success | 3 | 2 | 39,172 | 36 | 132 | context growth 181 |
| duplicate read dedup | success | 3 | 2 | 39,231 | 36 | 119 | 1 duplicate observation |
| multi-file edit | success | 3 | 4 | 39,558 | 36 | 132 | mutation plus verification |
| new-file creation | success | 3 | 2 | 39,224 | 36 | 120 | mutation plus verification |
| file-write failure/retry | success | 4 | 3 | 52,808 | 48 | 122 | 1 tool failure, then retry |
| failed-tool recovery | success | 3 | 2 | 39,014 | 36 | 118 | 1 tool failure |
| long context | success | 1 | 0 | 12,985 | 12 | 242 | 322 seeded messages, 3 compactions |
| reasoning off | success | 1 | 0 | 12,942 | 12 | 123 | disabled thinking wire |
| reasoning low | success | 1 | 0 | 12,942 | 12 | 121 | normalized to DeepSeek `high` |
| reasoning high | success | 1 | 0 | 12,943 | 12 | 116 | DeepSeek `high` |
| mutation verification required | success | 3 | 2 | 39,239 | 36 | 122 | verification read required |
| partial artifact | partial | 3 | 2 | 39,198 | 36 | 121 | intentional wrong artifact contract |
| provider fallback retry | success | 2 | 0 | 12,755 | 12 | 409 | 1 fallback event |
| provider recovery failure | failure | 3 | 0 | n/a | n/a | 117 | 2 recovery attempts, bounded |

The derived summary reports a median estimated cost of `$0.003696` for the 13
cost-bearing rows and a median task duration of 121 ms. The fallback row omits
pricing because its successful response came from the alternate fixture route;
the provider-failure row has no provider usage. No cost is claimed for either.

The local timing instrument reports approximately 0.001 ms to the first scripted
chunk and less than 1 ms of scripted provider stream time. Those values measure
the in-process fixture, not network or model latency. The task duration above is
the meaningful local wall-clock measurement.

### Model/provider versus harness overhead

The scripted model output is fixed at 12 tokens per answer turn, 36 tokens for
three-turn tasks, and 48 tokens for the four-turn write-retry task. That is not a
quality or provider-efficiency measurement. The measured request envelope breaks
down as follows:

| Scenario | Input | Tool schemas | Protocol | Continuation | Total harness overhead |
| --- | ---: | ---: | ---: | ---: | ---: |
| simple answer | 12,945 | 12,297 | 14 | 0 | 12,311 |
| duplicate read dedup, 3 requests | 39,231 | 36,891 | 42 | 0 | 36,933 |
| file-write retry, 4 requests | 52,808 | 49,188 | 56 | 0 | 49,244 |
| long context after compaction | 12,985 | 12,297 | 14 | 0 | 12,311 |

The measurement is deliberately conservative and includes the complete tool
schema envelope on every request. It is suitable for comparing changes within
Morrow, not for asserting exact provider billing. `measureProviderRequest` is at
`services/orchestrator/src/execution/context-budget.ts:196`; the agent's complete
profile selection is at `services/orchestrator/src/execution/agent.ts:1610`.

## Reproduced issues and repairs

### 1. Applied `append_file` history was still executable

Root cause: `capToolArgumentsForContext` redacts successful `append_file` bodies
to `_morrowAppliedWrite` metadata at `agent.ts:520`, but
`provider-projection.ts:43-44` only recognized `create_file` and
`propose_patch` as applied-write records. After compaction, an append marker was
therefore projected as a normal tool call whose `content` was missing. That is
the direct path to the observed `"content" or "patch" is missing` failure.

Repair: include `append_file` in `appliedWriteRecord`, making the compacted
history a non-executable historical record. Regression test:
`services/orchestrator/test/provider-projection.test.ts:163`.

Strict TDD evidence:

- RED: the new test observed one projected tool call where zero were expected.
- GREEN: after the one-condition fix, the focused projection test passed.

Expected effect: avoid replaying an already-applied write, avoid a corrective
model turn, and avoid re-sending the full write body. Deterministic projection
behavior changed from one executable call to zero executable calls for this
case; the full write-retry scenario remains successful when the initial write
is genuinely malformed.

### 2. Equivalent read calls with reordered JSON keys bypassed deduplication

Root cause: the executor keyed the safe-observation cache with raw argument
JSON. The loop detector already had a canonical recursive JSON signature, but
the execution cache did not share it.

Repair: use `toolCallSignature` for the safe read-observation cache at
`services/orchestrator/src/execution/agent.ts:4727`. Writes, commands, and
browser interactions remain outside this deduplication path. Regression test:
`services/orchestrator/test/agent-loop.test.ts:174`.

Strict TDD evidence:

- RED: reordered-key search calls produced zero `duplicate=true` observations;
  the test expected one.
- GREEN: canonicalized arguments produced one duplicate observation and the
  focused test passed.

Expected effect: one workspace read execution and one duplicate result are
avoided when a provider repeats the same read with semantically equivalent JSON.
The provider may still take a turn to issue the repeated call; this repair does
not claim a provider-call reduction.

### 3. Provider-call accounting counted responses, not attempts

Root cause: `projectFlagshipEfficiency` previously used `provider.usage` event
count as provider-call count. A provider that failed before returning a usage
chunk disappeared from the measurement. The same issue hid some recovery/fallback
work.

Repair: `openStreamWithFallback` accepts an attempt callback at
`services/orchestrator/src/provider/fallback.ts:106-120`; the agent persists a
minimal `provider.request_started` event (provider, model, route fingerprint)
at `agent.ts:4348`. `projectFlagshipEfficiency` prefers these attempt events and
falls back to usage counts for old append-only rows at
`services/orchestrator/src/acceptance/flagship-runner.ts:82-105`. The event is
included in the contracts enum and test at `packages/contracts/src/index.ts:33`
and `packages/contracts/test/task-events.test.ts:6`.

Strict TDD evidence:

- RED: a primary connection failure plus a successful fallback produced zero
  attempt events where two were expected.
- GREEN: the same task produced `mock`, then `secondary`, and the focused
  fallback test passed.

Expected effect: no direct reduction in a necessary fallback call, but accurate
cost/latency accounting and bounded retry decisions. The deterministic fallback
row reports two provider attempts; the always-failing recovery row reports three
attempts and two recovery events instead of falsely looking like a zero-usage
task.

### 4. DeepSeek reasoning aliases were sent without wire normalization

Root cause: Morrow's capability surface accepts `low`, `high`, `xhigh`, and
`max`, while the DeepSeek thinking wire supports `high` and `max` effort levels.
Sending the surface aliases unchanged could cause provider rejection or a
retry.

Repair: `deepSeekWireEffort` maps `low` and `high` to `high`, and `xhigh` and
`max` to `max` at `services/orchestrator/src/provider/reasoning.ts:24-72`.
Reasoning off emits only `{thinking:{type:"disabled"}}`. The real HTTP-shaped
pipeline tests are at `services/orchestrator/test/reasoning-pipeline.test.ts:155-188`.

The provider's official thinking-mode documentation describes enabled/disabled
thinking and the OpenAI-compatible effort mapping used here:
[DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode).

Strict TDD evidence:

- RED: the low-effort wire body contained raw `low`; the test expected `high`.
- GREEN: low, xhigh, and off wire tests passed after the smallest translation
  change.

Expected effect: prevent invalid-reasoning requests and their retry latency/cost.
This local test does not quantify avoided live retries.

### 5. DeepSeek 1M context versus preset compaction

The current DeepSeek Pro and Flash metadata declares a 1,000,000-token context
window at `services/orchestrator/src/routing/models.ts:162-170`. The budget
resolver computes usable route capacity separately from the preset's first-pass
compaction target at `services/orchestrator/src/routing/model-budget.ts:106-134`.
The focused test at `services/orchestrator/test/model-budget.test.ts:24` measures
1,000,000 total context, more than 900,000 usable input tokens, and a 131,072
token compaction target.

This is not evidence that the model is being hard-capped at 131,072: the value is
the balanced preset's soft first-pass compaction target, while route admission
uses the larger effective capacity. The current uncommitted registry change that
removed the stale DeepSeek endpoint cap was present before this pass and is not
attributed to this pass.

The corrected long-context scenario seeded 322 messages, emitted three durable
compaction events, and completed in one provider call after compaction. The
benchmark records a final compacted context sample of 674 tokens and an admitted
request of 12,985 tokens including the tool envelope.

## Ranked top five inefficiencies

1. **Repeated complete tool schemas (highest measured impact, not yet fixed).**
   Root: `agent.ts:1610` plus `measureProviderRequest:196`. Evidence: 12,297
   schema tokens per simple request and 36,891 over three duplicate-read turns.
   Recommendation: introduce a capability-scoped/lazy tool profile, with a
   fallback path that restores the complete profile when the task requires it.
   Expected reduction: up to about 12.3k measured input tokens per tool-free
   request and the same proportional estimated input cost; provider-call and
   latency reduction is unmeasured. This requires a new equivalent-task success
   benchmark before adoption.

2. **Applied-write replay after context projection (fixed).** Root cause and
   RED/GREEN evidence are in `provider-projection.ts:43` and the regression at
   `provider-projection.test.ts:163`. Expected reduction: one replayed write and
   its corrective turn in affected tasks; deterministic projection now emits no
   executable call.

3. **Byte-oriented read deduplication (fixed).** Root cause and RED/GREEN
   evidence are in `agent.ts:4727` and `agent-loop.test.ts:174`. Expected
   reduction: one duplicate workspace observation and its result bytes per
   semantically repeated read; provider-turn reduction is not claimed.

4. **Unobserved failed provider attempts and recovery work (fixed accounting,
   bounded behavior measured).** Root cause is usage-only counting in the
   flagship projection. The new attempt event makes two fallback attempts and
   two recovery events visible. Expected reduction: no necessary fallback call,
   but fewer hidden/misclassified retries and more reliable stop decisions.

5. **Reasoning wire mismatch (fixed normalization).** Root cause and wire RED/GREEN
   evidence are in `provider/reasoning.ts:24-72` and
   `reasoning-pipeline.test.ts:155`. Expected reduction: provider rejection and
   a retry for unsupported effort aliases; live token/time savings remain
   unmeasured.

## Completion, verification, and retry behavior

The benchmark covers both a task that should complete without extra verification
(`simple-answer`, one call, zero tools) and a mutation that requires verification
(`mutation-verification-required`, three calls, two tools). Existing completion,
loop, and recovery tests remained green in the full suite; no completion contract
was weakened or replaced with a hidden summary turn.

The fault rows distinguish intentional work from unnecessary work:

- file-write retry: one malformed write, one retry, then verification;
- failed-tool recovery: one failed read, then corrected read;
- provider fallback: one failed primary start, then alternate route;
- provider recovery failure: three bounded attempts, two recovery events, and a
  failed outcome rather than an invented success.

## Verification commands

All of these completed successfully after the final measurement change:

- Focused regressions: 103 orchestrator tests plus 2 contract tests.
- `pnpm test`: 14 package tasks; latest run included 179 orchestrator files / 1,963
  tests and 88 CLI files / 796 tests.
- `pnpm check`: 10 package checks and repository validation (11 required files).
- `pnpm build`: 9 build tasks successful.
- `pnpm --filter @morrow/orchestrator exec tsx ../../benchmarks/harness-economics/deterministic.ts`.
- `git diff --check`.

No browser or live-provider check was necessary. No commit, stage, push, merge, or
pull request was performed.

## Remaining limitations and next measurement

- Hermes/Pi equivalent black-box comparison is deferred; no superiority claim is
  justified.
- Live TTFT, provider reasoning tokens, and provider-metered cost remain
  unavailable in this pass.
- The tool-schema opportunity needs a paired capability-scoping experiment with
  identical prompts, success criteria, model routes, and budgets.
- The benchmark is 15 scenarios, not a representative production workload.
- The append-only evidence contains the initial fixture-validation rows by design;
  use the corrected run tag when aggregating.
- Existing uncommitted UI, CLI, registry, tests, screenshots, and plan artifacts
  remain untouched and are not all efficiency changes.
