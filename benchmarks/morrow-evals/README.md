# Morrow Evals

A deterministic benchmark harness that measures whether Morrow's **Verified
Missions** system is honest and improving. It does not measure a model's raw
coding ability (that is non-deterministic and provider-dependent); it measures
the thing that is Morrow's advantage: **does the mission's claimed outcome match
the ground truth?**

## What it measures

Each scenario starts from a clean, reproducible fixture with planted defects and
a **hidden ground-truth check** the mission never sees. A scenario supplies a
deterministic "implementer" (some correct, some deliberately incomplete) so the
harness can exercise both honest-success and honest-failure paths. For each run
the harness records:

- `missionStatus` — the final graded status
- `criteriaVerified` / `criteriaTotal`
- `hiddenTestsPassed` — did the work actually satisfy the hidden ground truth?
- `regressionsIntroduced`
- `humanInterventions`
- `elapsedMs`, `costUsd` (where available)
- `failedOperations`, `repeatedFailures`, `recoverySuccess`
- `reviewerVerdict`
- **`finalClaimAccurate`** — the headline metric: `true` when Morrow's claim
  (did it grade the mission a full success?) matches reality (did the hidden
  test pass?). This is what distinguishes *"the work was actually correct"* from
  *"the agent claimed the work was correct."*

## Scenarios (this release)

1. `browser-game` — a canvas game with two planted runtime/resource bugs.
2. `esm-cjs` — a latent ESM/CommonJS interop runtime failure.
3. `authz-check` — a hidden authorization-check bug.
4. `refactor-regression` — a refactor with hidden regression tests.
5. `restart-resume` — a mission interrupted and resumed after a service restart.

Scenarios live in `scenarios/` and are trivial to add: implement the
`Scenario` interface.

## Running

```
pnpm --filter @morrow/orchestrator exec tsx ../../benchmarks/morrow-evals/run.ts
```

or from the repo root:

```
npx tsx benchmarks/morrow-evals/run.ts            # human table
npx tsx benchmarks/morrow-evals/run.ts --json     # machine-readable
```

The same scenarios run in CI via
`services/orchestrator/test/mission-benchmark.test.ts`, which asserts final-claim
accuracy across the suite so a regression in Morrow's honesty fails the build.

## Methodology notes

- No competitor scores are fabricated. The harness has a slot for manually
  inserted Hermes / Claude Code / Codex results, but this release only produces
  Morrow measurements.
- Runs are deterministic: the implementer and the criteria/review completions
  are injected, so results are reproducible on any machine.
- The hidden ground-truth check is executed independently of the mission's own
  evidence, so a mission cannot "grade its own homework."
