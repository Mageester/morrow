# DeepSeek Flagship Reliability — Session Report

Branch: `gemini/deepseek-flagship-canary`
Start commit: `177be0e`
Final commit: `e98eb6e`
Nothing merged, nothing pushed; no branches/tags/worktrees/stashes deleted.

/ **Method:** every root cause below was found from the real product database
(`~/.morrow/morrow.db`) and/or in-process instrumentation of live
`deepseek-v4-pro` Build Auto runs driven through the real orchestrator HTTP API
(the same backend the UI calls), then fixed at the shared abstraction and locked
with deterministic regression tests. Full suite: **172 files, 1850 tests pass**
(was 1826). `tsc` clean. `git diff --check` clean.

## The failure this session removed

At the start, a complex Build Auto job on `deepseek-v4-pro` created several real
files and then **hard-interrupted** with `tool_arguments_unrecoverable`,
discarding the work. Across live runs this session, the pipeline now reliably
produces a **complete multi-file project, a passing production build, and
browser verification** instead of dying at file creation. The best observed run
(`scen1f`) reached turn 72 with 14 source files, a successful `dist/` build, and
29 browser interactions.

## Root causes found and fixed (each with regression tests)

1. **propose_patch shared correction budget** (`66a9dc3`). `toolArgumentAttemptKey`
   derived its per-call budget target only from a top-level `path`, which
   propose_patch lacks. Every propose_patch arg failure collapsed onto one key,
   so three distinct first attempts on three files climbed 1→2→3 and tripped the
   task-killing budget. Fix: `proposePatchTarget()` keys each file independently;
   an exhausted patch is redirected to `create_file` with a `tool.strategy_switch`.

2. **Echoed applied-write placeholders killed tasks** (`8fa4edd`). To fit the
   context window, `capToolArgumentsForContext` rewrites an applied write in the
   model's history as `{ path, _morrowAppliedWrite: { contentSha256, … } }` with
   the body stripped. deepseek-v4-pro copies that shape back verbatim; the
   content-less call was rejected as "content missing" and killed the task. Fix:
   `isEchoedAppliedWrite()` recognizes it and returns an idempotent no-op **only
   when the referenced file exists on disk** (a missing file falls through to a
   real content correction, never a silent skip).

3. **Weak correction for a placeholder echo of a missing file** (`e875469`).
   The generic "fix the content" hint let the model re-copy the marker forever.
   Fix: explicit feedback naming `_morrowAppliedWrite` as a history artifact and
   demanding the complete source.

4. **A started background server scored as a failed verification** (`f4c43d5`).
   A finished build was blocked by `failed_final_verification` because the model
   started a preview server via `run_command`, which the executor correctly
   detached (`{ status: "running", pid }`, no exit code) — and the verification
   collector scored the no-exit-code result as `passed: false`. Fix:
   `runCommandStartedBackgroundProcess()` excludes detached servers from pass/fail
   verification scoring.

5. **A mimicked-marker loop could kill the whole task** (`33fbcfb`, `5b5c06c`).
   deepseek-v4-pro also *fabricates* the compaction marker for files it never
   wrote and ignores corrections. Killing an entire run over that self-inflicted
   confusion is the worst outcome. Fix: keep the echoed-placeholder-missing-body
   case (create_file content OR propose_patch patch) out of the task-killing
   budget; the per-action loop detector still bounds an endless repeat, and a
   later build failure surfaces any genuinely missing file for a focused retry.

6. **A deduplicated browser call poisoned frontend completion evidence**
   (`e98eb6e`). The strongest live run (`scen1f`) built a complete dashboard,
   passed the build, and drove 29 post-edit browser interactions — yet completion
   was blocked with "No relevant frontend interaction was independently verified."
   Cause: the model clicked the same element twice; the repeat was deduplicated to
   a `{ duplicate: true }` placeholder (`clicked: undefined`), and the evidence
   check used `.every()`, so that one placeholder flipped `interaction` (and other
   categories) false for the whole task. Fix: exclude `{ duplicate: true }`
   results — reused prior observations, not new evidence and not failures — from
   the browser-evidence set before the category checks.

## Live evidence (real deepseek-v4-pro through the orchestrator API)

- Echoed-write no-ops fire correctly: `tool.strategy_switch { from:
  echoed_applied_write, to: noop, reason: already_applied }`, task proceeds past
  `npm install` (exit 0) and `npm run build` (exit 0).
- `scen1f` produced a complete, building app (App.tsx, TaskBoard/FocusTimer/
  Statistics + CSS, useLocalStorage/useTimer hooks, types; `dist/` with bundled
  assets) and 29 browser interactions — surviving to turn 72 versus the earlier
  turn-~15 hard death.

## Honest status of the acceptance goal

**No scenario was observed reaching a green `completed` state**, and none is
claimed. With all six fixes the hard task-killing crashes are gone and the
pipeline reliably builds a complete app and attempts browser verification, but
runs remain **model-limited and nondeterministic**: deepseek-v4-pro
intermittently (a) stalls by mimicking Morrow's own compaction marker and
ignoring corrections, or (b) stalls on a build error it cannot repair inside the
stagnation window. The closest run (`scen1f`) was blocked only by root cause #6,
which is now fixed — so a run that again reaches full post-edit browser
verification should now complete — but that was not re-observed within this
session's budget.

### Remaining limitation and the recommended root fix

The dominant remaining flakiness is self-inflicted: **exposing the
`_morrowAppliedWrite` compaction marker in the model's context teaches a weaker
model to emit content-less write calls.** The defensive fixes here stop it from
crashing the task, but do not stop the model from wasting turns on it. The
durable fix is to change the provider **projection** so a compacted, already-
applied write is represented as a short assistant *text* note ("already wrote
src/App.tsx") rather than a re-emittable `create_file`/`propose_patch` tool call
— removing the mimicable pattern entirely. That is a larger, higher-regression-
risk change to `buildProviderProjection` and was deliberately not attempted under
this session's remaining budget rather than risk the 1850-test gate.

## Verification commands (exact final results)

- `pnpm --filter @morrow/orchestrator test` → **172 files, 1850 tests passed**.
- `pnpm --filter @morrow/orchestrator check` (tsc) → clean.
- `git diff --check` → clean.
- Live orchestrator (`pnpm dev:app`, port 4317, `tsx watch`) runs this checkout's
  fixed code; UI on 4318 returns 200.

## Pre-existing evidence change (not authored this session)

`docs/evidence/flagship-runs.jsonl` has 3 uncommitted records generated by an
earlier `flagship:run` CLI invocation before this session. They were reviewed and
left untouched (not committed), per the task's evidence-handling instructions.
