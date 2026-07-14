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

## Journey G — self-hosting implementation integrity

Added after a real Morrow-manages-Morrow self-hosting task, `1fcbc8ab-7827-
4086-a6e7-b0477e752aaa` (project `morrow`, workspace this checkout, task type
`agent_chat`, `2026-07-14T16:05–16:07Z`), produced a catastrophic false
completion when Morrow was pointed at its own repository and asked to
investigate/fix a real orchestrator concern:

- 37 tool calls, 2 failed (`list_files` ×5, `read_file` ×5 completed + 2
  failed, `run_command` ×18, `search_symbols` ×4, `search_text` ×3) — **zero**
  `propose_patch` or `create_file` calls were ever attempted;
- 503,751 input tokens consumed;
- no implementation and no Git diff (`git diff` against the workspace was
  empty for the whole session);
- the persisted assistant message (40,591 characters) was almost entirely one
  narration string — `"Good — clean working tree on
  `fix/mission-tool-recovery-stall`. Let me inspect the relevant orchestrator
  files."` — repeated dozens of times back-to-back;
- all 3 plan steps (`Analyze & Plan`, `Read Workspace`, `Generate Answer`)
  were marked `completed`;
- the task's terminal status in `tasks.status` was `completed`, which the CLI
  reports as "last task passed."

This is architecturally the same trust failure as Journey A (a status lie),
but a different mechanism: Journey A wrongly called honest, side-effect-free
work a failure; this incident wrongly called a stalled, empty-handed
investigation a success. Both erode the same invariant (#9 — distinct,
truthful terminal states).

### Reproduction design

`services/orchestrator/test/journey-g-self-hosting-integrity.test.ts` exercises
the real `executeAgentChatTask` execution path (not a standalone helper)
against real sqlite-backed repositories (`task-records`, `conversations`,
`change-sets`, `execution-continuity`) and a disposable Git repository
containing a ~40 KB fixture source file (`big.js`, 900 helper functions plus
one deliberately buggy `add()`) and its test (`big.test.js`), using a
deterministic `MockProvider` fixture in place of the live model. Two cases:

1. **Full green path** — inspects the large file, restates the same
   orientation narration across two intermediate turns (realistic model
   behavior — restating context is not itself a defect) while still making
   distinct tool-call progress, applies one `propose_patch` fixing `add()`,
   runs the test to verify, and gives one final, novel answer.
2. **The proven root cause** — the model inspects the file, then narrates the
   *exact same string* alongside a distinct read-only tool call three times,
   then repeats that exact string one more time with **no** tool call
   attached (the literal shape of the corpus incident: repeated narration
   finally mistaken for a conclusion), and never calls a write tool.

### Before / after results

| Case | Before (pre-fix) | After (post-fix) |
|---|---|---|
| Full green path | PASS | PASS |
| Duplicate-narration false completion | **FAIL** — `task.status` was `completed`, plan steps all `completed`, no Git diff, no canonical answer distinguishable from the repeated text | **PASS** — `task.status` is `interrupted`; `canonical_task_answers` has no row for the task; at least one plan step is left non-`completed`; no `task.completed` event was ever emitted |

Confirmed by running the regression against the pre-fix code (`git stash` of
the two-file fix, rerun, restore): the duplicate-narration case fails exactly
as predicted (`expected 'completed' to be 'interrupted'`) before the fix and
passes after it. The full-green-path case already passed before the fix,
confirming the repair is additive and does not regress ordinary completions.

### Enforced tool, turn, and request-size limits

Exercised (not newly introduced by this pass — pre-existing, now verified
under Journey G):

- `maxTurns` (test uses 8) bounds provider turns per segment;
  `adaptiveTurnCeiling` bounds the absolute ceiling at 24–36 turns regardless
  of preset;
- the loop detector (`services/orchestrator/src/execution/loop-detector.ts`)
  bounds repeated *identical tool-call signatures* within a sliding window;
- the stall guard interrupts after 3 turns with no observable progress
  (`noProgressTurns >= 3`);
- the full green-path journey completed in 6 tool calls / 7 provider turns —
  well inside these ceilings, with no `/continue` required.

### Root cause and repair

**Root cause:** the natural "no more tool calls, no outstanding verification
failure ⇒ complete" shortcut (`services/orchestrator/src/execution/agent.ts`,
both the resume-time `replayableFinalTurn` path and the live end-of-loop
completion gate) accepted the final turn's text as a genuine, novel
conclusion purely because it arrived without a trailing tool call. It never
checked whether that text was itself a verbatim repeat of earlier
intermediate narration — the exact shape of the corpus incident, where a
stalled investigation's leftover scene-setting sentence was persisted as the
"final answer" and the task completed with zero delivered changes.

**Repair (smallest coherent fix, two files):**

- `services/orchestrator/src/execution/loop-detector.ts` — added
  `duplicatesPriorNarration(candidate, priorTexts)`, a pure, deterministic,
  whitespace-normalized exact-match check (mirrors the existing pure
  predicates in this file: `stableStringify`, `toolCallSignature`).
- `services/orchestrator/src/execution/agent.ts` — both completion paths now
  call `duplicatesPriorNarration` against every earlier recorded provider
  turn's `assistantText` **before** marking any plan step `completed` or
  calling `completeWithCanonicalAnswer`. On a match, the task stops
  truthfully as `interrupted` with reason `duplicate_final_narration` instead
  of completing, and the plan step that was in progress is marked `skipped`
  rather than `completed`.

No architecture change: this reuses the existing durable-turn ledger
(`agent_provider_turns`, already the source of truth for "each intermediate
turn stored exactly once" since the `responseContent.slice()` provider-history
fix) and the existing truthful-interruption pattern already used by the
unverified-completion and loop/stall gates.

### Regression coverage

`services/orchestrator/test/journey-g-self-hosting-integrity.test.ts`, both
cases. The duplicate-narration case is a deterministic, provider-independent
regression for this exact incident: it fails against the pre-fix code and
passes after it.

### Remaining risks

- The fix is a literal (whitespace-normalized) duplicate check, not a
  semantic one. A model that paraphrases the same non-conclusion each turn
  instead of repeating it verbatim would not be caught by this gate — that
  would require semantic judgment of "is this actually a conclusion," which
  is out of scope for a deterministic, architecture-preserving repair.
- This pass does not address *why* the real corpus task spent its entire
  budget re-reading overlapping chunks of `agent.ts` via `sed -n` (a
  `read_file` size-limit workaround) without ever converging on a change —
  the adaptive-progress heuristic (`turnMadeProgress` in
  `adaptive-budget.ts`) counts any new tool-call signature as progress, even
  near-duplicate re-reads with shifted line ranges. That is a real,
  identified P2 efficiency gap (tracked here, not fixed in this pass) but it
  did not by itself cause a false `completed` status — the duplicate-final-
  narration gate is the mechanism that was proven to do that, and is what
  this pass repairs.
- `canonical_task_answers` and the durable-turn ledger were empty/absent
  structures relative to the real corpus task's row-for-row data (that task
  predates or ran under different code than this checkout's current
  execution-continuity schema); Journey G is built from the *failure class*
  the corpus task documents, not a byte-for-byte replay of its exact
  provider trace.

## Final result: 7/7 permanent consumer acceptance journeys pass

A (read-only success), B (one-file edit), C (new file + test), D (repair a
failing test), E (multi-file feature), F (controlled recovery under a
read-limit), and G (self-hosting implementation integrity) all pass on this
checkout after the two fixes recorded in this document (Journey A's
`tool_not_permitted_in_mode` distinction, Journey G's
`duplicatesPriorNarration` gate).
