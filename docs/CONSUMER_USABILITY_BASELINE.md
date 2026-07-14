# Morrow — Consumer Usability Baseline (2026-07-14)

> Black-box acceptance pass against the actual consumer CLI (`morrow` linked
> from `apps/cli/bin/morrow.mjs` in this checkout, commit `145127f` at
> session start), driven through disposable Git repositories outside the
> Morrow source tree, using the real configured provider (DeepSeek,
> `deepseek-v4-flash`). No Morrow output was trusted without independent
> inspection of the resulting Git diff and test run.

## Method

Six journeys (A–F) were run twice: an initial baseline pass (this document's
"Before" column) and a final pass from fresh disposable repos after the
repair below ("After" column). Every journey's workspace was independently
verified with `git status`/`git diff` and a fresh `node <file>.test.js` run
outside of Morrow — Morrow's own reported status was never taken as proof.

## Baseline matrix

| Journey | Scenario | Before | After | Notes |
|---|---|---|---|---|
| A | Read-only investigation (planted bug in `multiply`, no changes expected) | **FAIL** — correct diagnosis, clean workspace, but task status falsely `interrupted` | **PASS** — same correct diagnosis, clean workspace, status `completed` | Root cause below |
| B | One-file edit + focused test | PASS | PASS | One `propose_patch` hunk-mismatch, self-recovered without `/continue` |
| C | New file + test | PASS | PASS | Two `propose_patch` failures, self-recovered without `/continue` |
| D | Repair a failing test | PASS | PASS | One-line surgical fix, verified green |
| E | Medium multi-file feature (3 files) | PASS | PASS | Two `propose_patch` failures, self-recovered without `/continue` |
| F | Controlled recovery (172 KB generated file, 100 KB `read_file` limit) | PASS | PASS | Switched strategy after `read_file` limit + two patch failures; one-line surgical fix to `clamp`, 3999 generated helper functions untouched |

**Initial pass rate: 5/6 (83%). Final pass rate: 6/6 (100%).**

## Exact failure — Journey A

- **Reproduction:** `morrow ask "Inspect this repository, run the test file
  to see it fail, explain what is wrong and why, and identify exactly which
  function has the bug. Do not modify any files." --project . --json
  --no-color --quiet` against a fixture with a deterministic bug (`multiply`
  implemented as addition).
- **Observed:** the model correctly identified the bug from source alone,
  attempted `run_command` to run the test, was correctly denied (read-only
  mode never exposes `run_command`), and produced a fully correct final
  answer. The workspace was verified clean (`git status --porcelain` empty).
  Despite this, the task's terminal status was `interrupted`, not
  `completed`.
- **Root cause (confirmed by reading the code, not just reproducing):**
  `services/orchestrator/src/execution/agent.ts` treats `run_command`,
  `propose_patch`, `create_file`, and `create_directory` as
  `VERIFY_OR_WRITE_TOOLS` — any failure of one of these tools is recorded as
  `lastVerificationFailure`, and the completion gate
  (`completedWithoutMoreTools && lastVerificationFailure`) stops the task
  with status `interrupted` rather than `completed`, on the theory that "the
  last verification did not actually pass." That gate exists correctly to
  catch the real defect of "tests failed yet the task said completed" — but
  it did not distinguish a **genuine failed verification** (a command that
  ran and exited non-zero, or threw) from a **tool call denied purely
  because the current mode forbids it** (the defense-in-depth guard at the
  former `agent.ts:2353`, which threw a plain `Error` indistinguishable from
  any other tool failure). A read-only task that correctly never attempts
  execution, and is correctly refused when it tries, was punished by the
  same gate meant to catch dishonest completions.
- **Consumer impact:** this reproduces the class of defect named in the
  sprint's known live incident and violates invariant #9 ("Failed,
  incomplete, interrupted, and completed are distinct truthful states") —
  successful, correct, side-effect-free work was reported as a failure,
  which erodes trust in every other status the product reports.
- **This is also independently documented** as `docs/KNOWN_ISSUES.md` issue
  #1 ("Read-only success recorded as interrupted"), filed 2026-07-11 and
  still open at the start of this session despite several beta.30 terminal/
  continuity PRs having landed since (`#44`–`#47`) — confirming it was not a
  side effect of unrelated recent work but an independent, still-live defect
  in the completion gate.

## Fix

`services/orchestrator/src/execution/agent.ts`:

- The mode-permission-denial guard now throws a typed `AgentToolFailure`
  with `errorType: "tool_not_permitted_in_mode"` instead of a plain `Error`,
  so it is distinguishable from a real tool/verification failure at every
  downstream consumer of tool-call outcomes.
- Both places that derive `lastVerificationFailure` (the live per-call
  bookkeeping, and `completionStateFromCalls`, which recomputes the same
  state from persisted `ToolCallRecord`s on replay/resume) now skip calls
  whose `errorType` is `tool_not_permitted_in_mode`.
- The model-facing behavior is unchanged: the tool call still fails, the
  model still receives a structured rejection it can (and did) route around
  by answering from source alone. Only the task-completion status
  computation changed.

This is the single shared root cause for the one confirmed baseline
failure; no other journey needed a code change. `propose_patch` hunk
mismatches observed in B, C, E, and F are an existing, already-handled
retry path (the model regenerates a corrected patch and succeeds on the
next attempt) — they did not violate any pass criterion and are called out
here only as a P2 efficiency observation, not a correctness defect.

## Regression coverage

`services/orchestrator/test/agent-security.test.ts` — the existing
"inspect (read-only) mode discloses read-only and refuses execution tools"
test already reproduced the exact defect end-to-end (agent mode, mock
provider, `run_command` attempted and denied). It has been extended to
assert `taskRepository(db).getTaskById("t")!.status === "completed"`,
which fails against the pre-fix code and passes after the fix — a
deterministic, provider-independent regression test for this exact
incident.

## Final six-journey result

Rerun from six **freshly created** disposable repositories (not reused from
the baseline pass) after rebuilding and restarting the orchestrator against
the fixed code: **6/6 passed** — unattended completion, no `/continue`, no
duplicated assistant text, exactly one final answer per task, truthful
status on every task, and independently verified workspace/test results
matching Morrow's own report in every case.

## Validation run

- `pnpm --filter @morrow/orchestrator check` — PASS
- `pnpm --filter @morrow/orchestrator test` — PASS (887 passed, 5 skipped)
- `pnpm --filter @morrow/cli check` — PASS
- `pnpm --filter @morrow/cli test` — PASS (612 passed)
- `pnpm check` — PASS (5 packages + repository validation)
- `pnpm test` — PASS (7 tasks, includes the two above)
- `pnpm build` — PASS (4 packages)

## Remaining risks / not fixed in this pass

These were observed as recoverable, non-blocking behavior during the
baseline and are **not** part of this fix (each journey that hit one still
passed every acceptance criterion), but are worth tracking:

- **`propose_patch` hunk-count mismatches are common** (4 of 6 journeys hit
  at least one). The model always recovered on retry without user
  intervention, so this did not fail any journey, but it is real,
  measurable extra tool-call/token overhead per `docs/KNOWN_ISSUES.md`'s P2
  "inefficient tool use" category. Not investigated further in this pass —
  out of scope for the one confirmed P0 finding, and doing so would have
  required speculative changes to the patch-hunk generation/validation path
  without a reproduced correctness failure to anchor them to.
- `docs/KNOWN_ISSUES.md` contains 16 other previously filed findings (some
  already addressed by beta.30 PRs #44–#47, not independently re-verified
  in this pass since they were outside the six-journey scope). This
  baseline only re-verifies issue #1; the rest of that document's status
  should be treated as unconfirmed until re-run.
