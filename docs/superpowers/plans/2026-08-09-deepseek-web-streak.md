# DeepSeek Flagship Web Streak Plan

**Goal:** Extend the first verified `deepseek-v4-flash` `flagship-web-v1` pass into ten consecutive qualifying passes without batching, retrying away failures, or weakening the gate.

**Starting evidence:** Run `6658f501-2768-48a1-82f9-fccdf19b4c75` is the first passing row after the reviewed runtime and evaluator repairs. The append-only evidence log remains authoritative.

**Stopped attempt:** The next serialized run, `8d334d0d-f7fa-44b3-bc71-dac2ec8dd7f1`, failed before browser verification because stagnation accounting did not recognize newly emitted supervised-process output as progress. This streak is stopped and must restart only after the bounded repair in `2026-08-09-process-observation-progress.md` is reviewed, deterministically green, and passes one explicit canary.

## Execution protocol

1. Run at most one live canary at a time with `MORROW_FLAGSHIP_RUNS=1`, provider `deepseek`, model `deepseek-v4-flash`, and scenario `flagship-web-v1`.
2. Before every run, require a clean worktree, no active flagship process, and no unexplained retained server.
3. After every run, inspect the newly appended row rather than trusting the wrapper exit code.
4. Commit each new evidence row before another provider call.
5. On any failure, stop the streak immediately, preserve the workspace/row, classify the failure, and create one bounded deterministic repair package.
6. Do not invoke OpenCode Zen until ten consecutive DeepSeek passes are present.

## Acceptance criteria

- Nine additional serialized DeepSeek runs are appended after the starting pass.
- Every streak row is real-mode, `flagship-web-v1`, `deepseek-v4-flash`, `passed: true`, `taskStatus: completed`, has no failure reason/detail, and has a non-null artifact hash.
- No live run overlaps another live run or a shared mutable test surface.
- The final ten most recent DeepSeek web rows are all passing.
- The scenario-aware gate reports DeepSeek qualified; the overall two-provider release gate remains unproven until a second provider qualifies.

## Rollback and stopping rule

Evidence is append-only and never rolled back. Code changes, if a failure demands them, occur only in a new reviewed repair package. A failed or unexplained row ends this streak package; it is never followed by an automatic live retry.
