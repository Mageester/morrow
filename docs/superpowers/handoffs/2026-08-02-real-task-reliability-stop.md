# Handoff — real-task reliability cycle, stopped 2026-08-02

## Inline continuation, 2026-08-03 — current state

Luna max was still unreachable, so this pass was implemented inline rather than
delegated. HEAD is now `be54eeb`. Full orchestrator suite **169 files / 1,784
tests**, typecheck clean, flagship evidence SHA-256 unchanged at
`0FE914A924AC3B780299ECBC7000831A447E630AAA5EFDD2B7E2A0C8E3FC3A5A`.

**Task 5 round-2 findings — closed** (`e079202`). Both were confirmed real by
failing tests before the fix, and both were the same class of bug: a redacted
value compared against a raw one.

- *Legacy artifact pagination.* Legacy rows carry a pre-redaction `bytes`
  column while `getContent` redacts on read. `readArtifactRange` measured
  truncation against that stale column, so the last page of a legacy artifact
  containing a secret returned `truncated: true` with a `nextOffset` that
  yielded **zero** further bytes — a compliant model paginated forever. This was
  a live infinite-loop path, reproduced in test. Truncation now measures against
  bytes actually served.
- *Operation idempotency.* `completeOperation` and `failOperation` compared the
  redacted persisted result against the caller's raw retry input, so an
  idempotent retry whose payload contained a secret was rejected as a
  conflicting result. Both now redact the retry input before comparing. A
  negative control pins that genuinely different results are still rejected.

**Task 6 — complete** (`370dc16`). New
`test/execution-boundary-conformance.test.ts` guards both boundaries as classes
over their full domain: every read-only tool name must resolve in the catalog
and be declared side-effect free, no mutating tool may appear in the read-only
profile, and continuation state is enumerated across every declared
`ProviderProtocol` plus host, endpoint kind, endpoint identity, provider, and
turn. **Both boundaries already held** — no production defect was found. The
only production change is exporting `READ_ONLY_TOOL_NAMES` so the guard reads
the real registry instead of a copy that could drift.

**Task 7 step 1 — complete** (`be54eeb`). `FLAGSHIP_PROVIDER_ELIGIBILITY`
replaces the private candidate array, stating eligibility, live-discovery
requirement, and a reason for every exclusion. A default-suite guard asserts the
table classifies every provider in `ProviderIdSchema` exactly once, so a new
provider must be classified deliberately. `deepseek` and `opencode-zen` remain
the declared gate providers. No provider call is made.

**Still outstanding — the whole live gate.** Task 7 steps 2–6 (free OpenCode Zen
model discovery, one canary per provider, diagnosis of any failure) and Task 8
(≥9/10 both providers, ADR 0011, issue-history update). Nothing here has been
proven against a real model. **Do not merge claiming reliability is proven.**

## Resume attempt later on 2026-08-02

The cycle resumed from `6b7dd1b`. The live-isolated baseline was confirmed at
166 files / 1,753 tests, with the flagship evidence SHA-256 unchanged at
`0FE914A924AC3B780299ECBC7000831A447E630AAA5EFDD2B7E2A0C8E3FC3A5A`.

Task 5 review round 1 found 2 Critical and 4 Important completion/privacy
defects. The delegated Luna-max implementation landed `c2c3795`
(`fix(orchestrator): complete tasks from durable evidence`). Its final focused
set passed 120/120; the full live-isolated orchestrator suite passed 167 files /
1,764 tests; both package typechecks and `git diff --check` passed; the evidence
hash remained unchanged.

Task 5 is still **not CLEAN**. Review round 2 reproduced two suspected fix
regressions before the Luna-max review task failed at the system level:

- legacy artifact range pagination uses pre-redaction byte metadata;
- mission-runtime idempotency compares redacted persisted values with raw retry
  inputs.

Two fresh Luna-max replacement review tasks then failed immediately with system
errors. The cycle stopped because the required Luna-max model was no longer
reachable and model substitution was prohibited. No Task 6-9 work and no live
provider run occurred. Current implementation HEAD is `c2c3795`; do not merge.

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
