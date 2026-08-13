# Plan: Harness Efficiency Investigation and Repairs

> **For the implementation agent:** follow this plan task-by-task, keeping each RED/GREEN cycle and verification command in the session evidence.

**Goal:** Measure Morrow's local agent-harness economics, reproduce the known write/replay/context/reasoning/fallback inefficiencies, and ship the smallest tested repairs that reduce unnecessary provider work without weakening completion or safety contracts.

**Scope:** `services/orchestrator` execution, provider routing/adapters, deterministic benchmark fixtures, and the efficiency report. The committed web UI redesign and unrelated uncommitted files remain out of scope.

**Safety boundary:** local deterministic fixtures and mocked provider/network boundaries only. Do not inspect credentials, call a live provider, add telemetry, add hosted dependencies, run unattended/destructive tasks, stage/commit/push/merge, or alter unrelated user work.

## Baseline and evidence

- Preserve and record the initial worktree with `git status --short --branch`, `git diff --stat`, `git diff --check`, branch/ancestry, worktrees, and targeted process/port identity.
- Use the existing focused baseline and the existing economics snapshot as historical evidence, labeling live-provider rows separately from deterministic local evidence.
- Add a deterministic benchmark runner under `benchmarks/harness-economics/` with fixed prompts, fixtures, route metadata, budgets, and a versioned append-only JSONL evidence output. Cover answer, read/search, multi-file mutation, new-file creation, write failure/retry, long context, reasoning off/low/high, failed-tool recovery, no-extra-verification completion, and mutation verification.
- Record model/provider calls, token fields, tool calls, duplicate observations, compactions, recovery attempts, interventions, wall time, estimated cost where pricing is known, and success state. Keep unavailable values explicitly unavailable.
- Produce `docs/harness-efficiency-report-2026-08-11.md` with baseline/after tables, exact source/test line references, ranked inefficiencies, root causes, expected and measured deltas, evidence class, and residual limitations. Do not claim cross-harness superiority without equivalent local evidence.

## Repair 1: applied-write projection

**RED:** Extend `services/orchestrator/test/provider-projection.test.ts` with a completed `append_file` call whose normalized arguments contain `_morrowAppliedWrite`; assert the next provider projection contains historical text, no executable append tool call, no marker, and no tool result for that call. Add the corresponding execution regression in `agent-file-creation.test.ts` if the end-to-end fixture exposes a distinct failure.

**GREEN:** Update `services/orchestrator/src/execution/provider-projection.ts` so successful `append_file` markers use the same non-executable historical path as `create_file` and `propose_patch`. Preserve failed writes with their original body and keep marker validation bounded to existing workspace evidence.

**Verify:** Run the focused projection/file tests, inspect the RED and GREEN outputs, and assert the fixture never emits a missing-`content` retry for a successful append.

## Repair 2: canonical observation deduplication

**RED:** Add an agent-loop fixture that issues semantically identical read calls with different JSON key order/whitespace and asserts they currently execute as separate observations. Keep the assertion behavioral by checking tool-result/event counts, not implementation details.

**GREEN:** Reuse the existing stable `toolCallSignature` for observation replay/deduplication and its cached-result map. Do not deduplicate writes, browser actions, or failed observations; preserve per-turn loop semantics and reset behavior across compaction/segment rollover.

**Verify:** Run the new regression plus existing loop/recovery tests and compare deterministic benchmark duplicate-observation and tool-call counts.

## Repair 3: complete provider-attempt accounting

**RED:** Add a fallback fixture where the first candidate fails before streaming and the second succeeds without a usage chunk. Assert provider-call accounting currently undercounts the attempted first route.

**GREEN:** Add a local task-event callback at the fallback boundary that records each actual `streamChat` attempt, without logging request content or secrets. Project provider-call counters from attempts, while retaining provider-reported usage as the sole source for token/cost counters. Keep retry/fallback behavior bounded and unchanged.

**Verify:** Test first-route failure, all-route failure, rate-limit ordering, and successful usage accounting. Ensure failed attempts never fabricate token or cost values.

## Repair 4: DeepSeek reasoning normalization

**RED:** Extend the real OpenAI-compatible adapter wire tests with DeepSeek V4 `off`, `low`, and `high`/`xhigh` cases. Assert the current adapter emits the provider-documented `thinking` toggle and provider-valid effort values; the low/xhigh cases must fail before the fix if they currently send unsupported raw values.

**GREEN:** Normalize Morrow's user-facing DeepSeek levels to the documented wire levels (`low`/`medium` to `high`, `xhigh` to `max`), keep explicit off as `thinking: { type: "disabled" }`, and preserve capability validation/fallback reset behavior. Do not change fixed-reasoning legacy routes.

**Verify:** Run the adapter and HTTP pipeline tests with mocked fetch only. Confirm auto sends no override, off sends no effort plus disabled thinking, and no unsupported route issues a request.

## Context and completion decisions

- Add deterministic assertions for DeepSeek effective capacity and the first-pass preset target. Treat the preset byte budget as an intentional cost/privacy soft target unless evidence shows it is being reported or enforced as the provider's hard 1M limit.
- Preserve the existing later-tool-free-final contract and bounded empty/recovery retries unless a focused regression demonstrates a successful tool result is being replayed or a completed final is missed. Any completion change must assert both no extra provider turn and no loss of required verification.

## Final verification

Run focused RED/GREEN tests, the deterministic benchmark, `pnpm test`, `pnpm check`, `pnpm build`, and `git diff --check` sequentially where build artifacts overlap. Re-check status, diff summary, branch/merge-base, worktrees, and actual Morrow process/port identity. Leave all changes unstaged and uncommitted unless explicitly instructed otherwise.
