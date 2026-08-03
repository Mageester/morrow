# Handoff — real-task reliability cycle, stopped 2026-08-02

Stopped by user direction (usage budget), not because the work reached its
definition of done. This records exactly what is true at `eac76e8`.

Branch: `codex/reliable-task-completion` (worktree `.worktrees/reliable-task-completion`)
Base: `754096a` on `main`
Size: 31 commits, 77 files, +9,846 / −339

## Verified state

Full orchestrator suite green: **166 files / 1,753 tests**, run with live opt-ins
absent. No provider calls were made and no evidence file was written during that
run. Both package typechecks pass.

## Complete and independently reviewed CLEAN

| Task | What it does |
|---|---|
| 1 | Terminal outcome coordination. A mission cannot go terminal independently of its runtime and worker task. Crash/restart recovery, lease fencing, atomic stale-claim takeover, exactly-once verification. Took 5 adversarial fix rounds; every round found a real defect. |
| 2 | Bounded non-progress execution. Replaces the 6-call sliding window with an epoch model (`src/execution/progress-epoch.ts`). Checkpoint hard cap of 128 KB with deterministic truncation (`src/execution/checkpoint-snapshot.ts`). Cursor-based SSE polling instead of full-history scans. Secret redaction in checkpoints. Live-provider tests now require positive opt-in. |
| 3 | Canonical model identity. Aliases resolve to canonical capabilities, context, and pricing while still sending the user-selected model ID outbound. Rejects cycles, missing targets, cross-provider aliases. Validate-before-persist so a bad remote catalog cannot poison startup. |
| 4 | Hard requirement enforcement. Explicit constraints ("backend only", "no database", "only edit these files") become runtime contracts checked at planning, tool-execution, and completion boundaries. Took 4 adversarial fix rounds covering wrapper bypasses, directory-satisfies-file, dropped unsupported requirements, and secrets in requirement evidence. |

## Partial

**Task 5 — completion contracts / privacy.** The completion engine works. Adversarial
review kept surfacing durable privacy-persistence paths; three fix rounds landed
(`d8aa5ba`, `845b2c6`, `eac76e8`) but no final review ran. Treat privacy
persistence as **not fully closed**.

## Not started

- Task 6 — read-only and boundary guardrails
- Task 7 — private-provider continuation isolation
- Task 8 — live DeepSeek / OpenCode canaries at ≥9/10
- Task 9 — final security review

## The honest caveat

**No live-provider proof exists for any of this.** Every structural bound is
verified by unit and conformance tests only. The branch demonstrably bounds the
loop; it has not been shown to build a real app in bounded turns against a real
model. That was Task 8 and it did not run.

## Live evidence that motivated the work

Captured from the packaged app before any fix:

- DB 258,727,936 bytes; `agent_execution_checkpoints` alone 206,159,872 bytes
- Two tasks recorded 300/340 provider turns, 831/713 tool calls, 276/265
  compactions, 281/269 checkpoints totalling ~201 MB
- Identical read/list/load calls repeated 31–92 times
- First mutation arrived only after 70/190 provider turns

Root causes found: the 6-call sliding loop window missed interleaved repeats;
observational evidence could reset stagnation; checkpoints copied cumulative raw
tool args and results; checkpoint creation and SSE polling rescanned full task
event history.

## Resuming

Plan: `docs/superpowers/plans/2026-08-02-real-task-reliability.md`
Design: `docs/superpowers/specs/2026-08-02-real-task-reliability-design.md`
Local ledger (gitignored): `.superpowers/sdd/2026-08-02-real-task-reliability/progress.md`

Next action is Task 5's final review, then 6–8. Do not merge to `main` claiming
reliability is proven until Task 8's canaries actually run.
